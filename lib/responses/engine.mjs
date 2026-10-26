import { ResponseError } from './validation.mjs';
import { getRuntimeProfile } from './profiles.mjs';

function unsupported(message, param) {
  return new ResponseError(400, message, 'unsupported_parameter', param);
}
function malformed(message) {
  return new ResponseError(502, message, 'invalid_upstream_response');
}
function checkSignal(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The request was aborted.', 'AbortError');
}

/** Compile only accepted canonical Items. Public IDs/state never reach the engine. */
export function compileMessages(request, history = [], profile) {
  const messages = [];
  const calls = new Map();
  if (request.instructions != null) messages.push({ role: 'system', content: request.instructions });
  for (const [index, item] of [...history, ...request.input].entries()) {
    const param = `input[${index}]`;
    if (item.type === 'message') {
      if (item.phase != null && !profile.capabilities.assistant_phase) {
        throw unsupported('This runtime cannot preserve assistant phase.', `${param}.phase`);
      }
      if (item.role === 'developer' && !profile.capabilities.developer_role) {
        throw unsupported('This runtime does not support developer-role messages.', `${param}.role`);
      }
      const message = { role: item.role, content: '' };
      if (!['system', 'developer', 'user', 'assistant'].includes(item.role)) throw unsupported('Unsupported message role.', `${param}.role`);
      for (const part of item.content) {
        if (['input_text', 'output_text'].includes(part.type)) message.content += part.text;
        else if (part.type === 'refusal' && item.role === 'assistant') {
          // Qwen chat templates render content, not Chat's separate refusal field.
          // The canonical Item retains refusal type; rendered history retains its text and order.
          message.content += part.refusal;
        }
        else throw unsupported('This engine adapter accepts only text and assistant refusal content.', `${param}.content`);
      }
      if (item.phase != null) message.phase = item.phase;
      messages.push(message);
    } else if (item.type === 'function_call') {
      if (!profile.capabilities.function_calling) throw unsupported('Function calling is unavailable on this runtime.', param);
      if (calls.has(item.call_id)) throw new ResponseError(400, 'Duplicate function call_id.', 'invalid_request_error', `${param}.call_id`);
      calls.set(item.call_id, false);
      let message = messages.at(-1);
      if (message?.role !== 'assistant') {
        message = { role: 'assistant', content: '', tool_calls: [] };
        messages.push(message);
      }
      message.tool_calls ??= [];
      message.tool_calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
    } else if (item.type === 'function_call_output') {
      if (!calls.has(item.call_id) || calls.get(item.call_id)) {
        throw new ResponseError(400, 'Function result must reference a preceding, unanswered call_id.', 'invalid_request_error', `${param}.call_id`);
      }
      calls.set(item.call_id, true);
      const content = typeof item.output === 'string' ? item.output : item.output.map((part) => {
        if (part.type !== 'input_text') throw unsupported('Function result output must be text.', `${param}.output`);
        return part.text;
      }).join('');
      messages.push({ role: 'tool', tool_call_id: item.call_id, content });
    } else throw unsupported(`Unsupported canonical Item type: ${item.type}`, `${param}.type`);
  }
  return messages;
}

function toolSettings(request, profile) {
  let tools = request.tools ?? [];
  let choice = request.tool_choice ?? 'auto';
  if (tools.length && !profile.capabilities.function_calling) throw unsupported('Function calling is unavailable on this runtime.', 'tools');
  if (choice?.type === 'allowed_tools') {
    const names = new Set(choice.tools.map((tool) => tool.name));
    tools = tools.filter((tool) => names.has(tool.name));
    choice = choice.mode;
  }
  if (typeof choice === 'object') {
    if (choice.type !== 'function') throw unsupported('Unsupported tool_choice.', 'tool_choice');
    choice = { type: 'function', function: { name: choice.name } };
  } else if (!['none', 'auto', 'required'].includes(choice)) throw unsupported('Unsupported tool_choice.', 'tool_choice');
  const forced = typeof choice === 'object' ? choice.function.name : null;
  const names = new Set(tools.map((tool) => tool.name));
  if ((forced && !names.has(forced)) || (choice === 'required' && !tools.length)) {
    throw new ResponseError(400, 'tool_choice must select an available function.', 'invalid_request_error', 'tool_choice');
  }
  // qwen25's legacy constraint otherwise includes every supplied function even
  // for a named choice. Match its prompt and grammar before exact tokenization.
  if (forced && profile.engine === 'sglang') tools = tools.filter((tool) => tool.name === forced);
  return {
    choice, forced, names,
    tools: tools.map(({ type, name, description, parameters, strict }) => {
      if (type !== 'function') throw unsupported('Only function tools are supported.', 'tools');
      return { type, function: { name, ...(description != null && { description }), parameters, ...(strict != null && { strict }) } };
    }),
  };
}

