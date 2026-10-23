# Responses Core API

This implements the first delivery profile in the [23 October design](https://chatgpt.com/space/page_d2ab672234848191b663c82d3b17b1b7): a service-owned Responses layer over vLLM and SGLang, with transient WebSocket continuation. The full source snapshot is [responses-implementation-spec.md](responses-implementation-spec.md). The [machine-readable manifest](../config/responses-capabilities.json) and `GET /api/capabilities` describe the supported subset and evidence; this is not full OpenAI parity or production certification.

## Run

```sh
npm ci
# Native vLLM Metal; start the native runtime with its updated template/parser first.
python3 scripts/native-service.py restart
RESPONSES_MODE=service RUNTIME_PROFILE=vllm-metal SERVICE_ID=native \
  UPSTREAM_BASE_URL=http://127.0.0.1:18001/v1 PORT=8089 npm start
# SGLang uses RUNTIME_PROFILE=sglang-metal, SERVICE_ID=sglang, port 18002,
# MODEL=mlx-community/Qwen3-0.6B-4bit and a separate gateway port.
```

`docker compose up --build -d` runs the three local gateways. Native inference remains in separate Mac LaunchAgents. CUDA deployments select `vllm-cuda` or `sglang-cuda` and an appropriate upstream/model; their hardware acceptance is unverified. `dmr-metal` is a limited legacy text profile and cannot pass the complete Core gate. `RESPONSES_MODE=adapter` and `native` preserve the old experimental endpoints for comparison only; they do not carry the new contract.

## Create and stream

The Core profile requires **explicit `store:false`**. Omitted, null or true storage is rejected before inference. The ordinary official storage default is never silently changed.

```sh
curl http://localhost:8089/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"input":"Explain an API in one sentence.","store":false,"max_output_tokens":128}'
# Add "stream":true for SSE; stream_options.include_obfuscation=false opts out of padding.
```

The service assigns Response and Item IDs, builds output Items and all events, enforces admission, and normalizes failures. JSON, SSE and WebSocket use the same lifecycle. Engine errors after public deltas produce a failed terminal response with the partial output; token exhaustion produces `incomplete` with `max_output_tokens`. Disconnect cancels foreground inference. There is no automatic generation retry.

Text output is in `output[].content[]`. `output_text` is an SDK helper, not a replacement wire field. Tool-only and empty output stay tool-only and empty. Usage comes from the selected tokenizer/engine; unreported detail objects are omitted rather than invented. The default local output reservation is 1024 tokens, echoed as `max_output_tokens`. Modern profiles call their engine's exact tokenizer before generation and enforce input + reserved output against the context window.

## Items, functions and JSON

Input may be a string or ordered typed Items. Message roles are system, developer, user and assistant. Supported content is input/output text and assistant refusals. Function-call Items use a separate `id` and `call_id`; results correlate on `call_id`. Replay the complete input plus returned output and new `function_call_output` Items over HTTP. Every outstanding call must have exactly one result; parallel results may arrive out of order. Historical calls only supply context: this service never executes a caller function.

The checked-in Qwen template retains developer-role messages that the bundled template otherwise omits. Both runtime scripts select this template and a function parser. Non-null assistant `phase`, reasoning Items, media and nonempty annotation/logprob metadata are explicitly unsupported by these profiles.

Functions use flat Responses definitions. Choices include `auto`, `none`, `required`, a forced function, and allowed function subsets. Omitted function strictness normalizes the admitted schema to strict when possible; explicit `strict:false` opts out, and impossible normalization reports `strict:false`. Strict schemas are sent to constrained decoding, then validated again before successful completion. Post-validation is not a substitute for the decoder.

`text.format` supports `text`, `json_object`, and `json_schema`. Structured text cannot be combined with active function tools in one request. The supported schema subset is type/nullable unions, properties, required, boolean additionalProperties, items, enum, const, anyOf, title and description, bounded to 64 KiB/20 levels/1000 nodes. Strict objects require all properties and `additionalProperties:false`. Unsupported keywords, references and recursion reject before dispatch. A cutoff mid-JSON is incomplete, never a fabricated valid object.

## WebSocket

Upgrade `/v1/responses` and send JSON `response.create` events. Streaming is implicit: omit `stream` and `background`. For continuation, send the previous response ID and only the new input Items. Current top-level instructions replace prior top-level instructions; explicit system/developer transcript Items remain in history.

```json
{"type":"response.create","input":"Remember the word amber.","store":false}
```

After completion:

```json
{"type":"response.create","previous_response_id":"resp_returned_id","input":"What was the word?","store":false}
```

One default lane runs FIFO. A create without a parent starts fresh. Only the latest context is cached in connection memory; closing the socket, a failed continuation, or exceeding the context budget evicts it. Reconnect with the full typed history and no parent ID. Unknown IDs produce `previous_response_not_found`. No blind resend or create deduplication is promised.

Defaults: 8 queued creates; 1 MiB frame, queued-byte, outbound and cached-context limits; 64 connections globally/8 per tenant; 30-second heartbeat/write timeout; 5-minute idle timeout; 60-minute maximum connection lifetime. Disconnect abandons queued work and aborts active inference. Named lanes, steering, warmup and retained reconnect recovery are rejected.

## Authentication and operations

Set `API_KEY` for one tenant or `API_KEYS='{"key-a":"tenant-a","key-b":"tenant-b"}'` for explicit tenant identities. Both HTTP and WebSocket enforce Bearer authentication when configured; socket identity is rechecked before each create. Without keys the mode is explicitly `local-development`; keep the listener on loopback. Browser playground credential entry is not implemented, so authenticated deployments should use an SDK or API client. For a standalone gateway, engine credentials use `UPSTREAM_API_KEY`. Compose uses `DMR_UPSTREAM_API_KEY`, `NATIVE_UPSTREAM_API_KEY`, and `SGLANG_UPSTREAM_API_KEY` for the respective services; client keys are not forwarded to the engine in service mode.

Bodies and complete continuation history are bounded to 1 MiB by default. Generation admission is 4 global/2 per tenant, with 429 and Retry-After on saturation. Request IDs are returned even for rejected requests. Logs contain IDs, status, timings and usage, never prompts, outputs, arguments or credentials. `store:false` does not disable engine KV/prefix caches and does not claim OpenAI ZDR.

Retained retrieve/delete/input-items, background/cancel/resume, Conversations, compaction, multimodal content, encrypted reasoning, custom grammar and hosted/MCP tools have no implementation in this profile. They return explicit errors. The old native SGLang background/storage features remain an independent experimental mode, not a service-owned stateful release.

## Verification

```sh
npm test
.runtime/native-venv/bin/python -m unittest discover -s tests -p 'test_*.py'
node scripts/check-core-responses.mjs --base http://127.0.0.1:8089 --report docs/core-vllm-metal.json
API_BASE_URL=http://127.0.0.1:8089/v1 .runtime/native-venv/bin/python scripts/check-core-sdk.py
```

Run Metal engines sequentially and release one model before starting the next. Protocol tests cover fragmentation, IDs, function correlation, strict failures, cutoff, backpressure, admission, auth, cancellation and transient history. Native logs and actual inference are required for hardware evidence; catalog health is insufficient. SDK fixtures are pinned separately: Node 7.43.0, Python 3.36.1 and Go v3.86.0. Run Go smoke with `cd scripts/sdk-go && go run . -api-base-url http://127.0.0.1:8089/v1`. Live official OpenAI differential tests, CUDA hardware tests, production load/soak and the retained/advanced release gates remain unverified.


### Recorded local results · 23 October 2026

The current suite passed 142 JavaScript tests and 21 Python tests. Both [vLLM Metal](core-vllm-metal.json) and [SGLang Metal](core-sglang-metal.json) passed 15 live checks through the Docker gateways, including adversarial strict functions, JSON schema, SSE reconstruction, HTTP abort recovery and WebSocket full-history replay. [Accelerator evidence](core-metal-evidence.json) records the runtime versions, template/tokenizer pins and observed Metal/MLX startup. Python SDK workflows passed on both engines; Go JSON/SSE smoke passed on both; Node SDK helper/stream/WebSocket workflows use deterministic fixtures.

These results do not close every first-release gate in the design. Assistant phase (I02) is rejected by these model profiles. Live process kill/restart under load (M05), measured unified-memory pressure (M06), official OpenAI wire comparisons and CUDA hardware acceptance remain pending. Client-observed recovery timings do not measure engine cancellation latency. Retained/background and advanced profiles remain later implementation milestones.
