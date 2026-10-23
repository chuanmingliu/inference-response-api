'use strict';

const $ = (id) => document.getElementById(id);
const serviceIds = ['docker', 'native', 'sglang'];
const state = {
  config: { model: 'huggingface.co/mlx-community/qwen3-0.6b-4bit:latest', backend: 'vllm-metal', context_length: 4096 },
  messages: [], busy: false, controller: null, request: null, response: null,
  inspector: 'request', usage: null, firstTokenMs: null, startedAt: null,
  inferenceVerified: false, status: null, toastTimer: null,
  service: 'docker', configReady: false, selectionVersion: 0, runs: { docker: null, native: null, sglang: null },
  statuses: {}, statusRevisions: {}, rootConfigured: false, comparisonAvailable: false, servicePaths: { docker: '' },
  previousResponseId: null, backgroundResponseId: null, cancelRequested: false, operationLabel: 'Generating',
};

function servicePath(path) { return (state.servicePaths[state.service] || '') + path; }
function currentMode() { return $('api-mode').value; }
function endpoint(mode = currentMode()) { return mode === 'chat' ? '/v1/chat/completions' : '/v1/responses'; }
function responseCapabilities() { return state.config.responses_capabilities || {}; }
function usesStoredConversation(mode = currentMode()) {
  const capabilities = responseCapabilities();
  return mode === 'responses' && capabilities.persistence && capabilities.previous_response_id && $('store-conversation').checked;
}
function usesBackground(mode = currentMode()) {
  const capabilities = responseCapabilities();
  return usesStoredConversation(mode) && capabilities.background && capabilities.retrieve && capabilities.cancel && $('background-response').checked;
}
function updateResponseControls() {
  const capabilities = responseCapabilities();
  const supported = currentMode() === 'responses' && capabilities.persistence && capabilities.previous_response_id;
  $('response-options').hidden = !supported;
  $('background-option').hidden = !(capabilities.background && capabilities.retrieve && capabilities.cancel);
  $('prompt-cache-field').hidden = !capabilities.prompt_cache_key;
  $('store-conversation').disabled = state.busy;
  $('background-response').disabled = state.busy;
  const ttl = Number(capabilities.storage_limits?.ttl_seconds);
  const retention = ttl > 0
    ? `Stored locally for up to ${Math.ceil(ttl / 60)} minutes; restart or eviction can remove it sooner.`
    : 'Stored locally until the engine restarts or evicts it.';
  $('conversation-storage-help').textContent = usesStoredConversation()
    ? `Follow-ups use the previous response ID. ${retention}`
    : 'Send full conversation history with each request. Responses are not stored.';
  $('composer-mode').textContent = usesBackground() ? 'Background job · polls for result' : 'Streaming enabled';
}
function historyMessages() {
  return state.messages.filter((message) => message.role === 'user' || (message.content && !message.error))
    .map(({ role, content }) => ({ role, content }));
}
function makeRequest(preview = false, mode = currentMode()) {
  const messages = historyMessages();
  if (preview && $('prompt').value.trim()) messages.push({ role: 'user', content: $('prompt').value.trim() });
  if (!messages.length) messages.push({ role: 'user', content: 'Hello! Tell me a little about yourself.' });
  const instructions = $('system-instructions').value.trim();
  const maxTokens = Number($('max-tokens').value);
  const request = { model: state.config.model, stream: true, temperature: Number($('temperature').value) };
  if (mode === 'chat') {
    request.messages = instructions ? [{ role: 'system', content: instructions }, ...messages] : messages;
    request.max_tokens = maxTokens;
    request.chat_template_kwargs = { enable_thinking: false };
    request.stream_options = { include_usage: true };
  } else {
    request.input = messages;
    if (instructions) request.instructions = instructions;
    request.max_output_tokens = maxTokens;
    request.store = Boolean(usesStoredConversation(mode));
    const cacheKey = $('prompt-cache-key').value.trim();
    if (responseCapabilities().prompt_cache_key && cacheKey) request.prompt_cache_key = cacheKey;
    if (request.store && state.previousResponseId) {
      request.previous_response_id = state.previousResponseId;
      request.input = preview ? [{ role: 'user', content: $('prompt').value.trim() || 'Your next message.' }] : messages.slice(-1);
    }
    if (usesBackground(mode)) { request.background = true; request.stream = false; }
  }
  return request;
}
function updateInspector() {
  const isRequest = state.inspector === 'request';
  const value = isRequest ? state.request || makeRequest(true) : state.response;
  $('inspector-code').textContent = value ? JSON.stringify(value, null, 2) : '// Your response will appear here.\n// Send a message to begin.';
  $('inspector-note').textContent = isRequest ? (state.request ? 'Last request sent to the API' : 'Preview of your next request') : (state.response ? 'Response received from the API' : 'Waiting for a response');
  $('request-tab').classList.toggle('active', isRequest);
  $('response-tab').classList.toggle('active', !isRequest);
  $('request-tab').setAttribute('aria-selected', String(isRequest));
  $('response-tab').setAttribute('aria-selected', String(!isRequest));
  $('inspector-code').setAttribute('aria-labelledby', isRequest ? 'request-tab' : 'response-tab');
}
function settingsChanged() {
  if (!state.busy) state.request = null;
  $('endpoint-label').textContent = `POST ${endpoint()}`;
  $('temperature-output').value = $('temperature').value;
  const percent = Number($('temperature').value) / 2 * 100;
  $('temperature').style.background = `linear-gradient(to right, #9eb971 ${percent}%, #e9eddf ${percent}%)`;
  updateResponseControls();
  updateInspector();
}
function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
function curlFor(request, mode = currentMode()) {
  return [`curl ${shellQuote(location.origin + servicePath(endpoint(mode)))}`, "  -H 'Content-Type: application/json'", '  -N', `  -d ${shellQuote(JSON.stringify(request, null, 2))}`].join(' ' + String.fromCharCode(92) + '\n');
}
function toast(message) {
  clearTimeout(state.toastTimer);
  $('toast').querySelector('span').textContent = message;
  $('toast').hidden = false;
  state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2700);
}
async function copyText(value) {
  try { await navigator.clipboard.writeText(value); toast('Copied to clipboard'); }
  catch { toast('Clipboard unavailable. Select and copy the text manually.'); }
}
function buildExamples() {
  const base = { model: state.config.model, stream: true };
  const responses = { ...base, input: 'Explain an API in one sentence.', max_output_tokens: 128, store: false };
  const chat = { ...base, messages: [{ role: 'user', content: 'Explain an API in one sentence.' }], max_tokens: 128, chat_template_kwargs: { enable_thinking: false } };
  $('api-base-url').textContent = `${location.origin}${servicePath('/v1')}`;
  $('responses-example').textContent = curlFor(responses, 'responses');
  $('chat-example').textContent = curlFor(chat, 'chat');
}
function selectView(name) {
  const playground = name === 'playground';
  $('playground-view').hidden = !playground;
  $('api-view').hidden = playground;
  $('nav-playground').classList.toggle('active', playground);
  $('nav-api').classList.toggle('active', !playground);
  $('nav-playground').toggleAttribute('aria-current', playground);
  $('nav-api').toggleAttribute('aria-current', !playground);
  if (playground) $('nav-playground').setAttribute('aria-current', 'page');
  else $('nav-api').setAttribute('aria-current', 'page');
  $('breadcrumb-page').textContent = playground ? 'Playground' : 'API reference';
  if (!playground) buildExamples();
}

