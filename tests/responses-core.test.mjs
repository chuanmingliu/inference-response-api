import test from 'node:test';
import assert from 'node:assert/strict';
import { ResponseAssembler, responseUsage } from '../lib/responses/events.mjs';
import { ResponsesService } from '../lib/responses/service.mjs';
import { normalizeRequest, ResponseError } from '../lib/responses/validation.mjs';

// These expectations follow the saved design's I03-I08, E01-E09, T01-T06,
// S08 and V01/V05/V06/V07 gates. They are deterministic protocol fixtures,
// not hardware or captured-official-wire certification.
const profile = {
  id: 'fixture', context_length: 100, default_max_output_tokens: 10,
  admission: { count_input_tokens: true },
  capabilities: { text: true, streaming: true, function_calling: true, structured_outputs: true, json_object: true, developer_role: true, assistant_phase: false, parallel_tool_calls: true, reasoning: false },
};
const parameters = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
const tool = (name = 'weather', strict = true) => ({ type: 'function', name, parameters, strict });
const normalize = (changes = {}) => normalizeRequest({ model: 'fixture-model', store: false, input: 'Hello', ...changes }, { profile });
const terminalTypes = new Set(['response.completed', 'response.failed', 'response.incomplete']);

function harness(changes = {}, options = {}) {
  const events = [];
  let identifier = 0;
  const assembler = new ResponseAssembler(normalize(changes), {
    now: () => 1_700_000_000_000,
    makeId: (prefix) => `${prefix}_fixture_${++identifier}`,
    onEvent: async (event) => { events.push(event); },
    ...options,
  });
  return { assembler, events };
}

async function generate(generation, changes = {}, options = {}) {
  const result = harness(changes, options);
  await result.assembler.start();
  try {
    for (const event of generation) await result.assembler.consume(event);
    await result.assembler.finish();
  } catch (error) { await result.assembler.fail(error); }
  result.response = result.assembler.snapshot();
  return result;
}

function assertSingleTerminal(events, type) {
  assert.deepEqual(events.filter((event) => terminalTypes.has(event.type)).map((event) => event.type), [type]);
  assert.equal(events.at(-1).type, type);
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index));
}

function engineWith(generation, count = { input_tokens: 5, context_length: 100 }) {
  return {
    countInputTokens: async () => count,
    async *generate() { for (const event of generation) yield event; },
  };
}

test('simple Unicode response has canonical immutable snapshots and source-defined event order', async () => {
  const { events, response } = await generate([
    { type: 'text_delta', delta: '你好，' }, { type: 'text_delta', delta: '🌍!' },
    { type: 'usage', usage: { prompt_tokens: 7, completion_tokens: 4 } }, { type: 'finish', reason: 'stop' },
  ], { stream_options: { include_obfuscation: false } });
  assert.deepEqual(events.map((event) => event.type), [
    'response.created', 'response.in_progress', 'response.output_item.added',
    'response.content_part.added', 'response.output_text.delta', 'response.output_text.delta',
    'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed',
  ]);
  assertSingleTerminal(events, 'response.completed');
  assert.equal(response.id, 'resp_fixture_1');
  assert.equal(response.created_at, 1_700_000_000);
  assert.equal(response.completed_at, 1_700_000_000);
  assert.deepEqual(response.usage, { input_tokens: 7, output_tokens: 4, total_tokens: 11 });
  assert.deepEqual(response.output, [{
    id: 'msg_fixture_2', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: '你好，🌍!', annotations: [], logprobs: [] }],
  }]);
  assert.equal(Object.hasOwn(response, 'output_text'), false, 'output_text remains an SDK convenience rather than the canonical output');
  assert.deepEqual(events[0].response.output, []);
  assert.deepEqual(events[1].response.output, []);
  assert.equal(events[2].item.status, 'in_progress');
  assert.deepEqual(events[2].item.content, []);
  assert.equal(events[3].part.text, '');
  assert.deepEqual(events.at(-1).response, response);
  for (const event of events.filter((event) => event.item_id)) {
    assert.equal(event.item_id, response.output[event.output_index].id);
    if (event.content_index !== undefined) assert.equal(event.content_index, 0);
  }
});

