"""Bound SGLang's native in-memory Responses store without buffering HTTP bodies.

Limits cover retained serialized payloads, not Python RSS or active generation.
Terminal records expire one hour after completion is first observed. Active
responses and parents needed by an active chain are never evicted mid-request.
"""

import asyncio
from contextlib import suppress
from dataclasses import dataclass
import json
import logging
import time

logger = logging.getLogger(__name__)
LEASE_KEY = "responsible_api.responses_lease"
TERMINAL = frozenset({"completed", "incomplete", "failed", "cancelled"})


@dataclass(frozen=True)
class Limits:
    ttl_seconds: float = 3600
    max_records: int = 128
    max_bytes: int = 64 * 1024 * 1024
    max_active: int = 8
    sweep_seconds: float = 30

    def __post_init__(self):
        if min(self.ttl_seconds, self.max_records, self.max_bytes,
               self.max_active, self.sweep_seconds) <= 0:
            raise ValueError("Responses store limits must be positive")


@dataclass(eq=False)
class Lease:
    request_id: str | None = None
    parent_id: str | None = None
    http_done: bool = False
    background_task: asyncio.Task | None = None


def value(record, key, default=None):
    return record.get(key, default) if isinstance(record, dict) else getattr(record, key, default)


def json_default(record):
    if hasattr(record, "model_dump"):
        return record.model_dump(mode="json")
    if hasattr(record, "to_dict"):
        return record.to_dict()
    raise TypeError(f"Cannot measure retained {type(record).__name__}")


