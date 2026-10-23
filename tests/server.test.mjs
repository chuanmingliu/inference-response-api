import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, normalizeModelId } from '../server.mjs';

const MODEL = 'huggingface.co/mlx-community/qwen3-0.6b-4bit:latest';

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function fixture(t, handler, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-gateway-test-'));
  const publicDir = join(directory, 'public');
  const docsDir = join(directory, 'docs');
  await mkdir(publicDir);
  await mkdir(docsDir);
  await writeFile(join(publicDir, 'index.html'), '<h1>Playground</h1>');
  await writeFile(join(publicDir, 'app.js'), 'window.ready = true;');
  await writeFile(join(directory, 'secret.txt'), 'secret outside public');
  await writeFile(join(docsDir, 'DEPLOYMENT.md'), '# Guide\n<script>alert("unsafe")</script>');
  await writeFile(join(docsDir, 'SGLANG.md'), '# SGLang guide\n<script>alert("unsafe")</script>');
  const upstreamServer = createHttpServer(handler ?? ((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: MODEL }] })); }));
  const upstream = `${await listen(upstreamServer)}/engines/vllm-metal/v1`;
  const logs = [];
  const gateway = createServer({ responsesMode: 'adapter', model: MODEL, upstream, publicDir, docsDir, logger: (entry) => logs.push(entry), ...options });
  const origin = await listen(gateway);
  t.after(async () => { await close(gateway); await close(upstreamServer); await rm(directory, { recursive: true, force: true }); });
  return { origin, upstream, directory, publicDir, docsDir, logs };
}

async function bodyJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}

