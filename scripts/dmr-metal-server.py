"""responsible-api compatibility entrypoint for Docker Desktop 4.62.0.

Only the pinned Qwen3 test bundle uses vLLM core. All other model paths
retain Docker's original entrypoint. Installed by repair-dmr-entrypoint.py.
"""
import argparse
from pathlib import Path
import runpy
import sys

MODEL_DIGEST = '4c871aaa1be2f0b14156553622c2fed6f62a4a0f1b9df3832cab5fac533cffcc'
MODEL_NAME = 'huggingface.co/mlx-community/qwen3-0.6b-4bit:latest'


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--model', '-m')
    args, _ = parser.parse_known_args()
    if not args.model or MODEL_DIGEST not in Path(args.model).parts:
        runpy.run_path(str(Path(__file__).with_name('server.py.responsible-api-original')), run_name='__main__')
        return
    if '--served-model-name' not in sys.argv:
        sys.argv.extend(['--served-model-name', MODEL_NAME,
                         'hf.co/mlx-community/Qwen3-0.6B-4bit', args.model])
    if '--max-num-seqs' not in sys.argv:
        sys.argv.extend(['--max-num-seqs', '1'])
    runpy.run_module('vllm.entrypoints.openai.api_server', run_name='__main__')


if __name__ == '__main__':
    main()
