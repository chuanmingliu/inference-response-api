import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the shipped browser script through its UI handlers without an engine.
class Element {
  constructor(value = '') {
    this.value = value;
    this.textContent = '';
    this.style = {};
    this.children = [];
    this.handlers = new Map();
    this.selectors = new Map();
    this.classList = { toggle() {}, add() {} };
  }
  addEventListener(event, handler) { this.handlers.set(event, handler); }
  setAttribute() {}
  toggleAttribute() {}
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  focus() {}
  checkValidity() { return true; }
  querySelector(selector) {
    if (!this.selectors.has(selector)) this.selectors.set(selector, new Element());
    return this.selectors.get(selector);
  }
  trigger(event) { return this.handlers.get(event)({ preventDefault() {} }); }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const jsonResponse = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('generation recovery replaces stale service status, but a later failed check still wins', async () => {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  get('api-mode').value = 'responses';
  get('temperature').value = '0';
  get('max-tokens').value = '128';
  get('service-select').options = ['docker', 'native', 'sglang'].map((id) => new Element(id));
  const guideLink = new Element();
  const oldPeerPoll = deferred();
  const oldSelectedPoll = deferred();
  let sglangPolls = 0;
  let sentRequest;
  const config = (id) => ({
    service_id: id,
    service_name: id,
    model: id === 'sglang' ? 'mlx-community/Qwen3-0.6B-4bit' : 'huggingface.co/mlx-community/qwen3-0.6b-4bit:latest',
    responses_mode: id === 'docker' ? 'adapter' : 'native',
    deployment_doc: id === 'sglang' ? '/docs/sglang' : '/docs',
    comparison: { available: id === 'docker', services: [
      { id: 'docker', base_path: '' }, { id: 'native', base_path: '/compare/native' }, { id: 'sglang', base_path: '/compare/sglang' },
    ] },
  });
  const fetch = async (path, options) => {
    if (path.endsWith('/api/config')) return jsonResponse(config(path.includes('/sglang/') ? 'sglang' : 'docker'));
    if (path === '/compare/sglang/api/status') {
      sglangPolls += 1;
      if (sglangPolls === 1) return oldPeerPoll.promise;
      if (sglangPolls === 3) return oldSelectedPoll.promise;
      return jsonResponse({ ready: false });
    }
    if (path.endsWith('/api/status')) return jsonResponse({ ready: true });
    assert.equal(path, '/compare/sglang/v1/responses');
    sentRequest = JSON.parse(options.body);
    return jsonResponse({ object: 'response', output_text: 'Hello from SGLang.', usage: { input_tokens: 8, output_tokens: 5 } });
  };
  const context = vm.createContext({
    document: {
      getElementById: get,
      querySelector: get,
      querySelectorAll: (selector) => selector === '[data-deployment-doc]' ? [guideLink] : [],
      createElement: () => new Element(),
      createTextNode: (text) => text,
    },
    navigator: { platform: 'MacIntel' },
    location: { origin: 'http://localhost:8088' },
    fetch, AbortController, TextDecoder, performance, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  await tick();
  await get('sglang-comparison').trigger('click');
  assert.equal(get('sglang-availability').textContent, 'Unavailable');
  assert.equal(guideLink.href, '/docs/sglang');

  const staleRefresh = get('refresh-status').trigger('click');
  get('prompt').value = 'Say hello.';
  await get('prompt-form').trigger('submit');
  assert.equal(sentRequest.model, 'mlx-community/Qwen3-0.6B-4bit');
  assert.equal(sentRequest.store, false);
  assert.equal(get('sglang-availability').textContent, 'Generation verified');
  assert.equal(get('status-label').textContent, 'Inference verified');

  oldPeerPoll.resolve(jsonResponse({ ready: false }));
  oldSelectedPoll.resolve(jsonResponse({ ready: false }));
  await staleRefresh;
  await tick();
  assert.equal(get('sglang-availability').textContent, 'Generation verified');
  assert.equal(get('status-label').textContent, 'Inference verified');

  await get('refresh-status').trigger('click');
  assert.equal(get('sglang-availability').textContent, 'Unavailable');
  assert.equal(get('status-label').textContent, 'Service unavailable');
});

const storedCapabilities = {
  persistence: true, previous_response_id: true, background: true,
  retrieve: true, cancel: true, cache_usage: true,
  prompt_cache_key: 'cache_salt_namespace',
  storage_limits: { ttl_seconds: 3600, max_completed: 128, max_serialized_bytes: 67108864, max_active: 8 },
};
async function playground(onRequest) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  get('api-mode').value = 'responses';
  get('temperature').value = '0';
  get('max-tokens').value = '128';
  get('service-select').options = ['docker', 'native', 'sglang'].map((id) => new Element(id));
  let clipboard = '';
  const requests = [];
  const fetch = async (path, options) => {
    if (path.endsWith('/api/config')) {
      const id = path.includes('/sglang/') ? 'sglang' : 'docker';
      return jsonResponse({
        service_id: id, model: id === 'sglang' ? 'mlx-community/Qwen3-0.6B-4bit' : 'docker-qwen',
        responses_mode: id === 'sglang' ? 'native' : 'adapter', context_length: 32768,
        ...(id === 'sglang' ? { responses_capabilities: storedCapabilities } : {}),
        comparison: { available: id === 'docker', services: [
          { id: 'docker', base_path: '' }, { id: 'sglang', base_path: '/compare/sglang' },
        ] },
      });
    }
    if (path.endsWith('/api/status')) return jsonResponse({ ready: true });
    const request = { path, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : null };
    requests.push(request);
    return onRequest(request, get);
  };
  const context = vm.createContext({
    document: { getElementById: get, querySelector: get, querySelectorAll: () => [],
      createElement: () => new Element(), createTextNode: (text) => text },
    navigator: { platform: 'MacIntel', clipboard: { writeText: async (text) => { clipboard = text; } } },
    location: { origin: 'http://localhost:8088' }, fetch, AbortController, TextDecoder, performance,
    setTimeout: (callback, delay) => setTimeout(callback, Math.min(delay, 5)), clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  await tick();
  await get('sglang-comparison').trigger('click');
  return {
    get, requests, clipboard: () => clipboard,
    async send(prompt) { get('prompt').value = prompt; await get('prompt-form').trigger('submit'); },
    toggle(id, checked) { get(id).checked = checked; return get(id).trigger('change'); },
  };
}
function complete(id, text = 'A local reply.') {
  return { id, object: 'response', status: 'completed', output_text: text,
    usage: { input_tokens: 1000, output_tokens: 8, input_tokens_details: { cached_tokens: 256 } } };
}

test('stored conversations chain only the newest input, with matching inspector, cURL and cache accounting', async () => {
  let count = 0;
  const panel = await playground(() => jsonResponse(complete(`resp_turn${++count}`)));
  assert.equal(panel.get('max-tokens').max, '32768');
  panel.toggle('store-conversation', true);
  assert.match(panel.get('conversation-storage-help').textContent, /up to 60 minutes/);
  await panel.send('Remember that my favorite color is green.');
  assert.equal(panel.requests[0].body.store, true);
  assert.equal(panel.requests[0].body.stream, true);
  assert.equal(panel.requests[0].body.previous_response_id, undefined);
  assert.equal(panel.get('response-id').textContent, 'resp_turn1');
  assert.equal(panel.get('cache-stat').textContent, '256 / 1,000 input tokens cached (26%)');

  panel.get('prompt').value = 'What color did I choose?';
  panel.get('prompt').trigger('input');
  const preview = JSON.parse(panel.get('inspector-code').textContent);
  assert.equal(preview.previous_response_id, 'resp_turn1');
  assert.deepEqual(preview.input, [{ role: 'user', content: 'What color did I choose?' }]);
  await panel.send('What color did I choose?');
  assert.deepEqual(panel.requests[1].body, preview);
  panel.get('copy-curl').trigger('click');
  await tick();
  assert.match(panel.clipboard(), /\/compare\/sglang\/v1\/responses/);
  assert.match(panel.clipboard(), /"previous_response_id": "resp_turn1"/);
  assert.doesNotMatch(panel.clipboard(), /Remember that my favorite color/);
  panel.get('copy-response-id').trigger('click');
  await tick();
  assert.equal(panel.clipboard(), 'resp_turn2');
});

test('a prompt cache key is independent of response storage and is omitted on unsupported services', async () => {
  const panel = await playground(() => jsonResponse(complete('resp_cached')));
  panel.get('prompt-cache-key').value = 'project-notes'; panel.get('prompt-cache-key').trigger('input');
  await panel.send('Use the shared prefix.');
  assert.equal(panel.requests[0].body.prompt_cache_key, 'project-notes');
  assert.equal(panel.requests[0].body.store, false);
  assert.equal(panel.get('prompt-cache-field').hidden, false);
  await panel.get('docker-comparison').trigger('click');
  assert.equal(panel.get('prompt-cache-field').hidden, true);
  await panel.send('No unsupported cache parameter.');
  assert.equal(panel.requests[1].body.prompt_cache_key, undefined);
});

test('opting out restores full history, changing API modes and clearing reset the stored chain', async () => {
  let count = 0;
  const panel = await playground(() => jsonResponse(complete(`resp_turn${++count}`)));
  panel.toggle('store-conversation', true);
  await panel.send('First turn.');
  panel.toggle('store-conversation', false);
  await panel.send('Second turn.');
  assert.equal(panel.requests[1].body.store, false);
  assert.equal(panel.requests[1].body.previous_response_id, undefined);
  assert.equal(panel.requests[1].body.input.length, 3);
  panel.toggle('store-conversation', true);
  await panel.send('Third turn.');
  assert.equal(panel.requests[2].body.previous_response_id, undefined);
  assert.equal(panel.requests[2].body.input.length, 5);
  panel.get('api-mode').value = 'chat'; panel.get('api-mode').trigger('input');
  panel.get('api-mode').value = 'responses'; panel.get('api-mode').trigger('input');
  await panel.send('After switching APIs.');
  assert.equal(panel.requests[3].body.previous_response_id, undefined);
  assert.equal(panel.requests[3].body.input.length, 7);
  panel.get('clear-chat').trigger('click');
  assert.equal(panel.get('response-meta').hidden, true);
  await panel.send('Fresh conversation.');
  assert.equal(panel.requests[4].body.previous_response_id, undefined);
  assert.deepEqual(panel.requests[4].body.input, [{ role: 'user', content: 'Fresh conversation.' }]);
});

test('failed requests reset the chain and switching services never leaks stored capabilities', async () => {
  let count = 0;
  const panel = await playground(() => ++count === 2
    ? new Response(JSON.stringify({ error: { message: 'Stored response was evicted.' } }), { status: 404 })
    : jsonResponse(complete(`resp_turn${count}`)));
  panel.toggle('store-conversation', true);
  await panel.send('First turn.');
  await panel.send('Follow up.');
  assert.equal(panel.get('generation-state').textContent, 'Request failed');
  await panel.send('Recover using full history.');
  assert.equal(panel.requests[2].body.previous_response_id, undefined);
  assert.equal(panel.requests[2].body.input.length, 4);
  assert.equal(panel.requests[2].body.input.some(({ content }) => /evicted/.test(content)), false);
  await panel.get('docker-comparison').trigger('click');
  assert.equal(panel.get('response-options').hidden, true);
  await panel.send('Use the adapter.');
  assert.equal(panel.requests[3].path, '/v1/responses');
  assert.equal(panel.requests[3].body.store, false);
  assert.equal(panel.requests[3].body.previous_response_id, undefined);
  assert.equal(panel.requests[3].body.input.length, 1);
});

test('background mode creates a stored nonstreaming job, polls its ID, and can chain the result', async () => {
  const panel = await playground(({ method, path }) => method === 'GET'
    ? jsonResponse(complete('resp_background'))
    : jsonResponse({ id: 'resp_background', status: 'queued', output: [] }));
  panel.toggle('background-response', true);
  assert.equal(panel.get('store-conversation').checked, true);
  await panel.send('Do some work in the background.');
  assert.equal(panel.requests[0].body.background, true);
  assert.equal(panel.requests[0].body.store, true);
  assert.equal(panel.requests[0].body.stream, false);
  assert.equal(panel.requests[1].path, '/compare/sglang/v1/responses/resp_background');
  assert.equal(panel.requests[1].method, 'GET');
  assert.equal(panel.get('generation-state').textContent, 'Complete');
  panel.toggle('background-response', false);
  panel.get('prompt').value = 'Continue with streaming.'; panel.get('prompt').trigger('input');
  const next = JSON.parse(panel.get('inspector-code').textContent);
  assert.equal(next.previous_response_id, 'resp_background');
  assert.equal(next.stream, true);
  assert.equal(next.background, undefined);
});

test('stopping a background job before create returns cancels its server ID and resets the chain', async () => {
  const submitted = deferred();
  let count = 0;
  const panel = await playground(({ path }) => {
    count += 1;
    if (count === 1) return submitted.promise;
    assert.equal(path, '/compare/sglang/v1/responses/resp_cancel/cancel');
    return jsonResponse({ id: 'resp_cancel', status: 'cancelled', output: [] });
  });
  panel.toggle('background-response', true);
  const generation = panel.send('A task to cancel.');
  await tick();
  panel.get('stop-button').trigger('click');
  assert.equal(panel.get('generation-state').textContent, 'Cancelling');
  submitted.resolve(jsonResponse({ id: 'resp_cancel', status: 'queued', output: [] }));
  await generation;
  assert.equal(panel.requests[1].method, 'POST');
  assert.equal(panel.get('generation-state').textContent, 'Cancelled');
  assert.equal(panel.get('response-id').textContent, 'resp_cancel');
  assert.equal(panel.get('stop-button').disabled, false);
  panel.get('prompt').value = 'Try again.'; panel.get('prompt').trigger('input');
  assert.equal(JSON.parse(panel.get('inspector-code').textContent).previous_response_id, undefined);
});
