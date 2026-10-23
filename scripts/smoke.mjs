import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.API_BASE_URL || 'http://127.0.0.1:8088';
const configResponse = await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(10000) });
assert.equal(configResponse.status, 200, 'Service configuration must be reachable.');
const config = await configResponse.json();
const model = config.model;
const checks = [];
async function check(name, path, body, stream = false) {
  const start = performance.now();
  const response = await fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(180000),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, `${name}: ${response.status} ${raw}`);
  let detail;
  if (stream) {
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    const events = raw.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => line.slice(6));
    const parsed = events.filter(x => x !== '[DONE]').map(x => JSON.parse(x));
    assert(parsed.length > 2, `${name}: no incremental events`);
    if (path.includes('responses')) {
      const deltas = parsed.filter(x => x.type === 'response.output_text.delta');
      assert(deltas.some(x => x.delta?.length), `${name}: no text delta`);
      assert(parsed.some(x => ['response.completed', 'response.incomplete'].includes(x.type)), `${name}: no terminal event`);
      detail = { events: parsed.length, text: deltas.map(x => x.delta).join('') };
    } else {
      assert(events.includes('[DONE]'), `${name}: missing DONE`);
      const text = parsed.map(x => x.choices?.[0]?.delta?.content || '').join('');
      assert(text.trim(), `${name}: empty text`);
      detail = { events: parsed.length, text };
    }
  } else {
    const data = JSON.parse(raw);
    if (path.includes('chat/completions')) {
      assert(data.choices?.[0]?.message?.content?.trim(), `${name}: empty model output`);
      detail = { text: data.choices[0].message.content, usage: data.usage };
    } else if (path.includes('responses')) {
      assert.equal(data.object, 'response');
      const text = data.output?.flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('');
      assert(text?.trim(), `${name}: empty model output`);
      detail = { text, status: data.status, usage: data.usage };
    } else detail = data;
  }
  const result = { name, ok: true, http_status: response.status, elapsed_ms: Math.round(performance.now() - start), ...detail };
  checks.push(result);
  console.log(JSON.stringify(result));
}
await check('API health', '/healthz');
await check('Model catalog readiness', '/readyz');
const prompt = 'Reply with one short sentence: what is the capital of France? /no_think';
const chat = { model, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 128, chat_template_kwargs: { enable_thinking: false } };
const responses = { model, input: prompt, store: false, temperature: 0, max_output_tokens: 128 };
await check('Chat completions JSON', '/v1/chat/completions', chat);
await check('Responses JSON', '/v1/responses', responses);
await check('Chat completions SSE', '/v1/chat/completions', { ...chat, stream: true, stream_options: { include_usage: true } }, true);
await check('Responses SSE', '/v1/responses', { ...responses, stream: true }, true);
await check('Responses multi-turn', '/v1/responses', { ...responses, input: [{ role: 'user', content: 'My name is Mira.' }, { role: 'assistant', content: 'Hello Mira.' }, { role: 'user', content: 'What is my name? /no_think' }] });
const serviceId = config.service_id || (config.responses_mode === 'native' ? 'native' : 'docker');
const snapshots = { docker: 'service-status.json', native: 'service-status-native.json', sglang: 'service-status-sglang.json' };
assert(Object.hasOwn(snapshots, serviceId), `Unknown service identity: ${serviceId}`);
const filename = config.snapshot_file || snapshots[serviceId];
assert.match(filename, /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/, 'Snapshot must be a JSON filename inside docs.');
const snapshot = { checked_at: new Date().toISOString(), base_url: base, model, service_id: serviceId, service_name: config.service_name, backend: config.backend, responses_mode: config.responses_mode || 'adapter', checks };
await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
await writeFile(new URL(`../docs/${filename}`, import.meta.url), JSON.stringify(snapshot, null, 2) + '\n');
console.log(`PASS: ${checks.length} live checks. Snapshot saved to docs/${filename}`);
