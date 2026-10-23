import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createServer } from '../server.mjs';
import { createEngineAdapter } from '../lib/responses/engine.mjs';

const MODEL = 'test-model';
const API_KEYS = { 'client-secret-a': 'tenant-a', 'client-secret-b': 'tenant-b' };
const headers = (key = 'client-secret-a') => ({ 'content-type': 'application/json', authorization: `Bearer ${key}` });
const payload = (extra = {}) => ({ model: MODEL, input: 'Hello', store: false, max_output_tokens: 16, ...extra });
const usage = { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12, prompt_tokens_details: { cached_tokens: 4 } };

function fakeEngine(overrides = {}) {
  const counts = [];
  const generations = [];
  return {
    counts, generations,
    async countInputTokens(request, options) {
      counts.push({ request, options });
      return { input_tokens: 9, context_length: 32768 };
    },
    async *generate(request, options) {
      generations.push({ request, options });
      yield { type: 'text_delta', delta: 'Hello ' };
      yield { type: 'text_delta', delta: 'world' };
      yield { type: 'usage', usage };
      yield { type: 'finish', reason: 'stop' };
    },
    ...overrides,
  };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, options = {}) {
  const engine = options.engine ?? fakeEngine();
  const logs = [];
  const server = createServer({ responsesMode: 'service', runtimeProfile: 'vllm-metal',
    model: MODEL, engine, apiKeys: API_KEYS, logger: (event) => logs.push(event), ...options });
  const origin = await listen(server);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, origin, engine, logs };
}

function post(origin, body = payload(), { path = '/v1/responses', key = 'client-secret-a', ...options } = {}) {
  return fetch(`${origin}${path}`, { method: 'POST', headers: headers(key), body: JSON.stringify(body), ...options });
}

function parseEvents(text) {
  return text.split(/\n\n/).filter((part) => part.trim()).map((part) => {
    const lines = part.split('\n');
    const event = JSON.parse(lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n'));
    assert.equal(lines.find((line) => line.startsWith('event:')).slice(6).trim(), event.type);
    return event;
  });
}

test('Service Responses authenticate before inference and return stable structured errors', async (t) => {
  const { origin, engine } = await fixture(t);
  for (const options of [{ headers: { 'content-type': 'application/json' } }, { key: 'wrong-key' }]) {
    const response = await post(origin, payload(), options);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    assert.match(response.headers.get('x-request-id'), /^req_/);
    const result = await response.json();
    assert.equal(result.error.code, 'invalid_api_key');
    assert.equal(result.error.param, null);
    assert.equal(typeof result.error.type, 'string');
  }
  assert.equal(engine.counts.length, 0);
  assert.equal(engine.generations.length, 0);
  const valid = await post(origin);
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get('x-responses-mode'), 'service');
});