test('interleaved parallel function arguments retain separate Item IDs, call IDs, indices and Unicode', async () => {
  const { events, response } = await generate([
    { type: 'tool_delta', index: 1, id: 'call_B', name: 'wea' },
    { type: 'tool_delta', index: 1, name: 'ther', arguments: '{"city":"' },
    { type: 'text_delta', delta: '查询：' },
    { type: 'tool_delta', index: 0, id: 'call_A', name: 'time', arguments: '{"city":' },
    { type: 'tool_delta', index: 1, arguments: '北京"}' },
    { type: 'tool_delta', index: 0, arguments: '"Paris"}' },
    { type: 'finish', reason: 'tool_calls' },
  ], { tools: [tool(), tool('time')] });
  assertSingleTerminal(events, 'response.completed');
  assert.deepEqual(response.output.map((item) => item.type), ['function_call', 'message', 'function_call']);
  const calls = response.output.filter((item) => item.type === 'function_call');
  assert.deepEqual(calls.map(({ call_id, name, arguments: args }) => ({ call_id, name, args })), [
    { call_id: 'call_B', name: 'weather', args: '{"city":"北京"}' },
    { call_id: 'call_A', name: 'time', args: '{"city":"Paris"}' },
  ]);
  assert.equal(new Set(response.output.map((item) => item.id)).size, 3);
  for (const item of calls) {
    assert.notEqual(item.id, item.call_id);
    const deltas = events.filter((event) => event.type === 'response.function_call_arguments.delta' && event.item_id === item.id);
    assert.equal(deltas.map((event) => event.delta).join(''), item.arguments);
    for (const event of deltas) assert.equal(response.output[event.output_index].call_id, item.call_id);
    const added = events.find((event) => event.type === 'response.output_item.added' && event.item.id === item.id);
    assert.equal(added.item.arguments, '');
    const done = events.find((event) => event.type === 'response.function_call_arguments.done' && event.item_id === item.id);
    // The pinned arguments-done schema contains no mandatory name or call_id.
    assert.deepEqual(Object.keys(done).sort(), ['arguments', 'item_id', 'output_index', 'sequence_number', 'type']);
    assert.equal(done.arguments, item.arguments);
  }
});

test('tool-only and empty responses preserve their canonical output instead of inventing text', async () => {
  const tools = await generate([
    { type: 'tool_delta', index: 0, id: 'call_only', name: 'weather', arguments: '{"city":"Paris"}' },
    { type: 'finish', reason: 'tool_calls' },
  ], { tools: [tool()] });
  assert.deepEqual(tools.response.output.map((item) => item.type), ['function_call']);
  assert.equal(tools.events.some((event) => event.type.startsWith('response.output_text.')), false);
  const empty = await generate([{ type: 'text_delta', delta: '' }, { type: 'finish', reason: 'stop' }]);
  assert.deepEqual(empty.response.output, []);
  assert.deepEqual(empty.events.map((event) => event.type), ['response.created', 'response.in_progress', 'response.completed']);
});

test('length cutoff preserves partial structured content and ends incomplete exactly once', async () => {
  const { response, events } = await generate([
    { type: 'text_delta', delta: '{"city":"Par' },
    { type: 'usage', usage: { prompt_tokens: 8, completion_tokens: 5 } },
    { type: 'finish', reason: 'length' },
  ], { max_output_tokens: 5, text: { format: { type: 'json_schema', name: 'answer', schema: parameters, strict: true } } });
  assertSingleTerminal(events, 'response.incomplete');
  assert.equal(response.status, 'incomplete');
  assert.equal(response.error, null);
  assert.deepEqual(response.incomplete_details, { reason: 'max_output_tokens' });
  assert.equal(response.output[0].status, 'incomplete');
  assert.equal(response.output[0].content[0].text, '{"city":"Par');
  assert.equal(response.completed_at, null);
});

test('content filter cutoff and refusal remain separate from ordinary text success', async () => {
  const cutoff = await generate([{ type: 'text_delta', delta: 'Partial' }, { type: 'finish', reason: 'content_filter' }]);
  assertSingleTerminal(cutoff.events, 'response.incomplete');
  assert.deepEqual(cutoff.response.incomplete_details, { reason: 'content_filter' });
  const refusal = await generate([{ type: 'refusal_delta', delta: 'Cannot ' }, { type: 'refusal_delta', delta: 'comply.' }, { type: 'finish', reason: 'stop' }], {
    text: { format: { type: 'json_schema', name: 'answer', schema: parameters, strict: true } },
  });
  assertSingleTerminal(refusal.events, 'response.completed');
  assert.deepEqual(refusal.response.output[0].content, [{ type: 'refusal', refusal: 'Cannot comply.' }]);
  assert.equal(refusal.events.find((event) => event.type === 'response.refusal.done').refusal, 'Cannot comply.');
});

