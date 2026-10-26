# WebSocket state reuse · 26 October 2026

The gateway now reuses immutable continuation history and its normalized Items, counts cached JSON bytes incrementally, and compiles the engine request once for exact token admission and generation. This applies the reusable-state approach described in [OpenAI's WebSocket workflow article](https://openai.com/index/speeding-up-agentic-workflows-with-websockets/).

## Measured gateway overhead

These are local WebSocket tool loops with deterministic tokenizer and inference fixtures, **not real inference speedups**. Each loop has 20 sequential response.create requests on one socket; each continuation carries one new 8 KiB tool result. The actual gateway, validation, Chat Completions compiler, tokenizer request serialization, SSE parser and WebSocket event writer run normally. No GPU, real tool execution or engine network latency is measured. The fixture token count is intentionally fixed, so this does not establish model context capacity.

Apple M3 Max, Node v22.22.3. Baseline: commit `7c20289`. Each process warms up with three complete workflows, then records 50. The table uses median complete-workflow wall time and median first argument-delta latency across all measured turns.

| Adapter | Before, 20 turns | After, 20 turns | Reduction | First delta before → after |
|---|---:|---:|---:|---:|
| vllm | 23.21 ms | 15.93 ms | 31.4% | 1.142 → 0.791 ms |
| sglang | 22.45 ms | 16.63 ms | 26.0% | 1.125 → 0.823 ms |

The initial 20-workflow run showed the same direction (vLLM 23.84 → 17.32 ms; SGLang 25.06 → 17.50 ms). Both version orders were exercised; the final after samples were recorded again after the history-freezing loop was finalized. These short shared-machine runs are not an isolated CPU or production-load study. Variance between the 20-run and 50-run samples is visible in the raw data. The savings are several milliseconds across an entire 20-turn loop; model and tool latency may dominate real workloads.

Raw measurements, including every turn and first-delta time, are in `vllm-before.json`, `vllm-after.json`, `sglang-before.json`, `sglang-after.json`, and the corresponding `*-repeat.json` files. Client payloads are the same in both implementations: the baseline already supported incremental WebSocket input. The measured difference comes from server-side processing changes, not fewer bytes sent by the client.

## Reproduce

From the repository root, create an isolated baseline snapshot (the baseline can resolve the root node_modules):

```sh
mkdir -p .runtime/websocket-before
git archive 7c20289 | tar -x -C .runtime/websocket-before
node scripts/benchmark-websocket-state.mjs --implementation .runtime/websocket-before --profile vllm-metal --runs 50 --report /tmp/vllm-before.json
node scripts/benchmark-websocket-state.mjs --profile vllm-metal --runs 50 --report /tmp/vllm-after.json
```

Repeat with `--profile sglang-metal`. The benchmark starts an ephemeral loopback listener and closes it afterwards. It does not call an inference provider. Run the versions sequentially and reverse their order to check sensitivity to machine state.

## Contract and remaining costs

- Cached history shares only deeply frozen Items. Weak-key metadata has no content lookup or cross-connection recovery. Eviction, tenant identity checks and failed-continuation behavior remain unchanged.
- Only new Items need normalization and JSON byte counting. Tool-result correlation still checks the whole conversation, including missing/duplicate results and unfinished calls.
- Request-local preparation snapshots messages, selected tools and decoder grammar before token admission. No compiled request is reused across different requests. Top-level instructions and tools remain explicitly supplied on each turn.
- Both native engines still receive the complete Chat Completions prompt and perform exact token admission. This change does not add incremental tokenization, model-side session state, KV-cache management, retained storage, or additional OpenAI API features.
- Operational logs add `engine_preparation_ms` and `token_admission_ms` alongside `ttft_ms` and `duration_ms`. Preparation measures compilation/snapshot creation inside service.run; token admission measures the successful tokenizer round trip. They do not include pre-run API validation. Null means that phase did not complete. Content and credentials are excluded.

## Validation

All 152 JavaScript regression tests passed, including official Node SDK workflows. New regressions cover immutable prefix sharing, Unicode byte limits, duplicate/missing/unfinished tool results, runtime profile isolation, mutation between tokenization and generation, cancellation, and request-local preparation.

After rebuilding and deploying the local gateways, real vLLM Metal and SGLang MLX inference passed these checks:

| Runtime | Live Core/WS checks | Official Python SDK 3.36.1 workflows |
|---|---|---|
| vLLM Metal | [15/15 passed](live-vllm.json) | [5/5 passed](sdk-vllm.json) |
| SGLang MLX | [15/15 passed](live-sglang.json) | [5/5 passed](sdk-sglang.json) |

The SDK workflows cover JSON, SSE helpers, function round trips, Pydantic structured output and same-socket continuation. These establish functional behavior on the Mac; they do not measure a real-inference before/after latency improvement.
