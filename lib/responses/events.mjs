import { randomBytes, randomUUID } from 'node:crypto';
import { ResponseError } from './validation.mjs';
import { validateValue } from './schema.mjs';

const id = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const copy = (value) => structuredClone(value);
const invalidEngine = (message) => new ResponseError(502, message, 'invalid_upstream_response');

/** Counts come from the engine, never from text length or a different tokenizer. */
export function responseUsage(raw) {
  if (!raw) return null;
  const input = raw.prompt_tokens;
  const output = raw.completion_tokens;
  if (![input, output].every((n) => Number.isSafeInteger(n) && n >= 0)) throw invalidEngine('Invalid engine token usage.');
  const result = { input_tokens: input, output_tokens: output, total_tokens: input + output };
  const cached = raw.prompt_tokens_details?.cached_tokens ?? raw.cached_tokens;
  if (Number.isSafeInteger(cached) && cached >= 0 && cached <= input) result.input_tokens_details = { cached_tokens: cached };
  const reasoning = raw.completion_tokens_details?.reasoning_tokens;
  if (Number.isSafeInteger(reasoning) && reasoning >= 0 && reasoning <= output) result.output_tokens_details = { reasoning_tokens: reasoning };
  return result;
}

/** A single canonical state machine drives JSON, SSE and WebSocket output. */
export class ResponseAssembler {
  constructor(request, { onEvent = async () => {}, maxOutputBytes = 4 * 1024 * 1024, maxOutputItems = 128, now = Date.now, makeId = id } = {}) {
    this.request = request;
    this.onEvent = onEvent;
    this.maxOutputBytes = maxOutputBytes;
    this.maxOutputItems = maxOutputItems;
    this.now = now;
    this.makeId = makeId;
    this.sequence = 0;
    this.bytes = 0;
    this.terminal = false;
    this.calls = new Map();
    this.parts = new Map();
    this.finishReason = null;
    this.response = {
      id: makeId('resp'), object: 'response', created_at: Math.floor(now() / 1000),
      completed_at: null, status: 'in_progress', error: null, incomplete_details: null,
      model: request.model, output: [], instructions: request.instructions,
      tools: copy(request.tools), tool_choice: copy(request.tool_choice),
      parallel_tool_calls: request.parallel_tool_calls, max_output_tokens: request.max_output_tokens,
      previous_response_id: request.previous_response_id, reasoning: request.reasoning,
      store: false, background: false, temperature: request.temperature, top_p: request.top_p,
      text: copy(request.text), truncation: request.truncation,
      metadata: copy(request.metadata), usage: null, service_tier: 'default',
    };
  }

  async emit(type, fields = {}) {
    const event = { type, sequence_number: this.sequence++, ...copy(fields) };
    if (type.endsWith('.delta') && this.request.stream_options?.include_obfuscation !== false) {
      // Pad deltas to a size bucket; this is transport padding, not encryption.
      const padding = 64 - (Buffer.byteLength(JSON.stringify(event)) % 64);
      event.obfuscation = randomBytes(Math.ceil(padding / 2)).toString('hex').slice(0, padding);
    }
    await this.onEvent(event);
  }

  async start() {
    await this.emit('response.created', { response: this.response });
    await this.emit('response.in_progress', { response: this.response });
  }

  account(text) {
    this.bytes += Buffer.byteLength(text);
    if (this.bytes > this.maxOutputBytes) throw invalidEngine('The generated output exceeds the service byte limit.');
  }

  async addItem(item) {
    if (this.response.output.length >= this.maxOutputItems) throw invalidEngine('The generated output exceeds the service Item limit.');
    const index = this.response.output.push(item) - 1;
    await this.emit('response.output_item.added', { output_index: index, item });
    return index;
  }