test('malformed structured JSON, violated strict tools, and duplicate calls never emit completed', async () => {
  const cases = [
    { changes: { text: { format: { type: 'json_schema', name: 'answer', schema: parameters, strict: true } } }, generation: [{ type: 'text_delta', delta: '{"city":42}' }, { type: 'finish', reason: 'stop' }] },
    { changes: { text: { format: { type: 'json_object' } } }, generation: [{ type: 'text_delta', delta: '[]' }, { type: 'finish', reason: 'stop' }] },
    { changes: { tools: [tool()] }, generation: [{ type: 'tool_delta', index: 0, id: 'call_A', name: 'weather', arguments: '{}' }, { type: 'finish', reason: 'tool_calls' }] },
    { changes: { tools: [tool()] }, generation: [{ type: 'tool_delta', index: 0, id: 'call_A', name: 'weather', arguments: '{"city":"A"}' }, { type: 'tool_delta', index: 1, id: 'call_A', name: 'weather', arguments: '{"city":"B"}' }, { type: 'finish', reason: 'tool_calls' }] },
    { changes: {}, generation: [{ type: 'text_delta', delta: 'Partial' }] },
    { changes: {}, generation: [{ type: 'text_delta', delta: 'Partial' }, { type: 'finish', reason: 'stop' }, { type: 'finish', reason: 'length' }] },
  ];
  for (const { changes, generation } of cases) {
    const { events, response } = await generate(generation, changes);
    assertSingleTerminal(events, 'response.failed');
    assert.equal(response.error.code, 'invalid_upstream_response');
    assert.equal(response.status, 'failed');
    assert.ok(response.output.length > 0, 'already published partial output remains inspectable');
    assert.ok(response.output.every((item) => item.status === 'incomplete'));
  }
});

test('nonstrict function arguments still require a JSON object', async () => {
  for (const args of ['null', '[]', '42', '"string"']) {
    const { events, response } = await generate([
      { type: 'tool_delta', index: 0, id: 'call_A', name: 'weather', arguments: args },
      { type: 'finish', reason: 'tool_calls' },
    ], { tools: [tool('weather', false)] });
    assertSingleTerminal(events, 'response.failed');
    assert.equal(response.error.code, 'invalid_upstream_response');
  }
});

test('tool choice and parallel restrictions are enforced on generated calls', async () => {
  const call = (index, name = 'weather') => ({ type: 'tool_delta', index, id: `call_${index}`, name, arguments: '{"city":"Paris"}' });
  const cases = [
    [{ tools: [tool()], tool_choice: 'none' }, [call(0)]],
    [{ tools: [tool()], tool_choice: 'required' }, [{ type: 'text_delta', delta: 'No tool' }]],
    [{ tools: [tool(), tool('time')], tool_choice: { type: 'function', name: 'time' } }, [call(0)]],
    [{ tools: [tool(), tool('time')], tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'time' }] } }, [call(0)]],
    [{ tools: [tool()], parallel_tool_calls: false }, [call(0), call(1)]],
    [{ tools: [tool()] }, [call(0, 'unknown')]],
  ];
  for (const [changes, calls] of cases) {
    const { events } = await generate([...calls, { type: 'finish', reason: 'stop' }], changes);
    assertSingleTerminal(events, 'response.failed');
  }
});

test('output byte/Item limits and whole-response token budgets cannot produce false success', async () => {
  const byteLimit = await generate([{ type: 'text_delta', delta: '你' }, { type: 'finish', reason: 'stop' }], {}, { maxOutputBytes: 2 });
  assertSingleTerminal(byteLimit.events, 'response.failed');
  const itemLimit = await generate([
    { type: 'text_delta', delta: 'x' }, { type: 'tool_delta', index: 0, id: 'call_A', name: 'weather', arguments: '{"city":"Paris"}' },
    { type: 'finish', reason: 'stop' },
  ], { tools: [tool()] }, { maxOutputItems: 1 });
  assertSingleTerminal(itemLimit.events, 'response.failed');
  const tokenLimit = await generate([
    { type: 'text_delta', delta: 'Some text' }, { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 11 } }, { type: 'finish', reason: 'stop' },
  ], { max_output_tokens: 10 });
  assertSingleTerminal(tokenLimit.events, 'response.failed');
});