/** SGLang qwen25's legacy tag ignores parallel=false. Own the complete grammar. */
function sglangToolFormat(selected, parallel) {
  const tags = selected.tools.map(({ function: fn }) => ({
    type: 'tag', begin: `<tool_call>\n{"name":${JSON.stringify(fn.name)},"arguments":`,
    content: { type: 'json_schema', json_schema: fn.strict === true ? fn.parameters : {} },
    end: '}\n</tool_call>',
  }));
  const stopAfterFirst = !parallel || Boolean(selected.forced);
  return {
    type: 'structural_tag',
    format: selected.choice === 'auto'
      ? { type: 'triggered_tags', triggers: ['<tool_call>'], tags, at_least_one: false, stop_after_first: stopAfterFirst }
      : { type: 'tags_with_separator', tags, separator: '\n', at_least_one: true, stop_after_first: stopAfterFirst },
  };
}

export function compileChatRequest(request, history = [], profile) {
  const selected = toolSettings(request, profile);
  const body = {
    model: request.model,
    messages: compileMessages(request, history, profile),
    stream: true, stream_options: { include_usage: true },
    max_tokens: request.max_output_tokens ?? profile.default_max_output_tokens,
  };
  if (profile.chat_template_kwargs) body.chat_template_kwargs = { ...profile.chat_template_kwargs };
  for (const field of ['temperature', 'top_p']) if (request[field] != null) body[field] = request[field];
  const format = request.text?.format;
  if (selected.tools.length && selected.choice !== 'none' && format?.type && format.type !== 'text') {
    throw unsupported('Structured text output and active function tools cannot be combined in this runtime profile. Set tool_choice:none or request text output.', 'text.format');
  }
  if (format?.type === 'json_schema') {
    if (!profile.capabilities.structured_outputs) throw unsupported('Constrained JSON-schema output is unavailable on this runtime.', 'text.format');
    body.response_format = { type: 'json_schema', json_schema: {
      name: format.name, schema: format.schema,
      ...(format.description != null && { description: format.description }),
      ...(format.strict != null && { strict: format.strict }),
    } };
  } else if (format?.type === 'json_object') {
    if (!profile.capabilities.json_object) throw unsupported('JSON output is unavailable on this runtime.', 'text.format');
    body.response_format = { type: 'json_object' };
  } else if (format?.type && format.type !== 'text') throw unsupported('Unsupported text format.', 'text.format');
  if (selected.tools.length) {
    body.tools = selected.tools;
    body.tool_choice = selected.choice;
    body.parallel_tool_calls = request.parallel_tool_calls ?? true;
    if (body.parallel_tool_calls && !profile.capabilities.parallel_tool_calls) {
      throw unsupported('Parallel tool calls are unavailable on this runtime.', 'parallel_tool_calls');
    }
    if (profile.engine === 'sglang' && selected.choice !== 'none') {
      if (profile.configuration?.tool_parser !== 'qwen25') throw unsupported('Function constraints require the configured qwen25 parser.', 'tools');
      body.response_format = sglangToolFormat(selected, body.parallel_tool_calls);
      // Native required/named + response_format rejects conflicting constraints.
      // Our complete grammar already enforces selection, strictness and count;
      // auto keeps the native parser active without replacing that grammar.
      body.tool_choice = 'auto';
    }
  }
  return { body, selected };
}

