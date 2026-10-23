#!/usr/bin/env bash
# Install the pinned native comparison runtime without changing Docker's bundle.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$PROJECT_ROOT/.runtime"
VENV_DIR="$RUNTIME_DIR/native-venv"
METAL_VERSION="0.32.0"
CORE_VERSION="0.32.0+cpu"
METAL_WHEEL="https://github.com/vllm-project/vllm-metal/releases/download/v0.32.0/vllm_metal-0.32.0-cp312-cp312-macosx_15_0_arm64.whl"
CORE_WHEEL="https://github.com/vllm-project/vllm/releases/download/v0.32.0/vllm-0.32.0%2Bcpu-cp38-abi3-macosx_11_0_arm64.whl"

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "This runtime requires native Apple Silicon macOS (arm64)." >&2
  exit 1
fi
MACOS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
if (( MACOS_MAJOR < 15 )); then
  echo "vLLM Metal $METAL_VERSION requires macOS 15 or newer." >&2
  exit 1
fi
if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required. Install it using https://docs.astral.sh/uv/getting-started/installation/ and rerun." >&2
  exit 1
fi

mkdir -p "$RUNTIME_DIR" "$RUNTIME_DIR/uv-cache"
# Keep dependency downloads in this project. Do not change HOME or global uv settings.
export UV_CACHE_DIR="$RUNTIME_DIR/uv-cache"

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  if command -v python3.12 >/dev/null 2>&1; then
    PYTHON_SEED="$(command -v python3.12)"
  elif [[ -x "$HOME/.docker/model-runner/vllm-metal/bin/python3" ]]; then
    PYTHON_SEED="$HOME/.docker/model-runner/vllm-metal/bin/python3"
  else
    echo "A native Python 3.12 interpreter is required; no existing interpreter was found." >&2
    exit 1
  fi
  "$PYTHON_SEED" -c 'import platform,sys; assert sys.version_info[:2] == (3,12), "Python 3.12 required"; assert platform.machine() == "arm64", "Native arm64 Python required"'
  uv venv --python "$PYTHON_SEED" "$VENV_DIR"
fi

"$VENV_DIR/bin/python" -c 'import platform,sys; assert sys.version_info[:2] == (3,12), "Existing environment is not Python 3.12"; assert platform.machine() == "arm64", "Existing environment is not arm64"'

if "$VENV_DIR/bin/python" - "$CORE_VERSION" "$METAL_VERSION" <<'PY'
import importlib.metadata as m
import sys
try:
    installed = (m.version("vllm"), m.version("vllm-metal"))
except m.PackageNotFoundError:
    sys.exit(1)
sys.exit(0 if installed == tuple(sys.argv[1:]) else 1)
PY
then
  echo "Pinned vLLM core and Metal versions are already installed."
else
  uv pip install --python "$VENV_DIR/bin/python" "$CORE_WHEEL" "$METAL_WHEEL" \
    2>&1 | tee "$RUNTIME_DIR/native-install.log"
fi

# Validate the resolver result and record exact installed versions.
"$VENV_DIR/bin/python" - "$RUNTIME_DIR/native-install.json" "$CORE_WHEEL" "$METAL_WHEEL" <<'PY'
import datetime
import importlib.metadata as m
import json
import pathlib
import platform
import sys

assert m.version("vllm") == "0.32.0+cpu", "Unexpected vLLM core version"
assert m.version("vllm-metal") == "0.32.0", "Unexpected vLLM Metal version"
import vllm_metal  # noqa: E402 — checks the native plugin can be imported

record = {
    "verified_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "python": sys.executable,
    "python_version": platform.python_version(),
    "architecture": platform.machine(),
    "macos_version": platform.mac_ver()[0],
    "packages": {name: m.version(name) for name in ("vllm", "vllm-metal", "mlx", "mlx-lm", "transformers")},
    "wheels": {"vllm": sys.argv[2], "vllm-metal": sys.argv[3]},
}
pathlib.Path(sys.argv[1]).write_text(json.dumps(record, indent=2) + "\n")
print(json.dumps(record, indent=2))
PY

echo "Native comparison runtime installed at $VENV_DIR"
echo "This step installs the runtime only; use the project's native service lifecycle script to start inference."
