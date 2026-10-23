#!/usr/bin/env python3
"""Manage the SGLang MLX engine as a per-user macOS LaunchAgent."""
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
label = 'local.responsible-api.sglang'
domain = f'gui/{os.getuid()}'
target = f'{domain}/{label}'
plist = Path.home() / 'Library/LaunchAgents' / f'{label}.plist'
model = Path.home() / '.docker/models/bundles/sha256/4c871aaa1be2f0b14156553622c2fed6f62a4a0f1b9df3832cab5fac533cffcc/model'
binary = runtime / 'sglang-venv/bin/python'

def run(*command, check=True):
    return subprocess.run(command, check=check)

if args.action == 'status':
    raise SystemExit(run('launchctl', 'print', target, check=False).returncode)
if args.action in ('start', 'restart'):
    if not binary.exists() or not (model / 'tokenizer_config.json').exists():
        raise SystemExit('Run install-sglang.sh and prepare the shared Qwen3 model first.')
    (runtime / 'sglang-cache').mkdir(parents=True, exist_ok=True)
    (runtime / 'tiktoken-cache').mkdir(parents=True, exist_ok=True)
if args.action in ('stop', 'restart', 'uninstall'):
    run('launchctl', 'bootout', target, check=False)
    # bootout returns before a gracefully draining process leaves launchd.
    deadline = time.monotonic() + 45
    while subprocess.run(['launchctl', 'print', target], capture_output=True).returncode == 0:
        if time.monotonic() >= deadline:
            raise SystemExit('SGLang is still shutting down; retry after active requests finish.')
        time.sleep(0.5)
    if args.action == 'uninstall':
        plist.unlink(missing_ok=True)
    if args.action != 'restart':
        raise SystemExit(0)
record = {
    'Label': label,
    'ProgramArguments': [str(binary), str(root / 'scripts/sglang_server.py'),
        '--model-path', str(model), '--served-model-name',
        'mlx-community/Qwen3-0.6B-4bit',
        '--host', '127.0.0.1', '--port', '18002', '--device', 'mps',
        '--context-length', '32768', '--max-running-requests', '1',
        '--max-total-tokens', '65536', '--mem-fraction-static', '0.10',
        '--disable-cuda-graph', '--enable-cache-report', '--mlx-enable-sampling',
        '--enable-response-store',
        '--tool-call-parser', 'qwen25',
        '--chat-template', str(root / 'config/qwen3-responses.jinja'),
        '--default-chat-template-kwargs', '{"enable_thinking":false}'],
    'WorkingDirectory': str(root),
    'EnvironmentVariables': {
        'PATH': f'{runtime}/sglang-venv/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        'SGLANG_USE_MLX': '1',
        'HF_HOME': str(runtime / 'hf-cache'),
        'HF_HUB_OFFLINE': '1',
        'TIKTOKEN_CACHE_DIR': str(runtime / 'tiktoken-cache'),
        'XDG_CACHE_HOME': str(runtime / 'sglang-cache'),
        'PYTHONUNBUFFERED': '1',
    },
    'RunAtLoad': True,
    'KeepAlive': True,
    'ThrottleInterval': 15,
    'StandardOutPath': str(runtime / 'sglang-engine.log'),
    'StandardErrorPath': str(runtime / 'sglang-engine.err.log'),
}
plist.parent.mkdir(parents=True, exist_ok=True)
plist.write_bytes(plistlib.dumps(record))
loaded = subprocess.run(['launchctl', 'print', target], capture_output=True).returncode == 0
if not loaded:
    run('launchctl', 'bootstrap', domain, str(plist))
else:
    print('LaunchAgent already loaded; use restart to reload configuration.')
print(f'SGLang engine: http://127.0.0.1:18002/v1; LaunchAgent: {plist}')
