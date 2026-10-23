import { ResponseError, validateSchema, normalizeStrictSchema } from './schema.mjs';
export { ResponseError } from './schema.mjs';

const own = (object, key) => Object.hasOwn(object, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (message, param, code = 'invalid_request_error') => { throw new ResponseError(400, message, code, param); };
const unsupported = (message, param) => invalid(message, param, 'unsupported_parameter');
const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const ROLES = new Set(['user', 'assistant', 'system', 'developer']);
const STATUSES = new Set(['in_progress', 'completed', 'incomplete']);
const FIELDS = new Set(['model', 'input', 'instructions', 'store', 'stream', 'background', 'previous_response_id', 'tools', 'tool_choice', 'parallel_tool_calls', 'text', 'temperature', 'top_p', 'max_output_tokens', 'metadata', 'reasoning', 'include', 'stream_options', 'truncation']);
const ADVANCED = new Set(['conversation', 'max_tool_calls', 'service_tier', 'user', 'safety_identifier', 'prompt_cache_key', 'prompt_cache_retention', 'context_management', 'top_logprobs', 'prompt', 'moderation', 'audio']);

function object(value, path) {
  if (!record(value)) invalid(`${path} must be an object.`, path);
  return value;
}

function keys(value, allowed, path) {
  object(value, path);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) unsupported(`Unsupported field: ${path}.${key}.`, `${path}.${key}`);
}

function string(value, path, { empty = true, max = Infinity } = {}) {
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > max) invalid(`${path} must be ${empty ? 'a' : 'a nonempty'} string${Number.isFinite(max) ? ` of at most ${max} characters` : ''}.`, path);
  return value;
}

function bool(value, path, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') invalid(`${path} must be a boolean or null.`, path);
  return value;
}

function sampling(value, path, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid(`${path} must be a number between ${min} and ${max}, or null.`, path);
  return value;
}

function requireCapability(profile, capability, path) {
  if (profile?.capabilities?.[capability] !== true) unsupported(`The selected model/runtime does not support ${capability}.`, path);
}

function validateName(value, path) {
  if (typeof value !== 'string' || !NAME.test(value)) invalid(`${path} must contain 1 to 64 letters, digits, underscores, or hyphens.`, path);
  return value;
}

function optionalIdentity(item, normalized, path) {
  if (own(item, 'id')) normalized.id = string(item.id, `${path}.id`, { empty: false, max: 256 });
  if (own(item, 'status')) {
    if (!STATUSES.has(item.status)) invalid('Invalid Item status.', `${path}.status`);
    normalized.status = item.status;
  }
  return normalized;
}

function normalizeContent(content, role, path, { functionOutput = false } = {}) {
  if (typeof content === 'string') {
    if (functionOutput) return content;
    return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content, ...(role === 'assistant' ? { annotations: [] } : {}) }];
  }
  if (!Array.isArray(content)) invalid(`${path} must be a string or an array of supported text parts.`, path);
  return content.map((part, index) => {
    const location = `${path}[${index}]`;
    object(part, location);
    if (part.type === 'input_text') {
      keys(part, ['type', 'text'], location);
      return { type: 'input_text', text: string(part.text, `${location}.text`) };
    }
    if (part.type === 'output_text' && role === 'assistant' && !functionOutput) {
      keys(part, ['type', 'text', 'annotations', 'logprobs'], location);
      for (const key of ['annotations', 'logprobs']) {
        if (own(part, key) && (!Array.isArray(part[key]) || part[key].length)) unsupported(`Only empty ${key} is supported for replayed text.`, `${location}.${key}`);
      }
      return { type: 'output_text', text: string(part.text, `${location}.text`), annotations: [], ...(own(part, 'logprobs') ? { logprobs: [] } : {}) };
    }
    if (part.type === 'refusal' && role === 'assistant' && !functionOutput) {
      keys(part, ['type', 'refusal'], location);
      return { type: 'refusal', refusal: string(part.refusal, `${location}.refusal`) };
    }
    unsupported(`Unsupported content type '${String(part.type)}' for ${functionOutput ? 'a function result' : role}.`, `${location}.type`);
  });
}

