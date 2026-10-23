# Responsible API · local Qwen playground

A service-owned Responses API for vLLM and SGLang, with a local Qwen3-0.6B playground. The new Core profile supports JSON/SSE, typed text Items, functions, constrained JSON, exact token admission and transient WebSocket continuation. Requests require `store:false`. Read the [Core guide and limitations](docs/RESPONSES-CORE.md) and [capability manifest](config/responses-capabilities.json). Retained responses, background jobs and advanced features remain separate release gates.

| Service | Playground / API base | Runtime | Responses |
| --- | --- | --- | --- |
| A · Docker Model Runner | <http://localhost:8088> / `/v1` | vLLM 0.13.0 + Metal 0.1.0, repaired entrypoint | Limited Core text profile |
| B · Native vLLM Metal | <http://localhost:8089> / `/v1` | Isolated vLLM + Metal 0.32.0 | Shared Core + WebSocket |
| C · SGLang MLX | <http://localhost:8090> / `/v1` | Isolated SGLang 0.5.22 with MLX | Shared Core + WebSocket |

- Responses Core: [API guide](docs/RESPONSES-CORE.md) · [vLLM live checks](docs/core-vllm-metal.json) · [SGLang live checks](docs/core-sglang-metal.json)
- Playground: <http://localhost:8088>
- Deployment guide: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), also served at <http://localhost:8088/docs>
- SGLang installation and operations: [docs/SGLANG.md](docs/SGLANG.md)
- Current Responses API and examples: [Core guide](http://localhost:8088/docs/responses)
- Legacy native SGLang experiments: [historical feature guide](docs/RESPONSES-FEATURES.md)
- Latest Docker Metal artifact and upgrade notes: [update guide](http://localhost:8088/docs/docker-update)
- Historical native-mode full-context checks: [prior status](docs/service-status-full-context.json), [32k answer check](docs/long-context-answer-verification.json), [Responses checks](docs/responses-feature-verification.json)
- Live status: <http://localhost:8088/api/status>
- Historical integration snapshots: [Docker](docs/service-status.json), [native vLLM](docs/service-status-native.json), [SGLang](docs/service-status-sglang.json)
- Benchmark report: [results and methodology](docs/benchmarks/2026-10-22-qwen3-comparison/REPORT.md) · [visual report](docs/benchmarks/2026-10-22-qwen3-comparison/report.html)
- Earlier three-sample smoke timing: [docs/comparison.json](docs/comparison.json)

```sh
./scripts/setup.sh
./scripts/status.sh
node scripts/smoke.mjs
API_BASE_URL=http://127.0.0.1:8089 node scripts/smoke.mjs
API_BASE_URL=http://127.0.0.1:8090 node scripts/smoke.mjs
node scripts/compare.mjs
node scripts/benchmark.mjs
```

Read the deployment guide before setup: Docker Desktop 4.62.0 bundles an early Metal entrypoint that requires the documented reversible compatibility repair on this machine. Service A remains text-only because its old runtime lacks the mandatory Core features. Services B and C use the shared service-owned Core. Legacy adapter/native pass-through modes remain explicitly selectable for comparison. The guide includes the update audit, runtime pins, API examples, lifecycle commands, and rollback.

To add Service C to an existing deployment:

```sh
bash scripts/install-sglang.sh
python3 scripts/sglang-service.py restart
python3 scripts/native-service.py restart
docker compose build playground
docker compose up -d
```

The recorded benchmark report compares A and B only; it predates Service C. Use the service selector in the main playground to try the same prompt against all three runtimes.

```sh
docker compose logs -f
docker compose down
python3 scripts/native-service.py stop
python3 scripts/sglang-service.py stop
```

Requires macOS 15+ on Apple Silicon, Docker Desktop with Model Runner, uv, Python 3.12, and Node 22+ for host-side development/testing. Inference runs natively on the Mac; the three API/playground gateways run in containers bound to loopback. Native vLLM and SGLang run as separate per-user LaunchAgents. Model weights are shared on disk.
