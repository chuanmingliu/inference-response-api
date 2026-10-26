import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngineAdapter, compileChatRequest, compileMessages, parseEngineSse } from '../lib/responses/engine.mjs';
import { RUNTIME_PROFILES, getRuntimeProfile } from '../lib/responses/profiles.mjs';

const profile = getRuntimeProfile('vllm-metal');
const user = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const request = (options = {}) => ({ model: 'test-model', input: [user('Hi')], tools: [], tool_choice: 'auto', parallel_tool_calls: true, text: { format: { type: 'text' } }, ...options });
const tool = (name = 'weather') => ({ type: 'function', name, description: `Run ${name}`, strict: true, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } });
const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, prompt_tokens_details: { cached_tokens: 2 } };
const frame = (value, newline = '\n') => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}${newline}${newline}`;
const choice = (delta = {}, reason = null) => ({ id: 'chatcmpl-private', choices: [{ index: 0, delta, finish_reason: reason }] });
const finish = (reason = 'stop') => frame(choice({}, reason)) + frame({ choices: [], usage }) + frame('[DONE]');
function streamResponse(text, chunkSize = Infinity, cancelled = () => {}) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const end = Math.min(bytes.length, offset + chunkSize);
      controller.enqueue(bytes.slice(offset, end)); offset = end;
    },
    cancel: cancelled,
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
function adapterWith(text, options = {}) {
  const seen = [];
  const adapter = createEngineAdapter({
    upstream: 'http://engine.local/v1', model: 'test-model', profile,
    fetchImpl: async (url, init) => { seen.push({ url: String(url), ...init, body: JSON.parse(init.body) }); return streamResponse(text, options.chunkSize); },
    ...options,
  });
  return { adapter, seen };
}
const collect = async (iterator) => { const all = []; for await (const item of iterator) all.push(item); return all; };

for (const name of ['vllm-metal', 'sglang-metal', 'vllm-cuda', 'sglang-cuda']) {
  test(`${name} is explicitly unverified with isolated runtime pins and exact admission`, () => {
    const configured = getRuntimeProfile(name);
    assert.equal(configured.id, name);
    assert.equal(configured.acceptance.core, 'pending');
    assert.equal(configured.acceptance.hardware, 'pending');
    assert.equal(configured.admission.count_input_tokens, true);
    assert.equal(configured.capabilities.assistant_phase, false);
    assert.ok(configured.runtime);
    assert.ok(Object.isFrozen(configured));
  });
}
test('legacy DMR never advertises a mandatory Core capability it cannot support', () => {
  const dmr = RUNTIME_PROFILES['dmr-metal'];
  assert.equal(dmr.capabilities.function_calling, false);
  assert.equal(dmr.capabilities.structured_outputs, false);
  assert.equal(dmr.acceptance.core, 'unsupported');
});

test('canonical history preserves role/text order, current instructions, tool linkage and text parts', () => {
  const history = [
    { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'explicit prior system' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'one' }, { type: 'refusal', refusal: 'declined' }, { type: 'output_text', text: 'two' }] },
    { type: 'function_call', id: 'fc_public_id', call_id: 'call_shared', name: 'weather', arguments: '{}' },
  ];
  const input = [
    { type: 'function_call_output', call_id: 'call_shared', output: [{ type: 'input_text', text: 'sun' }, { type: 'input_text', text: 'ny' }] },
    user('continue'),
  ];
  const messages = compileMessages(request({ instructions: 'new instructions', input }), history, profile);
  assert.deepEqual(messages, [
    { role: 'system', content: 'new instructions' },
    { role: 'system', content: 'explicit prior system' },
    { role: 'assistant', content: 'onedeclinedtwo', tool_calls: [{ id: 'call_shared', type: 'function', function: { name: 'weather', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_shared', content: 'sunny' },
    { role: 'user', content: 'continue' },
  ]);
  assert.ok(!JSON.stringify(messages).includes('fc_public_id'));
  assert.deepEqual(compileMessages(request(), [], profile), [{ role: 'user', content: 'Hi' }]);
});

test('pure function replay compiles one assistant call container with safe empty content', () => {
  const input = [
    { type: 'function_call', call_id: 'call_a', name: 'a', arguments: '{}' },
    { type: 'function_call', call_id: 'call_b', name: 'b', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_b', output: 'B' },
    { type: 'function_call_output', call_id: 'call_a', output: 'A' },
  ];
  const messages = compileMessages(request({ input }), [], profile);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].content, '');
  assert.equal(messages[0].tool_calls.length, 2);
  assert.equal(messages[1].tool_call_id, 'call_b');
});

test('unsupported assistant phase and developer role reject before engine dispatch', async () => {
  const { adapter, seen } = adapterWith(finish(), { profile: getRuntimeProfile('dmr-metal') });
  for (const item of [
    { type: 'message', role: 'assistant', content: [], phase: 'commentary' },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'guidance' }] },
  ]) await assert.rejects(collect(adapter.generate(request({ input: [item] }))), { status: 400, code: 'unsupported_parameter' });
  assert.equal(seen.length, 0);
  const supportsDeveloper = { ...profile, capabilities: { ...profile.capabilities, developer_role: true } };
  assert.equal(compileMessages(request({ input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'guide' }] }] }), [], supportsDeveloper)[0].role, 'developer');
});

test('unmatched, duplicate or already-answered tool correlation rejects', () => {
  const call = { type: 'function_call', call_id: 'call_a', name: 'a', arguments: '{}' };
  const result = { type: 'function_call_output', call_id: 'call_a', output: 'A' };
  for (const input of [[result], [call, call], [call, result, result]]) {
    assert.throws(() => compileMessages(request({ input }), [], profile), { status: 400, code: 'invalid_request_error' });
  }
});

test('strict schema and function settings map to native constrained decoding without state flags', () => {
  const format = { type: 'json_schema', name: 'answer', strict: true, schema: tool().parameters };
  const { body } = compileChatRequest(request({ instructions: 'answer', tools: [tool()], tool_choice: { type: 'function', name: 'weather' }, parallel_tool_calls: false, max_output_tokens: 45, temperature: 0, top_p: 0.8, store: false, background: false, previous_response_id: 'resp_private' }), [], profile);
  const structured = compileChatRequest(request({ text: { format } }), [], profile).body;
  assert.deepEqual(structured.response_format, { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: tool().parameters } });
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'weather', description: 'Run weather', parameters: tool().parameters, strict: true } }]);
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'weather' } });
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.max_tokens, 45);
  assert.equal(body.temperature, 0);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  for (const field of ['store', 'background', 'previous_response_id', 'request_id', 'input', 'instructions', 'text']) assert.ok(!(field in body));
});

test('allowed_tools dispatches only the selected subset, with required semantics', () => {
  const { body } = compileChatRequest(request({ tools: [tool('a'), tool('b')], tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'b' }] } }), [], profile);
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].function.name, 'b');
  assert.equal(body.tool_choice, 'required');
});

test('unsupported formats, tools, choices and configurations fail clearly', () => {
  const dmr = getRuntimeProfile('dmr-metal');
  for (const payload of [request({ tools: [tool()] }), request({ text: { format: { type: 'json_object' } } }), request({ text: { format: { type: 'json_schema', name: 'x', schema: {} } } })]) {
    assert.throws(() => compileChatRequest(payload, [], dmr), { status: 400, code: 'unsupported_parameter' });
  }
  assert.throws(() => compileChatRequest(request({ tool_choice: 'required' }), [], profile), { status: 400 });
  assert.throws(() => createEngineAdapter({ upstream: 'http://local/v1', profile: 'unknown' }), { code: 'invalid_engine_configuration' });
  assert.throws(() => createEngineAdapter({ upstream: 'file:///private/file', profile }), { code: 'invalid_engine_configuration' });
  assert.throws(() => createEngineAdapter({ upstream: 'http://local/v1', profile: { ...profile, engine: 'another' } }), { code: 'invalid_engine_configuration' });
});

test('byte fragmented UTF-8, LF, CRLF and CR SSE decode to the same internal events', async () => {
  for (const newline of ['\n', '\r', '\r\n']) {
    const text = `: heartbeat${newline}${newline}` + frame(choice({ role: 'assistant', content: '你🌍' }), newline) + frame(choice({}, 'stop'), newline) + frame({ choices: [], usage }, newline) + `data: [DONE]`;
    const { adapter, seen } = adapterWith(text, { chunkSize: 1, upstreamApiKey: 'local-secret' });
    const events = await collect(adapter.generate(request(), { requestId: 'req_test' }));
    assert.deepEqual(events, [{ type: 'text_delta', delta: '你🌍' }, { type: 'usage', usage }, { type: 'finish', reason: 'stop' }]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'http://engine.local/v1/chat/completions');
    assert.equal(seen[0].headers.authorization, 'Bearer local-secret');
    assert.equal(seen[0].headers['x-request-id'], 'req_test');
    assert.equal(seen[0].redirect, 'error', 'Inference must not forward credentials or input to redirects');
    assert.ok(!JSON.stringify(events).includes('chatcmpl-private'));
  }
});

test('SSE accepts multi-data lines and unterminated final events', async () => {
  const text = 'event: message\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\r\n\r\n' + finish();
  const { adapter } = adapterWith(text, { chunkSize: 3 });
  assert.equal((await collect(adapter.generate(request())))[0].delta, 'ok');
  const response = streamResponse('data: first\ndata: second');
  assert.deepEqual(await collect(parseEngineSse(response.body)), ['first\nsecond']);
});

test('tool-only output has no synthetic text, stable IDs and fragmented names/arguments', async () => {
  const text = frame(choice({ tool_calls: [{ index: 0, id: 'call_weather', type: 'function', function: { name: 'wea', arguments: '{' } }] }))
    + frame(choice({ tool_calls: [{ index: 0, function: { name: 'ther', arguments: '}' } }] })) + finish('tool_calls');
  const { adapter } = adapterWith(text, { chunkSize: 7 });
  const events = await collect(adapter.generate(request({ tools: [tool()], tool_choice: 'required', parallel_tool_calls: false })));
  assert.deepEqual(events.slice(0, 2), [
    { type: 'tool_delta', index: 0, id: 'call_weather', name: 'wea', arguments: '{' },
    { type: 'tool_delta', index: 0, name: 'ther', arguments: '}' },
  ]);
  assert.ok(events.every((event) => event.type !== 'text_delta'));
});

test('empty and refusal streams remain empty/refusal rather than fabricated text', async () => {
  const empty = adapterWith(frame(choice({ content: '' })) + finish());
  assert.deepEqual(await collect(empty.adapter.generate(request())), [{ type: 'usage', usage }, { type: 'finish', reason: 'stop' }]);
  const refusal = adapterWith(frame(choice({ refusal: 'Cannot comply.' })) + finish());
  assert.equal((await collect(refusal.adapter.generate(request())))[0].type, 'refusal_delta');
});

test('engine tool-choice and parallelism violations are detected', async () => {
  const call = (index, name, id = `call_${index}`) => ({ index, id, type: 'function', function: { name, arguments: '{}' } });
  const cases = [
    [request({ tools: [tool()], tool_choice: 'none' }), [call(0, 'weather')]],
    [request({ tools: [tool()], parallel_tool_calls: false }), [call(0, 'weather'), call(1, 'weather')]],
    [request({ tools: [tool()] }), [call(0, 'unknown')]],
    [request({ tools: [tool()] }), [call(0, 'weather', 'same'), call(1, 'weather', 'same')]],
    [request({ tools: [tool('a'), tool('b')], tool_choice: { type: 'function', name: 'a' } }), [call(0, 'b')]],
    [request({ tools: [tool('a'), tool('b')], tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'a' }] } }), [call(0, 'b')]],
  ];
  for (const [payload, toolCalls] of cases) {
    const { adapter } = adapterWith(frame(choice({ tool_calls: toolCalls })) + finish('tool_calls'));
    await assert.rejects(collect(adapter.generate(payload)), { status: 502, code: 'invalid_upstream_response' });
  }
  const { adapter } = adapterWith(finish());
  await assert.rejects(collect(adapter.generate(request({ tools: [tool()], tool_choice: 'required' }))), /required function/);
});

test('stream errors, missing terminal/usage, malformed chunks and unsupported content never become success', async () => {
  const broken = [
    frame(choice({ content: 'partial' })),
    frame(choice({}, 'stop')) + frame('[DONE]'),
    frame({ choices: [], usage }) + frame('[DONE]'),
    'data: {invalid}\n\n',
    frame({ error: { message: 'secret engine failure' } }),
    frame({ choices: [{ index: 1, delta: {} }] }),
    frame(choice({ reasoning_content: 'hidden raw reasoning' })) + finish(),
    frame(choice({ content: { text: 'wrong shape' } })) + finish(),
    frame(choice({ tool_calls: [null] })) + finish(),
    frame(choice({}, 'stop')) + frame(choice({ content: 'too late' })) + finish(),
    frame(choice({}, 'tool_calls')) + frame({ choices: [], usage }) + frame('[DONE]'),
  ];
  for (const text of broken) {
    const { adapter } = adapterWith(text);
    await assert.rejects(collect(adapter.generate(request())), { status: 502 });
  }
});

test('size limits bound event buffers, total stream and generated output', async () => {
  const checks = [
    [{ max_event_bytes: 50 }, frame(choice({ content: 'x'.repeat(100) })) + finish()],
    [{ max_output_bytes: 4 }, frame(choice({ content: 'hello' })) + finish()],
    [{ max_stream_bytes: 10 }, ': heartbeat\n\n'.repeat(20) + finish()],
  ];
  for (const [limits, text] of checks) {
    const { adapter } = adapterWith(text, { profile: { ...profile, limits: { ...profile.limits, ...limits } } });
    await assert.rejects(collect(adapter.generate(request())), /size limit/);
  }
});

test('invalid UTF-8 is rejected rather than silently repaired', async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0xff])); controller.close(); } }));
  await assert.rejects(collect(parseEngineSse(response.body)), /invalid UTF-8/);
});

test('cancellation while blocked on the body releases the reader and stops generation', async () => {
  let canceled = false;
  const controller = new AbortController();
  const adapter = createEngineAdapter({ upstream: 'http://engine/v1', profile, fetchImpl: async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'content-type': 'text/event-stream' } }) });
  const collecting = collect(adapter.generate(request(), { signal: controller.signal }));
  setTimeout(() => controller.abort(new DOMException('Cancelled', 'AbortError')), 10);
  await assert.rejects(collecting, { name: 'AbortError' });
  assert.equal(canceled, true);
});

test('early iterator return cancels the upstream reader', async () => {
  let canceled = false;
  const adapter = createEngineAdapter({ upstream: 'http://engine/v1', profile, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(frame(choice({ content: 'first' })))); },
    cancel() { canceled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }) });
  for await (const event of adapter.generate(request())) { assert.equal(event.type, 'text_delta'); break; }
  assert.equal(canceled, true);
});

test('fetch abort preserves cancellation and non-abort failures are not retried', async () => {
  let count = 0;
  const adapter = createEngineAdapter({ upstream: 'http://engine/v1', profile, fetchImpl: async () => { count++; throw new Error('private connection details'); } });
  await assert.rejects(collect(adapter.generate(request())), { status: 502, code: 'upstream_unavailable' });
  assert.equal(count, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collect(adapter.generate(request(), { signal: controller.signal })), { name: 'AbortError' });
  assert.equal(count, 1);
});

for (const runtime of ['vllm-metal', 'sglang-metal']) {
  test(`${runtime} counts exact rendered messages/tools with engine tokenizer and context limit`, async () => {
    const seen = [];
    const adapter = createEngineAdapter({ upstream: 'http://engine/v1', profile: runtime, fetchImpl: async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(init.body), redirect: init.redirect });
      return Response.json({ count: 124, max_model_len: 16000, tokens: [1, 2] });
    } });
    const payload = request({ tools: [tool()], tool_choice: 'none' });
    assert.deepEqual(await adapter.countInputTokens(payload), { input_tokens: 124, context_length: 16000 });
    assert.equal(seen[0].url, runtime === 'vllm-metal' ? 'http://engine/tokenize' : 'http://engine/v1/tokenize');
    const generated = compileChatRequest(payload, [], getRuntimeProfile(runtime)).body;
    assert.deepEqual(seen[0].body.messages, generated.messages);
    assert.deepEqual(seen[0].body.tools, generated.tools);
    assert.deepEqual(seen[0].body.chat_template_kwargs, generated.chat_template_kwargs);
    assert.ok(!('stream' in seen[0].body));
    assert.equal(seen[0].redirect, 'error', 'Tokenization must not follow redirects');
  });
}

test('tokenization failures are surfaced without token estimation or generation', async () => {
  let calls = 0;
  const adapter = createEngineAdapter({ upstream: 'http://engine/v1', profile, fetchImpl: async () => { calls++; return Response.json({ count: '124' }); } });
  await assert.rejects(adapter.countInputTokens(request()), /invalid exact token count/);
  assert.equal(calls, 1);
});

test('upstream HTTP errors preserve context/rate-limit classes without leaking raw bodies', async () => {
  for (const [status, response, code, publicStatus] of [
    [400, { error: { message: 'maximum context length exceeded secret prompt', code: 'context_length_exceeded' } }, 'context_length_exceeded', 400],
    [429, { error: { message: 'private rate limiter' } }, 'rate_limit_exceeded', 429],
    [500, { error: { message: 'private traceback' } }, 'upstream_error', 502],
  ]) {
    const adapter = createEngineAdapter({ upstream: 'http://engine/v1', profile, fetchImpl: async () => Response.json(response, { status }) });
    await assert.rejects(collect(adapter.generate(request())), (error) => error.code === code && error.status === publicStatus && !/secret|private/.test(error.message));
  }
});

test('structured text plus active tools rejects before tokenizer or inference on both engines', async () => {
  for (const name of ['vllm-metal', 'sglang-metal']) {
    let calls = 0;
    const adapter = createEngineAdapter({ upstream: 'http://engine/v1', profile: name, fetchImpl: async () => { calls++; return Response.json({}); } });
    const payload = request({ tools: [tool()], text: { format: { type: 'json_schema', name: 'a', schema: tool().parameters, strict: true } } });
    for (const tool_choice of ['auto', 'required', { type: 'function', name: 'weather' }]) {
      const chosen = { ...payload, tool_choice };
      await assert.rejects(adapter.countInputTokens(chosen), { status: 400, code: 'unsupported_parameter', param: 'text.format' });
      await assert.rejects(collect(adapter.generate(chosen)), { status: 400, code: 'unsupported_parameter', param: 'text.format' });
    }
    assert.equal(calls, 0);
    assert.equal(compileChatRequest({ ...payload, tool_choice: 'none' }, [], getRuntimeProfile(name)).body.response_format.type, 'json_schema');
  }
});

test('SGLang native grammar enforces required/forced selection and call count before sampling', () => {
  const sglang = getRuntimeProfile('sglang-metal');
  for (const tool_choice of ['auto', 'required', { type: 'function', name: 'a' }]) {
    const { body } = compileChatRequest(request({ tools: [tool('a'), { ...tool('b'), strict: false }], tool_choice, parallel_tool_calls: false }), [], sglang);
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.response_format.type, 'structural_tag');
    const grammar = body.response_format.format;
    assert.equal(grammar.stop_after_first, true);
    assert.equal(grammar.at_least_one, tool_choice !== 'auto');
    if (typeof tool_choice === 'object') {
      assert.equal(body.tools.length, 1);
      assert.equal(body.tools[0].function.name, 'a');
      assert.equal(grammar.tags.length, 1);
    } else {
      assert.equal(grammar.tags.length, 2);
      assert.deepEqual(grammar.tags[1].content.json_schema, {}, 'strict:false must not enforce the declared argument schema');
    }
    assert.deepEqual(grammar.tags[0].content.json_schema, tool().parameters);
  }
});

test('SGLang tokenizer sees the same forced subset and actual dispatch choice as generation', async () => {
  let counted;
  const adapter = createEngineAdapter({ upstream: 'http://engine/v1', profile: 'sglang-metal', fetchImpl: async (_url, init) => { counted = JSON.parse(init.body); return Response.json({ count: 10, max_model_len: 32768 }); } });
  const payload = request({ tools: [tool('a'), tool('b')], tool_choice: { type: 'function', name: 'b' }, parallel_tool_calls: false });
  await adapter.countInputTokens(payload);
  const { body } = compileChatRequest(payload, [], getRuntimeProfile('sglang-metal'));
  assert.deepEqual(counted.tools, body.tools);
  assert.equal(counted.tool_choice, body.tool_choice);
  assert.equal(counted.tools[0].function.name, 'b');
});

test('legitimate token cutoffs preserve incomplete outcomes before tool identity or within arguments', async () => {
  const chosen = request({ tools: [tool()], tool_choice: 'required', parallel_tool_calls: false });
  const beforeName = adapterWith(finish('length'));
  const early = await collect(beforeName.adapter.generate(chosen));
  assert.deepEqual(early.at(-1), { type: 'finish', reason: 'length' });
  assert.ok(!early.some((event) => event.type === 'tool_delta'));
  const partialArgs = frame(choice({ tool_calls: [{ index: 0, id: 'call_partial', type: 'function', function: { name: 'weather', arguments: '{"city":' } }] })) + finish('length');
  const afterName = await collect(adapterWith(partialArgs).adapter.generate(chosen));
  assert.equal(afterName[0].arguments, '{"city":');
  assert.deepEqual(afterName.at(-1), { type: 'finish', reason: 'length' });
});

test('a cutoff does not turn malformed emitted tool identity into a callable function', async () => {
  const chosen = request({ tools: [tool()], tool_choice: 'required' });
  for (const first of [
    { index: 0, id: 'call_missing_name', function: { arguments: '{' } },
    { index: 0, function: { name: 'weather', arguments: '{' } },
    { index: 0, id: 'call_partial_name', function: { name: 'wea', arguments: '' } },
  ]) {
    const { adapter } = adapterWith(frame(choice({ tool_calls: [first] })) + finish('length'));
    await assert.rejects(collect(adapter.generate(chosen)), { status: 502, code: 'invalid_upstream_response' });
  }
});

for (const runtime of ['vllm-metal', 'sglang-metal']) {
  test(`${runtime} request-local preparation snapshots messages/tools once across tokenization and generation`, async () => {
    const seen = [];
    const adapter = createEngineAdapter({
      upstream: 'http://engine.local/v1', profile: runtime,
      fetchImpl: async (url, init) => {
        seen.push({ path: url.pathname, body: JSON.parse(init.body), redirect: init.redirect });
        return url.pathname.endsWith('chat/completions')
          ? streamResponse(frame(choice({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'weather', arguments: '{}' } }] })) + finish('tool_calls'))
          : Response.json({ count: 5 });
      },
    });
    const input = request({ tools: [tool()], tool_choice: { type: 'function', name: 'weather' }, parallel_tool_calls: false });
    const history = [user('earlier')];
    const prepared = adapter.prepare(input, { history });
    await prepared.countInputTokens();
    // Mutation between the awaits must not invalidate the admitted snapshot.
    history[0].content[0].text = 'changed history';
    input.input[0].content[0].text = 'changed input';
    input.tools[0].parameters.properties.injected = { type: 'string' };
    Object.defineProperty(input, 'input', { get() { throw new Error('compiled twice'); } });
    await collect(prepared.generate());
    assert.deepEqual(seen[0].body.messages, seen[1].body.messages);
    assert.deepEqual(seen[0].body.tools, seen[1].body.tools);
    assert.equal(seen[1].body.messages[0].content, 'earlier');
    assert.equal(seen[1].body.messages[1].content, 'Hi');
    assert.equal(seen[1].body.parallel_tool_calls, false);
    assert.ok(seen.every((entry) => entry.redirect === 'error'));
    const fresh = adapter.prepare(request({ input: [user('fresh request')] }));
    await fresh.countInputTokens();
    assert.deepEqual(seen.at(-1).body.messages, [{ role: 'user', content: 'fresh request' }]);
    const controller = new AbortController();
    controller.abort(new Error('cancel prepared execution'));
    await assert.rejects(collect(fresh.generate({ signal: controller.signal })), /cancel prepared/);
    assert.equal(seen.length, 3, 'aborted prepared generation must not dispatch');
  });
}