  async content(delta, type) {
    if (!delta) return;
    this.account(delta);
    if (this.messageIndex === undefined) {
      this.messageIndex = await this.addItem({ id: this.makeId('msg'), type: 'message', role: 'assistant', status: 'in_progress', content: [] });
    }
    const message = this.response.output[this.messageIndex];
    if (!this.parts.has(type)) {
      const part = type === 'output_text' ? { type, text: '', annotations: [], logprobs: [] } : { type: 'refusal', refusal: '' };
      const contentIndex = message.content.push(part) - 1;
      this.parts.set(type, contentIndex);
      await this.emit('response.content_part.added', { item_id: message.id, output_index: this.messageIndex, content_index: contentIndex, part });
    }
    const contentIndex = this.parts.get(type);
    const part = message.content[contentIndex];
    part[type === 'output_text' ? 'text' : 'refusal'] += delta;
    await this.emit(`response.${type}.delta`, {
      item_id: message.id, output_index: this.messageIndex, content_index: contentIndex, delta,
      ...(type === 'output_text' ? { logprobs: [] } : {}),
    });
  }

  async tool(delta) {
    if (!Number.isInteger(delta.index) || delta.index < 0 || delta.index >= this.maxOutputItems) throw invalidEngine('Invalid tool-call index.');
    let call = this.calls.get(delta.index);
    if (!call) {
      call = { id: this.makeId('fc'), type: 'function_call', call_id: null, name: '', arguments: '', status: 'in_progress' };
      this.calls.set(delta.index, call);
    }
    if (delta.id) {
      if (call.call_id && call.call_id !== delta.id) throw invalidEngine('A tool-call correlation ID changed during generation.');
      call.call_id = delta.id;
    }
    if (delta.name) { this.account(delta.name); call.name += delta.name; }
    if (delta.arguments) { this.account(delta.arguments); call.arguments += delta.arguments; }
    // Names and IDs may themselves be fragmented. Do not publish an incomplete
    // identity. Buffer until arguments begin, then stream argument fragments.
    if (call._index === undefined && call.call_id && call.name && delta.arguments) {
      const argumentsSoFar = call.arguments;
      call.arguments = '';
      const item = { ...call };
      const index = await this.addItem(item);
      call._index = index;
      item.arguments = argumentsSoFar;
      await this.emit('response.function_call_arguments.delta', { item_id: call.id, output_index: index, delta: argumentsSoFar });
      call.arguments = argumentsSoFar;
    } else if (call._index !== undefined) {
      const item = this.response.output[call._index];
      item.name = call.name;
      item.arguments = call.arguments;
      if (delta.arguments) await this.emit('response.function_call_arguments.delta', { item_id: call.id, output_index: call._index, delta: delta.arguments });
    }
  }

  async consume(event) {
    if (this.terminal) return; // A finished attempt cannot mutate published state.
    switch (event.type) {
      case 'text_delta': return this.content(event.delta, 'output_text');
      case 'refusal_delta': return this.content(event.delta, 'refusal');
      case 'tool_delta': return this.tool(event);
      case 'usage': this.response.usage = responseUsage(event.usage); return;
      case 'finish':
        if (this.finishReason && this.finishReason !== event.reason) throw invalidEngine('Conflicting engine finish reasons.');
        this.finishReason = event.reason;
        return;
      default: throw invalidEngine(`Unsupported internal generation event: ${event.type}.`);
    }
  }

  async flushCalls() {
    for (const call of this.calls.values()) {
      if (!call.call_id || !call.name) throw invalidEngine('The engine returned a function call without its ID or name.');
      if (call._index === undefined) {
        const { _index, ...item } = call;
        call._index = await this.addItem(item);
      }
    }
  }

