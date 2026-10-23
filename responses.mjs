import { randomUUID } from 'node:crypto';

const id = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const invalid = (message, code = 'unsupported_response_parameter') => Object.assign(new Error(message), { status: 400, code });
const allowedFields = new Set(['model', 'input', 'instructions', 'stream', 'store', 'max_output_tokens', 'temperature', 'top_p', 'metadata', 'text', 'tools', 'background', 'previous_response_id']);

function inputMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input) || !input.length) throw invalid('input must be a string or a nonempty array of text messages.', 'invalid_input');
  return input.map((item) => {
    if (!item || (item.type && item.type !== 'message') || !['user', 'assistant', 'system', 'developer'].includes(item.role)) {
      throw invalid('Each input item must be a user, assistant, system, or developer text message. Tool calls and item references are unsupported.', 'invalid_input');
    }
    let content = item.content;
    if (Array.isArray(content)) {
      content = content.map((part) => {
        if (!part || !['input_text', 'output_text'].includes(part.type) || typeof part.text !== 'string') {
          throw invalid('Only input_text and output_text content is supported; image, audio, and file input is unsupported.', 'unsupported_input_type');
        }
        return part.text;
      }).join('\n');
    }
    if (typeof content !== 'string') throw invalid('Message content must be a string or an array of text parts.', 'invalid_input');
    return { role: item.role === 'developer' ? 'system' : item.role, content };
  });
}

export function prepareResponseRequest(body, defaultModel) {
  if (!body || Array.isArray(body) || typeof body !== 'object') throw invalid('The request must be a JSON object.', 'invalid_request');
  for (const field of Object.keys(body)) {
    if (!allowedFields.has(field)) throw invalid(`The local Responses adapter does not support '${field}'. Use /v1/chat/completions for native chat parameters.`);
  }
  if (body.store !== undefined && body.store !== false) throw invalid('This adapter is stateless. Set store:false and send the full input history.');
  if (body.previous_response_id != null) throw invalid('previous_response_id is unsupported. Send the full conversation as input.');
  if (body.background !== undefined && body.background !== false) throw invalid('Background responses are unsupported.');
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length)) throw invalid('Tools are unsupported by the text-only Responses adapter.');
  if (body.text !== undefined && (body.text?.format?.type !== 'text' || Object.keys(body.text).some((key) => key !== 'format') || Object.keys(body.text.format).some((key) => key !== 'type'))) {
    throw invalid('Only text.format.type="text" is supported. Structured output is unsupported.');
  }
  if (body.instructions !== undefined && typeof body.instructions !== 'string') throw invalid('instructions must be a string.', 'invalid_request');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw invalid('stream must be a boolean.', 'invalid_request');
  if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) throw invalid('model must be a nonempty string.', 'invalid_request');
  if (body.max_output_tokens !== undefined && (!Number.isInteger(body.max_output_tokens) || body.max_output_tokens < 1)) throw invalid('max_output_tokens must be a positive integer.', 'invalid_request');
  for (const [field, max] of [['temperature', 2], ['top_p', 1]]) {
    if (body[field] !== undefined && (typeof body[field] !== 'number' || !Number.isFinite(body[field]) || body[field] < 0 || body[field] > max)) throw invalid(`${field} must be between 0 and ${max}.`, 'invalid_request');
  }
  if (body.metadata !== undefined && (!body.metadata || Array.isArray(body.metadata) || typeof body.metadata !== 'object' || Object.entries(body.metadata).some(([key, value]) => key.length > 64 || typeof value !== 'string' || value.length > 512) || Object.keys(body.metadata).length > 16)) {
    throw invalid('metadata supports up to 16 string values (keys ≤64 characters, values ≤512 characters).', 'invalid_request');
  }
  const messages = inputMessages(body.input);
  if (body.instructions) messages.unshift({ role: 'system', content: body.instructions });
  const chat = {
    model: body.model ?? defaultModel,
    messages,
    stream: body.stream ?? false,
    chat_template_kwargs: { enable_thinking: false },
  };
  if (body.max_output_tokens !== undefined) chat.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.top_p !== undefined) chat.top_p = body.top_p;
  if (chat.stream) chat.stream_options = { include_usage: true };
  return {
    chat,
    response: {
      id: id('resp'), object: 'response', created_at: Math.floor(Date.now() / 1000),
      status: 'in_progress', error: null, incomplete_details: null,
      instructions: body.instructions ?? null, max_output_tokens: body.max_output_tokens ?? null,
      model: chat.model, output: [], output_text: '',
      parallel_tool_calls: false, previous_response_id: null,
      reasoning: { effort: null, summary: null }, store: false,
      temperature: body.temperature ?? null, text: { format: { type: 'text' } },
      tool_choice: 'none', tools: [], top_p: body.top_p ?? null,
      truncation: 'disabled', usage: null, metadata: body.metadata ?? {},
    },
    itemId: id('msg'),
  };
}

