import test from 'node:test';
import assert from 'node:assert/strict';
import { appendHistory, historyBytes, snapshotHistory } from '../lib/responses/history.mjs';
import { appendResponseHistory, normalizeRequest } from '../lib/responses/validation.mjs';
import { ResponsesService } from '../lib/responses/service.mjs';
import { getRuntimeProfile } from '../lib/responses/profiles.mjs';

const profile = getRuntimeProfile('vllm-metal');
const message = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const call = (id, status = 'completed', args = '{}') => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name: 'weather', arguments: args, status });
const result = (id) => ({ type: 'function_call_output', call_id: id, output: 'sunny' });
const normalize = (history, input, selectedProfile = profile) => normalizeRequest({ model: 'fixture', store: false, input }, { profile: selectedProfile, transport: 'websocket', history });

test('optional-profile normalization handles both uncached and cached history', () => {
  const payload = { model: 'fixture', store: false, input: 'hello' };
  assert.equal(normalizeRequest(payload).input[0].content[0].text, 'hello');
  const history = appendResponseHistory([], [message('earlier')]);
  assert.deepEqual(normalizeRequest(payload, { history }), normalizeRequest(payload, { history: structuredClone(history) }));
});

test('history snapshots isolate mutable sources and structurally share only frozen prefixes', () => {
  const source = [message('original')];
  const first = snapshotHistory(source);
  source[0].content[0].text = 'changed';
  assert.equal(first[0].content[0].text, 'original');
  assert.throws(() => { first[0].content[0].text = 'changed'; }, TypeError);
  const second = appendHistory(first, [message('next')]);
  assert.equal(second[0], first[0]);
  assert.equal(snapshotHistory(second), second);
  assert.equal(first.length, 1);
  const forged = Object.freeze([message('mutable child')]);
  assert.notEqual(snapshotHistory(forged)[0], forged[0]);
});

test('incremental byte accounting exactly matches JSON with Unicode, escapes and empty deltas', () => {
  let history = [];
  for (const items of [[], [message('你好🌍\n"\\')], [], [call('a'), result('a')], [], [message('last')]]) {
    history = appendHistory(history, items);
    assert.equal(historyBytes(history), Buffer.byteLength(JSON.stringify(history)));
  }
});

test('cached and replayed histories enforce the same tool linkage and duplicate Item checks', () => {
  const history = appendResponseHistory([], [message('hello'), call('a'), call('b')], profile);
  const cases = [
    [result('b'), result('a')], [result('a')], [result('x')],
    [result('a'), result('a'), result('b')], [result('a'), result('b'), call('a'), result('a')],
    [result('a'), result('b'), { ...message('duplicate'), id: 'fc_a' }],
  ];
  const outcome = (value, input) => {
    try { return { request: normalize(value, input) }; }
    catch (error) { return { code: error.code, param: error.param, message: error.message }; }
  };
  for (const input of cases) assert.deepEqual(outcome(history, input), outcome(structuredClone(history), input));
  assert.equal(normalize(history, cases[0]).input.length, 2);
});

test('incomplete call JSON is returned but cannot become a valid cached continuation', () => {
  for (const item of [call('a', 'incomplete'), call('a', 'incomplete', '{')]) {
    const history = appendResponseHistory([], [item], profile);
    for (const value of [history, structuredClone(history)]) assert.throws(() => normalize(value, [result('a')]));
    const extended = appendResponseHistory(history, [message('next')], profile);
    assert.throws(() => normalize(extended, [result('a')]));
  }
});

test('history normalization cache cannot bypass a different runtime capability profile', () => {
  const history = appendResponseHistory([], [call('a'), result('a')], profile);
  assert.equal(normalize(history, []).input.length, 0);
  assert.throws(() => normalize(history, [], getRuntimeProfile('dmr-metal')), { code: 'unsupported_parameter' });
  assert.throws(() => normalize(Object.freeze([{ ...message('bad'), phase: 'commentary' }]), []), { code: 'invalid_request_error' });
});

test('cached history obeys the same exact input byte boundary as full replay', () => {
  const history = appendResponseHistory([], [message('你好🌍')], profile);
  const payload = { model: 'fixture', store: false, input: 'next' };
  const baseline = new ResponsesService({ profile, model: 'fixture', engine: {} });
  const request = baseline.prepare(payload, { transport: 'websocket', history });
  const limit = Buffer.byteLength(JSON.stringify([history, request]));
  for (const value of [history, structuredClone(history)]) {
    const exact = new ResponsesService({ profile, model: 'fixture', engine: {}, maxInputBytes: limit });
    assert.deepEqual(exact.prepare(payload, { history: value }), request);
    const tooSmall = new ResponsesService({ profile, model: 'fixture', engine: {}, maxInputBytes: limit - 1 });
    assert.throws(() => tooSmall.prepare(payload, { history: value }), { code: 'request_too_large' });
  }
});