function post(origin, route, body) {
  return fetch(`${origin}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function chatResponse(text = 'Hello from Qwen', finishReason = 'stop') {
  return { id: 'chatcmpl-test', model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } };
}

function sseEvents(text) {
  return text.split(/\n\n/).filter(Boolean).map((block) => JSON.parse(block.split('\n').find((line) => line.startsWith('data: ')).slice(6)));
}

test('local routes, safe documentation, model aliases, and honest catalog availability', async (t) => {
  const app = await fixture(t);
  assert.equal(normalizeModelId('hf.co/mlx-community/Qwen3-0.6B-4bit'), normalizeModelId(MODEL));
  const config = await (await fetch(`${app.origin}/api/config`)).json();
  assert.equal(config.responses_mode, 'adapter');
  assert.equal(config.upstream, app.upstream);
  assert.equal(config.endpoints.responses, '/v1/responses');
  const health = await (await fetch(`${app.origin}/healthz`)).json();
  assert.equal(health.ok, true);
  const status = await (await fetch(`${app.origin}/api/status`)).json();
  assert.equal(status.ready, true);
  assert.equal(status.api_reachable, true);
  assert.equal(status.selected_model_present, true);
  assert.equal(status.backend_verified, false);
  assert.equal(status.inference.verified, false);
  assert.equal(status.availability_scope, 'model_catalog');
  assert.equal((await fetch(`${app.origin}/readyz`)).status, 200);
  assert.match(await (await fetch(`${app.origin}/`)).text(), /Playground/);
  assert.match((await fetch(`${app.origin}/app.js`)).headers.get('content-type'), /javascript/);
  const docs = await (await fetch(`${app.origin}/docs`)).text();
  assert.match(docs, /&lt;script&gt;/);
  assert.doesNotMatch(docs, /<script>/);
  const sglangDocsResponse = await fetch(`${app.origin}/docs/sglang`);
  const sglangDocs = await sglangDocsResponse.text();
  assert.equal(sglangDocsResponse.status, 200);
  assert.match(sglangDocs, /SGLang guide/);
  assert.match(sglangDocs, /&lt;script&gt;/);
  assert.doesNotMatch(sglangDocs, /<script>/);
  const headGuide = await fetch(`${app.origin}/docs/sglang`, { method: 'HEAD' });
  assert.equal(headGuide.status, 200);
  assert.equal(headGuide.headers.get('content-length'), String(Buffer.byteLength(sglangDocs)));
  assert.equal(await headGuide.text(), '');
  assert.equal((await fetch(`${app.origin}/docs/unlisted`)).status, 404);
  assert.deepEqual(await (await fetch(`${app.origin}/api/deployment`)).json(), { available: false });
  await writeFile(join(app.docsDir, 'service-status.json'), JSON.stringify({ recorded_at: 'test', inference: 'passed' }));
  assert.deepEqual(await (await fetch(`${app.origin}/api/deployment`)).json(), { available: true, snapshot: { recorded_at: 'test', inference: 'passed' } });
  const snapshotStatus = await (await fetch(`${app.origin}/api/status`)).json();
  assert.equal(snapshotStatus.verification_source, 'saved_snapshot');
  assert.equal(snapshotStatus.deployment_verification.recorded_at, 'test');
  assert.equal(snapshotStatus.inference.verified, false);
});

test('readiness fails when catalog is reachable but the selected model is absent', async (t) => {
  const app = await fixture(t, (req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"data":[]}'); });
  const response = await fetch(`${app.origin}/readyz`);
  assert.equal(response.status, 503);
  const status = await response.json();
  assert.equal(status.api_reachable, true);
  assert.equal(status.ready, false);
  assert.equal((await fetch(`${app.origin}/healthz`)).status, 200);
});

test('catalog timeout is reported independently from local health', async (t) => {
  const app = await fixture(t, () => {}, { probeTimeoutMs: 30 });
  const status = await (await fetch(`${app.origin}/api/status`)).json();
  assert.equal(status.api_reachable, false);
  assert.match(status.error, /timed out/);
  assert.equal((await fetch(`${app.origin}/healthz`)).status, 200);
});

test('chat JSON and native Responses pass through unchanged; logs contain no prompts or query', async (t) => {
  const requests = [];
  const app = await fixture(t, async (req, res) => {
    requests.push({ url: req.url, body: await bodyJson(req), authorization: req.headers.authorization });
    res.writeHead(201, { 'content-type': 'application/json', 'x-request-id': 'upstream-id' });
    res.end('{"upstream":"unchanged"}');
  }, { responsesMode: 'native' });
  const input = { model: MODEL, messages: [{ role: 'user', content: 'secret prompt' }] };
  const response = await fetch(`${app.origin}/v1/chat/completions?tag=private`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' }, body: JSON.stringify(input) });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-request-id'), 'upstream-id');
  assert.deepEqual(await response.json(), { upstream: 'unchanged' });
  assert.deepEqual(requests[0], { url: '/engines/vllm-metal/v1/chat/completions?tag=private', body: input, authorization: 'Bearer test-token' });
  const native = await post(app.origin, '/v1/responses', { input: 'hello', store: true });
  assert.equal(native.status, 201);
  assert.equal(requests[1].url, '/engines/vllm-metal/v1/responses');
  assert.equal(requests[1].body.store, true);
  assert.doesNotMatch(JSON.stringify(app.logs), /secret prompt|private|test-token/);
});

test('upstream error status and body are preserved for unsupported native endpoints', async (t) => {
  const app = await fixture(t, (req, res) => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); }, { responsesMode: 'native' });
  const response = await post(app.origin, '/v1/responses', { input: 'hello' });
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'not found');
});

test('native SSE is streamed immediately and byte content preserved', async (t) => {
  const first = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
  const last = 'data: [DONE]\n\n';
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = await fixture(t, async (req, res) => {
    await bodyJson(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(first);
    await gate;
    res.end(last);
  });
  const response = await post(app.origin, '/v1/chat/completions', { messages: [], stream: true });
  const reader = response.body.getReader();
  const initial = await reader.read();
  assert.equal(new TextDecoder().decode(initial.value), first);
  release();
  let remainder = '';
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; remainder += new TextDecoder().decode(chunk.value); }
  assert.equal(remainder, last);
});

test('client cancellation closes the upstream stream', async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => { upstreamClosed = resolve; });
  const app = await fixture(t, async (req, res) => {
    await bodyJson(req);
    res.on('close', upstreamClosed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
  });
  const controller = new AbortController();
  const response = await fetch(`${app.origin}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"stream":true}', signal: controller.signal });
  await response.body.getReader().read();
  controller.abort();
  await Promise.race([closed, delay(1000).then(() => { throw new Error('Upstream did not close after client disconnected.'); })]);
});