function configureRootService(config) {
  if (state.rootConfigured) return;
  state.rootConfigured = true;
  state.service = serviceIds.includes(config.service_id) ? config.service_id : config.responses_mode === 'native' ? 'native' : 'docker';
  state.servicePaths = { [state.service]: '' };
  state.comparisonAvailable = Boolean(config.comparison?.available);
  if (state.comparisonAvailable) {
    const services = config.comparison.services || [];
    for (const service of services) {
      if (serviceIds.includes(service.id) && typeof service.base_path === 'string') state.servicePaths[service.id] = service.base_path;
    }
    $('page-subtitle').textContent = `${Object.keys(state.servicePaths).length} ways to run local. One place to put them to the test.`;
  } else {
    $('service-help').textContent = 'Connected directly to this service.';
    $('page-subtitle').textContent = `${config.service_name || 'Your local model'}, running directly on this Mac.`;
  }
  for (const option of $('service-select').options) option.hidden = !(option.value in state.servicePaths);
  $('service-select').value = state.service;
  $('service-select').disabled = !state.comparisonAvailable;
  document.querySelector('.comparison-rail').hidden = !state.comparisonAvailable;
  updateComparison();
  for (const id of Object.keys(state.servicePaths)) {
    if (id !== state.service) refreshComparisonStatus(id);
  }
}

