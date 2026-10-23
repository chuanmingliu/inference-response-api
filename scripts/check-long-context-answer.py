"""Check usable text output near the 32,768-token context limit, sequentially.

Run with .runtime/native-venv/bin/python. This is a narrow integration check:
its answer is explicitly supplied near the END of a deterministic, varied
reference document. Success does not establish long-range retrieval quality,
general reasoning quality, or a performance advantage between services.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import random
import time
import urllib.error
import urllib.request

from transformers import AutoTokenizer

ROOT = Path(__file__).resolve().parent.parent
MODEL_PATH = Path.home() / '.docker/models/bundles/sha256/4c871aaa1be2f0b14156553622c2fed6f62a4a0f1b9df3832cab5fac533cffcc/model'
MODEL = 'huggingface.co/mlx-community/qwen3-0.6b-4bit:latest'
SERVICES = {'docker': (8088, MODEL), 'native': (8089, MODEL),
            'sglang': (8090, 'mlx-community/Qwen3-0.6B-4bit')}
CONTEXT_LENGTH = 32768
TARGET_INPUT_TOKENS = 32600
MAX_OUTPUT_TOKENS = 128
EXPECTED_CODENAME = 'Cedar Lantern'
SEED = 20261022


def reference_records(count=1200):
    """Varied, reproducible operational notes; no external data or repeated token padding."""
    rng = random.Random(SEED)
    people = ['Maya', 'Elliot', 'Noor', 'Jonah', 'Priya', 'Felix', 'Amara', 'Theo',
              'Iris', 'Luca', 'Sofia', 'Marcus', 'Leila', 'Owen', 'Nadia', 'Hugo']
    places = ['Riverside', 'Hilltop', 'Northgate', 'Meadow', 'Harbor', 'Orchard',
              'Westbrook', 'Southbank', 'Brookside', 'Lakeside', 'Oakridge', 'Seaview']
    materials = ['inventory sheets', 'training notes', 'maintenance records',
                 'delivery labels', 'staff schedules', 'inspection forms',
                 'reference photographs', 'supplier receipts', 'equipment manuals',
                 'accessibility plans', 'survey summaries', 'workshop handouts']
    findings = ['the entries were complete', 'two dates needed clarification',
                'the revised layout was easier to read', 'the totals matched the ledger',
                'a missing signature had been supplied', 'the labels used consistent names',
                'the new checklist covered every station', 'the spare parts were available']
    actions = ['send a short update before lunch', 'file the original in the cabinet',
               'ask the coordinator to confirm the schedule', 'bring copies to the next meeting',
               'check the measurements again on Monday', 'leave a clear note for the evening team',
               'summarize the result in the weekly digest', 'arrange a brief follow-up visit']
    templates = [
        '{person} reviewed the {material} at {place}. The review found that {finding}. The team agreed to {action}.',
        'During the morning visit to {place}, {person} compared the {material} with the working copy. Because {finding}, the next step was to {action}.',
        'The {place} office received {number} folders of {material}. {person} checked a sample and reported that {finding}; colleagues planned to {action}.',
        'A practical exercise at {place} used the {material} as reference. {person} noted that {finding}. Participants had enough time to {action}.',
        '{person} reserved {number} minutes for the {place} review. The discussion covered the {material}, established that {finding}, and ended with a decision to {action}.',
        'After the delivery reached {place}, the team asked {person} to organize the {material}. It was useful to learn that {finding}. The handover asked staff to {action}.',
        'The afternoon summary from {place} described an ordinary check of {material}. According to {person}, {finding}. Tomorrow the coordinator will {action}.',
        'There were {number} items on the {place} checklist. {person} used the {material} to confirm that {finding}, then made a reminder to {action}.',
        'Staff at {place} wanted a clearer account of the {material}. {person} prepared a concise explanation: {finding}. The remaining task was to {action}.',
        'Before closing the {place} desk, {person} read the {material} once more. The written summary says {finding}. The opening team should {action}.',
        'At the scheduled meeting, {person} brought the {material} from {place}. Everyone agreed that {finding}. A volunteer offered to {action}.',
        'The {place} archive now contains {number} labeled sets of {material}. {person} verified that {finding}. The local supervisor will {action}.',
    ]
    result = []
    for index in range(count):
        values = {'person': rng.choice(people), 'place': rng.choice(places),
                  'material': rng.choice(materials), 'finding': rng.choice(findings),
                  'action': rng.choice(actions), 'number': rng.randrange(3, 49)}
        note = rng.choice(templates).format(**values)
        result.append(f'Record {index + 1:04d}, day {index // 24 + 1}: {note}')
    return result


def prepare_prompt(tokenizer):
    header = ('Read the reference archive below, then answer the question after the final handover note. '
              'Use the codename stated in that final note. Return only the project codename.\n\n')
    footer = (f'\n\nFinal handover note: The project codename is {EXPECTED_CODENAME}. '
              'This is the confirmed name for the project.\n'
              'What is the project codename?\n'
              'Answer with only the project codename.')
    records = reference_records()

    def messages(body):
        return [{'role': 'user', 'content': header + body + footer}]

    def tokens(items):
        return len(tokenizer.apply_chat_template(items, tokenize=True,
                   add_generation_prompt=True, enable_thinking=False, return_dict=False))

    low, high = 0, len(records)
    while low < high:
        middle = (low + high + 1) // 2
        if tokens(messages('\n'.join(records[:middle]))) <= TARGET_INPUT_TOKENS:
            low = middle
        else:
            high = middle - 1
    body = '\n'.join(records[:low])
    # Complete natural-language notes fill the remaining gap before the answer.
    closing_notes = [
        'The archive follows the order of the visits.', 'Each entry records an ordinary operational update.',
        'Original paper copies remain in the office.', 'Dates refer to the local working calendar.',
        'The coordinator has a copy of the final checklist.', 'No additional meeting is scheduled today.',
        'The remaining folders are labeled for collection.', 'All rooms will reopen on the next working day.',
        'The final handover note follows these records.', 'The staff have completed the routine filing.',
    ]
    added_notes = 0
    for note in closing_notes:
        candidate = body + '\n' + note
        if tokens(messages(candidate)) <= TARGET_INPUT_TOKENS:
            body = candidate
            added_notes += 1
    items = messages(body)
    count = tokens(items)
    if not 32550 <= count <= 32630:
        raise ValueError(f'Prompt construction produced {count} tokens, outside the requested range.')
    content = items[0]['content']
    marker_start = content.rindex(EXPECTED_CODENAME)
    marker_suffix_tokens = len(tokenizer.encode(content[marker_start:], add_special_tokens=False))
    return items, {
        'local_prompt_tokens': count,
        'record_count': low,
        'closing_note_count': added_notes,
        'characters': len(content),
        'sha256': hashlib.sha256(content.encode()).hexdigest(),
        'seed': SEED,
        'expected_codename': EXPECTED_CODENAME,
        'marker_tokens_from_end_before_chat_template': marker_suffix_tokens,
        'max_output_tokens': MAX_OUTPUT_TOKENS,
        'local_input_plus_output_budget': count + MAX_OUTPUT_TOKENS,
        'prompt_tail': content[-700:],
    }


def post(base, body, timeout):
    request = urllib.request.Request(base + '/v1/chat/completions',
        data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    start = time.perf_counter()
    status = None
    raw = ''
    transport_error = None
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            raw = response.read().decode('utf-8', errors='replace')
    except urllib.error.HTTPError as error:
        status = error.code
        raw = error.read().decode('utf-8', errors='replace')
    except Exception as error:
        transport_error = {'type': type(error).__name__, 'message': str(error)}
    try:
        data = json.loads(raw) if raw else None
    except json.JSONDecodeError:
        data = {'non_json_body': raw}
    return {'http_status': status, 'elapsed_seconds': round(time.perf_counter() - start, 3),
            'response': data, 'transport_error': transport_error}


def save(path, report):
    report['checked_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(report, indent=2) + '\n')
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--services', default='docker,native,sglang')
    parser.add_argument('--output', default=str(ROOT / 'docs/long-context-answer-verification.json'))
    parser.add_argument('--timeout', type=int, default=240)
    parser.add_argument('--prepare-only', action='store_true', help='Tokenize and print prompt metadata; do not call services or write evidence.')
    args = parser.parse_args()
    services = [name.strip() for name in args.services.split(',') if name.strip()]
    if not services or any(name not in SERVICES for name in services):
        parser.error('Services must be a comma-separated selection of docker,native,sglang.')
    tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH, local_files_only=True)
    messages, prompt = prepare_prompt(tokenizer)
    if args.prepare_only:
        print(json.dumps(prompt, indent=2))
        return
    report = {
        'context_length': CONTEXT_LENGTH,
        'purpose': 'Usable visible text with varied reference material near the supported context limit.',
        'scope': 'One deterministic prompt with its answer near the end. This does not test long-range retrieval or establish general model quality.',
        'method': 'Same prompt and output budget; temperature 0; thinking disabled; all services called sequentially.',
        'endpoint': '/v1/chat/completions',
        'prompt': prompt,
        'services': [],
    }
    output = Path(args.output)
    save(output, report)
    for name in services:
        port, model = SERVICES[name]
        base = f'http://127.0.0.1:{port}'
        body = {'model': model, 'messages': messages, 'temperature': 0,
                'max_tokens': MAX_OUTPUT_TOKENS, 'stream': False,
                'chat_template_kwargs': {'enable_thinking': False}}
        result = post(base, body, args.timeout)
        data = result['response'] if isinstance(result['response'], dict) else {}
        choices = data.get('choices') or []
        first = choices[0] if choices else {}
        message = first.get('message') or {}
        text = message.get('content') if isinstance(message.get('content'), str) else ''
        usage = data.get('usage') or {}
        record = {'service_id': name, 'base_url': base, 'model': model, **result,
                  'output_text': text, 'finish_reason': first.get('finish_reason'), 'usage': usage,
                  'has_visible_text': bool(text.strip()),
                  'answered_codename': EXPECTED_CODENAME.casefold() in text.casefold(),
                  'exact_codename': text.strip().strip('"\' .').casefold() == EXPECTED_CODENAME.casefold(),
                  'reported_input_in_target_range': 32550 <= (usage.get('prompt_tokens') or 0) <= 32630}
        report['services'].append(record)
        save(output, report)
        print(json.dumps({key: record[key] for key in ['service_id', 'http_status', 'elapsed_seconds',
              'usage', 'output_text', 'finish_reason', 'answered_codename', 'transport_error']}), flush=True)
        # A timed-out request may still occupy the GPU upstream. Preserve evidence
        # and stop instead of accidentally overlapping the next service's request.
        if result['transport_error']:
            report['stopped_after_transport_error'] = name
            save(output, report)
            break


if __name__ == '__main__':
    main()