  validateCompletion() {
    const toolItems = this.response.output.filter((item) => item.type === 'function_call');
    if (!this.request.parallel_tool_calls && toolItems.length > 1) throw invalidEngine('The engine ignored parallel_tool_calls=false.');
    const choice = this.request.tool_choice;
    const forced = typeof choice === 'object' && choice.type === 'function' ? choice.name : null;
    if ((choice === 'required' || forced || choice?.mode === 'required') && !toolItems.length) throw invalidEngine('The engine did not produce the required function call.');
    if (choice === 'none' && toolItems.length) throw invalidEngine('The engine ignored tool_choice=none.');
    const allowed = choice?.type === 'allowed_tools' ? new Set(choice.tools.map((tool) => tool.name)) : null;
    const ids = new Set();
    for (const item of toolItems) {
      if (ids.has(item.call_id)) throw invalidEngine('The engine reused a tool-call correlation ID.');
      ids.add(item.call_id);
      const tool = this.request.tools.find((tool) => tool.name === item.name);
      if (!tool || (forced && item.name !== forced) || (allowed && !allowed.has(item.name))) throw invalidEngine('The engine selected an unavailable function.');
      let args;
      try { args = JSON.parse(item.arguments); } catch { throw invalidEngine('The engine returned invalid function arguments JSON.'); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalidEngine('Function arguments must be a JSON object.');
      if (tool.strict) {
        try { validateValue(args, tool.parameters); } catch { throw invalidEngine('The engine violated the strict function schema.'); }
      }
    }
    const format = this.request.text.format;
    const messageParts = this.response.output.filter((item) => item.type === 'message').flatMap((item) => item.content);
    const text = messageParts.filter((part) => part.type === 'output_text').map((part) => part.text).join('');
    if (format.type !== 'text' && !toolItems.length && !messageParts.some((part) => part.type === 'refusal')) {
      let value;
      try { value = JSON.parse(text); } catch { throw invalidEngine('The engine did not produce valid structured JSON.'); }
      if (format.type === 'json_schema') {
        try { validateValue(value, format.schema); } catch { throw invalidEngine('The engine violated the requested JSON schema.'); }
      } else if (!value || Array.isArray(value) || typeof value !== 'object') throw invalidEngine('The engine did not produce a JSON object.');
    }
    if (this.response.usage && this.request.max_output_tokens && this.response.usage.output_tokens > this.request.max_output_tokens) {
      throw invalidEngine('The engine exceeded max_output_tokens.');
    }
  }

  async finish() {
    if (this.terminal) return this.snapshot();
    if (!['stop', 'eos_token', 'tool_calls', 'length', 'content_filter'].includes(this.finishReason)) throw invalidEngine('The engine stream ended without a supported finish reason.');
    await this.flushCalls();
    if (this.response.usage && this.request.max_output_tokens && this.response.usage.output_tokens > this.request.max_output_tokens) throw invalidEngine('The engine exceeded max_output_tokens.');
    const incomplete = ['length', 'content_filter'].includes(this.finishReason);
    if (!incomplete) this.validateCompletion();
    return this.end(incomplete ? 'incomplete' : 'completed', incomplete ? { reason: this.finishReason === 'length' ? 'max_output_tokens' : 'content_filter' } : null);
  }

  async fail(error) {
    if (this.terminal) return this.snapshot();
    return this.end('failed', null, { code: error.code ?? 'server_error', message: error.message ?? 'Generation failed.' });
  }

  async end(status, incompleteDetails = null, error = null) {
    this.terminal = true;
    this.response.status = status;
    this.response.completed_at = status === 'completed' ? Math.floor(this.now() / 1000) : null;
    this.response.incomplete_details = incompleteDetails;
    this.response.error = error;
    for (const [index, item] of this.response.output.entries()) {
      item.status = status === 'completed' ? 'completed' : 'incomplete';
      if (item.type === 'message') {
        for (const [contentIndex, part] of item.content.entries()) {
          await this.emit(`response.${part.type}.done`, {
            item_id: item.id, output_index: index, content_index: contentIndex,
            ...(part.type === 'output_text' ? { text: part.text, logprobs: [] } : { refusal: part.refusal }),
          });
          await this.emit('response.content_part.done', { item_id: item.id, output_index: index, content_index: contentIndex, part });
        }
      } else {
        await this.emit('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.arguments });
      }
      await this.emit('response.output_item.done', { output_index: index, item });
    }
    await this.emit(`response.${status}`, { response: this.response });
    return this.snapshot();
  }

  snapshot() { return copy(this.response); }
}