test('delta obfuscation defaults on and explicit opt-out applies to every delta kind', async () => {
  const generation = [
    { type: 'text_delta', delta: 'Hello' }, { type: 'refusal_delta', delta: 'No' },
    { type: 'tool_delta', index: 0, id: 'call_A', name: 'weather', arguments: '{"city":"Paris"}' }, { type: 'finish', reason: 'stop' },
  ];
  for (const enabled of [true, false]) {
    const { events } = await generate(generation, { tools: [tool()], ...(enabled ? {} : { stream_options: { include_obfuscation: false } }) });
    const deltas = events.filter((event) => event.type.endsWith('.delta'));
    assert.equal(deltas.length, 3);
    for (const event of deltas) {
      assert.equal(Object.hasOwn(event, 'obfuscation'), enabled);
      if (enabled) assert.match(event.obfuscation, /^[a-f0-9]{1,64}$/);
    }
    for (const event of events.filter((event) => !event.type.endsWith('.delta'))) assert.equal(Object.hasOwn(event, 'obfuscation'), false);
  }
});

test('terminal state is immutable to late engine events, repeated finish/fail and consumer mutation', async () => {
  const { assembler, response, events } = await generate([{ type: 'text_delta', delta: 'Final' }, { type: 'finish', reason: 'stop' }]);
  const count = events.length;
  await assembler.consume({ type: 'text_delta', delta: 'LATE' });
  await assembler.consume({ type: 'usage', usage: { prompt_tokens: 999, completion_tokens: 999 } });
  await assembler.finish();
  await assembler.fail(new Error('late failure'));
  assert.equal(events.length, count);
  assert.deepEqual(assembler.snapshot(), response);
  events.at(-1).response.output[0].content[0].text = 'consumer changed event';
  response.output[0].content[0].text = 'consumer changed snapshot';
  assert.equal(assembler.snapshot().output[0].content[0].text, 'Final');
});

test('usage records actual measured detail without fabricating cache or reasoning counts', () => {
  assert.equal(responseUsage(null), null);
  assert.deepEqual(responseUsage({ prompt_tokens: 8, completion_tokens: 3 }), { input_tokens: 8, output_tokens: 3, total_tokens: 11 });
  assert.deepEqual(responseUsage({ prompt_tokens: 8, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } }), {
    input_tokens: 8, output_tokens: 3, total_tokens: 11, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 },
  });
  for (const usage of [{ prompt_tokens: -1, completion_tokens: 0 }, { prompt_tokens: 1.5, completion_tokens: 0 }, { prompt_tokens: 1 }, { prompt_tokens: 1, completion_tokens: '2' }]) assert.throws(() => responseUsage(usage), (error) => error.code === 'invalid_upstream_response');
});

test('service converts an engine error after deltas into one failed terminal and never retries', async () => {
  let attempts = 0;
  const events = [];
  const engine = {
    countInputTokens: async () => ({ input_tokens: 5 }),
    async *generate() { attempts++; yield { type: 'text_delta', delta: 'Partial' }; throw new ResponseError(502, 'Upstream interrupted.', 'upstream_disconnected'); },
  };
  const service = new ResponsesService({ model: 'fixture-model', profile, engine });
  const { response } = await service.run(service.prepare({ store: false, input: 'Hello' }), { onEvent: async (event) => events.push(event) });
  assertSingleTerminal(events, 'response.failed');
  assert.equal(attempts, 1);
  assert.equal(response.output[0].content[0].text, 'Partial');
  assert.equal(response.error.code, 'upstream_disconnected');
  assert.equal(service.active, 0);
  assert.equal(service.tenants.size, 0);
});

test('post-start deadlines send failed terminal with partial output while transport remains writable', async () => {
  for (const code of ['upstream_timeout', 'request_timeout']) {
    const controller = new AbortController();
    const events = [];
    let attempts = 0;
    const timeout = new ResponseError(504, 'Generation deadline exceeded.', code);
    const engine = {
      countInputTokens: async () => ({ input_tokens: 5 }),
      async *generate() {
        attempts++;
        yield { type: 'text_delta', delta: 'Partial before timeout' };
        controller.abort(timeout);
        throw timeout;
      },
    };
    const service = new ResponsesService({ model: 'fixture-model', profile, engine });
    const { response } = await service.run(service.prepare({ store: false, input: 'Hello' }), {
      signal: controller.signal, onEvent: async (event) => events.push(event),
    });
    assertSingleTerminal(events, 'response.failed');
    assert.equal(events[0].type, 'response.created');
    assert.equal(response.error.code, code);
    assert.equal(response.output[0].content[0].text, 'Partial before timeout');
    assert.equal(response.output[0].status, 'incomplete');
    assert.equal(attempts, 1);
    assert.equal(service.active, 0);
  }
});