function normalizeItem(item, index, profile, prefix = 'input') {
  const path = `${prefix}[${index}]`;
  object(item, path);
  const type = own(item, 'type') ? item.type : (own(item, 'role') ? 'message' : undefined);
  if (type === 'message') {
    keys(item, ['type', 'role', 'content', 'id', 'status', 'phase'], path);
    if (!ROLES.has(item.role)) invalid('Message role must be system, developer, user, or assistant.', `${path}.role`);
    if (item.role === 'developer' && profile?.capabilities?.developer_role === false) unsupported('The selected model/runtime cannot preserve developer role.', `${path}.role`);
    const normalized = optionalIdentity(item, { type: 'message', role: item.role, content: normalizeContent(item.content, item.role, `${path}.content`) }, path);
    if (own(item, 'phase')) {
      if (item.role !== 'assistant') invalid('phase is only valid on assistant messages.', `${path}.phase`);
      if (item.phase !== null) {
        requireCapability(profile, 'assistant_phase', `${path}.phase`);
        if (!['commentary', 'final_answer'].includes(item.phase)) invalid('phase must be commentary, final_answer, or null.', `${path}.phase`);
      }
      normalized.phase = item.phase;
    }
    return normalized;
  }
  if (type === 'function_call') {
    requireCapability(profile, 'function_calling', `${path}.type`);
    keys(item, ['type', 'id', 'status', 'call_id', 'name', 'arguments'], path);
    const args = string(item.arguments, `${path}.arguments`);
    let parsed;
    try { parsed = JSON.parse(args); } catch { invalid('Function arguments must be a JSON string containing an object.', `${path}.arguments`); }
    if (!record(parsed)) invalid('Function arguments must encode an object.', `${path}.arguments`);
    return optionalIdentity(item, { type, call_id: string(item.call_id, `${path}.call_id`, { empty: false, max: 256 }), name: validateName(item.name, `${path}.name`), arguments: args }, path);
  }
  if (type === 'function_call_output') {
    requireCapability(profile, 'function_calling', `${path}.type`);
    keys(item, ['type', 'id', 'status', 'call_id', 'output'], path);
    return optionalIdentity(item, { type, call_id: string(item.call_id, `${path}.call_id`, { empty: false, max: 256 }), output: normalizeContent(item.output, 'user', `${path}.output`, { functionOutput: true }) }, path);
  }
  unsupported(`Unsupported input Item type: ${String(type)}.`, `${path}.type`);
}

function validateCorrelation(items) {
  const calls = new Map();
  const ids = new Set();
  for (const { item, path } of items) {
    if (item.id) {
      if (ids.has(item.id)) invalid(`Duplicate Item id '${item.id}'.`, `${path}.id`);
      ids.add(item.id);
    }
    if (item.type === 'function_call') {
      if (calls.has(item.call_id)) invalid(`Duplicate function call_id '${item.call_id}'.`, `${path}.call_id`);
      calls.set(item.call_id, { answered: false, path, status: item.status });
    }
    if (item.type === 'function_call_output') {
      const call = calls.get(item.call_id);
      if (!call) invalid(`No preceding function call matches call_id '${item.call_id}'.`, `${path}.call_id`);
      if (call.status && call.status !== 'completed') invalid('A function result cannot continue an unfinished function call.', `${path}.call_id`);
      if (call.answered) invalid(`Duplicate result for call_id '${item.call_id}'.`, `${path}.call_id`);
      call.answered = true;
    }
  }
  for (const [callId, call] of calls) if (!call.answered) invalid(`Missing function result for call_id '${callId}'.`, `${call.path}.call_id`);
}

function normalizeTools(tools, profile) {
  if (tools === undefined) return [];
  if (!Array.isArray(tools) || tools.length > 128) invalid('tools must be an array of at most 128 functions.', 'tools');
  const names = new Set();
  return tools.map((tool, index) => {
    const path = `tools[${index}]`;
    object(tool, path);
    if (tool.type !== 'function') unsupported(`Unsupported tool type: ${String(tool.type)}.`, `${path}.type`);
    requireCapability(profile, 'function_calling', path);
    keys(tool, ['type', 'name', 'description', 'parameters', 'strict'], path);
    const name = validateName(tool.name, `${path}.name`);
    if (names.has(name)) invalid('Function names must be unique.', `${path}.name`);
    names.add(name);
    if (own(tool, 'strict') && tool.strict !== null && typeof tool.strict !== 'boolean') invalid('strict must be a boolean or null.', `${path}.strict`);
    const source = tool.parameters ?? { type: 'object', properties: {}, required: [], additionalProperties: false };
    if (own(tool, 'parameters') && tool.parameters === null) invalid('Function parameters must be an object schema.', `${path}.parameters`);
    let strict = tool.strict;
    let parameters;
    if (strict === true) parameters = validateSchema(source, { strict: true, param: `${path}.parameters` });
    else if (strict === false) parameters = validateSchema(source, { param: `${path}.parameters` });
    else {
      // First validate the declared subset: normalization fallback must never
      // turn an unsupported keyword into an ignored constraint.
      parameters = validateSchema(source, { param: `${path}.parameters` });
      try { parameters = normalizeStrictSchema(parameters, { param: `${path}.parameters` }); strict = true; }
      catch (error) { if (!(error instanceof ResponseError)) throw error; strict = false; }
    }
    if (parameters.type !== 'object') invalid('Function parameters require an object schema at the root.', `${path}.parameters.type`);
    if (strict) requireCapability(profile, 'structured_outputs', `${path}.strict`);
    return { type: 'function', name, ...(own(tool, 'description') ? { description: string(tool.description, `${path}.description`) } : {}), parameters, strict };
  });
}