function advanceStatusRevision(id) {
  state.statusRevisions[id] = (state.statusRevisions[id] || 0) + 1;
  return state.statusRevisions[id];
}

async function refreshComparisonStatus(id) {
  const revision = advanceStatusRevision(id);
  try {
    const response = await fetch(`${state.servicePaths[id]}/api/status`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = await response.json();
    if (revision !== state.statusRevisions[id]) return;
    state.statuses[id] = status;
  } catch {
    if (revision !== state.statusRevisions[id]) return;
    state.statuses[id] = { ready: false };
  }
  updateComparison();
}

async function loadConfig() {
  const version = state.selectionVersion;
  try {
    const response = await fetch(servicePath('/api/config'), { cache: 'no-store' });
    if (!response.ok) throw new Error(`Configuration returned HTTP ${response.status}`);
    const config = await response.json();
    if (version !== state.selectionVersion) return;
    configureRootService(config);
    state.config = { ...state.config, ...config, responses_capabilities: config.responses_capabilities || {} };
    state.configReady = true;
    // All gateways ship the same two guides. Keep links local to this panel.
    const guide = config.deployment_doc === '/docs/sglang' ? '/docs/sglang' : '/docs';
    for (const link of document.querySelectorAll('[data-deployment-doc]')) link.href = guide;
    const modeLabel = config.responses_mode === 'service' ? 'Core' : config.responses_mode === 'native' ? 'native' : 'adapter';
    $('api-mode').querySelector('option[value="responses"]').textContent = `Responses API · ${modeLabel}`;
    $('responses-example-title').textContent = `Responses API · ${modeLabel}`;
    $('responses-example-description').textContent = config.responses_mode === 'service' ? 'Typed messages and streaming, with function calls and JSON schemas on supported runtimes. Send full history with store: false.' : modeLabel === 'adapter' ? 'Text-only compatibility adapter. Send full history with store: false.' : config.responses_capabilities?.persistence ? 'Native Responses with optional local storage, response chaining, and background jobs. The example is stateless.' : 'Native Responses endpoint. This playground sends full history with store: false.';
    $('service-url').textContent = location.origin + servicePath('/v1');
    const model = config.model || state.config.model;
    const shortName = /qwen3.*0[.-]6b/i.test(model) ? 'Qwen3 0.6B' : model.split('/').pop().replace(/:latest$/, '');
    $('config-model-name').textContent = shortName;
    $('config-model-name').title = model;
    $('overview-model').textContent = shortName;
    if (/4bit|4-bit/i.test(model)) {
      const tag = document.createElement('span'); tag.className = 'muted-tag'; tag.textContent = '4-bit';
      $('overview-model').append(' ', tag);
    }
    $('config-model-detail').textContent = /4bit|4-bit/i.test(model) ? '4-bit · Local model' : 'Local model';
    $('overview-engine').textContent = config.backend === 'vllm-metal' ? 'vLLM Metal' : config.backend || 'Configured upstream';
    const contextLength = Number(config.context_length);
    $('context-help').textContent = contextLength ? `Context window: ${contextLength.toLocaleString()} tokens, shared with input.` : 'Output and input share the model context window.';
    if (contextLength) $('max-tokens').max = String(Math.max(16, contextLength));
    updateResponseControls(); updateInspector(); buildExamples();
  } catch (error) {
    if (version !== state.selectionVersion) return;
    state.configReady = false;
    $('overview-engine').textContent = 'Configuration unavailable';
    $('context-help').textContent = 'Configuration unavailable. Refresh service status to retry.';
    showServiceNotice(error.message);
  } finally { if (version === state.selectionVersion) $('send-button').disabled = !state.configReady; }
}
function showServiceNotice(message) {
  $('service-notice').textContent = message;
  $('service-notice').hidden = !message;
}
async function refreshStatus() {
  const version = state.selectionVersion;
  const id = state.service;
  const revision = advanceStatusRevision(id);
  $('refresh-status').disabled = true;
  try {
    const response = await fetch(servicePath('/api/status'), { cache: 'no-store' });
    if (!response.ok) throw new Error(`Status check returned HTTP ${response.status}`);
    const status = await response.json();
    if (version !== state.selectionVersion || revision !== state.statusRevisions[id]) return;
    state.status = status;
    state.statuses[id] = status;
    updateComparison();
    const ready = status.ready ?? status.ok ?? false;
    const verified = state.inferenceVerified || Boolean(status.inference?.verified);
    const dot = $('refresh-status').querySelector('.status-dot');
    dot.className = `status-dot${ready ? '' : ' offline'}`;
    $('status-label').textContent = ready ? (verified ? 'Inference verified' : 'Model available') : 'Service unavailable';
    const checked = status.checked_at ? new Date(status.checked_at) : new Date();
    const checkedText = Number.isNaN(checked.valueOf()) ? '' : ` Checked ${checked.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
    $('status-footnote').textContent = ready
      ? `${verified ? 'A generation request has succeeded.' : 'Model catalog is reachable. Engine inference is verified when you send a message.'}${checkedText}`
      : `The API could not confirm this model is available.${checkedText} See the deployment guide for service commands.`;
    if (ready) showServiceNotice('');
    else showServiceNotice(status.error ? `Model service unavailable: ${typeof status.error === 'string' ? status.error : JSON.stringify(status.error)}` : 'The model service is not ready. Check the Deployment guide, then refresh service status.');
  } catch (error) {
    if (version !== state.selectionVersion || revision !== state.statusRevisions[id]) return;
    $('status-label').textContent = 'Status unavailable';
    $('refresh-status').querySelector('.status-dot').className = 'status-dot offline';
    $('status-footnote').textContent = 'Service status could not be checked. You can retry with the refresh button.';
    state.statuses[id] = { ready: false };
    updateComparison();
    showServiceNotice(error.message);
  } finally { if (version === state.selectionVersion) $('refresh-status').disabled = false; }
}

function scrollConversation(force = false) {
  const panel = $('conversation-scroll');
  if (force || panel.scrollHeight - panel.scrollTop - panel.clientHeight < 150) panel.scrollTop = panel.scrollHeight;
}
function createMessage(role, content = '') {
  const item = { role, content, reasoning: '', error: false, node: null, textNode: null };
  state.messages.push(item);
  $('empty-state').hidden = true;
  const element = document.createElement('article'); element.className = `message ${role}`;
  const avatar = document.createElement('span'); avatar.className = 'message-avatar'; avatar.textContent = role === 'user' ? 'Y' : 'Q'; avatar.setAttribute('aria-hidden', 'true');
  const body = document.createElement('div'); body.className = 'message-body';
  const heading = document.createElement('div'); heading.className = 'message-heading';
  const name = document.createElement('strong'); name.textContent = role === 'user' ? 'You' : $('config-model-name').textContent;
  const subtitle = document.createElement('span'); subtitle.textContent = role === 'user' ? 'PROMPT' : 'LOCAL MODEL';
  const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'icon-button message-copy'; copy.title = 'Copy message'; copy.setAttribute('aria-label', `Copy ${role === 'user' ? 'your' : 'model'} message`);
  copy.innerHTML = '<svg aria-hidden="true"><use href="#i-copy"/></svg>';
  copy.addEventListener('click', () => copyText(item.content));
  heading.append(name, subtitle, copy);
  const messageText = document.createElement('div'); messageText.className = 'message-text'; messageText.textContent = content;
  if (!content && role === 'assistant') messageText.innerHTML = '<span class="thinking-indicator" aria-label="Waiting for model"><i></i><i></i><i></i></span>';
  body.append(heading, messageText); element.append(avatar, body); $('messages').append(element);
  item.node = element; item.textNode = messageText;
  $('message-count').textContent = String(state.messages.filter((message) => message.role === 'user').length);
  scrollConversation(true);
  return item;
}
function renderMessage(item) {
  // Model text is always rendered as text nodes. Only fenced code is formatted.
  const parts = item.content.split(/(```[\s\S]*?```)/g);
  item.textNode.replaceChildren();
  for (const part of parts) {
    if (part.startsWith('```') && part.endsWith('```')) {
      const pre = document.createElement('pre'); const code = document.createElement('code');
      code.textContent = part.slice(3, -3).replace(/^[^\n]*\n/, '').replace(/\n$/, '');
      pre.append(code); item.textNode.append(pre);
    } else item.textNode.append(document.createTextNode(part));
  }
  if (item.reasoning) {
    let details = item.node.querySelector('.reasoning-details');
    if (!details) {
      details = document.createElement('details'); details.className = 'reasoning-details';
      const summary = document.createElement('summary'); summary.textContent = 'Model reasoning';
      details.append(summary, document.createElement('p')); item.textNode.before(details);
    }
    details.querySelector('p').textContent = item.reasoning;
  }
  scrollConversation();
}
function appendText(item, value) {
  if (!value) return;
  if (state.firstTokenMs === null) state.firstTokenMs = performance.now() - state.startedAt;
  item.content += value; item.textNode.textContent = item.content; scrollConversation();
}
function fullResponseText(response) {
  if (typeof response.output_text === 'string') return response.output_text;
  return (response.output || []).flatMap((item) => item.content || []).filter((part) => part.type === 'output_text').map((part) => part.text || '').join('');
}
function apiError(data, fallback = 'The model request failed.') {
  const error = data?.error || data;
  return typeof error === 'string' ? error : error?.message || error?.detail || fallback;
}
function handleStreamEvent(data, item) {
  if (data.error || data.type === 'error' || data.type === 'response.failed') throw new Error(apiError(data.response || data));
  if (data.type === 'response.created' || data.type === 'response.in_progress') state.response = data.response || data;
  if (data.type === 'response.output_text.delta') {
    appendText(item, data.delta);
    state.response = { ...(state.response || {}), status: 'in_progress', output_text: item.content };
  }
  if (data.type === 'response.reasoning_summary_text.delta' || data.type === 'response.reasoning_text.delta') item.reasoning += data.delta || '';
  if (data.type === 'response.completed' || data.type === 'response.incomplete') {
    state.response = data.response || data;
    state.usage = state.response.usage || state.usage;
    if (!item.content) item.content = fullResponseText(state.response);
    if (data.type === 'response.incomplete') item.incomplete = true;
  }
  if (Array.isArray(data.choices)) {
    const choice = data.choices[0];
    if (choice?.delta?.content) appendText(item, choice.delta.content);
    if (choice?.delta?.reasoning_content) item.reasoning += choice.delta.reasoning_content;
    if (choice?.finish_reason === 'length') item.incomplete = true;
    if (data.usage) state.usage = data.usage;
    state.response = { id: data.id, object: 'chat.completion', model: data.model || state.config.model, choices: [{ index: 0, message: { role: 'assistant', content: item.content }, finish_reason: choice?.finish_reason || state.response?.choices?.[0]?.finish_reason || null }], ...(state.usage ? { usage: state.usage } : {}) };
  }
  updateInspector();
}
async function readSSE(response, item) {
  if (!response.body) throw new Error('This browser did not provide a readable response stream.');
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buffer = ''; let sawData = false; let completed = false;
  const consume = (block) => {
    const lines = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart());
    if (!lines.length) return;
    const payload = lines.join('\n').trim();
    if (payload === '[DONE]') { completed = true; return; }
    if (!payload) return;
    let data;
    try { data = JSON.parse(payload); } catch { throw new Error('The model service returned an invalid streaming event.'); }
    sawData = true; handleStreamEvent(data, item);
    if (['response.completed', 'response.incomplete'].includes(data.type) || data.choices?.some((choice) => choice.finish_reason)) completed = true;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) { consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
      if (done) { if (buffer.trim()) consume(buffer); break; }
    }
    if (!sawData) throw new Error('The model service closed the stream without a response.');
    if (!completed) throw new Error('The model stream ended unexpectedly. Any received text is shown above.');
  } finally { reader.releaseLock(); }
}
async function responseJSON(response) {
  const body = await response.text();
  let data;
  try { data = JSON.parse(body); } catch { data = { message: body.slice(0, 1200) || response.statusText }; }
  if (!response.ok || data.error) throw new Error(apiError(data, `The API returned HTTP ${response.status}.`));
  return data;
}
async function finishBackground(initial) {
  let data = initial;
  if (!data.id || !/^resp_[A-Za-z0-9_-]+$/.test(data.id)) throw new Error('The background request did not return a valid response ID.');
  state.backgroundResponseId = data.id;
  const path = servicePath(`/v1/responses/${encodeURIComponent(data.id)}`);
  let cancellationSent = false;
  while (['queued', 'in_progress'].includes(data.status)) {
    state.response = data;
    state.operationLabel = state.cancelRequested ? 'Cancelling' : data.status === 'queued' ? 'Queued' : 'Running in background';
    showStats(state.operationLabel); updateInspector();
    if (state.cancelRequested && !cancellationSent) {
      data = await responseJSON(await fetch(`${path}/cancel`, { method: 'POST', signal: state.controller.signal }));
      cancellationSent = true;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 500));
      data = await responseJSON(await fetch(path, { cache: 'no-store', signal: state.controller.signal }));
    }
  }
  return data;
}
function setBusy(busy) {
  state.busy = busy;
  $('send-button').hidden = busy; $('stop-button').hidden = !busy;
  $('clear-chat').disabled = busy;
  $('api-mode').disabled = busy;
  $('service-select').disabled = busy || !state.comparisonAvailable;
  $('stop-button').disabled = false;
  for (const id of serviceIds) $(`${id}-comparison`).disabled = busy || !state.rootConfigured;
  for (const starter of document.querySelectorAll('.starter')) starter.disabled = busy;
  $('messages').setAttribute('aria-busy', String(busy));
  updateResponseControls();
}
function showStats(label) {
  $('generation-stats').hidden = false;
  $('generation-state').textContent = label;
  const elapsed = state.startedAt ? (performance.now() - state.startedAt) / 1000 : 0;
  $('latency-stat').textContent = `${elapsed.toFixed(2)} s${state.firstTokenMs !== null ? ` · ${(state.firstTokenMs / 1000).toFixed(2)} s first token` : ''}`;
  const usage = state.usage;
  $('tokens-stat').textContent = usage ? `${usage.input_tokens ?? usage.prompt_tokens ?? '—'} in / ${usage.output_tokens ?? usage.completion_tokens ?? '—'} out` : '';
  const input = usage?.input_tokens ?? usage?.prompt_tokens;
  const cached = usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens;
  $('cache-stat').textContent = Number.isFinite(cached)
    ? `${cached.toLocaleString()} / ${Number.isFinite(input) ? input.toLocaleString() : '—'} input tokens cached${input > 0 ? ` (${Math.round(cached / input * 100)}%)` : ''}`
    : 'Cache usage not reported';
  const responseId = state.response?.id;
  $('response-meta').hidden = false;
  $('response-id').textContent = responseId || 'Waiting for response ID';
  $('response-id').title = responseId || '';
  $('copy-response-id').disabled = !responseId;
}
async function sendMessage(event) {
  event?.preventDefault();
  if (state.busy || !state.configReady) return;
  const prompt = $('prompt').value.trim();
  if (!prompt) { $('prompt').focus(); return; }
  if (!$('max-tokens').checkValidity()) { $('max-tokens').reportValidity(); return; }
  const mode = currentMode();
  createMessage('user', prompt);
  state.request = makeRequest(false, mode); state.response = null; state.usage = null; state.firstTokenMs = null;
  $('prompt').value = ''; $('prompt').style.height = '';
  const item = createMessage('assistant');
  state.controller = new AbortController(); state.startedAt = performance.now();
  state.backgroundResponseId = null; state.cancelRequested = false; state.operationLabel = state.request.background ? 'Submitting background job' : 'Generating';
  setBusy(true); updateInspector(); showStats('Generating');
  const interval = setInterval(() => showStats(state.operationLabel), 250);
  let resultLabel = 'Complete';
  try {
    const response = await fetch(servicePath(endpoint(mode)), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: state.request.stream ? 'text/event-stream' : 'application/json' }, body: JSON.stringify(state.request), signal: state.controller.signal });
    if (!response.ok) {
      const body = await response.text(); let data;
      try { data = JSON.parse(body); } catch { data = { message: body.slice(0, 1200) || response.statusText }; }
      state.response = { status: response.status, ...data };
      throw new Error(apiError(data, `The API returned HTTP ${response.status}.`));
    }
    if ((response.headers.get('content-type') || '').includes('text/event-stream')) await readSSE(response, item);
    else {
      let data = await response.json();
      if (data.error) throw new Error(apiError(data));
      if (state.request.background) data = await finishBackground(data);
      state.response = data;
      if (data.error || data.status === 'failed') throw new Error(apiError(data));
      item.content = mode === 'chat' ? data.choices?.[0]?.message?.content || '' : fullResponseText(data);
      state.usage = data.usage || null;
      if (data.status === 'incomplete') item.incomplete = true;
      if (data.status === 'cancelled') {
        resultLabel = 'Cancelled'; item.error = true; state.previousResponseId = null;
        if (!item.content) item.content = 'Background generation cancelled.';
        return;
      }
    }
    if (!item.content && !item.reasoning) throw new Error('The model returned an empty response. Try more output tokens or check the service logs.');
    if (!item.content && item.reasoning) item.content = 'The model used its output budget for reasoning. Increase max output tokens and try again.';
    resultLabel = item.incomplete ? 'Output limit reached' : 'Complete';
    state.previousResponseId = state.request.store && typeof state.response?.id === 'string' ? state.response.id : null;
    state.inferenceVerified = true;
    state.runs[state.service] = { elapsed: (performance.now() - state.startedAt) / 1000, firstToken: state.firstTokenMs, mode, usage: state.usage };
    // A completed generation is newer evidence than any poll already in flight.
    advanceStatusRevision(state.service);
    state.status = state.statuses[state.service] = {
      ready: true, api_reachable: true, selected_model_present: true,
      checked_at: new Date().toISOString(), availability_scope: 'generation',
      inference: { verified: true },
    };
    updateComparison();
    $('status-label').textContent = 'Inference verified';
    $('refresh-status').querySelector('.status-dot').className = 'status-dot';
    $('status-footnote').textContent = `Generation succeeded through ${endpoint(mode)} at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
    showServiceNotice('');
  } catch (error) {
    state.previousResponseId = null;
    if (error.name === 'AbortError') {
      resultLabel = 'Stopped';
      if (!item.content) { item.content = 'Generation stopped before any text was received.'; item.error = true; }
      state.response = { ...(state.response || {}), stopped: true, partial_output: item.error ? '' : item.content };
    } else {
      resultLabel = 'Request failed'; item.error = true; item.node.classList.add('error');
      item.content = `${item.content ? `${item.content}\n\n` : ''}${error.message}`;
      state.response = { ...(state.response || {}), error: { message: error.message } };
      $('status-footnote').textContent = 'The latest generation failed. See the response inspector for details, or refresh service status.';
    }
  } finally {
    clearInterval(interval); renderMessage(item); showStats(resultLabel); updateInspector(); setBusy(false); state.controller = null; state.backgroundResponseId = null; $('prompt').focus();
  }
}

$('prompt-form').addEventListener('submit', sendMessage);
$('prompt').addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); sendMessage(); } });
$('prompt').addEventListener('input', () => {
  $('prompt').style.height = 'auto'; $('prompt').style.height = `${Math.min($('prompt').scrollHeight, 160)}px`;
  if (!state.busy) { state.request = null; updateInspector(); }
});
$('stop-button').addEventListener('click', () => {
  if (state.request?.background && state.busy) {
    state.cancelRequested = true; state.operationLabel = 'Cancelling'; $('stop-button').disabled = true;
    showStats(state.operationLabel);
  } else state.controller?.abort();
});
function clearConversation() {
  if (state.busy) return;
  state.messages = []; state.request = null; state.response = null; state.usage = null; state.previousResponseId = null;
  $('messages').replaceChildren(); $('empty-state').hidden = false; $('message-count').textContent = '0'; $('generation-stats').hidden = true; $('response-meta').hidden = true; updateInspector(); $('prompt').focus();
}
$('clear-chat').addEventListener('click', clearConversation);
function updateComparison() {
  for (const name of serviceIds) {
    const run = state.runs[name];
    const status = state.statuses[name];
    const badge = $(`${name}-availability`);
    badge.textContent = status && !status.ready ? 'Unavailable' : run ? 'Generation verified' : status ? 'Model available' : 'Checking service';
    badge.classList.toggle('unavailable', Boolean(status && !status.ready));
    $(`${name}-time`).textContent = run ? `${run.elapsed.toFixed(2)} s` : '—';
    $(`${name}-run-detail`).textContent = run ? `Last ${run.mode === 'chat' ? 'Chat' : 'Responses'} request${run.firstToken !== null ? ` · ${(run.firstToken / 1000).toFixed(2)} s first token` : ''}` : 'Send a prompt to measure';
    $(`${name}-comparison`).classList.toggle('selected', name === state.service);
    $(`${name}-comparison`).setAttribute('aria-pressed', String(name === state.service));
    $(`${name}-comparison`).disabled = state.busy || !state.rootConfigured;
    $(`${name}-comparison`).hidden = state.rootConfigured && !(name in state.servicePaths);
  }
}
async function switchService(name) {
  if (state.busy || !state.rootConfigured || !state.comparisonAvailable || !(name in state.servicePaths) || name === state.service) return;
  state.service = name; state.selectionVersion += 1; state.configReady = false;
  state.inferenceVerified = Boolean(state.runs[name]); state.status = null;
  $('service-select').value = name; $('send-button').disabled = true;
  $('config-model-name').textContent = 'Loading model…';
  $('overview-engine').textContent = 'Checking configuration';
  $('status-label').textContent = 'Checking service';
  $('refresh-status').querySelector('.status-dot').className = 'status-dot pending';
  $('service-url').textContent = location.origin + servicePath('/v1');
  clearConversation(); updateComparison();
  await Promise.allSettled([loadConfig(), refreshStatus()]);
}
$('service-select').addEventListener('change', (event) => switchService(event.target.value));
for (const name of serviceIds) $(`${name}-comparison`).addEventListener('click', () => switchService(name));
for (const button of document.querySelectorAll('.starter')) button.addEventListener('click', () => { $('prompt').value = button.dataset.prompt; $('prompt').dispatchEvent(new Event('input')); $('prompt').focus(); });
for (const id of ['temperature', 'max-tokens', 'system-instructions', 'prompt-cache-key']) $(id).addEventListener('input', settingsChanged);
$('api-mode').addEventListener('input', () => { state.previousResponseId = null; settingsChanged(); });
$('store-conversation').addEventListener('change', () => {
  state.previousResponseId = null;
  if (!$('store-conversation').checked) $('background-response').checked = false;
  settingsChanged();
});
$('background-response').addEventListener('change', () => {
  if ($('background-response').checked) $('store-conversation').checked = true;
  settingsChanged();
});
$('copy-response-id').addEventListener('click', () => { if (state.response?.id) copyText(state.response.id); });
$('request-tab').addEventListener('click', () => { state.inspector = 'request'; updateInspector(); });
$('response-tab').addEventListener('click', () => { state.inspector = 'response'; updateInspector(); });
for (const id of ['request-tab', 'response-tab']) $(id).addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = id === 'request-tab' ? 'response-tab' : 'request-tab'; $(next).click(); $(next).focus(); }
});
$('copy-inspector').addEventListener('click', () => copyText($('inspector-code').textContent));
$('copy-curl').addEventListener('click', () => copyText(curlFor(state.request || makeRequest(true))));
$('copy-response-example').addEventListener('click', () => copyText($('responses-example').textContent));
$('copy-chat-example').addEventListener('click', () => copyText($('chat-example').textContent));
$('refresh-status').addEventListener('click', () => Promise.allSettled([loadConfig(), refreshStatus(), ...Object.keys(state.servicePaths).filter((id) => id !== state.service).map(refreshComparisonStatus)]));
$('nav-playground').addEventListener('click', () => selectView('playground'));
$('nav-api').addEventListener('click', () => selectView('api'));
if (!/Mac|iPhone|iPad/.test(navigator.platform)) document.querySelector('.composer-hint kbd').textContent = 'Ctrl';
settingsChanged(); buildExamples(); updateComparison(); $('send-button').disabled = true; $('service-select').disabled = true;
loadConfig().then(refreshStatus);
