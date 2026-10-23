#!/usr/bin/env python3
"""Reversible, version-gated repair for Docker Desktop's early Metal bundle."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--restore', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
runtime = Path.home() / '.docker/model-runner/vllm-metal'
version = (runtime / '.vllm-metal-version').read_text().strip()
expected = 'v0.1.0-20260126-121650'
if version != expected:
    raise SystemExit(f'Refusing repair for untested runtime {version!r}; expected {expected!r}.')
target = runtime / 'lib/python3.12/site-packages/vllm_metal/server.py'
backup = target.with_name('server.py.responsible-api-original')
shim = (root / 'scripts/dmr-metal-server.py').read_bytes()
digest = '4c871aaa1be2f0b14156553622c2fed6f62a4a0f1b9df3832cab5fac533cffcc'
model = Path.home() / f'.docker/models/bundles/sha256/{digest}/model'
config = model / 'tokenizer_config.json'
marker = model / '.responsible-api-tokenizer-repair'
if args.restore:
    if marker.exists() and (not config.exists() or hashlib.sha256(config.read_bytes()).hexdigest() != marker.read_text()):
        raise SystemExit('Tokenizer metadata changed since repair; preserve it for manual review.')
    if backup.exists():
        if target.read_bytes() != shim:
            raise SystemExit('Entrypoint changed since repair; refusing to overwrite it.')
        shutil.copy2(backup, target)
        backup.unlink()
        print('Restored original Docker Metal entrypoint.')
    if marker.exists():
        if config.exists() and hashlib.sha256(config.read_bytes()).hexdigest() == marker.read_text():
            config.unlink()
            marker.unlink()
            print('Removed only the tokenizer metadata created by this repair.')
        else:
            raise SystemExit('Tokenizer metadata changed since repair; preserve it for manual review.')
else:
    if not (model / 'model.safetensors').exists():
        raise SystemExit('Expected Qwen3 bundle is missing. Pull and validate its digest first.')
    # Preflight all input metadata before touching the shared runtime.
    metadata = json.loads((config if config.exists() else model / 'template.jinja').read_text())
    if not isinstance(metadata.get('chat_template'), str):
        raise SystemExit('Packaged template is not the expected tokenizer config.')
    content = (json.dumps(metadata, ensure_ascii=False, indent=2) + '\n').encode()
    original = target.read_bytes()
    if original != shim:
        if backup.exists() and original != backup.read_bytes():
            raise SystemExit('Existing backup and runtime differ; refusing to overwrite unknown changes.')
        if b'from vllm_metal.model_runner import MetalModelRunner' not in original:
            raise SystemExit('Unrecognized original entrypoint; repair does not apply.')
        if not backup.exists():
            shutil.copy2(target, backup)
        target.write_bytes(shim)
    if not config.exists():
        # DMR 1.0.18 materializes tokenizer_config JSON under template.jinja.
        config.write_bytes(content)
        marker.write_text(hashlib.sha256(content).hexdigest())
    print(f'Repaired vLLM entrypoint for Qwen3 only: {target}')
    print(f'Original preserved at: {backup}')
    print(f'Tokenizer metadata: {config}')