function normalizeChoice(choice, tools, profile) {
  choice ??= 'auto';
  if (typeof choice === 'string') {
    if (!['auto', 'none', 'required'].includes(choice)) invalid('tool_choice must be auto, none, required, a forced function, or allowed_tools.', 'tool_choice');
    if (choice === 'required' && !tools.length) invalid('tool_choice required needs at least one tool.', 'tool_choice');
    return choice;
  }
  object(choice, 'tool_choice');
  requireCapability(profile, 'function_calling', 'tool_choice');
  const known = (name, path) => {
    validateName(name, path);
    if (!tools.some((tool) => tool.name === name)) invalid(`Unknown function '${name}' in tool_choice.`, path);
    return name;
  };
  if (choice.type === 'function') {
    keys(choice, ['type', 'name'], 'tool_choice');
    return { type: 'function', name: known(choice.name, 'tool_choice.name') };
  }
  if (choice.type === 'allowed_tools') {
    keys(choice, ['type', 'mode', 'tools'], 'tool_choice');
    if (!['auto', 'required'].includes(choice.mode)) invalid('allowed_tools mode must be auto or required.', 'tool_choice.mode');
    if (!Array.isArray(choice.tools) || !choice.tools.length) invalid('allowed_tools requires a nonempty tools array.', 'tool_choice.tools');
    const names = new Set();
    return { type: 'allowed_tools', mode: choice.mode, tools: choice.tools.map((tool, index) => {
      const path = `tool_choice.tools[${index}]`;
      keys(tool, ['type', 'name'], path);
      if (tool.type !== 'function') unsupported('Only function references are supported in allowed_tools.', `${path}.type`);
      const name = known(tool.name, `${path}.name`);
      if (names.has(name)) invalid('allowed_tools contains a duplicate function.', `${path}.name`);
      names.add(name);
      return { type: 'function', name };
    }) };
  }
  unsupported('Unsupported tool_choice type.', 'tool_choice.type');
}

function normalizeText(text, profile) {
  if (text === undefined || text === null) return { format: { type: 'text' } };
  keys(text, ['format'], 'text');
  if (!own(text, 'format')) return { format: { type: 'text' } };
  const format = object(text.format, 'text.format');
  if (format.type === 'text') { keys(format, ['type'], 'text.format'); return { format: { type: 'text' } }; }
  if (format.type === 'json_object') {
    keys(format, ['type'], 'text.format');
    requireCapability(profile, 'json_object', 'text.format');
    return { format: { type: 'json_object' } };
  }
  if (format.type === 'json_schema') {
    keys(format, ['type', 'name', 'description', 'schema', 'strict'], 'text.format');
    requireCapability(profile, 'structured_outputs', 'text.format');
    if (own(format, 'strict') && format.strict !== null && typeof format.strict !== 'boolean') invalid('strict must be a boolean or null.', 'text.format.strict');
    const strict = format.strict ?? false;
    return { format: { type: 'json_schema', name: validateName(format.name, 'text.format.name'), ...(own(format, 'description') ? { description: string(format.description, 'text.format.description') } : {}), schema: validateSchema(format.schema, { strict, param: 'text.format.schema' }), strict } };
  }
  unsupported('Unsupported text format.', 'text.format.type');
}

