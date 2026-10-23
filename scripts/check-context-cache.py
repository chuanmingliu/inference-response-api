"""Live context-boundary and prefix-cache checks; run with native-venv Python.

Inference is sequential to avoid GPU contention. This is integration evidence,
not a performance benchmark or a model-quality evaluation.
"""
import argparse
import datetime
import json
from pathlib import Path
import time
import urllib.error
import urllib.request
import uuid

from transformers import AutoTokenizer

ROOT = Path(__file__).resolve().parent.parent
MODEL_PATH = Path.home() / '.docker/models/bundles/sha256/4c871aaa1be2f0b14156553622c2fed6f62a4a0f1b9df3832cab5fac533cffcc/model'
MODEL = 'huggingface.co/mlx-community/qwen3-0.6b-4bit:latest'
SERVICES = {'docker': (8088, MODEL), 'native': (8089, MODEL),
            'sglang': (8090, 'mlx-community/Qwen3-0.6B-4bit')}


def post(base, body):
    request = urllib.request.Request(base + '/v1/chat/completions',
        data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    start = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=240) as response:
            data = json.load(response)
            return response.status, data, round(time.perf_counter() - start, 3)
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read()), round(time.perf_counter() - start, 3)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--services', default='docker,native,sglang')
    parser.add_argument('--output', default=str(ROOT / 'docs/context-cache-verification.json'))
    parser.add_argument('--resume', action='store_true', help='Keep completed service checks after an interrupted run.')
    args = parser.parse_args()
    tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH, local_files_only=True)

    def messages(n, suffix='Reply with the word ready.'):
        return [{'role': 'user', 'content': 'Read the reference text, then answer the final instruction.\n' + ' token' * n + '\n' + suffix}]

    def tokens(items):
        return len(tokenizer.apply_chat_template(items, tokenize=True,
                   add_generation_prompt=True, enable_thinking=False, return_dict=False))

    # Reserve room for output and small renderer differences. The overflow
    # request exceeds the entire input limit, so output clamping cannot hide it.
    overhead = tokens(messages(0))
    near = messages(32752 - overhead)
    overflow = messages(32785 - overhead)
    assert 32720 <= tokens(near) <= 32760
    assert tokens(overflow) > 32768
    results = []
    report = {'checked_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'context_length': 32768, 'local_prompt_tokens': tokens(near), 'services': results}
    if args.resume and Path(args.output).exists():
        previous = json.loads(Path(args.output).read_text())
        assert previous['context_length'] == 32768 and previous['local_prompt_tokens'] == tokens(near)
        results.extend(previous['services'])
    for service in args.services.split(','):
        if any(item['service_id'] == service for item in results):
            continue
        port, model = SERVICES[service]
        base = f'http://127.0.0.1:{port}'
        common = {'model': model, 'temperature': 0, 'max_tokens': 8,
                  'chat_template_kwargs': {'enable_thinking': False}}
        status, data, seconds = post(base, {**common, 'messages': near})
        assert status == 200, (service, status, data)
        # A legitimate EOS can yield empty visible text on this tiny model.
        # Capacity success is not evidence of answer quality; preserve both.
        assert data['usage']['completion_tokens'] > 0, (service, data)
        assert data['usage']['prompt_tokens'] >= 32720, (service, data['usage'])
        record = {'service_id': service, 'near_limit': {'http_status': status,
                  'usage': data['usage'], 'elapsed_seconds': seconds,
                  'output_text': data['choices'][0]['message']['content'],
                  'finish_reason': data['choices'][0]['finish_reason']}}
        print(json.dumps({'service': service, 'near_limit': record['near_limit']}), flush=True)
        status, data, _ = post(base, {**common, 'messages': overflow, 'max_tokens': 1})
        assert status == 400, (service, 'overflow must fail', status, data)
        record['overflow'] = {'http_status': status, 'error': data.get('error', data)}

        unique = uuid.uuid4().hex
        cache_runs = []
        for suffix in ('Reply with one word: ready.', 'Reply with one word: done.'):
            prefix = [{'role': 'user', 'content': f'Reference {unique}:\n' + ' alpha beta gamma delta' * 512 + '\n' + suffix}]
            status, data, elapsed = post(base, {**common, 'messages': prefix})
            assert status == 200, (service, status, data)
            usage = data['usage']
            cached = (usage.get('prompt_tokens_details') or {}).get('cached_tokens', 0)
            cache_runs.append({'prompt_tokens': usage['prompt_tokens'], 'cached_tokens': cached, 'elapsed_seconds': elapsed})
        record['prefix_cache'] = {'runs': cache_runs, 'reuse_verified': cache_runs[1]['cached_tokens'] > 1000}
        if service != 'docker':
            assert record['prefix_cache']['reuse_verified'], (service, cache_runs)
        results.append(record)
        report['checked_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        Path(args.output).write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'service': service, 'overflow': record['overflow']['http_status'], 'prefix_cache': record['prefix_cache']}), flush=True)


if __name__ == '__main__':
    main()
