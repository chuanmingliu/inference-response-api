#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker model status
docker model ps
docker compose ps
curl --fail --silent --show-error "http://127.0.0.1:${PORT:-8088}/api/status"
echo
curl --fail --silent --show-error http://127.0.0.1:8089/api/status
echo
curl --fail --silent --show-error http://127.0.0.1:8090/api/status
echo
launchctl list local.responsible-api.native
launchctl list local.responsible-api.sglang