test('transport disconnect aborts generation without trying to publish a terminal to the closed consumer', async () => {
  const controller = new AbortController();
  const events = [];
  let cancelled = false;
  const disconnect = new Error('client disconnected');
  const engine = {
    countInputTokens: async () => ({ input_tokens: 5 }),
    async *generate() {
      try {
        yield { type: 'text_delta', delta: 'Partial before disconnect' };
        controller.abort(disconnect);
        throw disconnect;
      } finally { cancelled = true; }
    },
  };
  const service = new ResponsesService({ model: 'fixture-model', profile, engine });
  await assert.rejects(service.run(service.prepare({ store: false, input: 'Hello' }), {
    signal: controller.signal, onEvent: async (event) => { assert.equal(controller.signal.aborted, false); events.push(event); },
  }), (error) => error === disconnect);
  assert.equal(events.some((event) => terminalTypes.has(event.type)), false);
  assert.equal(cancelled, true);
  assert.equal(service.active, 0);
});

test('service enforces global and tenant concurrency and releases permits after failure', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const engine = {
    countInputTokens: async () => ({ input_tokens: 1 }),
    async *generate() { await gate; yield { type: 'finish', reason: 'stop' }; },
  };
  const service = new ResponsesService({ model: 'fixture-model', profile, engine, maxConcurrent: 2, maxConcurrentPerTenant: 1 });
  const request = service.prepare({ store: false, input: 'Hello' });
  const first = service.run(request, { tenant: 'one' });
  await assert.rejects(service.run(request, { tenant: 'one' }), (error) => error.status === 429 && error.code === 'rate_limit_exceeded' && error.retryAfter === 1);
  const second = service.run(request, { tenant: 'two' });
  await assert.rejects(service.run(request, { tenant: 'three' }), (error) => error.status === 429);
  assert.equal(service.active, 2);
  release();
  await Promise.all([first, second]);
  assert.equal(service.active, 0);
  assert.equal(service.tenants.size, 0);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(service.run(request, { signal: controller.signal }), /cancelled/);
  assert.equal(service.active, 0);
  assert.equal(service.tenants.size, 0);
});

test('service reserves output tokens using actual input counts before created or inference', async () => {
  let generated = 0;
  const events = [];
  const engine = {
    countInputTokens: async () => ({ input_tokens: 91, context_length: 100 }),
    async *generate() { generated++; yield { type: 'finish', reason: 'stop' }; },
  };
  const service = new ResponsesService({ model: 'fixture-model', profile, engine });
  const request = service.prepare({ store: false, input: 'Hello' });
  assert.equal(request.max_output_tokens, 10);
  await assert.rejects(service.run(request, { onEvent: async (event) => events.push(event) }), (error) => error.status === 400 && error.code === 'context_length_exceeded' && error.param === 'input');
  assert.equal(generated, 0);
  assert.deepEqual(events, []);
  assert.equal(service.active, 0);
  engine.countInputTokens = async () => ({ input_tokens: 90, context_length: 100 });
  const result = await service.run(request);
  assert.equal(result.response.status, 'completed');
  assert.equal(generated, 1);
  assert.throws(() => service.prepare({ store: false, input: 'Hello', max_output_tokens: 101 }), (error) => error.param === 'max_output_tokens');
});

test('mandatory token admission rejects missing counters and invalid engine context windows', async () => {
  for (const context_length of ['100', NaN, 0, -1, Infinity]) {
    const service = new ResponsesService({ model: 'fixture-model', profile, engine: engineWith([{ type: 'finish', reason: 'stop' }], { input_tokens: 90, context_length }) });
    await assert.rejects(service.run(service.prepare({ store: false, input: 'Hello' })), (error) => error.status === 502 && error.code === 'invalid_upstream_response');
    assert.equal(service.active, 0);
  }
  const service = new ResponsesService({ model: 'fixture-model', profile, engine: { async *generate() { yield { type: 'finish', reason: 'stop' }; } } });
  await assert.rejects(service.run(service.prepare({ store: false, input: 'Hello' })), /token|admission|count/i);
  assert.equal(service.active, 0);
});