test('JSON and SSE use the same canonical Items, actual usage, terminal status and event indexes', async (t) => {
  const { origin, engine, logs } = await fixture(t);
  const json = await (await post(origin, payload({ input: 'private input', instructions: 'private instructions' }))).json();
  const streaming = await post(origin, payload({ stream: true, input: 'private input', instructions: 'private instructions', stream_options: { include_obfuscation: false } }));
  assert.equal(streaming.status, 200);
  assert.match(streaming.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(streaming.headers.get('x-accel-buffering'), 'no');
  const events = parseEvents(await streaming.text());
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index));
  assert.deepEqual(events.slice(0, 2).map((event) => event.type), ['response.created', 'response.in_progress']);
  const terminal = events.at(-1);
  assert.equal(terminal.type, 'response.completed');
  assert.equal(events.filter((event) => ['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)).length, 1);
  const streamed = terminal.response;
  for (const result of [json, streamed]) {
    assert.equal(result.status, 'completed');
    assert.equal(result.store, false);
    assert.equal(result.output.length, 1);
    assert.equal(result.output[0].type, 'message');
    assert.equal(result.output[0].content[0].text, 'Hello world');
    assert.deepEqual(result.usage, { input_tokens: 9, input_tokens_details: { cached_tokens: 4 }, output_tokens: 3, total_tokens: 12 });
  }
  const item = streamed.output[0];
  for (const event of events.filter((event) => event.type === 'response.output_text.delta')) {
    assert.equal(event.item_id, item.id);
    assert.equal(event.output_index, 0);
    assert.equal(event.content_index, 0);
    assert.equal(event.obfuscation, undefined);
  }
  assert.equal(engine.generations.length, 2);
  assert.deepEqual(engine.generations[0].request.input, engine.generations[1].request.input);
  assert.equal(JSON.stringify(logs).includes('private input'), false);
  assert.equal(JSON.stringify(logs).includes('private instructions'), false);
  assert.equal(JSON.stringify(logs).includes('client-secret'), false);
});

test('Public Bearer keys never become engine credentials; request IDs reach both engine operations', async (t) => {
  const requests = [];
  const upstream = createHttpServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, authorization: req.headers.authorization, requestId: req.headers['x-request-id'], body: JSON.parse(body) });
    if (req.url === '/tokenize') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ count: 9, max_model_len: 32768 }));
    } else {
      const frame = (item) => `data: ${JSON.stringify(item)}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(frame({ choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] })
        + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        + frame({ choices: [], usage }) + 'data: [DONE]\n\n');
    }
  });
  const base = await listen(upstream);
  t.after(async () => { upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); });
  const engine = createEngineAdapter({ upstream: `${base}/v1`, model: MODEL, profile: 'vllm-metal', upstreamApiKey: 'engine-only-secret' });
  const { origin } = await fixture(t, { engine });
  const response = await post(origin);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'completed');
  assert.deepEqual(requests.map((request) => request.url), ['/tokenize', '/v1/chat/completions']);
  for (const request of requests) {
    assert.equal(request.authorization, 'Bearer engine-only-secret');
    assert.equal(request.requestId, response.headers.get('x-request-id'));
    assert.equal(JSON.stringify(request.body).includes('client-secret'), false);
    assert.equal(Object.hasOwn(request.body, 'previous_response_id'), false);
  }
});

test('Unsupported fields and malformed Items fail before tokenization or SSE headers', async (t) => {
  const { origin, engine } = await fixture(t);
  const cases = [
    { store: undefined }, { store: true }, { background: true }, { previous_response_id: 'resp_old' },
    { input: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: 'unsupported phase' }] },
    { input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/image.png' }] }] },
    { input: [{ type: 'function_call_output', call_id: 'unknown', output: '42' }] },
    { tools: [{ type: 'web_search' }] }, { text: { verbosity: 'high' } },
    { reasoning: { effort: 'high' } }, { stream_id: 'named-lane' },
  ];
  for (const invalid of cases) {
    const response = await post(origin, payload({ stream: true, ...invalid }));
    assert.equal(response.status, 400, JSON.stringify(invalid));
    assert.match(response.headers.get('content-type'), /^application\/json/);
    const result = await response.json();
    assert.ok(result.error.code);
    assert.equal(typeof result.error.message, 'string');
  }
  const unknownModel = await post(origin, payload({ model: 'different-model' }));
  assert.equal(unknownModel.status, 404);
  assert.equal((await unknownModel.json()).error.code, 'model_not_found');
  assert.equal(engine.counts.length, 0);
  assert.equal(engine.generations.length, 0);
});

test('HTTP media, malformed JSON, body and complete-input byte limits are enforced', async (t) => {
  const limited = await fixture(t, { bodyLimit: 180 });
  const wrongType = await post(limited.origin, payload(), { headers: { authorization: 'Bearer client-secret-a', 'content-type': 'text/plain' } });
  assert.equal(wrongType.status, 415);
  const invalidJson = await fetch(`${limited.origin}/v1/responses`, { method: 'POST', headers: headers(), body: '{' });
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).error.code, 'invalid_json');
  const tooLarge = await post(limited.origin, payload({ input: 'x'.repeat(300) }));
  assert.equal(tooLarge.status, 413);
  assert.equal(limited.engine.counts.length, 0);
  const inputLimited = await fixture(t, { maxInputBytes: 1024 });
  const tooMuchInput = await post(inputLimited.origin, payload({ input: 'x'.repeat(2000) }));
  assert.equal(tooMuchInput.status, 413);
  assert.equal(inputLimited.engine.counts.length, 0);
});

test('Exact input tokens plus reserved output reject overflow before creating a public response', async (t) => {
  const engine = fakeEngine({ async countInputTokens() { return { input_tokens: 32760, context_length: 32768 }; } });
  const { origin } = await fixture(t, { engine });
  for (const stream of [false, true]) {
    const response = await post(origin, payload({ stream }));
    assert.equal(response.status, 400);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.equal((await response.json()).error.code, 'context_length_exceeded');
  }
  assert.equal(engine.generations.length, 0);
});

test('Admission caps work per tenant and return 429 with Retry-After before SSE starts', async (t) => {
  let aborted;
  const abortedPromise = new Promise((resolve) => { aborted = resolve; });
  const engine = fakeEngine({
    async *generate(request, { signal }) {
      if (request.input[0].content[0].text === 'hold') {
        yield { type: 'text_delta', delta: 'working' };
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted(); reject(signal.reason); }, { once: true }));
      } else {
        yield { type: 'text_delta', delta: 'done' };
        yield { type: 'usage', usage };
        yield { type: 'finish', reason: 'stop' };
      }
    },
  });
  const { origin } = await fixture(t, { engine, maxConcurrent: 2, maxConcurrentPerTenant: 1 });
  const controller = new AbortController();
  const first = await post(origin, payload({ input: 'hold', stream: true }), { signal: controller.signal });
  assert.equal(first.status, 200);
  const sameTenant = await post(origin, payload({ stream: true }));
  assert.equal(sameTenant.status, 429);
  assert.equal(sameTenant.headers.get('retry-after'), '1');
  assert.equal((await sameTenant.json()).error.code, 'rate_limit_exceeded');
  const differentTenant = await post(origin, payload(), { key: 'client-secret-b' });
  assert.equal(differentTenant.status, 200);
  assert.equal((await differentTenant.json()).status, 'completed');
  controller.abort();
  await Promise.race([abortedPromise, delay(1000).then(() => { throw new Error('Disconnected inference did not abort.'); })]);
  const after = await post(origin);
  assert.equal(after.status, 200);
});

test('Generation errors preserve partial output and emit exactly one failed terminal event', async (t) => {
  let attempts = 0;
  const engine = fakeEngine({ async *generate() {
    attempts++;
    yield { type: 'text_delta', delta: 'partial' };
    throw Object.assign(new Error('Engine stream interrupted.'), { code: 'invalid_upstream_response' });
  } });
  const { origin } = await fixture(t, { engine });
  const response = await post(origin, payload({ stream: true }));
  const events = parseEvents(await response.text());
  assert.equal(events.at(-1).type, 'response.failed');
  assert.equal(events.at(-1).response.error.code, 'invalid_upstream_response');
  assert.equal(events.at(-1).response.output[0].content[0].text, 'partial');
  assert.equal(events.at(-1).response.output[0].status, 'incomplete');
  assert.equal(events.filter((event) => event.type === 'response.failed').length, 1);
  assert.equal(events.some((event) => event.type === 'response.completed'), false);
  assert.equal(attempts, 1);
  const json = await (await post(origin)).json();
  assert.equal(json.status, 'failed');
  assert.equal(json.output[0].content[0].text, 'partial');
  assert.equal(attempts, 2);
});

test('Token-limit completion is incomplete in JSON and streaming representations', async (t) => {
  const engine = fakeEngine({ async *generate() {
    yield { type: 'text_delta', delta: 'cut short' };
    yield { type: 'usage', usage };
    yield { type: 'finish', reason: 'length' };
  } });
  const { origin } = await fixture(t, { engine });
  const json = await (await post(origin)).json();
  const events = parseEvents(await (await post(origin, payload({ stream: true }))).text());
  assert.equal(events.at(-1).type, 'response.incomplete');
  for (const result of [json, events.at(-1).response]) {
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(result.incomplete_details, { reason: 'max_output_tokens' });
    assert.equal(result.output[0].status, 'incomplete');
  }
});

test('Stateful and advanced routes return explicit unsupported errors without engine forwarding', async (t) => {
  const { origin, engine } = await fixture(t);
  for (const [method, path] of [
    ['GET', '/v1/responses/resp_missing'], ['DELETE', '/v1/responses/resp_missing'],
    ['POST', '/v1/responses/resp_missing/cancel'], ['GET', '/v1/responses/resp_missing/input_items'],
    ['POST', '/v1/responses/compact'], ['POST', '/v1/responses/input_tokens'],
    ['POST', '/v1/conversations'],
  ]) {
    const response = await fetch(`${origin}${path}`, { method, headers: headers() });
    assert.equal(response.status, 400, path);
    assert.equal((await response.json()).error.code, 'unsupported_endpoint', path);
  }
  const query = await post(origin, payload(), { path: '/v1/responses?stream=true' });
  assert.equal(query.status, 400);
  assert.equal((await query.json()).error.code, 'unsupported_parameter');
  assert.equal(engine.counts.length, 0);
  assert.equal(engine.generations.length, 0);
});

test('Deadlines remain HTTP errors before creation and failed terminal events after streaming starts', async (t) => {
  const waitForAbort = (signal) => new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const before = await fixture(t, { requestTimeoutMs: 20, engine: fakeEngine({
    async countInputTokens(request, { signal }) { return waitForAbort(signal); },
  }) });
  const rejected = await post(before.origin, payload({ stream: true }));
  assert.equal(rejected.status, 504);
  assert.match(rejected.headers.get('content-type'), /^application\/json/);
  assert.equal((await rejected.json()).error.code, 'upstream_timeout');
  assert.equal(before.engine.generations.length, 0);

  const after = await fixture(t, { requestTimeoutMs: 20, engine: fakeEngine({
    async *generate(request, { signal }) {
      yield { type: 'text_delta', delta: 'partial before timeout' };
      await waitForAbort(signal);
    },
  }) });
  const streamed = await post(after.origin, payload({ stream: true }));
  assert.equal(streamed.status, 200);
  const events = parseEvents(await streamed.text());
  assert.equal(events.at(-1).type, 'response.failed');
  assert.equal(events.at(-1).response.error.code, 'upstream_timeout');
  assert.equal(events.at(-1).response.output[0].content[0].text, 'partial before timeout');
  assert.equal(events.filter((event) => event.type === 'response.failed').length, 1);
});

test('Invalid API key maps and unbounded resource limits fail startup instead of disabling protection', () => {
  const options = { responsesMode: 'service', runtimeProfile: 'vllm-metal', model: MODEL, engine: fakeEngine(), logger: () => {} };
  for (const apiKeys of ['[]', '42', 'null', 'false']) {
    assert.throws(() => createServer({ ...options, apiKeys }), /API_KEYS|API keys/i, apiKeys);
  }
  for (const limits of [{ maxConcurrent: NaN }, { maxConcurrent: Infinity }, { maxConcurrentPerTenant: 0 }, { maxInputBytes: -1 }, { maxOutputBytes: NaN }]) {
    assert.throws(() => createServer({ ...options, ...limits }), /positive|integer|limit/i, JSON.stringify(limits));
  }
});

test('Request deadlines bound incomplete HTTP bodies before validation or engine admission', async (t) => {
  const { origin, engine } = await fixture(t, { requestTimeoutMs: 25 });
  const response = await new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}/v1/responses`, { method: 'POST', headers: headers() }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        clearTimeout(timer);
        request.end();
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) });
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('Incomplete body outlived the request deadline.')), 1000);
    request.on('error', (error) => { clearTimeout(timer); reject(error); });
    request.write('{'); // Keep the body open; the service must finish by itself.
  });
  assert.equal(response.status, 504);
  assert.equal(response.body.error.code, 'upstream_timeout');
  assert.equal(engine.counts.length, 0);
  assert.equal(engine.generations.length, 0);
});
