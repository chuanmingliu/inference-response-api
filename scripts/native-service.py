#!/usr/bin/env python3
"""Manage the native comparison engine as a per-user macOS LaunchAgent."""
import argparse
import os
from pathlib import Path
import plistlib
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('action', choices=['start', 'stop', 'restart', 'status', 'uninstall'])
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
runtime = root / '.runtime'
label = 'local.responsible-api.native'
domain = f'gui/{os.getuid()}'
target = f'{domain}/{label}'
plist = Path.home() / 'Library/LaunchAgents' / f'{label}.plist'
model = Path.home() / '.docker/models/bundles/sha256/4c871aaa1be2f0b14156553622c2fed6f62a4a0f1b9df3832cab5fac533cffcc/model'
binary = runtime / 'native-venv/bin/vllm'

def run(*command, check=True):
    return subprocess.run(command, check=check)

if args.action == 'status':
    raise SystemExit(run('launchctl', 'print', target, check=False).returncode)
if args.action in ('start', 'restart') and (not binary.exists() or not (model / 'tokenizer_config.json').exists()):
    raise SystemExit('Run install-native.sh and repair-dmr-entrypoint.py first.')
if args.action in ('stop', 'restart', 'uninstall'):
    run('launchctl', 'bootout', target, check=False)
    deadline = time.monotonic() + 45
    while subprocess.run(['launchctl', 'print', target], capture_output=True).returncode == 0:
        if time.monotonic() >= deadline:
            raise SystemExit('Native vLLM is still shutting down; retry after active requests finish.')
        time.sleep(0.5)
    if args.action == 'uninstall':
        plist.unlink(missing_ok=True)
    if args.action != 'restart':
        raise SystemExit(0)
record = {
    'Label': label,
    'ProgramArguments': [str(binary), 'serve', str(model),
        '--host', '127.0.0.1', '--port', '18001',
        '--served-model-name', 'huggingface.co/mlx-community/qwen3-0.6b-4bit:latest',
        '--max-model-len', '32768', '--max-num-seqs', '1',
        '--gpu-memory-utilization', '0.10',
        '--enable-prefix-caching',
        '--enable-auto-tool-choice', '--tool-call-parser', 'hermes',
        '--tool-strict-level', 'auto',
        '--chat-template', str(root / 'config/qwen3-responses.jinja'),
        '--enable-prompt-tokens-details',
        '--default-chat-template-kwargs', '{"enable_thinking":false}'],
    'WorkingDirectory': str(root),
    'EnvironmentVariables': {
        'PATH': f'{runtime}/native-venv/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        'HF_HOME': str(runtime / 'hf-cache'),
        'VLLM_CACHE_ROOT': str(runtime / 'vllm-cache'),
        'HF_HUB_OFFLINE': '1',
        'VLLM_ENFORCE_STRICT_TOOL_CALLING': '1',
        'PYTHONUNBUFFERED': '1',
    },
    'RunAtLoad': True,
    'KeepAlive': True,
    'ThrottleInterval': 15,
    'StandardOutPath': str(runtime / 'native-engine.log'),
    'StandardErrorPath': str(runtime / 'native-engine.err.log'),
}
plist.parent.mkdir(parents=True, exist_ok=True)
plist.write_bytes(plistlib.dumps(record))
loaded = subprocess.run(['launchctl', 'print', target], capture_output=True).returncode == 0
if not loaded:
    run('launchctl', 'bootstrap', domain, str(plist))
else:
    print('LaunchAgent already loaded; use restart to reload configuration.')
print(f'Native engine: http://127.0.0.1:18001/v1; LaunchAgent: {plist}')