class BoundedResponseStore:
    def __init__(self, handler, limits=Limits(), clock=time.monotonic):
        self.handler = handler
        self.limits = limits
        self.clock = clock
        self.active = set()
        self.completed_at = {}
        self.size_cache = {}
        self.sweeper = None
        self.cleanup_tasks = set()
        self.closed = False
        self.original_create = None

    def _own_active_ids(self):
        ids = {lease.request_id for lease in self.active if lease.request_id}
        ids.update(key for key, task in self.handler.background_tasks.items() if not task.done())
        return ids

    def _protected_ids(self):
        protected = self._own_active_ids()
        pending = [lease.parent_id for lease in self.active if lease.parent_id]
        # Protect the chain as well as its immediate parent. This also handles
        # native background work still present during an HTTP-task handoff.
        pending.extend(value(self.handler.response_store.get(key), "previous_response_id")
                       for key in protected)
        while pending:
            key = pending.pop()
            if key and key not in protected:
                protected.add(key)
                pending.append(value(self.handler.response_store.get(key), "previous_response_id"))
        return protected

    def _remove(self, key):
        self.handler.response_store.pop(key, None)
        self.handler.msg_store.pop(key, None)
        self.completed_at.pop(key, None)
        self.size_cache.pop(key, None)

    def _size(self, key, response):
        messages = self.handler.msg_store.get(key)
        signature = (id(response), id(messages), value(response, "status"))
        cached = self.size_cache.get(key)
        if cached and cached[0] == signature:
            return cached[1]
        size = 0
        try:
            encoder = json.JSONEncoder(default=json_default, ensure_ascii=False,
                                       separators=(",", ":"))
            for chunk in encoder.iterencode({"response": response, "messages": messages}):
                size += len(chunk.encode("utf-8"))
                if size > self.limits.max_bytes:
                    break
        except (TypeError, ValueError, OverflowError):
            # An unmeasurable item cannot safely count as zero retained bytes.
            logger.warning("Evicting an unserializable Responses record")
            size = self.limits.max_bytes + 1
        self.size_cache[key] = (signature, size)
        return size

    def _prune_locked(self):
        now = self.clock()
        protected = self._protected_ids()
        own_active = self._own_active_ids()
        retained = []
        for key, response in list(self.handler.response_store.items()):
            terminal = value(response, "status") in TERMINAL
            if not terminal:
                if key not in protected:
                    self._remove(key)
                continue
            completed = self.completed_at.setdefault(key, now)
            if key not in protected and now - completed >= self.limits.ttl_seconds:
                self._remove(key)
            elif key not in own_active:
                retained.append((completed, key, self._size(key, response)))

        total = sum(item[2] for item in retained)
        count = len(retained)
        for _, key, size in sorted(retained):
            if count <= self.limits.max_records and total <= self.limits.max_bytes:
                break
            if key in protected:
                continue
            self._remove(key)
            count -= 1
            total -= size

        # Native SGLang writes input history before it writes a response. Only
        # remove unmatched histories when no active creator/background owns it.
        for key in list(self.handler.msg_store):
            if key not in self.handler.response_store and key not in protected:
                self.handler.msg_store.pop(key, None)
        for key in list(self.completed_at):
            if key not in self.handler.response_store:
                self.completed_at.pop(key, None)
                self.size_cache.pop(key, None)

    async def prune(self):
        async with self.handler.response_store_lock:
            self._prune_locked()

    async def admit(self):
        async with self.handler.response_store_lock:
            self._prune_locked()
            if len(self.active) >= self.limits.max_active:
                return None
            lease = Lease()
            self.active.add(lease)
            return lease

    async def bind(self, lease, request_id, parent_id):
        async with self.handler.response_store_lock:
            if request_id in self.handler.response_store or any(
                other is not lease and other.request_id == request_id for other in self.active
            ):
                return False
            lease.request_id = request_id
            lease.parent_id = parent_id
            return True

    def attach_background(self, lease):
        task = self.handler.background_tasks.get(lease.request_id)
        if task is not None and lease.background_task is None:
            lease.background_task = task
            task.add_done_callback(lambda _: self._schedule_cleanup(lease))

    def _schedule_cleanup(self, lease):
        if self.closed:
            return
        task = asyncio.create_task(self._finish(lease))
        self.cleanup_tasks.add(task)
        task.add_done_callback(self.cleanup_tasks.discard)

    async def _finish(self, lease, http_done=False):
        async with self.handler.response_store_lock:
            lease.http_done |= http_done
            if lease.http_done and (lease.background_task is None or lease.background_task.done()):
                self.active.discard(lease)
            self._prune_locked()

    async def finish_http(self, lease):
        # Capture the background handoff even if native create raises after it
        # scheduled a task. Keep the lease until both task and HTTP are finished.
        self.attach_background(lease)
        await self._finish(lease, http_done=True)

    def wrap_handler(self):
        self.original_create = self.handler.create_responses

        async def create(request, raw_request=None):
            lease = raw_request.scope.get(LEASE_KEY) if raw_request is not None else None
            if lease is None or lease not in self.active:
                return self.handler.create_error_response(
                    "Responses admission control is unavailable.", status_code=503)
            if not await self.bind(lease, request.request_id, request.previous_response_id):
                return self.handler.create_error_response(
                    "The response request_id is already in use.", status_code=409)
            try:
                return await self.original_create(request, raw_request)
            finally:
                self.attach_background(lease)

        self.handler.create_responses = create

    async def start(self):
        self.wrap_handler()
        await self.prune()

        async def sweep():
            while True:
                await asyncio.sleep(self.limits.sweep_seconds)
                await self.prune()

        self.sweeper = asyncio.create_task(sweep(), name="responses-store-retention")

    async def close(self):
        self.closed = True
        if self.sweeper:
            self.sweeper.cancel()
            with suppress(asyncio.CancelledError):
                await self.sweeper
        if self.cleanup_tasks:
            await asyncio.gather(*self.cleanup_tasks)
        if self.original_create:
            self.handler.create_responses = self.original_create


async def send_error(send, status, message):
    body = json.dumps({"error": {"message": message, "type": "rate_limit_error"
                       if status == 429 else "server_error", "code": status}}).encode()
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
    if status == 429:
        headers.append((b"retry-after", b"1"))
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


class ResponsesAdmissionMiddleware:
    """Reserve before body parsing; forward receive/send unchanged, including SSE."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/v1/responses"):
            return await self.app(scope, receive, send)
        controller = getattr(scope["app"].state, "bounded_responses", None)
        if controller is None:
            return await send_error(send, 503, "Responses storage is not ready.")
        if scope.get("method") != "POST" or scope["path"].rstrip("/") != "/v1/responses":
            await controller.prune()
            return await self.app(scope, receive, send)
        lease = await controller.admit()
        if lease is None:
            return await send_error(send, 429,
                                    f"At most {controller.limits.max_active} active Responses requests/background jobs are allowed.")
        scope[LEASE_KEY] = lease
        try:
            await self.app(scope, receive, send)
        finally:
            await asyncio.shield(controller.finish_http(lease))
