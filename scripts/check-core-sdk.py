#!/usr/bin/env python3
"""Exercise the pinned official Python SDK against a local Core gateway.

API_BASE_URL=http://127.0.0.1:8089/v1 API_MODEL=... \
  .runtime/native-venv/bin/python scripts/check-core-sdk.py --websocket

The script never selects a hosted API. SDK helper results are also checked against
canonical Items, tool correlation, stream deltas, and terminal status. Passing
these workflows is evidence for this gateway/runtime, not full API conformance.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import openai
from openai import OpenAI
from pydantic import BaseModel, ConfigDict


class CityAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    city: Literal["Paris"]


def canonical_text(response):
    return "".join(
        part.text
        for item in response.output
        if item.type == "message"
        for part in item.content
        if part.type == "output_text"
    )


def assert_completed(response, *, text=True):
    assert response.status == "completed", f"status={response.status}, error={response.error}, incomplete={response.incomplete_details}"
    assert response.object == "response"
    assert response.id.startswith("resp_")
    assert response.store is False
    assert response.error is None
    assert response.incomplete_details is None
    ids = [item.id for item in response.output]
    assert len(ids) == len(set(ids)), "duplicate output Item IDs"
    if text:
        assert canonical_text(response).strip(), "empty canonical text"
        assert response.output_text == canonical_text(response), "SDK output_text disagrees with canonical Items"
    assert response.usage is not None, "missing actual backend usage"
    assert response.usage.input_tokens >= 0
    assert response.usage.output_tokens >= 0
    assert response.usage.total_tokens == response.usage.input_tokens + response.usage.output_tokens


@contextmanager
def deadline(seconds):
    """Bound synchronous socket reads as well as HTTP requests on macOS/Linux."""
    if not hasattr(signal, "SIGALRM"):
        yield
        return
    previous = signal.getsignal(signal.SIGALRM)

    def expired(_signum, _frame):
        raise TimeoutError(f"SDK check exceeded {seconds} seconds")

    signal.signal(signal.SIGALRM, expired)
    signal.alarm(seconds)
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


def check_json(client, common):
    response = client.responses.create(**common, input="Reply with the single word ready.")
    assert_completed(response)
    return {"response_id": response.id, "status": response.status, "output_text": response.output_text}


def check_stream(client, common):
    events, deltas = [], []
    with client.responses.stream(**common, input="Say hello in one short sentence.") as stream:
        for event in stream:
            events.append(event)
            if event.type == "response.output_text.delta":
                deltas.append(event.delta)
        response = stream.get_final_response()
    assert_completed(response)
    assert "".join(deltas) == response.output_text, "stream deltas disagree with SDK final response"
    terminal = [event.type for event in events if event.type in ("response.completed", "response.failed", "response.incomplete")]
    assert terminal == ["response.completed"], f"terminal events={terminal}"
    wire = [event for event in events if hasattr(event, "sequence_number")]
    assert [event.sequence_number for event in wire] == list(range(len(wire)))
    for event in wire:
        if event.type == "response.output_text.delta":
            assert response.output[event.output_index].id == event.item_id
            # The 3.36.1 streaming helper reconstructs this event and omits
            # obfuscation; wire-level tests check padding independently.
    return {"response_id": response.id, "status": response.status, "delta_count": len(deltas)}


def check_functions(client, common):
    prompt = "Call lookup_weather with city Paris. After receiving its result, summarize the weather in one sentence."
    tool = {
        "type": "function", "name": "lookup_weather", "description": "Return weather for a city.", "strict": True,
        "parameters": {"type": "object", "properties": {"city": {"type": "string", "enum": ["Paris"]}}, "required": ["city"], "additionalProperties": False},
    }
    response = client.responses.create(**common, input=prompt, tools=[tool], tool_choice={"type": "function", "name": "lookup_weather"}, parallel_tool_calls=False)
    assert_completed(response, text=False)
    calls = [item for item in response.output if item.type == "function_call"]
    assert len(calls) == 1, f"expected one function call, got {len(calls)}"
    call = calls[0]
    assert call.id != call.call_id, "Item identity was conflated with call correlation"
    assert call.name == "lookup_weather"
    assert json.loads(call.arguments) == {"city": "Paris"}
    replay = [{"role": "user", "content": prompt}]
    replay.extend(item.model_dump(mode="json", exclude_none=True) for item in response.output)
    replay.append({"type": "function_call_output", "call_id": call.call_id, "output": '{"weather":"sunny","temperature_c":19}'})
    followup = client.responses.create(**common, input=replay, tools=[tool], tool_choice="none")
    assert_completed(followup)
    assert not any(item.type == "function_call" for item in followup.output), "tool_choice none was ignored"
    return {"response_id": response.id, "item_id": call.id, "call_id": call.call_id, "followup_id": followup.id}


def check_parse(client, common):
    response = client.responses.parse(**common, input="Return the city Paris using the requested JSON schema.", text_format=CityAnswer)
    assert_completed(response)
    assert isinstance(response.output_parsed, CityAnswer), "SDK did not create the Pydantic value"
    assert response.output_parsed.city == "Paris"
    assert json.loads(response.output_text) == {"city": "Paris"}
    return {"response_id": response.id, "parsed": response.output_parsed.model_dump()}


def receive_completed(connection):
    events, deltas = [], []
    for event in connection:
        events.append(event)
        if event.type == "error":
            raise AssertionError(f"WebSocket admission error: {event}")
        if event.type == "response.output_text.delta":
            deltas.append(event.delta)
        if event.type in ("response.completed", "response.failed", "response.incomplete"):
            assert_completed(event.response)
            assert "".join(deltas) == canonical_text(event.response)
            assert [item.sequence_number for item in events] == list(range(len(events)))
            return event.response
    raise AssertionError("WebSocket closed without a terminal Response")


def check_websocket(client, common):
    if not hasattr(client.responses, "connect"):
        raise AssertionError("This SDK version lacks the official Responses WebSocket connect API")
    with client.responses.connect(max_retries=0, websocket_connection_options={"open_timeout": 10, "close_timeout": 5}) as connection:
        connection.response.create(**common, input="Remember the word sapphire and acknowledge briefly.")
        first = receive_completed(connection)
        connection.response.create(**common, input="What word did I ask you to remember?", previous_response_id=first.id)
        second = receive_completed(connection)
        assert second.previous_response_id == first.id
        assert second.id != first.id
        assert "sapphire" in canonical_text(second).lower(), "continuation lost the preceding transcript"
    return {"first_response_id": first.id, "continued_response_id": second.id}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=os.environ.get("API_BASE_URL", "http://127.0.0.1:8089/v1"))
    parser.add_argument("--model", default=os.environ.get("API_MODEL"))
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--max-output-tokens", type=int, default=256)
    parser.add_argument("--websocket", action="store_true", help="also test the official Responses socket API and continuation")
    parser.add_argument("--report", type=Path, help="save the same JSON evidence printed to stdout")
    args = parser.parse_args()
    if urlsplit(args.base_url).path in ("", "/"):
        args.base_url = args.base_url.rstrip("/") + "/v1"
    base = urlsplit(args.base_url)
    if base.scheme not in ("http", "https") or base.hostname not in ("127.0.0.1", "localhost", "::1", "host.docker.internal") or base.username or base.password:
        parser.error("This acceptance runner only targets local gateways; provide a loopback API_BASE_URL without URL credentials.")
    if args.timeout < 1 or args.max_output_tokens < 1:
        parser.error("timeout and max-output-tokens must be positive")
    api_key = os.environ.get("API_KEY", "local")
    if args.model is None:
        config_url = f"{base.scheme}://{base.netloc}/api/config"
        with urlopen(Request(config_url, headers={"Authorization": f"Bearer {api_key}"}), timeout=10) as response:
            args.model = json.load(response)["model"]
    common = {"model": args.model, "store": False, "max_output_tokens": args.max_output_tokens}
    checks = [("json_create", check_json), ("sse_sdk_helper", check_stream), ("function_roundtrip", check_functions), ("pydantic_parse", check_parse)]
    if args.websocket:
        checks.append(("sdk_websocket_continuation", check_websocket))
    report = {"recorded_at": datetime.now(timezone.utc).isoformat(), "sdk": f"openai-python {openai.__version__}", "base_url": args.base_url, "model": args.model, "evidence": "official SDK workflows with semantic assertions; not full conformance", "checks": []}
    with OpenAI(base_url=args.base_url, api_key=api_key, timeout=args.timeout, max_retries=0) as client:
        for name, check in checks:
            started = time.monotonic()
            try:
                with deadline(args.timeout):
                    detail = check(client, common)
                result = {"name": name, "passed": True, **detail}
            except Exception as error:
                result = {"name": name, "passed": False, "error_type": type(error).__name__, "error": str(error)}
            result["duration_seconds"] = round(time.monotonic() - started, 3)
            report["checks"].append(result)
    report["passed"] = all(check["passed"] for check in report["checks"])
    encoded = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
