"""Exercise the local SGLang Responses feature contract with the OpenAI SDK.

Run with .runtime/native-venv/bin/python; the client sends HTTP only. Test tools
are simulated locally and never execute model-provided code or external actions.
"""
import argparse
import datetime
import json
from pathlib import Path
import time
import uuid

import openai
from openai import OpenAI

ROOT = Path(__file__).resolve().parent.parent
MODEL = 'mlx-community/Qwen3-0.6B-4bit'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:8090/v1')
    parser.add_argument('--output', default=str(ROOT / 'docs/responses-feature-verification.json'))
    args = parser.parse_args()
    client = OpenAI(base_url=args.base_url, api_key='local', timeout=120, max_retries=0)
    common = dict(model=MODEL, temperature=0, max_output_tokens=128)
    checks = []

    def record(name, **detail):
        checks.append({'name': name, 'ok': True, **detail})
        report = {'checked_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  'base_url': args.base_url, 'sdk': openai.__version__, 'checks': checks}
        Path(args.output).write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(checks[-1]), flush=True)

    response = client.responses.create(**common, input='Reply with exactly one word: ready', store=False)
    assert response.status == 'completed' and response.output_text.strip()
    record('Responses JSON', output=response.output_text)
    deltas = []
    with client.responses.stream(**common, input='Reply with exactly one word: ready', store=False) as stream:
        for event in stream:
            if event.type == 'response.output_text.delta':
                deltas.append(event.delta)
        final = stream.get_final_response()
    assert final.status == 'completed' and ''.join(deltas) == final.output_text and deltas
    record('SDK streaming accumulation', output=final.output_text, delta_count=len(deltas))
    try:
        client.responses.retrieve(response.id)
        raise AssertionError('store=false response must not be retrievable')
    except openai.NotFoundError:
        record('Stateless response is not retained')

    first = client.responses.create(**common, input='The test label is ORCHID. Acknowledge it.', store=True,
                                    metadata={'suite': 'local-feature-check'})
    retrieved = client.responses.retrieve(first.id)
    assert retrieved.id == first.id and retrieved.output_text == first.output_text
    assert retrieved.metadata.get('suite') == 'local-feature-check'
    second = client.responses.create(**common, previous_response_id=first.id,
                                     input='What was the test label?', store=True)
    assert second.status == 'completed' and second.output_text.strip()
    assert second.previous_response_id == first.id
    record('Stored retrieval and continuation', response_id=first.id, child_id=second.id,
           continuation=second.output_text, metadata_round_trip=True)

    namespace = 'verify-' + uuid.uuid4().hex
    prefix = f'Reference {namespace}:\n' + ' alpha beta gamma delta' * 768
    cache_runs = []
    for key, suffix in [(namespace, 'ready'), (namespace, 'done'), (namespace + '-isolated', 'done')]:
        started = time.perf_counter()
        result = client.responses.create(**common, input=prefix + '\nReply with exactly one word: ' + suffix,
                                         store=False, prompt_cache_key=key)
        details = result.usage.input_tokens_details
        cache_runs.append({'input_tokens': result.usage.input_tokens,
                           'cached_tokens': details.cached_tokens if details else 0,
                           'elapsed_seconds': round(time.perf_counter() - started, 4)})
    assert cache_runs[1]['cached_tokens'] > 1000, cache_runs
    assert cache_runs[2]['cached_tokens'] == 0, cache_runs
    record('Prefix reuse and cache-key isolation', runs=cache_runs)

    schema = {'type': 'object', 'properties': {'city': {'type': 'string', 'enum': ['Paris']},
              'ready': {'type': 'boolean'}}, 'required': ['city', 'ready'], 'additionalProperties': False}
    structured = client.responses.create(**common, input='Return city Paris and ready true.', store=False,
        text={'format': {'type': 'json_schema', 'name': 'readiness', 'strict': True, 'schema': schema}})
    parsed = json.loads(structured.output_text)
    assert set(parsed) == {'city', 'ready'} and parsed['city'] == 'Paris' and isinstance(parsed['ready'], bool)
    record('JSON schema constrained output', output=parsed)

    tools = [{'type': 'function', 'name': 'get_test_value', 'description': 'Read a local test value.',
              'parameters': {'type': 'object', 'properties': {'key': {'type': 'string', 'enum': ['sample']}},
                             'required': ['key'], 'additionalProperties': False}, 'strict': True}]
    requested = client.responses.create(**common, input='Call get_test_value for sample.',
                                        tools=tools, tool_choice='required', store=True)
    call = next(item for item in requested.output if item.type == 'function_call')
    assert call.name == 'get_test_value' and json.loads(call.arguments) == {'key': 'sample'}
    continued = client.responses.create(**common, previous_response_id=requested.id,
        input=[{'type': 'function_call_output', 'call_id': call.call_id, 'output': '{"value":42}'}],
        tools=tools, tool_choice='none', store=True)
    assert continued.status == 'completed' and continued.output_text.strip()
    record('Function call and tool-result continuation', function_name=call.name, arguments=json.loads(call.arguments),
           output=continued.output_text)

    background = client.responses.create(**common, input='Reply with exactly one word: ready',
                                         background=True, store=True)
    states = [background.status]
    deadline = time.monotonic() + 60
    while background.status in ('queued', 'in_progress'):
        assert time.monotonic() < deadline, 'Background polling timed out'
        time.sleep(.2)
        background = client.responses.retrieve(background.id)
        states.append(background.status)
    assert background.status == 'completed' and background.output_text.strip()
    record('Background completion and polling', states=states, output=background.output_text)
    background = client.responses.create(model=MODEL, input='Write a very long story with 500 numbered paragraphs about a railway.',
                                         max_output_tokens=8192, background=True, store=True)
    cancelled = client.responses.cancel(background.id)
    assert cancelled.status == 'cancelled', cancelled.status
    assert client.responses.retrieve(background.id).status == 'cancelled'
    record('Background cancellation', status=cancelled.status)

    jobs = []
    try:
        for _ in range(8):
            job = client.responses.create(model=MODEL,
                input='Write 500 numbered paragraphs about a railway. Continue for as long as possible.',
                max_output_tokens=8192, background=True, store=True)
            jobs.append(job.id)
        try:
            client.responses.create(**common, input='Hello', background=True, store=True)
            raise AssertionError('Ninth active Responses job should receive 429')
        except openai.RateLimitError:
            record('Active job admission limit', admitted=len(jobs), overflow_status=429)
    finally:
        for response_id in jobs:
            current = client.responses.retrieve(response_id)
            if current.status in ('queued', 'in_progress'):
                client.responses.cancel(response_id)

    for option in [{'prompt_cache_options': {'ttl': '12h'}},
                   {'input': [{'role': 'user', 'content': [{'type': 'input_text', 'text': 'Hello',
                       'prompt_cache_breakpoint': {'mode': 'explicit'}}]}]},
                   {'tools': [{'type': 'web_search'}]}]:
        request = {'input': 'Hello', 'store': False, **option}
        try:
            client.responses.create(**common, **request)
            raise AssertionError(f'Unsupported cloud feature was silently accepted: {option}')
        except openai.BadRequestError:
            pass
    record('Unsupported cloud cache controls and hosted tools return 400')
    print(f'PASS: {len(checks)} feature checks', flush=True)


if __name__ == '__main__':
    main()