/** A bounded SSE decoder; UTF-8 and CRLF boundaries may split at any byte. */
export async function* parseEngineSse(stream, { signal, maxEventBytes = 1024 * 1024, maxStreamBytes = 32 * 1024 * 1024 } = {}) {
  if (!stream?.getReader) throw malformed('The engine returned no readable event stream.');
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', data = [], eventBytes = 0, streamBytes = 0;
  let ended = false;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  function line(value) {
    eventBytes += Buffer.byteLength(value) + 1;
    if (eventBytes > maxEventBytes) throw malformed('Engine SSE event exceeds the configured size limit.');
    if (value === '') {
      const result = data.length ? data.join('\n') : undefined;
      data = []; eventBytes = 0;
      return result;
    }
    if (value.startsWith(':')) return undefined;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'data') data.push(content);
    return undefined;
  }
  try {
    while (!ended) {
      checkSignal(signal);
      const { value, done } = await reader.read();
      checkSignal(signal);
      ended = done;
      if (value) {
        streamBytes += value.byteLength;
        if (streamBytes > maxStreamBytes) throw malformed('Engine stream exceeds the configured size limit.');
      }
      try { pending += decoder.decode(value, { stream: !done }); }
      catch { throw malformed('Engine stream contains invalid UTF-8.'); }
      while (true) {
        const at = pending.search(/[\r\n]/);
        if (at < 0 || (pending[at] === '\r' && at === pending.length - 1 && !done)) break;
        const width = pending[at] === '\r' && pending[at + 1] === '\n' ? 2 : 1;
        const result = line(pending.slice(0, at));
        pending = pending.slice(at + width);
        if (result !== undefined) yield result;
      }
      if (Buffer.byteLength(pending) + eventBytes > maxEventBytes) throw malformed('Engine SSE event exceeds the configured size limit.');
    }
    if (pending) {
      const result = line(pending);
      if (result !== undefined) yield result;
    }
    if (data.length) yield data.join('\n');
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function boundedJson(response, limit, signal) {
  if (!response.body?.getReader) throw malformed('The engine returned an empty response.');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0, done = false;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (!done) {
      checkSignal(signal);
      const part = await reader.read();
      checkSignal(signal);
      done = part.done;
      if (part.value) {
        bytes += part.value.byteLength;
        if (bytes > limit) throw malformed('Engine JSON response exceeds the configured size limit.');
        chunks.push(part.value);
      }
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw malformed('The engine returned malformed JSON.'); }
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function assertSuccess(response, signal) {
  if (response.ok) return;
  let error;
  try { error = (await boundedJson(response, 64 * 1024, signal))?.error; }
  catch (failure) { checkSignal(signal); /* Do not expose raw engine HTML, stack traces, or prompts. */ }
  const status = [400, 413, 429].includes(response.status) ? response.status : 502;
  const context = error?.code === 'context_length_exceeded' || /context|maximum.*token|max.*length/i.test(error?.message ?? '');
  throw new ResponseError(status,
    context ? 'The rendered input and reserved output exceed this model context window.' : `The inference engine rejected the request (HTTP ${response.status}).`,
    context ? 'context_length_exceeded' : (status === 429 ? 'rate_limit_exceeded' : 'upstream_error'),
    context ? 'input' : null);
}

function validateUsage(usage) {
  if (!usage || typeof usage !== 'object') throw malformed('The engine returned invalid usage.');
  for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (!Number.isSafeInteger(usage[field]) || usage[field] < 0) throw malformed(`The engine returned invalid ${field} usage.`);
  }
}

export function createEngineAdapter({ upstream, model, profile = 'dmr-metal', fetchImpl = fetch, upstreamApiKey } = {}) {
  try { if (typeof profile === 'string') profile = getRuntimeProfile(profile); }
  catch (error) { throw new ResponseError(500, error.message, 'invalid_engine_configuration'); }
  if (!profile || !['vllm', 'sglang'].includes(profile.engine) || profile.api !== 'chat_completions') {
    throw new ResponseError(500, 'Responses requires a configured vLLM or SGLang Chat Completions runtime profile.', 'invalid_engine_configuration');
  }
  let base;
  try {
    base = new URL(`${upstream.replace(/\/+$/, '')}/`);
    if (!['http:', 'https:'].includes(base.protocol) || base.search || base.hash) throw new Error();
  } catch { throw new ResponseError(500, 'A valid HTTP inference engine base URL is required.', 'invalid_engine_configuration'); }
  async function post(path, body, { signal, requestId } = {}) {
    checkSignal(signal);
    const headers = { 'content-type': 'application/json' };
    if (upstreamApiKey) headers.authorization = `Bearer ${upstreamApiKey}`;
    if (requestId) headers['x-request-id'] = requestId;
    let response;
    try { response = await fetchImpl(new URL(path, base), { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' }); }
    catch (error) {
      checkSignal(signal);
      throw new ResponseError(502, 'The inference engine could not be reached.', 'upstream_unavailable');
    }
    await assertSuccess(response, signal);
    return response;
  }
  function compile(request, history) {
    return compileChatRequest({ ...request, model: request.model ?? model }, history, profile);
  }
  async function countInputTokens(compiled, { signal, requestId } = {}) {
    if (!profile.tokenization) throw unsupported('Exact token counting is unavailable on this runtime.', 'input');
    const { body } = compiled;
    const payload = { model: body.model, messages: body.messages, ...(body.tools && { tools: body.tools }), ...(body.chat_template_kwargs && { chat_template_kwargs: body.chat_template_kwargs }) };
    if (profile.tokenization.format === 'sglang' && body.tool_choice) payload.tool_choice = body.tool_choice;
    const response = await post(profile.tokenization.path, payload, { signal, requestId });
    const result = await boundedJson(response, 4 * 1024 * 1024, signal);
    if (!Number.isSafeInteger(result.count) || result.count < 0) throw malformed('The engine returned an invalid exact token count.');
    const context = Number.isSafeInteger(result.max_model_len) && result.max_model_len > 0
      ? Math.min(result.max_model_len, profile.context_length) : profile.context_length;
    return { input_tokens: result.count, context_length: context };
  }
  async function* generate(compiled, { signal, requestId } = {}) {
    const { body, selected } = compiled;
    const response = await post('chat/completions', body, { signal, requestId });
    if (!/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel().catch(() => {});
      throw malformed('The engine did not return a Chat Completions SSE stream.');
    }
    const calls = new Map();
    let finish = null, terminated = false, outputBytes = 0, usageSeen = false;
    const bound = (value) => {
      outputBytes += Buffer.byteLength(value ?? '');
      if (outputBytes > profile.limits.max_output_bytes) throw malformed('Engine output exceeds the configured size limit.');
    };
    for await (const data of parseEngineSse(response.body, { signal, maxEventBytes: profile.limits.max_event_bytes, maxStreamBytes: profile.limits.max_stream_bytes })) {
      if (data === '[DONE]') { terminated = true; break; }
      let chunk;
      try { chunk = JSON.parse(data); } catch { throw malformed('The engine returned malformed SSE JSON.'); }
      if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) throw malformed('The engine returned an invalid SSE chunk.');
      if (chunk.error) throw new ResponseError(502, 'The inference engine failed while generating a response.', 'upstream_error');
      if (chunk.usage != null) {
        validateUsage(chunk.usage); usageSeen = true;
        yield { type: 'usage', usage: chunk.usage };
      }
      if (!Array.isArray(chunk.choices) || chunk.choices.length > 1) throw malformed('The engine returned an unsupported number of choices.');
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.index !== 0) throw malformed('The engine returned an unexpected choice index.');
      const delta = choice.delta;
      if (!delta || typeof delta !== 'object' || Array.isArray(delta)) throw malformed('The engine returned an invalid delta.');
      if (finish !== null) throw malformed('The engine emitted a choice after its terminal choice.');
      if (delta.role != null && delta.role !== 'assistant') throw malformed('The engine returned a non-assistant output role.');
      if (delta.reasoning || delta.reasoning_content || delta.audio || delta.function_call) throw malformed('The engine returned content unsupported by the selected runtime profile.');
      for (const [field, type] of [['content', 'text_delta'], ['refusal', 'refusal_delta']]) {
        if (delta[field] != null && typeof delta[field] !== 'string') throw malformed(`The engine returned invalid ${field}.`);
        if (delta[field]) { bound(delta[field]); yield { type, delta: delta[field] }; }
      }
      if (delta.tool_calls != null && !Array.isArray(delta.tool_calls)) throw malformed('The engine returned invalid tool calls.');
      for (const tool of delta.tool_calls ?? []) {
        if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw malformed('The engine returned an invalid tool-call delta.');
        if (!Number.isSafeInteger(tool.index) || tool.index < 0 || tool.index >= profile.limits.max_tool_calls) throw malformed('The engine returned an invalid tool-call index.');
        if (selected.choice === 'none' || !selected.tools.length) throw malformed('The engine called a function forbidden by tool_choice.');
        if (tool.type != null && tool.type !== 'function') throw malformed('The engine returned a non-function tool call.');
        let call = calls.get(tool.index);
        if (!call) {
          if (body.parallel_tool_calls === false && calls.size) throw malformed('The engine violated parallel_tool_calls=false.');
          call = { id: '', name: '', arguments: '' }; calls.set(tool.index, call);
        }
        const event = { type: 'tool_delta', index: tool.index };
        if (tool.id != null) {
          if (typeof tool.id !== 'string' || !tool.id || tool.id.length > 256) throw malformed('The engine returned an invalid function call ID.');
          if (call.id && call.id !== tool.id) throw malformed('The engine changed a function call ID.');
          if (!call.id) bound(tool.id);
          call.id = tool.id; event.id = tool.id;
        }
        for (const field of ['name', 'arguments']) {
          const part = tool.function?.[field];
          if (part != null) {
            if (typeof part !== 'string') throw malformed(`The engine returned invalid function ${field}.`);
            call[field] += part; event[field] = part; bound(part);
          }
        }
        yield event;
      }
      if (choice.finish_reason != null) {
        if (typeof choice.finish_reason !== 'string' || !choice.finish_reason) throw malformed('The engine returned an invalid finish reason.');
        finish = choice.finish_reason;
      }
    }
    checkSignal(signal);
    if (!terminated || finish === null) throw malformed('The engine stream ended without a finish reason and [DONE] marker.');
    if (!usageSeen) throw malformed('The engine omitted the requested token usage.');
    const ids = new Set();
    for (const call of calls.values()) {
      if (!call.id || !call.name || ids.has(call.id)) throw malformed('The engine returned an incomplete or duplicate function call.');
      ids.add(call.id);
      if (!selected.names.has(call.name) || (selected.forced && call.name !== selected.forced)) throw malformed('The engine called a function outside tool_choice.');
    }
    if (finish !== 'length' && finish !== 'content_filter' && !calls.size && (selected.choice === 'required' || selected.forced)) throw malformed('The engine did not produce the required function call.');
    if (finish === 'tool_calls' && !calls.size) throw malformed('The engine finished with tool_calls but produced no call.');
    yield { type: 'finish', reason: finish };
  }
  return {
    profile,
    // A request-local snapshot: tokenizer and generation use exactly the same
    // messages, tool selection and grammar, even across an asynchronous await.
    // No content-keyed or cross-request cache is retained by the adapter.
    prepare(request, { history = [] } = {}) {
      const compiled = structuredClone(compile(request, history));
      return {
        countInputTokens: (options) => countInputTokens(compiled, options),
        generate: (options) => generate(compiled, options),
      };
    },
    async countInputTokens(request, { history = [], ...options } = {}) {
      return countInputTokens(compile(request, history), options);
    },
    async *generate(request, { history = [], ...options } = {}) {
      yield* generate(compile(request, history), options);
    },
  };
}
