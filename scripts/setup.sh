#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker model status
docker model pull hf.co/mlx-community/Qwen3-0.6B-4bit
MODEL_ID="$(docker model inspect hf.co/mlx-community/Qwen3-0.6B-4bit | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
if [[ "$MODEL_ID" != sha256:4c871aaa1be2f0b14156553622c2fed6f62a4a0f1b9df3832cab5fac533cffcc ]]; then
  echo "The upstream model tag changed ($MODEL_ID). This deployment repair is validated only for the digest in docs/DEPLOYMENT.md; review the new bundle before proceeding." >&2
  exit 1
fi
python3 scripts/repair-dmr-entrypoint.py
docker model unload hf.co/mlx-community/Qwen3-0.6B-4bit
docker model configure --context-size 32768 --keep-alive 1h hf.co/mlx-community/Qwen3-0.6B-4bit
docker model run --detach hf.co/mlx-community/Qwen3-0.6B-4bit
./scripts/install-native.sh
python3 scripts/native-service.py start
docker compose build playground
docker compose up -d
echo 'Playgrounds: http://localhost:8088 and http://localhost:8089'
echo 'Native engine may take a minute to initialize. Check ./scripts/status.sh.'
