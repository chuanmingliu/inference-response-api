> **Legacy native mode only.** This guide describes the old `RESPONSES_MODE=native` SGLang pass-through. The default Compose deployment now uses the [service-owned Core API](RESPONSES-CORE.md), requires `store:false`, and rejects retained responses/background jobs. The historical checks below do not certify the new Core service.

# Full context and practical Responses features

The three Qwen3 services use a **32,768-token context window**. Service C provides SGLang's native Responses API with stored continuation, retrieval, background execution, cancellation, streaming, structured JSON, function calling, and prefix-cache accounting. The local gateway adds precise route validation and rejects known cloud features that this deployment cannot implement.

Open [the main playground](http://localhost:8088/) and select **C · SGLang MLX**, or use [Service C directly](http://localhost:8090/). Its API base is `http://localhost:8090/v1`, and its model ID is `mlx-community/Qwen3-0.6B-4bit`.

Read this guide in the running panel at [http://localhost:8088/docs/features](http://localhost:8088/docs/features).

## Context window

The [official Qwen3-0.6B model card](https://huggingface.co/Qwen/Qwen3-0.6B) documents a 32,768-token context. The model bundle's `max_position_embeddings: 40960` configuration value is not the documented model context window. This deployment uses 32,768 without adding RoPE scaling or claiming extended-context quality.

The limit covers the rendered prompt, previous conversation turns, tool definitions/results, and generated tokens together. For example, reserving 2,048 output tokens leaves approximately 30,720 tokens for rendered input, including chat-template overhead. `previous_response_id` saves resending history over HTTP; the history still occupies model context.

| Service | Engine | Context | Engine prefix reuse | Responses implementation |
| --- | --- | ---: | --- | --- |
| A · Docker Model Runner | Bundled vLLM Metal 0.1.0 in the recorded check | 32,768 | No reuse in the recorded older runtime | Project text/streaming adapter |
| B · Native vLLM Metal | vLLM Metal 0.32.0 | 32,768 | Paged prefix cache | Native |
| C · SGLang MLX | SGLang 0.5.22 / MLX 0.32.2 | 32,768 | SGLang radix cache | Native, with project retention bounds |

Service C's 65,536-token KV pool is aggregate cache capacity, not a larger request context. Its engine executes one request at a time; admitted requests can wait in the scheduler. Service B also uses one active inference sequence. Increasing the context and cache allocation increases memory use even though the model weights are small.

The capacity check sends an input close to the window limit and separately checks that an oversized input returns HTTP 400. Successful capacity checks do not establish useful long-context recall or answer quality. This 0.6B quantized model remains a small testing model; the verification records preserve its actual output, including any empty output after EOS.

### Verified capacity and prefix reuse

The complete [`context-cache-verification.json`](context-cache-verification.json) record, timestamped **22 October 2026 at 22:13:36 China Standard Time**, contains all three services. Each accepted **32,753 input tokens**, returned HTTP 200 with one completion token, and stopped with **empty visible text after EOS**. Each oversized-input probe returned HTTP 400. This demonstrates that the configured window is usable by the engines; it does not demonstrate that the model answered the long prompt.

The same run sent two requests with a shared roughly 2,100-token prefix and different final instructions:

| Service | First request: cached / input | Second request: cached / input | First / second elapsed time |
| --- | ---: | ---: | ---: |
| A · Docker | 0 / 2,094 | 0 / 2,094 | 0.340 / 0.311 s |
| B · Native vLLM | 0 / 2,100 | 2,080 / 2,100 | 0.300 / 0.070 s |
| C · SGLang | 3 / 2,101 | 2,090 / 2,101 | 3.583 / 0.145 s |

The cached-token counters verify prefix reuse in B and C. These single sequential pairs are integration checks, **not a performance benchmark**: they have no repeated timing distribution or control for all warmup effects, and their tokenization counts differ slightly. They should not be used to rank engine throughput or answer quality.

**Separate visible-answer check:** [`long-context-answer-verification.json`](long-context-answer-verification.json), recorded at **22:19:45 China Standard Time**, contains the same deterministic varied reference sent sequentially to all three services. Each processed **32,598 input tokens**, generated **4 completion tokens**, and returned exactly **`Cedar Lantern`**. The expected answer was explicitly supplied **28 tokens before the end of the input text**, before chat-template rendering. This confirms usable visible output with a nearly full window for this prompt; it does not test long-range retrieval or establish general answer quality. The reproducible script is [`scripts/check-long-context-answer.py`](../scripts/check-long-context-answer.py).

## Capability matrix

This table describes the configured public gateways, not everything an upstream project might support in another deployment. “Not enabled” for B means this project does not expose or claim that feature through B's current gateway.

| Feature | A · Docker | B · Native vLLM | C · SGLang |
| --- | --- | --- | --- |
| Chat Completions JSON and streaming | Yes | Yes | Yes |
| Responses JSON and streaming | Text adapter | Native | Native |
| Stateless full-history Responses | Yes | Yes | Yes |
| `store: true` and `previous_response_id` | No | Not enabled | Yes, bounded process memory |
| Retrieve a stored response | No | Not enabled | Yes |
| Background execution and polling | No | Not enabled | Yes |
| Cancel a background response | No | Not enabled | Yes |
| Cached input-token usage | No reuse in this runtime | Yes | Yes |
| `prompt_cache_key` namespace mapping | No | Not added | Yes, gateway maps to `cache_salt` |
| Responses JSON-schema output | No | Not verified here | Verified native support |
| Responses function-call/result round trip | No | Not verified here | Verified native support |
| Delete response / list input items | No | Not exposed | Not exposed |
| Durable cloud conversation objects | No | No | No |
| Hosted web search, files, code interpreter, MCP | No | Not configured | Rejected |

Read `/api/config` for machine-readable `context_length` and `responses_capabilities`. Through the main panel, use `/compare/sglang/api/config` for Service C. These are configuration declarations; `/api/status` checks model-catalog readiness, while a generation request verifies inference.

## Client setup and endpoints

The examples below use the installed OpenAI Python client. Run them with `.runtime/native-venv/bin/python` from `/Users/chuanmingliu/responsible-api`; this client environment sends HTTP and does not choose the inference engine.

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8090/v1",
    api_key="local",  # SDK placeholder for this loopback-only deployment
    timeout=120,
)
model = "mlx-community/Qwen3-0.6B-4bit"
```

The same examples work with `base_url="http://localhost:8088/compare/sglang/v1"`.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/v1/responses` | Create a response, stream, or start background work |
| `GET` | `/v1/responses/{response_id}` | Retrieve a stored response |
| `POST` | `/v1/responses/{response_id}/cancel` | Cancel ongoing background work |
| `POST` | `/v1/chat/completions` | Chat Completions API |
| `GET` | `/v1/models` | Model catalog |

Response IDs are opaque `resp_...` identifiers. Cancellation accepts an empty body, matching the SDK. Retrieval and cancellation accept no query options: stream resumption, event cursors, and output filtering are not implemented. Unlisted subresources are blocked rather than forwarded to arbitrary engine routes.

## Stateless text and streaming

Explicitly choose `store=False` when the application retains its own history. A stateless response cannot subsequently be retrieved or used as a stored parent.

```python
reply = client.responses.create(
    model=model,
    input="Explain prefix caching in one sentence.",
    max_output_tokens=128,
    temperature=0,
    store=False,
)
print(reply.output_text)

with client.responses.stream(
    model=model,
    input="Name three uses of a local inference service.",
    max_output_tokens=128,
    store=False,
) as stream:
    for event in stream:
        if event.type == "response.output_text.delta":
            print(event.delta, end="", flush=True)
    final = stream.get_final_response()
print("\n", final.status, final.usage)
```

When using full-history mode, send prior input/output items again. Streaming cancellation by closing the connection is separate from cancelling a detached background response by ID.

## Stored conversation and retrieval

The request shape follows OpenAI's [conversation-state guide](https://developers.openai.com/api/docs/guides/conversation-state): create a stored response, then supply its ID with the next input.

```python
first = client.responses.create(
    model=model,
    input="Our project label is ORCHID. Acknowledge it.",
    max_output_tokens=64,
    store=True,
    metadata={"example": "stored-conversation"},
)
saved = client.responses.retrieve(first.id)
print(saved.id, saved.output_text, saved.metadata)

second = client.responses.create(
    model=model,
    previous_response_id=first.id,
    input="What is our project label?",
    max_output_tokens=64,
    store=True,
)
print(second.output_text)
```

Retain the latest returned response ID for the next turn. Repeating the entire conversation while also setting `previous_response_id` duplicates context. Supply any per-turn instructions explicitly. After a restart or eviction, an old ID can return 404; start a new response with the full history retained by your application.

SGLang's native store is enabled with `--enable-response-store`. The project launcher, [`scripts/sglang_server.py`](../scripts/sglang_server.py), attaches [`scripts/response_store.py`](../scripts/response_store.py) to bound its retention without replacing native response generation:

| Bound | Configured value |
| --- | --- |
| Terminal-record lifetime | 1 hour after completion is first observed |
| Retained completed/terminal records | 128 |
| Retained serialized response plus history payload | 64 MiB |
| Admitted active Responses requests | 8 |
| Periodic cleanup | Every 30 seconds, plus request lifecycle cleanup |

The wrapper evicts older eligible records sooner when count or byte limits are reached. Active responses and parents needed by an active continuation are protected, so temporary protected data can exceed retention targets. The 64 MiB bound measures retained serialized payloads; it is not a Python process RSS limit, a GPU-memory limit, or a KV-cache limit. Admission limits include work waiting for the single inference slot; excess active work receives an error instead of entering an unlimited application queue.

State lives only in the engine process. Restarting the engine loses all response IDs and histories. Reads do not promise a fresh one-hour lease. This is local working memory with bounded retention, not durable cloud storage.

## Background execution and cancellation

Use `background=True`, `store=True`, and `stream=False` for detached work. Poll until the status is no longer `queued` or `in_progress`, as described by OpenAI's [background-mode guide](https://developers.openai.com/api/docs/guides/background).

```python
import time

job = client.responses.create(
    model=model,
    input="Write a short checklist for testing a local API.",
    max_output_tokens=256,
    background=True,
    store=True,
    stream=False,
)
deadline = time.monotonic() + 60
while job.status in ("queued", "in_progress"):
    if time.monotonic() >= deadline:
        job = client.responses.cancel(job.id)
        break
    time.sleep(0.2)
    job = client.responses.retrieve(job.id)
print(job.status, job.output_text)
```

To cancel a known job immediately:

```python
cancelled = client.responses.cancel(job.id)
print(cancelled.status)
```

If the job already completed, native cancellation returns its terminal response; cancellation cannot undo completed work. Repeated cancellation is harmless. `background=True` with `store=False` is invalid. SGLang's combined background-and-stream mode remains tied to the active connection, so this deployment's playground uses detached polling or ordinary streaming separately. It does not claim OpenAI's reconnectable background event stream.

## Automatic prefix caching

Put stable instructions, reusable reference text, and unchanged tool definitions before changing user text. Cache reuse depends on a matching rendered token prefix; similar meaning is insufficient. OpenAI's [prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) explains this general usage pattern. Service C implements reuse with SGLang's local radix cache and MLX KV storage.

```python
reference = "Reusable reference: " + "alpha beta gamma delta " * 512

for instruction in ("Reply with ready.", "Reply with done."):
    reply = client.responses.create(
        model=model,
        input=reference + "\n" + instruction,
        prompt_cache_key="demo-reference-v1",
        max_output_tokens=32,
        temperature=0,
        store=False,
    )
    details = reply.usage.input_tokens_details
    print({
        "input_tokens": reply.usage.input_tokens,
        "cached_tokens": details.cached_tokens if details else 0,
        "output_tokens": reply.usage.output_tokens,
    })
```

The gateway translates `prompt_cache_key` into SGLang's native `cache_salt`. It selects a local cache namespace, not an OpenAI cloud routing policy. The key must be a nonempty string of at most 256 characters; a simultaneously supplied `cache_salt` must match. Keeping the same key permits matching prefixes to share cache entries; changing it isolates their cache matching. This is not an authentication or tenant-authorization mechanism.

`usage.input_tokens_details.cached_tokens` reports reused input tokens for Responses. Chat Completions uses `usage.prompt_tokens_details.cached_tokens`. A missing detail field means no reported reuse; do not manufacture a hit count. Cache hits reduce repeated prefill work, but output tokens still require generation.

Prefix KV caching and stored conversation history are separate. `store=False` prevents response/history retention but does not disable prefix reuse. A cache hit does not make a response retrievable. The response-store TTL does not specify KV-cache retention. GPU-cache entries may be evicted under capacity pressure or lost on engine restart; this deployment offers no configurable OpenAI-style cache TTL or explicit breakpoints.

## Structured JSON

Use the Responses `text.format` schema shape from OpenAI's [structured-outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs). The native SGLang path has been exercised with a strict schema containing required properties, an enum, and `additionalProperties: False`.

```python
import json

schema = {
    "type": "object",
    "properties": {
        "city": {"type": "string", "enum": ["Paris"]},
        "ready": {"type": "boolean"},
    },
    "required": ["city", "ready"],
    "additionalProperties": False,
}
reply = client.responses.create(
    model=model,
    input="Return city Paris and ready true.",
    text={"format": {
        "type": "json_schema", "name": "readiness",
        "strict": True, "schema": schema,
    }},
    max_output_tokens=128,
    store=False,
)
if reply.status != "completed":
    raise RuntimeError(f"Generation did not complete: {reply.status}")
result = json.loads(reply.output_text)
print(result)
```

Schema-constrained syntax does not prove the values are factually correct. Validate application inputs/outputs and handle incomplete generation, including an exhausted output-token budget. Arbitrary JSON Schema dialects and all OpenAI schema features have not been exhaustively tested.

## Function calling and tool results

The model proposes a tool call; the client executes the selected function and submits the result using the matching `call_id`. This follows OpenAI's [function-calling flow](https://developers.openai.com/api/docs/guides/function-calling). The example uses a fixed local lookup, with no external actions.

```python
import json

tools = [{
    "type": "function",
    "name": "get_test_value",
    "description": "Read a local test value.",
    "parameters": {
        "type": "object",
        "properties": {"key": {"type": "string", "enum": ["sample"]}},
        "required": ["key"],
        "additionalProperties": False,
    },
    "strict": True,
}]
requested = client.responses.create(
    model=model,
    input="Call get_test_value for sample.",
    tools=tools,
    tool_choice="required",
    max_output_tokens=128,
    store=True,
)
call = next(item for item in requested.output if item.type == "function_call")
arguments = json.loads(call.arguments)
if call.name != "get_test_value" or arguments != {"key": "sample"}:
    raise ValueError("Unexpected tool request")

continued = client.responses.create(
    model=model,
    previous_response_id=requested.id,
    input=[{
        "type": "function_call_output",
        "call_id": call.call_id,
        "output": json.dumps({"value": 42}),
    }],
    tools=tools,
    tool_choice="none",
    max_output_tokens=128,
    store=True,
)
print(continued.output_text)
```

The native smoke test exercised this round trip. Applications should handle zero or multiple returned calls, validate each name and argument object, and execute only their own registered functions. The gateway allows native custom-tool declarations, but the verified contract here covers function tools; custom-tool formats are not independently certified by these checks.

## Explicit compatibility limits

Known unsupported controls return HTTP 400 at Service C's gateway instead of being silently accepted:

| Request option | Local behavior / alternative |
| --- | --- |
| `prompt_cache_retention`, `prompt_cache_options` | No cloud cache TTL or retention-policy implementation |
| `prompt_cache_breakpoint`, `cache_control` | Explicit request/message/content/tool cache breakpoints rejected; reuse is automatic |
| Hosted web/file/code/computer/MCP tools | Rejected; use client-executed functions |
| Cloud `service_tier` values | Only `auto` and `default` are accepted; no paid priority/flex infrastructure |
| `safety_identifier` | Rejected; no OpenAI account-level safety-monitoring service |
| `text.verbosity` | Request the desired detail in instructions |
| Non-`none` `reasoning.effort` | Qwen3 does not implement OpenAI effort tiers; use the native thinking toggle |
| `truncation: "auto"` | Rejected; manage history within 32,768 tokens; `disabled` is valid |
| Non-null `max_tool_calls` | Native SGLang does not enforce this hosted-tool execution limit |
| Nonzero frequency/presence penalties, non-default repetition penalty | This pinned MLX sampler does not apply these penalties |

The default template disables thinking for quick testing. `reasoning={"effort": "none"}` is accepted. To use Qwen3's native thinking toggle with the Python client, pass `extra_body={"chat_template_kwargs": {"enable_thinking": True}}`; this does not create OpenAI effort tiers and consumes the same output/context budget.

This is a text model. Images, audio, hosted files, durable Conversations resources, webhooks, stream resumption, delete-response, and input-items listing are not part of this deployed contract. These restrictions concern the local gateway; direct requests to the engine can have different validation behavior. Unknown parameters are not universally checked for full OpenAI parity, so use the documented feature set and verification scripts rather than assuming every OpenAI field has equivalent semantics.

## Verification and operation

Native spot checks exercised strict JSON output, a function-call/result continuation, stored retrieval, background completion, and cancellation. The repeatable final records below are the source of truth for their timestamp, endpoint, actual generated text, token counts, and completion status. They are integration evidence, not a performance benchmark or a model-quality evaluation.

The public Service C gateway passed **all 11 live feature checks** using OpenAI Python SDK **3.36.1** on **22 October 2026 at 22:17:09 China Standard Time**, with the bounded store wrapper active. The [full record](responses-feature-verification.json) confirms JSON and streaming responses, non-retention with `store=False`, metadata retrieval and continuation recalling `ORCHID`, structured JSON, a function result correctly incorporating `42`, background completion/cancellation, admission limits, and explicit errors for unsupported cloud options.

The same-key Responses cache probe reused **3,114 of 3,124 input tokens** on its second request; changing the key yielded **zero cached tokens**. The admission test accepted eight active background jobs, rejected the ninth with HTTP 429, and cancelled the admitted jobs during cleanup. This verifies the configured control paths and cache namespace behavior; the timings are not a comparative benchmark. The supporting automated suite also passed **35 Node tests and 11 Python store tests** at this verification stage.

The [full-context service-status snapshot](service-status-full-context.json), recorded at **22:21:51 China Standard Time**, reports all three gateways healthy and model catalogs ready, with 32,768-token configuration. Readiness is a catalog check; the generation records above provide separate inference evidence.

The main-panel UI was also exercised through its SGLang comparison proxy: a stored conversation recalled `ORCHID`, the continuation sent only the new input plus `previous_response_id`, and its usage displayed **23 cached tokens out of 69 input tokens**. Starting background work and pressing **Stop** produced a response that the native retrieval endpoint reported as `cancelled`. The [playground screenshot](responses-features-playground.png) shows the completed feature panel; the manual check supplements the SDK tests.

```bash
cd /Users/chuanmingliu/responsible-api

# Native feature contract through Service C's public gateway.
.runtime/native-venv/bin/python scripts/check-responses-features.py

# Repeat through the main panel's fixed comparison proxy if needed.
.runtime/native-venv/bin/python scripts/check-responses-features.py \
  --base-url http://127.0.0.1:8088/compare/sglang/v1 \
  --output docs/responses-feature-verification-proxy.json

# Sequential capacity, overflow, and cache-accounting checks for A/B/C.
.runtime/native-venv/bin/python scripts/check-context-cache.py

# Varied reference near the full window, with the answer explicitly near the end.
.runtime/native-venv/bin/python scripts/check-long-context-answer.py

# Current service state and gateway checks.
bash scripts/status.sh
API_BASE_URL=http://127.0.0.1:8090 node scripts/smoke.mjs
npm test
```

| Record | What to inspect |
| --- | --- |
| [`responses-feature-verification.json`](responses-feature-verification.json) | Responses JSON/SSE, stateless non-retention, stored continuation, key-isolated cache reuse, JSON schema, functions, background completion/cancellation, and unsupported-option errors |
| [`context-cache-verification.json`](context-cache-verification.json) | Actual prompt counts near the 32,768 boundary, overflow HTTP status, generated text, and paired cache usage for each service |
| [`long-context-answer-verification.json`](long-context-answer-verification.json) | Varied-reference prompt provenance, answer placement, and each service's visible output near the full window |
| [`service-status-full-context.json`](service-status-full-context.json) | All three gateways' health, model-catalog readiness, and configured full context |
| [`service-status-sglang.json`](service-status-sglang.json) | Timestamped baseline API smoke checks |

The scripts write progress records as checks pass and exit nonzero on a failed assertion. A partial JSON file is not proof that the whole suite passed; check that all expected feature checks and all three requested service records are present. The existing historical A/B benchmark predates this expanded context configuration and is not a three-engine benchmark of the new settings.

Use `python3 scripts/sglang-service.py status`, `restart`, or `stop` to manage C's engine. A restart invalidates retained response IDs and cache entries. Full installation and lifecycle details remain in [`SGLANG.md`](SGLANG.md); this document defines the expanded context and Responses feature contract.