/** Admission contract for the explicitly stateless Core profile. */
export function normalizeRequest(payload, { model, profile, transport = 'http', history = [] } = {}) {
  object(payload, 'request');
  for (const key of Object.keys(payload)) {
    if (ADVANCED.has(key)) unsupported(`The Core profile does not implement ${key}.`, key);
    if (!FIELDS.has(key)) invalid(`Unknown parameter: ${key}.`, key, 'unknown_parameter');
  }
  if (payload.store !== false) unsupported('This stateless Core profile requires explicit store:false; omitted, null, and true request unsupported retained storage.', 'store');
  const background = bool(payload.background, 'background', false);
  if (background) unsupported('Background execution requires a separate retention profile and is not implemented.', 'background');
  const stream = bool(payload.stream, 'stream', false);
  if (stream && profile?.capabilities?.streaming === false) unsupported('Streaming is unavailable for this model/runtime.', 'stream');
  const selectedModel = payload.model === undefined ? model : payload.model;
  string(selectedModel, 'model', { empty: false, max: 512 });
  if (model && selectedModel !== model) throw new ResponseError(404, 'The requested model is not available on this service.', 'model_not_found', 'model');
  const instructions = payload.instructions ?? null;
  if (instructions !== null) string(instructions, 'instructions');
  const previousResponseId = payload.previous_response_id ?? null;
  if (previousResponseId !== null) {
    string(previousResponseId, 'previous_response_id', { empty: false, max: 256 });
    if (transport !== 'websocket') unsupported('previous_response_id is supported only in the active transient WebSocket session.', 'previous_response_id');
  }
  const input = payload.input === undefined ? [] : typeof payload.input === 'string'
    ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: payload.input }] }]
    : payload.input;
  if (!Array.isArray(input) || input.length > 1000) invalid('input must be a string or an array of at most 1000 Items.', 'input');
  if (!Array.isArray(history)) invalid('Invalid continuation history.', 'previous_response_id');
  const normalizedInput = input.map((item, index) => normalizeItem(item, index, profile));
  const normalizedHistory = history.map((item, index) => normalizeItem(item, index, profile, 'history'));
  validateCorrelation([...normalizedHistory.map((item, index) => ({ item, path: `history[${index}]` })), ...normalizedInput.map((item, index) => ({ item, path: `input[${index}]` }))]);
  const tools = normalizeTools(payload.tools, profile);
  const toolChoice = normalizeChoice(payload.tool_choice, tools, profile);
  const parallel = bool(payload.parallel_tool_calls, 'parallel_tool_calls', true);
  if (tools.length && parallel && profile?.capabilities?.parallel_tool_calls === false) unsupported('This model/runtime requires parallel_tool_calls:false.', 'parallel_tool_calls');
  const text = normalizeText(payload.text, profile);
  if (text.format.type !== 'text' && tools.length && toolChoice !== 'none') unsupported('Structured text and active function tools cannot be combined in this profile.', 'text.format');
  const maxOutputTokens = payload.max_output_tokens ?? null;
  if (maxOutputTokens !== null && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)) invalid('max_output_tokens must be a positive safe integer or null.', 'max_output_tokens');
  const metadata = payload.metadata ?? {};
  object(metadata, 'metadata');
  if (Object.keys(metadata).length > 16) invalid('metadata may contain at most 16 entries.', 'metadata');
  for (const [key, value] of Object.entries(metadata)) {
    if (key.length > 64) invalid('Metadata keys may contain at most 64 characters.', 'metadata');
    string(value, `metadata.${key}`, { max: 512 });
  }
  const reasoning = payload.reasoning ?? null;
  if (reasoning !== null) {
    keys(reasoning, ['effort'], 'reasoning');
    if (reasoning.effort !== 'none') unsupported('Only reasoning.effort:none is supported by this profile.', 'reasoning.effort');
  }
  const include = payload.include ?? [];
  if (!Array.isArray(include)) invalid('include must be an array or null.', 'include');
  if (include.length) unsupported('No optional include fields are implemented in this profile.', 'include');
  const truncation = payload.truncation ?? 'disabled';
  if (truncation !== 'disabled') unsupported('Only truncation:disabled is supported; excess context must be rejected.', 'truncation');
  const streamOptions = payload.stream_options ?? {};
  keys(streamOptions, ['include_obfuscation'], 'stream_options');
  return {
    model: selectedModel, input: normalizedInput, instructions, store: false, background: false, stream,
    previous_response_id: previousResponseId, tools, tool_choice: toolChoice, parallel_tool_calls: parallel,
    text, temperature: sampling(payload.temperature, 'temperature', 1, 0, 2), top_p: sampling(payload.top_p, 'top_p', 1, 0, 1),
    max_output_tokens: maxOutputTokens, metadata: structuredClone(metadata), reasoning: reasoning === null ? null : { ...reasoning },
    include: [], truncation, stream_options: { include_obfuscation: bool(streamOptions.include_obfuscation, 'stream_options.include_obfuscation', true) },
  };
}
