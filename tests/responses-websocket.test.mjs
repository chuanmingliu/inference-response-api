import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import WebSocket from 'ws';
import { attachResponsesWebSocket } from '../lib/responses/websocket.mjs';

const AUTH = { authorization: 'Bearer test-key' };
const create = (input = 'hello', extra = {}) => ({ type: 'response.create', model: 'model-a', input, store: false, ...extra });
const auth = (req) => {
  if (req.headers.authorization !== AUTH.authorization) throw Object.assign(new Error('Invalid API key.'), { status: 401, code: 'invalid_api_key', type: 'authentication_error' });
  return 'tenant-a';
};

function fakeService(overrides = {}) {
  let sequence = 0;
  const calls = [];
  return {
    calls, profile: { id: 'test' },
    prepare(payload, context) { return { ...payload, input: typeof payload.input === 'string' ? [{ type: 'message', role: 'user', content: payload.input }] : payload.input }; },
    async run(request, { history, signal, onEvent, requestId, tenant }) {
      const id = `resp_${++sequence}`;
      calls.push({ request, history: structuredClone(history), signal, requestId, tenant });
      const response = { id, object: 'response', status: 'in_progress', previous_response_id: request.previous_response_id ?? null, output: [] };
      await onEvent({ type: 'response.created', sequence_number: 0, response: { ...response } });
      await overrides.wait?.(request, signal);
      const output = [{ id: `msg_${sequence}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }];
      response.status = 'completed';
      response.output = output;
      await onEvent({ type: 'response.completed', sequence_number: 1, response });
      return { response, history: [...history, ...request.input, ...output] };
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'wait')),
  };
}

async function fixture(t, options = {}) {
  const server = createServer((req, res) => { res.writeHead(404); res.end(); });
  const service = options.service ?? fakeService();
  const transport = attachResponsesWebSocket(server, { service, authenticate: auth, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await transport.close(); await new Promise((resolve) => server.close(resolve)); });
  return { service, transport, url: `ws://127.0.0.1:${server.address().port}/v1/responses` };
}

async function connect(url, options = {}) {
  const ws = new WebSocket(url, { headers: AUTH, ...options });
  const events = [];
  const listeners = new Set();
  ws.on('message', (data) => {
    const event = JSON.parse(data.toString());
    events.push(event);
    for (const listener of listeners) listener();
  });
  await once(ws, 'open');
  const next = (type) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Missing WebSocket event: ${type}`)); }, 1500);
    const check = () => {
      const index = events.findIndex((event) => event.type === type);
      if (index === -1) return;
      clearTimeout(timer);
      listeners.delete(check);
      resolve(events.splice(index, 1)[0]);
    };
    listeners.add(check);
    check();
  });
  return { ws, events, next, send: (payload) => ws.send(JSON.stringify(payload)) };
}

async function rejectedUpgrade(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: AUTH, ...options });
    ws.on('open', () => { ws.terminate(); reject(new Error('Upgrade unexpectedly succeeded.')); });
    ws.on('error', () => {});
    ws.on('unexpected-response', (req, response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => { ws.terminate(); resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); });
    });
  });
}

test('WebSocket validates route, query, authentication, and tenant connection limits before upgrade', async (t) => {
  const { url } = await fixture(t, { maxConnectionsPerTenant: 1 });
  assert.equal((await rejectedUpgrade(url, { headers: {} })).status, 401);
  assert.equal((await rejectedUpgrade(`${url}?api_key=secret`)).status, 400);
  assert.equal((await rejectedUpgrade(url.replace('/responses', '/other'))).status, 404);
  const client = await connect(url);
  const limited = await rejectedUpgrade(url);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'connection_limit_exceeded');
  client.ws.close();
});

test('WebSocket continuation uses canonical Items, excludes old top-level instructions, and never implicitly inherits history', async (t) => {
  const { url, service } = await fixture(t);
  const client = await connect(url);
  client.send(create('first', { instructions: 'old top-level instruction' }));
  const first = (await client.next('response.completed')).response;
  client.send(create([{ type: 'function_call_output', call_id: 'call_1', output: '42' }], { previous_response_id: first.id, instructions: 'new instructions' }));
  const second = (await client.next('response.completed')).response;
  assert.equal(second.previous_response_id, first.id);
  assert.equal(service.calls[1].history.length, 2);
  assert.equal(JSON.stringify(service.calls[1].history).includes('old top-level instruction'), false);
  assert.deepEqual(service.calls[1].request.input, [{ type: 'function_call_output', call_id: 'call_1', output: '42' }]);
  assert.equal(service.calls[1].request.instructions, 'new instructions');
  client.send(create('independent'));
  await client.next('response.completed');
  assert.deepEqual(service.calls[2].history, []);
  assert.match(service.calls[2].requestId, /^req_/);
  assert.equal(service.calls[2].tenant, 'tenant-a');
});

test('WebSocket runs queued creates FIFO without overlap or parent substitution', async (t) => {
  let release;
  const firstWait = new Promise((resolve) => { release = resolve; });
  const service = fakeService({ wait: (request) => request.input[0].content === 'first' ? firstWait : undefined });
  const { url } = await fixture(t, { service });
  const client = await connect(url);
  client.send(create('first'));
  const first = (await client.next('response.created')).response;
  client.send(create('second', { previous_response_id: first.id }));
  client.send(create('stale third', { previous_response_id: first.id }));
  await delay(20);
  assert.equal(service.calls.length, 1);
  release();
  await client.next('response.completed');
  await client.next('response.completed');
  assert.equal(service.calls.length, 2);
  assert.equal(service.calls[1].history[0].content, 'first');
  assert.equal((await client.next('error')).error.code, 'previous_response_not_found');
});

test('Malformed and unsupported events are recoverable and create events use implicit streaming', async (t) => {
  const { url, service } = await fixture(t);
  const client = await connect(url);
  client.ws.send('{');
  assert.equal((await client.next('error')).error.code, 'invalid_json');
  client.ws.send(Buffer.from('binary'));
  assert.equal((await client.next('error')).error.code, 'invalid_message');
  for (const payload of [
    { ...create(), type: 'response.steer' }, create('x', { stream_id: 'lane' }), create('x', { stream: true }),
    create('x', { background: false }), create('x', { generate: false }), { ...create(), store: undefined },
  ]) {
    client.send(payload);
    const error = await client.next('error');
    assert.ok(['unsupported_event', 'unsupported_parameter'].includes(error.error.code));
    assert.equal(error.error.type, 'invalid_request_error');
  }
  client.send(create('valid', { generate: true }));
  await client.next('response.completed');
  assert.equal(service.calls.length, 1);
  assert.equal(Object.hasOwn(service.calls[0].request, 'type'), false);
  assert.equal(Object.hasOwn(service.calls[0].request, 'generate'), false);
});

test('Failed continuations evict their predecessor and connections retain model affinity', async (t) => {
  const { url } = await fixture(t);
  const client = await connect(url);
  client.send(create());
  const first = (await client.next('response.completed')).response;
  client.send(create('wrong model', { previous_response_id: first.id, model: 'model-b' }));
  assert.equal((await client.next('error')).error.code, 'model_mismatch');
  client.send(create('retry', { previous_response_id: first.id }));
  assert.equal((await client.next('error')).error.code, 'previous_response_not_found');
  client.send(create('full replay'));
  assert.equal((await client.next('response.completed')).response.status, 'completed');
});

test('Reconnection loses transient context and full replay starts an independent chain', async (t) => {
  const { url } = await fixture(t);
  const first = await connect(url);
  first.send(create());
  const parent = (await first.next('response.completed')).response.id;
  first.ws.close();
  await once(first.ws, 'close');
  const second = await connect(url);
  second.send(create('continue', { previous_response_id: parent }));
  assert.equal((await second.next('error')).error.code, 'previous_response_not_found');
  second.send(create('full replay', { previous_response_id: null }));
  assert.equal((await second.next('response.completed')).response.status, 'completed');
});

test('Disconnect aborts active inference and abandons unstarted queued work', async (t) => {
  let aborted;
  const abortedPromise = new Promise((resolve) => { aborted = resolve; });
  const service = fakeService({ wait: (request, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted(); reject(signal.reason); }, { once: true });
  }) });
  const { url } = await fixture(t, { service });
  const client = await connect(url);
  client.send(create('active'));
  await client.next('response.created');
  client.send(create('queued'));
  client.ws.terminate();
  await Promise.race([abortedPromise, delay(1000).then(() => { throw new Error('Inference was not aborted.'); })]);
  await delay(20);
  assert.equal(service.calls.length, 1);
  assert.equal(service.calls[0].signal.aborted, true);
});

test('Inbound queue limits reject excess count and bytes without running rejected work', async (t) => {
  for (const limits of [{ maxQueue: 1 }, { maxQueuedBytes: 120 }]) {
    let release;
    const wait = new Promise((resolve) => { release = resolve; });
    const service = fakeService({ wait: (request) => request.input[0].content === 'active' ? wait : undefined });
    const { url } = await fixture(t, { service, ...limits });
    const client = await connect(url);
    client.send(create('active'));
    await client.next('response.created');
    client.send(create('queued'));
    client.send(create('excess'));
    assert.equal((await client.next('error')).error.code, 'queue_limit_exceeded');
    release();
    await client.next('response.completed');
    await client.next('response.completed');
    assert.equal(service.calls.length, 2);
  }
});

test('Context byte limits evict oversized histories without claiming persistence', async (t) => {
  const { url } = await fixture(t, { maxContextBytes: 32 });
  const client = await connect(url);
  client.send(create());
  const parent = (await client.next('response.completed')).response.id;
  client.send(create('continue', { previous_response_id: parent }));
  assert.equal((await client.next('error')).error.code, 'previous_response_not_found');
});

test('Oversized frames and outbound events close bounded connections', async (t) => {
  const incoming = await fixture(t, { maxPayload: 100 });
  const sender = await connect(incoming.url);
  sender.send(create('x'.repeat(1000)));
  assert.equal((await once(sender.ws, 'close'))[0], 1009);
  const outgoing = await fixture(t, { maxBufferedBytes: 64 });
  const receiver = await connect(outgoing.url);
  receiver.send(create());
  const [code] = await once(receiver.ws, 'close');
  assert.ok([1006, 1013].includes(code));
});

test('Authorization is rechecked for every queued request', async (t) => {
  let authorized = true;
  const { url, service } = await fixture(t, { authenticate: (req) => {
    if (!authorized) throw Object.assign(new Error('API key revoked.'), { status: 401, type: 'authentication_error', code: 'invalid_api_key' });
    return auth(req);
  } });
  const client = await connect(url);
  authorized = false;
  client.send(create());
  const closed = once(client.ws, 'close');
  assert.equal((await client.next('error')).error.code, 'invalid_api_key');
  assert.equal((await closed)[0], 1008);
  assert.equal(service.calls.length, 0);
});

test('Connections rotate at configured lifetime and shutdown closes upgraded sockets', async (t) => {
  const { url, transport } = await fixture(t, { maxConnectionMs: 40 });
  const client = await connect(url);
  assert.equal((await once(client.ws, 'close'))[0], 1001);
  const second = await connect(url);
  const closed = once(second.ws, 'close');
  await transport.close();
  await closed;
  assert.equal(transport.wss.clients.size, 0);
});

test('Cached history is copied from service results and again before continuation validation', async (t) => {
  let retainedHistory;
  const service = fakeService();
  const run = service.run;
  service.run = async (...args) => {
    const result = await run(...args);
    retainedHistory = result.history;
    return result;
  };
  const { url } = await fixture(t, { service });
  const client = await connect(url);
  client.send(create('immutable first'));
  const first = (await client.next('response.completed')).response.id;
  retainedHistory[0].content = 'mutated by engine';
  client.send(create('second', { previous_response_id: first }));
  await client.next('response.completed');
  assert.equal(service.calls[1].history[0].content, 'immutable first');
});

test('Missing heartbeat replies and application idle periods close connections', async (t) => {
  const heartbeat = await fixture(t, { heartbeatIntervalMs: 15, idleTimeoutMs: 500 });
  const silent = await connect(heartbeat.url, { autoPong: false });
  assert.equal((await once(silent.ws, 'close'))[0], 1006);
  const idle = await fixture(t, { heartbeatIntervalMs: 15, idleTimeoutMs: 30 });
  const responsive = await connect(idle.url);
  assert.equal((await once(responsive.ws, 'close'))[0], 1006);
});

test('Write timeout terminates a stalled connection without starting queued work', async (t) => {
  const { url, transport, service } = await fixture(t, { sendTimeoutMs: 15 });
  const client = await connect(url);
  const serverSocket = [...transport.wss.clients][0];
  serverSocket.send = () => {}; // Simulate a write that never reaches its callback.
  client.send(create());
  client.send(create('queued'));
  assert.equal((await once(client.ws, 'close'))[0], 1006);
  assert.equal(service.calls.length, 1);
  // The common core observes the failed awaited event write; the connection
  // cannot advance to the queued request while that write remains pending.
});

test('Request deadlines abort generation and allow later independent work', async (t) => {
  const service = fakeService({ wait: (request, signal) => {
    if (request.input[0].content !== 'wait') return;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const { url } = await fixture(t, { service, requestTimeoutMs: 20 });
  const client = await connect(url);
  client.send(create('wait'));
  assert.equal((await client.next('error')).error.code, 'request_timeout');
  assert.equal(service.calls[0].signal.aborted, true);
  client.send(create('independent'));
  await client.next('response.completed');
});

test('Disconnect during asynchronous preparation never starts inference', async (t) => {
  let release;
  let preparing;
  const started = new Promise((resolve) => { preparing = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  const service = fakeService();
  const prepare = service.prepare;
  service.prepare = async (...args) => { preparing(); await wait; return prepare(...args); };
  const { url, transport } = await fixture(t, { service });
  const client = await connect(url);
  client.send(create());
  await started;
  const closed = once([...transport.wss.clients][0], 'close');
  client.ws.terminate();
  await closed;
  release();
  await delay(15);
  assert.equal(service.calls.length, 0);
});