test('continuation retains typed transcript but replaces top-level instructions each turn', async () => {
  const seen = [];
  const engine = {
    countInputTokens: async () => ({ input_tokens: 10 }),
    async *generate(request, { history }) { seen.push(structuredClone({ request, history })); yield { type: 'text_delta', delta: 'answer' }; yield { type: 'finish', reason: 'stop' }; },
  };
  const service = new ResponsesService({ model: 'fixture-model', profile, engine });
  const input = [{ role: 'system', content: 'persistent system' }, { role: 'developer', content: 'persistent developer' }, { role: 'user', content: 'question one' }];
  const first = await service.run(service.prepare({ store: false, input, instructions: 'instruction A' }));
  assert.equal(first.history.length, 4);
  const secondRequest = service.prepare({ store: false, input: 'question two', instructions: 'instruction B', previous_response_id: first.response.id }, { transport: 'websocket', history: first.history });
  const second = await service.run(secondRequest, { history: first.history });
  const thirdRequest = service.prepare({ store: false, input: 'question three', previous_response_id: second.response.id }, { transport: 'websocket', history: second.history });
  await service.run(thirdRequest, { history: second.history });
  assert.deepEqual(seen.map((entry) => entry.request.instructions), ['instruction A', 'instruction B', null]);
  assert.equal(JSON.stringify(first.history).includes('instruction A'), false);
  assert.equal(JSON.stringify(second.history).includes('instruction B'), false);
  assert.deepEqual(second.history.slice(0, 3).map((item) => item.role), ['system', 'developer', 'user']);
  assert.equal(seen[1].request.input.length, 1, 'the service must not duplicate predecessor Items into the new input');
  assert.deepEqual(seen[1].history, first.history);
  assert.equal(second.history.length, 6);
});

test('transient service does not retain response content or write it into operational telemetry', async () => {
  const privateInput = 'private-input-85cc2';
  const privateOutput = 'private-output-31fab';
  const privateInstruction = 'private-instruction-b6d2a';
  const logs = [];
  const service = new ResponsesService({ model: 'fixture-model', profile, engine: engineWith([{ type: 'text_delta', delta: privateOutput }, { type: 'finish', reason: 'stop' }]), logger: (entry) => logs.push(entry) });
  const { history } = await service.run(service.prepare({ store: false, input: privateInput, instructions: privateInstruction }), { requestId: 'req_fixture', tenant: 'tenant_fixture' });
  assert.ok(JSON.stringify(history).includes(privateInput));
  assert.ok(JSON.stringify(history).includes(privateOutput));
  const retained = JSON.stringify({ service, logs });
  for (const secret of [privateInput, privateOutput, privateInstruction]) assert.equal(retained.includes(secret), false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].request_id, 'req_fixture');
  assert.equal(logs[0].status, 'completed');
  assert.equal(service.active, 0);
  assert.equal(service.tenants.size, 0);
});

test('request byte admission includes continuation history rather than only the new turn', () => {
  const service = new ResponsesService({ model: 'fixture-model', profile, engine: engineWith([]), maxInputBytes: 2000 });
  const payload = { store: false, input: 'new turn' };
  assert.doesNotThrow(() => service.prepare(payload));
  const history = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old'.repeat(1000) }] }];
  assert.throws(() => service.prepare(payload, { transport: 'websocket', history }), (error) => error.status === 413 && error.code === 'request_too_large');
});

test('service prepares one engine execution and logs separate content-free preparation/admission timings', async () => {
  let preparations = 0, admissions = 0, generations = 0;
  const logs = [];
  const engine = {
    prepare(request, { history }) {
      preparations++;
      assert.equal(request.input[0].content[0].text, 'private prompt');
      assert.deepEqual(history, []);
      return {
        async countInputTokens() { admissions++; return { input_tokens: 3 }; },
        async *generate() { generations++; yield { type: 'text_delta', delta: 'private answer' }; yield { type: 'finish', reason: 'stop' }; },
      };
    },
    countInputTokens() { assert.fail('must use the prepared execution'); },
    generate() { assert.fail('must use the prepared execution'); },
  };
  const service = new ResponsesService({ model: 'fixture-model', profile, engine, logger: (entry) => logs.push(entry) });
  const request = service.prepare({ store: false, input: 'private prompt' });
  const result = await service.run(request);
  assert.deepEqual([preparations, admissions, generations], [1, 1, 1]);
  assert.equal(result.response.status, 'completed');
  assert.ok(Object.isFrozen(result.history));
  assert.ok(logs[0].engine_preparation_ms >= 0);
  assert.ok(logs[0].token_admission_ms >= 0);
  assert.equal(JSON.stringify(logs).includes('private'), false);
});
