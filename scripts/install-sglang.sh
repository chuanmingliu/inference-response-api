#!/usr/bin/env bash
# Install a pinned Apple Silicon SGLang runtime in this project only.
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$PROJECT_ROOT/.runtime"
SOURCE_DIR="$RUNTIME_DIR/sglang-src"
VENV_DIR="$RUNTIME_DIR/sglang-venv"
SGLANG_TAG="v0.5.22"
SGLANG_COMMIT="baa9befa381511cd4d56f83980951e5a45fffc6d"
MLX_VERSION="0.32.2"

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'This installer requires native Apple Silicon macOS.' >&2
  exit 1
fi
command -v uv >/dev/null
mkdir -p "$RUNTIME_DIR/uv-cache"
export UV_CACHE_DIR="$RUNTIME_DIR/uv-cache"
if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  git clone --depth 1 --branch "$SGLANG_TAG" https://github.com/sgl-project/sglang.git "$SOURCE_DIR"
fi
if [[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" != "$SGLANG_COMMIT" ]]; then
  echo "Unexpected SGLang checkout; expected $SGLANG_COMMIT. Preserve it and inspect before reinstalling." >&2
  exit 1
fi
if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  uv venv --python "$RUNTIME_DIR/native-venv/bin/python" "$VENV_DIR"
fi
"$VENV_DIR/bin/python" -c 'import platform,sys; assert platform.machine()=="arm64"; assert sys.version_info[:2]==(3,12)'

# Upstream's documented alternate manifest supplies the Apple backend extras.
# Keep the original and skip optional Rust/multimodal extensions for text serving.
if [[ ! -f "$SOURCE_DIR/python/pyproject.toml.original" ]]; then
  cp "$SOURCE_DIR/python/pyproject.toml" "$SOURCE_DIR/python/pyproject.toml.original"
fi
cp "$SOURCE_DIR/python/pyproject_other.toml" "$SOURCE_DIR/python/pyproject.toml"
SGLANG_BUILD_RUST_EXTS=none uv pip install --python "$VENV_DIR/bin/python" \
  -e "$SOURCE_DIR/python[srt_mps]" "mlx==$MLX_VERSION" \
  2>&1 | tee "$RUNTIME_DIR/sglang-install.log"
uv pip check --python "$VENV_DIR/bin/python"
uv pip freeze --python "$VENV_DIR/bin/python" > "$PROJECT_ROOT/docs/sglang-requirements.txt"
echo "SGLang runtime installed at $VENV_DIR"