test('only known routes are proxied; malformed, oversized, and non-JSON requests fail locally', async (t) => {
  let hits = 0;
  const app = await fixture(t, (req, res) => { hits++; res.end('{}'); }, { bodyLimit: 64 });
  assert.equal((await fetch(`${app.origin}/v1/unknown`)).status, 404);
  assert.equal((await fetch(`${app.origin}/v1/responses`)).status, 405);
  assert.equal((await fetch(`${app.origin}/%ZZ`)).status, 400);
  assert.equal((await fetch(`${app.origin}/..%2Fsecret.txt`)).status, 403);
  await symlink(join(app.directory, 'secret.txt'), join(app.publicDir, 'outside.txt'));
  assert.equal((await fetch(`${app.origin}/outside.txt`)).status, 403);
  assert.equal((await fetch(`${app.origin}/v1/responses`, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(`${app.origin}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await post(app.origin, '/v1/responses', { input: 'x'.repeat(100) })).status, 413);
  assert.equal(hits, 0);
});

test('Responses adapter maps full text history, disables thinking, and maps usage', async (t) => {
  let seen;
  const app = await fixture(t, async (req, res) => {
    seen = { url: req.url, body: await bodyJson(req) };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(chatResponse()));
  });
  const response = await post(app.origin, '/v1/responses', {
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }, { role: 'user', content: 'continue' }],
    instructions: 'Be concise', store: false, max_output_tokens: 32, temperature: 0.3, top_p: 0.8, metadata: { test: 'yes' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-responses-mode'), 'chat-completions-adapter');
  const result = await response.json();
  assert.equal(seen.url, '/engines/vllm-metal/v1/chat/completions');
  assert.deepEqual(seen.body.messages, [{ role: 'system', content: 'Be concise' }, { role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'continue' }]);
  assert.equal(seen.body.max_tokens, 32);
  assert.equal(seen.body.chat_template_kwargs.enable_thinking, false);
  assert.equal(result.object, 'response');
  assert.match(result.id, /^resp_/);
  assert.equal(result.output[0].content[0].text, 'Hello from Qwen');
  assert.equal(result.output_text, 'Hello from Qwen');
  assert.equal(result.status, 'completed');
  assert.equal(result.store, false);
  assert.deepEqual(result.usage, { input_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens: 4, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 16 });
});

test('Responses adapter reports token-limited responses as incomplete', async (t) => {
  const app = await fixture(t, async (req, res) => { await bodyJson(req); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(chatResponse('Partial', 'length'))); });
  const result = await (await post(app.origin, '/v1/responses', { input: 'hello' })).json();
  assert.equal(result.status, 'incomplete');
  assert.equal(result.incomplete_details.reason, 'max_output_tokens');
  assert.equal(result.output[0].status, 'incomplete');
});

test('Responses adapter rejects unsupported features instead of silently ignoring them', async (t) => {
  let hits = 0;
  const app = await fixture(t, (req, res) => { hits++; res.end('{}'); });
  for (const body of [
    { input: 'hello', store: true }, { input: 'hello', previous_response_id: 'resp_old' },
    { input: 'hello', tools: [{ type: 'function' }] }, { input: 'hello', background: true },
    { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'url' }] }] },
    { input: 'hello', text: { format: { type: 'json_schema' } } }, { input: 'hello', reasoning: { effort: 'high' } },
    { input: 'hello', max_output_tokens: -1 }, { input: 'hello', stream: 'true' },
  ]) {
    const response = await post(app.origin, '/v1/responses', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.ok((await response.json()).error.message);
  }
  assert.equal(hits, 0);
});

test('Responses adapter emits SDK-style SSE lifecycle with true deltas and monotonic sequences', async (t) => {
  let seen;
  const app = await fixture(t, async (req, res) => {
    seen = await bodyJson(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const blocks = [
      { choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'Hello ' }, finish_reason: null }] },
      { choices: [{ delta: { content: '世界' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    ];
    const bytes = Buffer.from(blocks.map((block) => `data: ${JSON.stringify(block)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
    // Deliberately split framing and multibyte UTF-8 characters across network chunks.
    for (let i = 0; i < bytes.length; i += 7) { res.write(bytes.subarray(i, i + 7)); await delay(1); }
    res.end();
  });
  const response = await post(app.origin, '/v1/responses', { input: 'hello', stream: true });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = sseEvents(await response.text());
  assert.deepEqual(events.map((event) => event.type), [
    'response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added',
    'response.output_text.delta', 'response.output_text.delta', 'response.output_text.done',
    'response.content_part.done', 'response.output_item.done', 'response.completed',
  ]);
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, i) => i));
  assert.equal(events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta).join(''), 'Hello 世界');
  assert.equal(events.at(-1).response.output_text, 'Hello 世界');
  assert.equal(events.at(-1).response.usage.total_tokens, 5);
  assert.deepEqual(seen.stream_options, { include_usage: true });
});

