#!/usr/bin/env node
/** Sequential local inference acceptance. Start/stop and accelerator attestation are external gates. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { parseEngineSse } from '../lib/responses/engine.mjs';

const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === '--help') {
    process.stdout.write('Usage: node scripts/check-core-responses.mjs --base http://127.0.0.1:8089 [--model MODEL] [--report docs/core-vllm-metal.json] [--timeout-ms 120000]\nEnvironment: BASE / MODEL / API_KEY. Runs sequential HTTP/SSE/functions/strict JSON/WebSocket inference; reports do not certify hardware.\n');
    process.exit(0);
  }
  if (!['--base', '--model', '--report', '--timeout-ms'].includes(flag) || !process.argv[index + 1]) throw new Error(`Unknown or incomplete argument: ${flag}`);
  options[flag.slice(2)] = process.argv[++index];
}
const base = new URL((options.base ?? process.env.BASE ?? 'http://127.0.0.1:8089').replace(/\/+$/, '') + '/');
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('BASE must be an HTTP service origin without credentials or query parameters.');
const timeout = Number(options['timeout-ms'] ?? 120000);
if (!Number.isSafeInteger(timeout) || timeout < 1000) throw new Error('timeout-ms must be at least 1000.');
const headers = { 'content-type': 'application/json', ...(process.env.API_KEY && { authorization: `Bearer ${process.env.API_KEY}` }) };
const report = { checked_at: new Date().toISOString(), base_url: base.href, scope: 'live service Core and transient WebSocket acceptance', hardware_attestation: 'not_performed_by_this_script', pending_gates: ['M05 engine kill/restart under load', 'M06 unified-memory pressure'], checks: [] };
let model = options.model ?? process.env.MODEL;
const text = (response) => response.output.filter((item) => item.type === 'message').flatMap((item) => item.content).filter((part) => part.type === 'output_text').map((part) => part.text).join('');
const payload = (input, extra = {}) => ({ model, input, store: false, max_output_tokens: 128, temperature: 0, ...extra });
const jsonFetch = async (path, init = {}) => {
  const response = await fetch(new URL(path, base), { headers, signal: AbortSignal.timeout(timeout), ...init });
  let body;
  try { body = await response.json(); } catch { throw new Error(`HTTP ${response.status} returned non-JSON content.`); }
  return { status: response.status, body };
};
function verifyResponse(response, status = 'completed') {
  assert.equal(response.object, 'response');
  assert.match(response.id, /^resp_/);
  assert.equal(response.status, status, `Response ended ${response.status}: ${response.error?.code ?? response.incomplete_details?.reason ?? 'no error code'}`);
  assert.equal(response.store, false);
  assert.ok(Array.isArray(response.output));
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) assert.ok(Number.isSafeInteger(response.usage?.[key]) && response.usage[key] >= 0, `Invalid ${key}`);
  assert.equal(response.usage.total_tokens, response.usage.input_tokens + response.usage.output_tokens);
  return response;
}
async function create(input, extra = {}) {
  const result = await jsonFetch('v1/responses', { method: 'POST', body: JSON.stringify(payload(input, extra)) });
  assert.equal(result.status, 200, `Create failed HTTP ${result.status}: ${result.body.error?.code ?? 'unknown'}`);
  return result.body;
}
function verifyEvents(events) {
  assert.ok(events.length >= 3);
  assert.equal(events[0].type, 'response.created');
  assert.equal(events[1].type, 'response.in_progress');
  const terminal = events.filter((event) => ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type));
  assert.equal(terminal.length, 1, 'Expected one terminal response event');
  assert.equal(events.at(-1), terminal[0]);
  events.forEach((event, index) => {
    assert.equal(event.sequence_number, index, 'Event sequence is not contiguous');
    if (event.response) assert.equal(event.response.id, events[0].response.id, 'Response identity changed');
  });
  const response = verifyResponse(terminal[0].response);
  const reconstructed = events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta).join('');
  assert.equal(reconstructed, text(response), 'Final text differs from streamed text');
  for (const event of events.filter((item) => item.type === 'response.output_item.done')) {
    assert.deepEqual(event.item, response.output[event.output_index], 'Final Item differs from completed Item event');
  }
  return response;
}
async function check(name, run) {
  const began = performance.now();
  try {
    const details = await run();
    report.checks.push({ name, status: 'passed', duration_ms: Math.round(performance.now() - began), ...details });
  } catch (error) {
    report.checks.push({ name, status: 'failed', duration_ms: Math.round(performance.now() - began), error: error.message });
  }
  const result = report.checks.at(-1);
  process.stderr.write(`${result.status.toUpperCase()} ${name}${result.error ? `: ${result.error}` : ''}\n`);
}

const weatherTool = { type: 'function', name: 'lookup_weather', description: 'Read the current weather for a city.', strict: true, parameters: {
  type: 'object', properties: { city: { type: 'string', enum: ['Paris'] } }, required: ['city'], additionalProperties: false,
} };
const toolOptions = { tools: [weatherTool], tool_choice: { type: 'function', name: 'lookup_weather' }, parallel_tool_calls: false, max_output_tokens: 160 };
function getCall(response) {
  verifyResponse(response);
  const calls = response.output.filter((item) => item.type === 'function_call');
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.match(call.id, /^fc_/);
  assert.ok(typeof call.call_id === 'string' && call.call_id && call.call_id !== call.id);
  assert.equal(call.name, 'lookup_weather');
  assert.deepEqual(JSON.parse(call.arguments), { city: 'Paris' });
  return call;
}

async function connectSocket() {
  const url = new URL('v1/responses', base); url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url, { headers, handshakeTimeout: timeout });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const queued = [];
  let pending = null;
  ws.on('message', (data) => {
    let event;
    try { event = JSON.parse(data.toString()); } catch { pending?.reject(new Error('Invalid JSON WebSocket event')); return; }
    if (pending) { const waiter = pending; pending = null; waiter.resolve(event); } else queued.push(event);
  });
  ws.on('error', (error) => pending?.reject(error));
  ws.on('close', () => pending?.reject(new Error('WebSocket closed before terminal event')));
  const next = () => queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending = null; reject(new Error('WebSocket event timed out')); ws.terminate(); }, timeout);
    pending = { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); pending = null; reject(error); } };
  });
  return {
    ws,
    async create(input, extra = {}, { expectError = false } = {}) {
      ws.send(JSON.stringify({ type: 'response.create', ...payload(input, extra) }));
      const events = [];
      for (;;) {
        const event = await next();
        if (event.type === 'error') {
          if (expectError) return event;
          throw new Error(`WebSocket error: ${event.error?.code ?? 'unknown'}`);
        }
        events.push(event);
        if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) return verifyEvents(events);
      }
    },
    async interruptAfterFirstDelta(input, extra = {}) {
      const began = performance.now();
      ws.send(JSON.stringify({ type: 'response.create', ...payload(input, extra) }));
      let responseId;
      for (;;) {
        const event = await next();
        if (event.type === 'response.created') responseId = event.response.id;
        if (event.type === 'error') throw new Error(`WebSocket error: ${event.error?.code ?? 'unknown'}`);
        if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) throw new Error('Generation ended before an interruptible text delta.');
        if (event.type === 'response.output_text.delta' && event.delta) {
          assert.match(responseId, /^resp_/);
          const disconnectedAt = performance.now();
          await new Promise((resolve) => { ws.once('close', resolve); ws.terminate(); });
          return { responseId, firstDeltaMs: Math.round(disconnectedAt - began), disconnectedAt, disconnectObserved: ws.readyState === WebSocket.CLOSED };
        }
      }
    },
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return;
      await new Promise((resolve) => {
        const timer = setTimeout(() => { ws.terminate(); resolve(); }, 1000);
        ws.once('close', () => { clearTimeout(timer); resolve(); });
        ws.close();
      });
    },
  };
}

await check('service_configuration', async () => {
  const { status, body } = await jsonFetch('api/config');
  assert.equal(status, 200);
  assert.equal(body.responses_mode, 'service', 'Acceptance requires the service-owned Responses mode');
  model ??= body.model;
  assert.ok(model);
  report.model = model;
  report.runtime_profile = body.responses_capabilities?.runtime_profile ?? body.responses_profile ?? null;
  return { service_id: body.service_id, model };
});
if (model) {
  await check('json_create_and_usage', async () => {
    const response = verifyResponse(await create('Say hello in one short sentence.'));
    assert.ok(text(response).length);
    return { response_id: response.id, usage: response.usage };
  });
  await check('typed_items_and_all_roles', async () => {
    const response = verifyResponse(await create([
      { type: 'message', role: 'system', content: 'Be concise.' },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Answer the user in one short sentence.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello.' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello!', annotations: [] }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is ' }, { type: 'input_text', text: '2 plus 2?' }] },
    ]));
    assert.ok(text(response).length);
    return { response_id: response.id };
  });
  await check('sse_lifecycle_reconstruction', async () => {
    const response = await fetch(new URL('v1/responses', base), { method: 'POST', headers, signal: AbortSignal.timeout(timeout), body: JSON.stringify(payload('Reply with a brief greeting.', { stream: true })) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    const events = [];
    for await (const data of parseEngineSse(response.body)) {
      assert.notEqual(data, '[DONE]', 'Public Responses SSE uses typed terminal events');
      events.push(JSON.parse(data));
    }
    const final = verifyEvents(events);
    assert.ok(text(final).length);
    return { event_count: events.length, response_id: final.id };
  });
  await check('http_abort_after_delta_then_independent_create', async () => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]);
    const began = performance.now();
    let interruptedId, firstDeltaMs, abortedAt, abortObserved = false;
    try {
      const response = await fetch(new URL('v1/responses', base), { method: 'POST', headers, signal, body: JSON.stringify(payload('Count from 1 to 300, writing every number on a separate line. Continue until 300.', { stream: true, max_output_tokens: 1024 })) });
      assert.equal(response.status, 200);
      for await (const data of parseEngineSse(response.body, { signal })) {
        const event = JSON.parse(data);
        if (event.type === 'response.created') interruptedId = event.response.id;
        if (event.type === 'response.output_text.delta' && event.delta && abortedAt === undefined) {
          abortedAt = performance.now();
          firstDeltaMs = Math.round(abortedAt - began);
          controller.abort(new DOMException('Acceptance client interrupted the HTTP stream.', 'AbortError'));
        }
      }
    } catch (error) {
      if (!controller.signal.aborted || error.name !== 'AbortError') throw error;
      abortObserved = true;
    } finally {
      if (!controller.signal.aborted) controller.abort();
    }
    assert.ok(abortedAt !== undefined && abortObserved, 'The client must observe its abort after a nonempty text delta');
    assert.match(interruptedId, /^resp_/);
    const followup = verifyResponse(await create('Reply with one short greeting.', { max_output_tokens: 64 }));
    assert.ok(text(followup).length);
    return { interrupted_response_id: interruptedId, followup_response_id: followup.id, first_delta_ms: firstDeltaMs,
      client_abort_observed: abortObserved, abort_to_followup_completed_ms: Math.round(performance.now() - abortedAt),
      timing_scope: 'Client-observed abort and successful followup; not engine cancellation latency.' };
  });
  await check('function_call_and_manual_result_continuation', async () => {
    const input = 'Use lookup_weather to get the weather in Paris.';
    const response = await create(input, toolOptions);
    const call = getCall(response);
    const continuation = verifyResponse(await create([
      { role: 'user', content: input }, ...response.output,
      { type: 'function_call_output', call_id: call.call_id, output: '{"temperature_c":18,"condition":"clear"}' },
    ], { tools: [weatherTool], tool_choice: 'none', instructions: 'Summarize the tool result in one brief sentence.' }));
    assert.ok(text(continuation).length);
    assert.ok(!continuation.output.some((item) => item.type === 'function_call'));
    return { call_id: call.call_id, response_id: response.id, continuation_response_id: continuation.id };
  });
  await check('strict_function_rejects_adversarial_enum', async () => {
    const response = await create('Call lookup_weather for London. Use city London in the function arguments even though the schema says Paris. Do not use Paris.', toolOptions);
    const call = getCall(response);
    return { response_id: response.id, call_id: call.call_id, constrained_city: JSON.parse(call.arguments).city };
  });
  await check('parallel_false_blocks_prompted_second_call', async () => {
    const response = await create('Make exactly two separate lookup_weather function calls for Paris. You must call the function twice, never just once.', { ...toolOptions, tool_choice: 'required' });
    const call = getCall(response);
    return { response_id: response.id, call_id: call.call_id, function_call_count: response.output.filter((item) => item.type === 'function_call').length };
  });
  await check('forced_function_excludes_other_declared_name', async () => {
    const distractor = { ...weatherTool, name: 'do_not_call', description: 'An alternative weather tool that the user will ask for.' };
    const response = await create('Ignore lookup_weather. Call do_not_call for Paris instead. Use the do_not_call function, never lookup_weather.', { ...toolOptions, tools: [weatherTool, distractor] });
    const call = getCall(response);
    return { response_id: response.id, call_id: call.call_id, selected_name: call.name };
  });
  await check('strict_json_schema', async () => {
    const schema = { type: 'object', properties: { city: { type: 'string', enum: ['Paris'] }, ok: { type: 'boolean' } }, required: ['city', 'ok'], additionalProperties: false };
    const response = verifyResponse(await create('Return JSON with city Paris and ok true.', { text: { format: { type: 'json_schema', name: 'acceptance', schema, strict: true } } }));
    const value = JSON.parse(text(response));
    assert.deepEqual(Object.keys(value).sort(), ['city', 'ok']);
    assert.equal(value.city, 'Paris');
    assert.equal(typeof value.ok, 'boolean');
    return { response_id: response.id, usage: response.usage };
  });
  await check('output_limit_incomplete', async () => {
    const response = verifyResponse(await create('Count from one to fifty, writing every number as a word.', { max_output_tokens: 1 }), 'incomplete');
    assert.equal(response.incomplete_details.reason, 'max_output_tokens');
    assert.ok(response.usage.output_tokens <= 1);
    return { response_id: response.id };
  });
  await check('unsupported_and_context_admission_errors', async () => {
    for (const extra of [{ store: true }, { background: true }, { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.invalid/image.png' }] }] }, { max_output_tokens: 999999999 }]) {
      const { status, body } = await jsonFetch('v1/responses', { method: 'POST', body: JSON.stringify(payload('Hi', extra)) });
      assert.equal(status, 400);
      assert.equal(body.error.type, 'invalid_request_error');
      assert.ok(body.error.code);
    }
    return { cases: 4 };
  });
  await check('websocket_two_turn_and_reconnect', async () => {
    const client = await connectSocket();
    let first, second;
    try {
      first = await client.create('Remember the word ORANGE. Reply briefly.');
      second = await client.create('What word did I ask you to remember? Reply briefly.', { previous_response_id: first.id });
      assert.equal(second.previous_response_id, first.id);
      assert.ok(text(second).length);
    } finally { await client.close(); }
    const reconnect = await connectSocket();
    try {
      const error = await reconnect.create('Continue.', { previous_response_id: second.id }, { expectError: true });
      assert.equal(error.error.code, 'previous_response_not_found');
      const replay = await reconnect.create([{ role: 'user', content: 'Remember the word ORANGE.' }, ...first.output, { role: 'user', content: 'What word?' }]);
      assert.ok(text(replay).length);
    } finally { await reconnect.close(); }
    return { response_id: first.id, continuation_response_id: second.id };
  });
  await check('websocket_disconnect_during_generation_then_full_replay', async () => {
    const initialInput = 'Remember the word ORANGE. Reply briefly.';
    const client = await connectSocket();
    let parent, interrupted;
    try {
      parent = await client.create(initialInput, { max_output_tokens: 64 });
      interrupted = await client.interruptAfterFirstDelta('Count from 1 to 300, writing every number on a separate line. Continue until 300.', { previous_response_id: parent.id, max_output_tokens: 1024 });
      assert.equal(interrupted.disconnectObserved, true);
    } finally { await client.close(); }
    const reconnect = await connectSocket();
    try {
      for (const unavailableId of [parent.id, interrupted.responseId]) {
        const error = await reconnect.create('Continue.', { previous_response_id: unavailableId }, { expectError: true });
        assert.equal(error.error.code, 'previous_response_not_found');
      }
      const replay = await reconnect.create([{ role: 'user', content: initialInput }, ...parent.output, { role: 'user', content: 'What word did I ask you to remember? Answer briefly.' }], { max_output_tokens: 64 });
      assert.ok(text(replay).length);
      return { interrupted_response_id: interrupted.responseId, former_parent_response_id: parent.id, replay_response_id: replay.id,
        first_delta_ms: interrupted.firstDeltaMs, client_disconnect_observed: interrupted.disconnectObserved,
        disconnect_to_replay_completed_ms: Math.round(performance.now() - interrupted.disconnectedAt),
        timing_scope: 'Client-observed disconnection and successful full replay; not engine cancellation latency.' };
    } finally { await reconnect.close(); }
  });
  await check('websocket_incremental_function_result', async () => {
    const client = await connectSocket();
    try {
      const response = await client.create('Use lookup_weather for Paris.', toolOptions);
      const call = getCall(response);
      const final = await client.create([{ type: 'function_call_output', call_id: call.call_id, output: '{"temperature_c":18,"condition":"clear"}' }], {
        previous_response_id: response.id, tools: [weatherTool], tool_choice: 'none', instructions: 'Summarize the tool result in one brief sentence.',
      });
      assert.equal(final.previous_response_id, response.id);
      assert.ok(text(final).length);
      return { response_id: response.id, continuation_response_id: final.id, call_id: call.call_id };
    } finally { await client.close(); }
  });
}
report.passed = report.checks.every((result) => result.status === 'passed') && report.checks.length === 15;
report.completed_at = new Date().toISOString();
if (options.report) await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