function responseUsage(usage) {
  if (!usage) return null;
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 },
    output_tokens: usage.completion_tokens ?? 0,
    output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 },
    total_tokens: usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)),
  };
}

function outputItem(itemId, text, status) {
  return { id: itemId, type: 'message', status, role: 'assistant', content: [{ type: 'output_text', text, annotations: [], logprobs: [] }] };
}

function finalResponse(prepared, text, finishReason, usage) {
  const incomplete = finishReason === 'length';
  return {
    ...prepared.response,
    status: incomplete ? 'incomplete' : 'completed',
    incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
    output: [outputItem(prepared.itemId, text, incomplete ? 'incomplete' : 'completed')],
    output_text: text,
    usage: responseUsage(usage),
  };
}

export function adaptChatResponse(chat, prepared) {
  const choice = chat?.choices?.[0];
  if (!choice?.message || typeof choice.message.content !== 'string' || choice.message.tool_calls?.length) {
    throw Object.assign(new Error('The upstream response did not contain a supported text completion.'), { status: 502, code: 'invalid_upstream_response' });
  }
  if (!['stop', 'length', 'eos_token'].includes(choice.finish_reason)) {
    throw Object.assign(new Error(`Unsupported upstream finish reason: ${choice.finish_reason ?? 'missing'}.`), { status: 502, code: 'invalid_upstream_response' });
  }
  return finalResponse(prepared, choice.message.content, choice.finish_reason, chat.usage);
}

async function writeChunk(res, chunk) {
  if (res.destroyed) throw new Error('Client disconnected.');
  if (res.write(chunk)) return;
  await new Promise((resolveWrite, reject) => {
    const cleanup = () => { res.off('drain', onDrain); res.off('close', onClose); res.off('error', onError); };
    const onDrain = () => { cleanup(); resolveWrite(); };
    const onClose = () => { cleanup(); reject(new Error('Client disconnected.')); };
    const onError = (error) => { cleanup(); reject(error); };
    res.once('drain', onDrain); res.once('close', onClose); res.once('error', onError);
  });
}

/** Translate only protocol envelopes; all generated text comes from the upstream SSE stream. */
export async function streamChatAsResponses(upstream, res, prepared) {
  let sequence = 0;
  const event = async (type, fields) => writeChunk(res, `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`);
  const reader = upstream.body?.getReader();
  let text = '';
  let finishReason;
  let usage;
  let done = false;
  let partStarted = false;
  const startPart = async () => {
    if (partStarted) return;
    partStarted = true;
    await event('response.output_item.added', { output_index: 0, item: { ...outputItem(prepared.itemId, '', 'in_progress'), content: [] } });
    await event('response.content_part.added', { item_id: prepared.itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } });
  };
  const consume = async (block) => {
    const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    if (data === '[DONE]') { done = true; return; }
    let chunk;
    try { chunk = JSON.parse(data); } catch { throw new Error('The upstream returned an invalid SSE JSON event.'); }
    if (chunk.error) throw new Error(chunk.error.message ?? 'Upstream generation failed.');
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (choice?.delta?.tool_calls?.length) throw new Error('The upstream emitted an unsupported tool call.');
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta.length) {
      await startPart();
      text += delta;
      await event('response.output_text.delta', { item_id: prepared.itemId, output_index: 0, content_index: 0, delta, logprobs: [] });
    }
  };
  try {
    if (!reader) throw new Error('The upstream response has no stream body.');
    await event('response.created', { response: prepared.response });
    await event('response.in_progress', { response: prepared.response });
    const decoder = new TextDecoder();
    let buffer = '';
    while (!done) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        await consume(block);
        if (done) break;
      }
      if (buffer.length > 1024 * 1024) throw new Error('The upstream SSE event exceeds the supported size.');
      if (chunk.done) {
        if (buffer.trim() && !done) await consume(buffer);
        break;
      }
    }
    if (!finishReason || !['stop', 'length', 'eos_token'].includes(finishReason)) throw new Error(`The upstream stream ended without a supported finish reason (${finishReason ?? 'missing'}).`);
    await startPart();
    const response = finalResponse(prepared, text, finishReason, usage);
    const item = response.output[0];
    await event('response.output_text.done', { item_id: prepared.itemId, output_index: 0, content_index: 0, text, logprobs: [] });
    await event('response.content_part.done', { item_id: prepared.itemId, output_index: 0, content_index: 0, part: item.content[0] });
    await event('response.output_item.done', { output_index: 0, item });
    await event(`response.${response.status}`, { response });
    res.end();
  } catch (error) {
    if (!res.destroyed && !res.writableEnded) {
      await event('response.failed', { response: { ...prepared.response, status: 'failed', output: partStarted ? [outputItem(prepared.itemId, text, 'incomplete')] : [], output_text: text, error: { code: 'upstream_stream_error', message: error.message }, usage: responseUsage(usage) } });
      res.end();
    }
  } finally {
    try { await reader?.cancel(); } catch { /* Connection may already be aborted. */ }
    reader?.releaseLock();
  }
}
