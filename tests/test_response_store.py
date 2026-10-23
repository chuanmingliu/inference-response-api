"""Unit tests for retention/admission; no SGLang installation or GPU required."""

import asyncio
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from response_store import BoundedResponseStore, LEASE_KEY, Limits, ResponsesAdmissionMiddleware


class StoreTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.now = 0.0
        self.handler = SimpleNamespace(response_store={}, msg_store={}, background_tasks={},
                                       response_store_lock=asyncio.Lock())
        self.controller = BoundedResponseStore(self.handler, Limits(max_records=2), lambda: self.now)

    def put(self, key, text="hello", parent=None, status="completed"):
        self.handler.response_store[key] = {"id": key, "status": status, "output": text,
                                            "previous_response_id": parent}
        self.handler.msg_store[key] = [{"role": "user", "content": text}]

    async def test_ttl_removes_response_and_history(self):
        self.put("resp_a")
        await self.controller.prune()
        self.now = 3599
        await self.controller.prune()
        self.assertIn("resp_a", self.handler.response_store)
        self.now = 3600
        await self.controller.prune()
        self.assertEqual(self.handler.response_store, {})
        self.assertEqual(self.handler.msg_store, {})

    async def test_count_evicts_oldest_completed(self):
        for index in range(3):
            self.now = index
            self.put(f"resp_{index}")
            await self.controller.prune()
        self.assertEqual(set(self.handler.response_store), {"resp_1", "resp_2"})
        self.assertEqual(set(self.handler.msg_store), {"resp_1", "resp_2"})

    async def test_byte_budget_includes_history_and_utf8(self):
        self.controller.limits = Limits(max_bytes=2000)
        self.put("resp_big", text="small")
        self.handler.msg_store["resp_big"] = [{"content": "界" * 800}]
        self.put("resp_small")
        await self.controller.prune()
        self.assertEqual(set(self.handler.response_store), {"resp_small"})
        self.assertEqual(set(self.handler.msg_store), {"resp_small"})

    async def test_active_chain_protects_parents_until_finished(self):
        self.put("resp_grandparent")
        self.put("resp_parent", parent="resp_grandparent")
        await self.controller.prune()
        lease = await self.controller.admit()
        self.assertTrue(await self.controller.bind(lease, "resp_child", "resp_parent"))
        self.handler.msg_store["resp_child"] = [{"content": "unfinished"}]
        self.handler.msg_store["resp_orphan"] = [{"content": "orphan"}]
        self.now = 7200
        await self.controller.prune()
        self.assertEqual(set(self.handler.msg_store), {"resp_child", "resp_parent", "resp_grandparent"})
        await self.controller.finish_http(lease)
        self.assertEqual(self.handler.msg_store, {})
        self.assertEqual(self.handler.response_store, {})

    async def test_active_completion_is_retained_only_after_http_finishes(self):
        self.controller.limits = Limits(max_bytes=250)
        lease = await self.controller.admit()
        await self.controller.bind(lease, "resp_active", None)
        self.put("resp_active", "x" * 1000)
        await self.controller.prune()
        self.assertIn("resp_active", self.handler.response_store)
        await self.controller.finish_http(lease)
        self.assertNotIn("resp_active", self.handler.response_store)
        self.assertNotIn("resp_active", self.handler.msg_store)

    async def test_background_owns_admission_after_http_returns(self):
        self.controller.limits = Limits(max_active=1)
        lease = await self.controller.admit()
        await self.controller.bind(lease, "resp_bg", None)
        done = asyncio.Event()
        task = asyncio.create_task(done.wait())
        self.handler.background_tasks["resp_bg"] = task
        self.put("resp_bg", status="in_progress")
        await self.controller.finish_http(lease)
        self.assertIsNone(await self.controller.admit())
        self.assertIn("resp_bg", self.handler.response_store)
        done.set()
        await task
        self.put("resp_bg")
        await self.controller._finish(lease)
        self.assertIsNotNone(await self.controller.admit())
        await self.controller.close()

    async def test_duplicate_active_or_retained_request_id_rejected(self):
        self.put("resp_existing")
        first = await self.controller.admit()
        second = await self.controller.admit()
        self.assertFalse(await self.controller.bind(first, "resp_existing", None))
        self.assertTrue(await self.controller.bind(first, "resp_new", None))
        self.assertFalse(await self.controller.bind(second, "resp_new", None))

    async def test_handler_wrapper_binds_validated_metadata_and_background_handoff(self):
        done = asyncio.Event()

        async def native_create(request, raw_request):
            lease = raw_request.scope[LEASE_KEY]
            self.assertEqual(lease.request_id, request.request_id)
            self.assertEqual(lease.parent_id, "resp_parent")
            self.handler.msg_store[request.request_id] = [{"content": "active history"}]
            task = asyncio.create_task(done.wait())
            self.handler.background_tasks[request.request_id] = task
            return {"id": request.request_id, "status": "queued"}

        self.handler.create_responses = native_create
        self.handler.create_error_response = lambda message, status_code: {"status": status_code}
        await self.controller.start()
        lease = await self.controller.admit()
        request = SimpleNamespace(request_id="resp_new", previous_response_id="resp_parent")
        raw_request = SimpleNamespace(scope={LEASE_KEY: lease})
        result = await self.handler.create_responses(request, raw_request)
        self.assertEqual(result["id"], "resp_new")
        await self.controller.finish_http(lease)
        self.assertEqual(len(self.controller.active), 1)
        self.assertIn("resp_new", self.handler.msg_store)
        done.set()
        await lease.background_task
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(len(self.controller.active), 0)
        self.assertNotIn("resp_new", self.handler.msg_store)
        await self.controller.close()
        self.assertIs(self.handler.create_responses, native_create)

    async def test_inactive_nonterminal_and_history_are_cleaned_together(self):
        self.put("resp_abandoned", status="in_progress")
        await self.controller.prune()
        self.assertEqual(self.handler.response_store, {})
        self.assertEqual(self.handler.msg_store, {})

    async def test_asgi_capacity_rejection_does_not_read_body(self):
        self.controller.limits = Limits(max_active=1)
        await self.controller.admit()
        called = []

        async def downstream(*args):
            self.fail("Rejected request reached application")

        async def receive():
            self.fail("Rejected request body was read")

        async def send(event):
            called.append(event)

        scope = {"type": "http", "method": "POST", "path": "/v1/responses",
                 "app": SimpleNamespace(state=SimpleNamespace(bounded_responses=self.controller))}
        await ResponsesAdmissionMiddleware(downstream)(scope, receive, send)
        self.assertEqual(called[0]["status"], 429)
        self.assertEqual(json.loads(called[1]["body"])["error"]["code"], 429)

    async def test_asgi_stream_forwards_events_and_releases_on_error(self):
        outgoing = []
        body_event = {"type": "http.request", "body": b'{"input":"hello"}', "more_body": False}

        async def receive():
            return body_event

        async def send(event):
            outgoing.append(event)

        async def downstream(scope, passed_receive, passed_send):
            self.assertIn(LEASE_KEY, scope)
            self.assertIs(await passed_receive(), body_event)
            await passed_send({"type": "http.response.body", "body": b"data: token\n\n", "more_body": True})
            raise RuntimeError("disconnected")

        scope = {"type": "http", "method": "POST", "path": "/v1/responses",
                 "app": SimpleNamespace(state=SimpleNamespace(bounded_responses=self.controller))}
        with self.assertRaisesRegex(RuntimeError, "disconnected"):
            await ResponsesAdmissionMiddleware(downstream)(scope, receive, send)
        self.assertEqual(outgoing[0]["body"], b"data: token\n\n")
        self.assertEqual(len(self.controller.active), 0)


if __name__ == "__main__":
    unittest.main()