test('truncated upstream streams fail explicitly, without claiming completion', async (t) => {
  const app = await fixture(t, async (req, res) => {
    await bodyJson(req); res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  });
  const events = sseEvents(await (await post(app.origin, '/v1/responses', { input: 'hello', stream: true })).text());
  assert.equal(events.at(-1).type, 'response.failed');
  assert.match(events.at(-1).response.error.message, /finish reason/);
  assert.ok(!events.some((event) => event.type === 'response.completed'));
});

test('upstream HTTP errors remain errors in adapter mode', async (t) => {
  const app = await fixture(t, async (req, res) => { await bodyJson(req); res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '10' }); res.end('{"error":{"message":"busy"}}'); });
  const response = await post(app.origin, '/v1/responses', { input: 'hello', stream: true });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '10');
  assert.deepEqual(await response.json(), { error: { message: 'busy' } });
});

test('comparison forwards only allowlisted routes to the fixed native service without adapting Responses', async (t) => {
  const requests = [];
  const native = createHttpServer(async (req, res) => {
    requests.push({ path: req.url, body: req.method === 'POST' ? await bodyJson(req) : undefined });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/config') res.end(JSON.stringify({ responses_mode: 'native', service_name: 'Native vLLM Metal', model: MODEL }));
    else if (req.url === '/api/status') res.end('{"ready":true}');
    else res.end('{"id":"resp_native","output":[]}');
  });
  const nativeServiceBase = await listen(native);
  t.after(() => close(native));
  const app = await fixture(t, undefined, { nativeServiceBase, backend: 'DMR vLLM Metal', serviceName: 'Service A' });
  const config = await (await fetch(`${app.origin}/api/config`)).json();
  assert.equal(config.service_name, 'Service A');
  assert.equal(config.backend, 'DMR vLLM Metal');
  assert.equal(config.comparison.available, true);
  assert.equal(config.comparison.services[1].base_path, '/compare/native');
  const nativeConfig = await (await fetch(`${app.origin}/compare/native/api/config`)).json();
  assert.equal(nativeConfig.responses_mode, 'native');
  assert.equal((await (await fetch(`${app.origin}/compare/native/api/status`)).json()).ready, true);
  const response = await post(app.origin, '/compare/native/v1/responses', { input: 'hello', store: true, previous_response_id: 'resp_prior' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, 'resp_native');
  assert.deepEqual(requests[2], { path: '/v1/responses', body: { input: 'hello', store: true, previous_response_id: 'resp_prior' } });
  assert.equal((await fetch(`${app.origin}/compare/native/admin`)).status, 404);
  assert.equal((await fetch(`${app.origin}/compare/native/v1/responses`)).status, 405);
  assert.equal(requests.length, 3);
});

test('comparison streams native Responses SSE unchanged', async (t) => {
  const stream = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"native output"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n';
  const native = createHttpServer(async (req, res) => {
    await bodyJson(req); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(stream);
  });
  const nativeServiceBase = await listen(native);
  t.after(() => close(native));
  const app = await fixture(t, undefined, { nativeServiceBase });
  const response = await post(app.origin, '/compare/native/v1/responses', { input: 'hello', stream: true });
  assert.equal(await response.text(), stream);
});

test('SGLang comparison stays on its fixed service and preserves API requests', async (t) => {
  const requests = [];
  const sglang = createHttpServer(async (req, res) => {
    requests.push({ path: req.url, body: req.method === 'POST' ? await bodyJson(req) : undefined });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/config' ? { service_id: 'sglang', responses_mode: 'native', model: MODEL } : { id: 'sglang-result' }));
  });
  const sglangServiceBase = await listen(sglang);
  t.after(() => close(sglang));
  const app = await fixture(t, undefined, { sglangServiceBase });
  const config = await (await fetch(`${app.origin}/api/config`)).json();
  assert.deepEqual(config.comparison.services.map(({ id, base_path }) => ({ id, base_path })), [{ id: 'docker', base_path: '' }, { id: 'sglang', base_path: '/compare/sglang' }]);
  const peer = await (await fetch(`${app.origin}/compare/sglang/api/config`)).json();
  assert.equal(peer.service_id, 'sglang');
  const responses = { model: MODEL, input: 'hello', store: false, stream: true };
  assert.equal((await post(app.origin, '/compare/sglang/v1/responses', responses)).status, 200);
  const chat = { model: MODEL, messages: [{ role: 'user', content: 'hello' }], chat_template_kwargs: { enable_thinking: false } };
  assert.equal((await post(app.origin, '/compare/sglang/v1/chat/completions?url=http://untrusted.invalid', chat)).status, 200);
  assert.deepEqual(requests[1], { path: '/v1/responses', body: responses });
  assert.deepEqual(requests[2], { path: '/v1/chat/completions?url=http://untrusted.invalid', body: chat });
  assert.equal((await fetch(`${app.origin}/compare/sglang/admin`)).status, 404);
  assert.equal((await fetch(`${app.origin}/compare/sglang/v1/responses`)).status, 405);
  assert.equal((await fetch(`${app.origin}/compare/anything/v1/models`)).status, 404);
  assert.equal((await fetch(`${app.origin}/compare/native/v1/models`)).status, 503);
  assert.equal(requests.length, 3);
});

test('native vLLM and SGLang keep distinct identities and verification snapshots', async (t) => {
  for (const [serviceId, snapshotFile] of [['native', 'service-status-native.json'], ['sglang', 'service-status-sglang.json']]) {
    const app = await fixture(t, undefined, { serviceId, responsesMode: 'native' });
    await writeFile(join(app.docsDir, 'service-status.json'), JSON.stringify({ service_id: 'docker' }));
    await writeFile(join(app.docsDir, snapshotFile), JSON.stringify({ service_id: serviceId }));
    const config = await (await fetch(`${app.origin}/api/config`)).json();
    assert.equal(config.service_id, serviceId);
    assert.equal(config.snapshot_file, snapshotFile);
    assert.equal(config.deployment_doc, serviceId === 'sglang' ? '/docs/sglang' : '/docs');
    assert.equal(config.comparison.available, false);
    assert.equal(config.comparison.services[0].id, serviceId);
    const status = await (await fetch(`${app.origin}/api/status`)).json();
    assert.equal(status.service_id, serviceId);
    assert.equal(status.deployment_verification.service_id, serviceId);
    const deployment = await (await fetch(`${app.origin}/api/deployment`)).json();
    assert.equal(deployment.snapshot.service_id, serviceId);
    assert.equal((await (await fetch(`${app.origin}/healthz`)).json()).service_id, serviceId);
  }
  assert.throws(() => createServer({ serviceId: 'unknown' }), /SERVICE_ID/);
  assert.throws(() => createServer({ snapshotFile: '../secret.json' }), /SNAPSHOT_FILE/);
  assert.throws(() => createServer({ sglangServiceBase: 'http://user:password@localhost:8090' }), /SGLANG_SERVICE_BASE_URL/);
});

test('cancelling a SGLang comparison stream closes the peer connection', async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => { upstreamClosed = resolve; });
  const peer = createHttpServer(async (req, res) => {
    await bodyJson(req);
    res.once('close', upstreamClosed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n');
  });
  const sglangServiceBase = await listen(peer);
  t.after(() => close(peer));
  const app = await fixture(t, undefined, { sglangServiceBase });
  const controller = new AbortController();
  const response = await fetch(`${app.origin}/compare/sglang/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"input":"hello","stream":true}', signal: controller.signal });
  await response.body.getReader().read();
  controller.abort();
  await Promise.race([closed, delay(1000).then(() => { throw new Error('Comparison peer did not close after client disconnected.'); })]);
});

test('SGLang retrieves stored responses and accepts the SDK bodyless cancel request', async (t) => {
  const requests = [];
  const app = await fixture(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: req.url, body });
    res.writeHead(req.url.endsWith('resp_missing') ? 404 : 200, { 'content-type': 'application/json', 'x-request-id': 'engine-request' });
    res.end(JSON.stringify(req.url.endsWith('resp_missing') ? { error: { message: 'Response not found.' } } : { id: 'resp_test', status: req.method === 'POST' ? 'cancelled' : 'completed' }));
  }, { serviceId: 'sglang', responsesMode: 'native' });
  const retrieved = await fetch(`${app.origin}/v1/responses/resp_test`);
  assert.equal(retrieved.status, 200);
  assert.equal(retrieved.headers.get('x-request-id'), 'engine-request');
  assert.equal((await retrieved.json()).status, 'completed');
  const cancelled = await fetch(`${app.origin}/v1/responses/resp_test/cancel`, { method: 'POST' });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).status, 'cancelled');
  assert.equal((await post(app.origin, '/v1/responses/resp_test/cancel', {})).status, 200);
  assert.equal((await fetch(`${app.origin}/v1/responses/resp_missing`)).status, 404);
  assert.deepEqual(requests.slice(0, 3), [
    { method: 'GET', path: '/engines/vllm-metal/v1/responses/resp_test', body: '' },
    { method: 'POST', path: '/engines/vllm-metal/v1/responses/resp_test/cancel', body: '' },
    { method: 'POST', path: '/engines/vllm-metal/v1/responses/resp_test/cancel', body: '{}' },
  ]);
  assert.equal((await fetch(`${app.origin}/v1/responses/resp_test`, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(`${app.origin}/v1/responses/resp_test/cancel`)).status, 405);
  assert.equal((await fetch(`${app.origin}/v1/responses/resp_test/input_items`)).status, 404);
  assert.equal((await fetch(`${app.origin}/v1/responses/resp_test%2Fadmin`)).status, 404);
  assert.equal((await fetch(`${app.origin}/v1/responses/not_a_response`)).status, 404);
  assert.equal((await fetch(`${app.origin}/v1/responses/resp_${'a'.repeat(193)}`)).status, 404);
  assert.equal((await fetch(`${app.origin}/v1/responses/resp_test?stream=true`)).status, 400);
  assert.equal((await post(app.origin, '/v1/responses/resp_test/cancel', { reason: 'ignored?' })).status, 400);
  assert.equal((await post(app.origin, '/v1/responses/resp_test/cancel', null)).status, 400);
  assert.equal(requests.length, 4, 'invalid lifecycle requests must not reach the engine');
});

test('SGLang lifecycle is available through the fixed comparison peer only', async (t) => {
  const requests = [];
  const peer = createHttpServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: req.url, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"resp_peer","status":"cancelled"}');
  });
  const sglangServiceBase = await listen(peer);
  t.after(() => close(peer));
  const app = await fixture(t, undefined, { sglangServiceBase, nativeServiceBase: sglangServiceBase });
  assert.equal((await fetch(`${app.origin}/compare/sglang/v1/responses/resp_peer`)).status, 200);
  const response = await fetch(`${app.origin}/compare/sglang/v1/responses/resp_peer/cancel`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'cancelled');
  assert.deepEqual(requests, [
    { method: 'GET', path: '/v1/responses/resp_peer', body: '' },
    { method: 'POST', path: '/v1/responses/resp_peer/cancel', body: '' },
  ]);
  for (const route of ['/compare/sglang/v1/responses/resp_peer/input_items', '/compare/sglang/admin', '/compare/native/v1/responses/resp_peer', '/v1/responses/resp_peer']) {
    assert.equal((await fetch(`${app.origin}${route}`)).status, 404, route);
  }
  assert.equal((await fetch(`${app.origin}/compare/sglang/v1/responses/resp_peer/cancel?reason=none`, { method: 'POST' })).status, 400);
  assert.equal(requests.length, 2);
});

test('SGLang preserves native state, tools, and formats while mapping prompt_cache_key to a local namespace', async (t) => {
  const seen = [];
  const app = await fixture(t, async (req, res) => {
    seen.push(await bodyJson(req));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"resp_next","status":"queued"}');
  }, { serviceId: 'sglang', responsesMode: 'native' });
  const payload = {
    input: 'next turn', previous_response_id: 'resp_prior', store: true, background: true, truncation: 'disabled',
    prompt_cache_key: 'project-a', temperature: 0, top_p: 0.9,
    text: { format: { type: 'json_schema', name: 'answer', strict: true, schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } } },
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: { cache_control: { type: 'string' }, prompt_cache_breakpoint: { type: 'string' } } } }],
  };
  assert.equal((await post(app.origin, '/v1/responses', payload)).status, 200);
  const { prompt_cache_key, ...expected } = payload;
  assert.deepEqual(seen[0], { ...expected, cache_salt: prompt_cache_key });
  assert.equal((await post(app.origin, '/v1/responses', { input: 'hello', cache_salt: 'native-key' })).status, 200);
  assert.equal(seen[1].cache_salt, 'native-key');
  const comparison = await fixture(t, undefined, { sglangServiceBase: app.origin });
  assert.equal((await post(comparison.origin, '/compare/sglang/v1/responses', payload)).status, 200);
  assert.deepEqual(seen[2], { ...expected, cache_salt: prompt_cache_key });
  assert.equal((await post(app.origin, '/v1/responses', { input: 'hello', reasoning: { effort: 'none' }, chat_template_kwargs: { enable_thinking: false } })).status, 200);
  assert.deepEqual(seen[3].reasoning, { effort: 'none' });
});

test('SGLang rejects known unsupported cloud/cache/MLX options rather than silently accepting them', async (t) => {
  let hits = 0;
  const app = await fixture(t, (req, res) => { hits++; res.end('{}'); }, { serviceId: 'sglang', responsesMode: 'native' });
  const comparison = await fixture(t, undefined, { sglangServiceBase: app.origin });
  for (const invalid of [
    { prompt_cache_retention: '24h' }, { prompt_cache_options: {} }, { cache_control: { type: 'ephemeral' } },
    { prompt_cache_breakpoint: { mode: 'explicit', ttl: '1h' } },
    { input: [{ role: 'user', content: 'hello', prompt_cache_breakpoint: { mode: 'explicit', ttl: '1h' } }] },
    { input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello', prompt_cache_breakpoint: { mode: 'explicit', ttl: '1h' } }] }] },
    { tools: [{ type: 'function', name: 'lookup', prompt_cache_breakpoint: { mode: 'explicit', ttl: '1h' } }] },
    { service_tier: 'priority' }, { safety_identifier: 'user123' },
    { text: { verbosity: 'low' } }, { reasoning: { effort: 'high' } },
    { truncation: 'auto' }, { max_tool_calls: 1 }, { max_tool_calls: 0 },
    { tools: [{ type: 'web_search' }] }, { tools: [{ type: 'mcp', server_url: 'http://untrusted.invalid' }] },
    { input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello', cache_control: { type: 'ephemeral' } }] }] },
    { frequency_penalty: 0.5 }, { presence_penalty: -0.5 }, { repetition_penalty: 1.2 },
    { prompt_cache_key: 'first', cache_salt: 'second' }, { prompt_cache_key: '' }, { prompt_cache_key: 42 },
    { request_id: 'resp_bad/path' }, { request_id: 'resp_bad/cancel' },
  ]) {
    for (const [origin, route] of [[app.origin, '/v1/responses'], [comparison.origin, '/compare/sglang/v1/responses']]) {
      const response = await post(origin, route, { input: 'hello', ...invalid });
      assert.equal(response.status, 400, JSON.stringify(invalid));
      assert.ok((await response.json()).error.message);
    }
  }
  assert.equal(hits, 0);
});

test('Responses capabilities describe each deployed service without claiming cloud persistence', async (t) => {
  for (const [serviceId, responsesMode] of [['docker', 'adapter'], ['native', 'native'], ['sglang', 'native']]) {
    const app = await fixture(t, undefined, { serviceId, responsesMode });
    const config = await (await fetch(`${app.origin}/api/config`)).json();
    assert.equal(config.context_length, 32768);
    const caps = config.responses_capabilities;
    assert.equal(caps.text, true);
    assert.equal(caps.streaming, true);
    assert.equal(caps.persistence, serviceId === 'sglang');
    assert.equal(caps.previous_response_id, serviceId === 'sglang');
    assert.equal(caps.background, serviceId === 'sglang');
    assert.equal(caps.retrieve, serviceId === 'sglang');
    assert.equal(caps.cancel, serviceId === 'sglang');
    assert.equal(caps.delete, false);
    assert.equal(caps.input_items, false);
    if (serviceId === 'sglang') {
      assert.equal(caps.cache_usage, true);
      assert.equal(caps.prompt_cache_key, 'cache_salt_namespace');
      assert.equal(caps.storage, 'process_memory');
      assert.equal(caps.retention, 'bounded_memory');
      assert.equal(caps.structured_outputs, true);
      assert.equal(caps.function_calling, true);
      assert.deepEqual(caps.storage_limits, { ttl_seconds: 3600, max_completed: 128, max_serialized_bytes: 67108864, max_active: 8 });
    }
  }
});
