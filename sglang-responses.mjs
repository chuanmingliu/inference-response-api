/** Features supported by this local, text-only SGLang deployment. */
export const SGLANG_RESPONSES_CAPABILITIES = {
  text: true, streaming: true, stateless: true,
  images: false, persistence: true, previous_response_id: true,
  background: true, retrieve: true, cancel: true, delete: false, input_items: false,
  structured_outputs: true, function_calling: true,
  cache_usage: true, prompt_cache_key: 'cache_salt_namespace',
  storage: 'process_memory', retention: 'bounded_memory',
  storage_limits: {
    ttl_seconds: 3600, max_completed: 128, max_serialized_bytes: 64 * 1024 * 1024, max_active: 8,
  },
};

// IDs are opaque single path segments. Never forward arbitrary subresources.
export function responseLifecycleMethod(pathname) {
  if (/^\/v1\/responses\/resp_[A-Za-z0-9_-]{1,192}$/.test(pathname)) return 'GET';
  if (/^\/v1\/responses\/resp_[A-Za-z0-9_-]{1,192}\/cancel$/.test(pathname)) return 'POST';
  return undefined;
}

function unsupported(param, explanation) {
  return Object.assign(new Error(`${param}: ${explanation}`), {
    status: 400, code: 'unsupported_parameter',
  });
}

function rejectCacheBreakpoints(value, path) {
  if (!Array.isArray(value)) return;
  for (const [index, item] of value.entries()) {
    for (const field of ['cache_control', 'prompt_cache_breakpoint']) {
      if (item && Object.hasOwn(item, field)) {
        throw unsupported(`${path}[${index}].${field}`, 'Explicit cache breakpoints are not supported; prefix caching is automatic.');
      }
    }
  }
}

/** Keep native features intact while rejecting options SGLang would ignore. */
export function prepareSglangResponseRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw Object.assign(new Error('Request body must be a JSON object.'), { status: 400, code: 'invalid_request' });
  }
  if (payload.request_id != null && (typeof payload.request_id !== 'string' || responseLifecycleMethod(`/v1/responses/${payload.request_id}`) !== 'GET')) {
    throw Object.assign(new Error('request_id must start with resp_ and contain at most 192 letters, digits, underscores, or hyphens after that prefix.'), { status: 400, code: 'invalid_request' });
  }
  for (const field of ['prompt_cache_retention', 'prompt_cache_options', 'cache_control', 'prompt_cache_breakpoint']) {
    if (Object.hasOwn(payload, field)) {
      throw unsupported(field, 'This local cache has no OpenAI retention policy or explicit breakpoints. Prefix caching is automatic.');
    }
  }
  if (payload.service_tier != null && !['auto', 'default'].includes(payload.service_tier)) {
    throw unsupported('service_tier', 'Cloud service tiers are unavailable on this local instance.');
  }
  if (payload.safety_identifier != null) {
    throw unsupported('safety_identifier', 'This local instance does not provide OpenAI safety monitoring.');
  }
  if (payload.text && Object.hasOwn(payload.text, 'verbosity')) {
    throw unsupported('text.verbosity', 'SGLang does not implement output verbosity controls. Request the desired detail in instructions instead.');
  }
  if (payload.reasoning?.effort != null && payload.reasoning.effort !== 'none') {
    throw unsupported('reasoning.effort', 'Qwen3 does not implement OpenAI reasoning effort tiers. Use reasoning.effort="none" or chat_template_kwargs.enable_thinking to control thinking.');
  }
  // Native SGLang accepts these schema fields but does not apply them during generation.
  if (payload.truncation === 'auto') {
    throw unsupported('truncation', 'Automatic input truncation is unavailable. Keep input and reserved output within the model context window.');
  }
  if (payload.max_tool_calls != null) {
    throw unsupported('max_tool_calls', 'SGLang does not enforce this hosted-tool execution limit; tools in this deployment execute in your client.');
  }
  if (Array.isArray(payload.tools)) {
    for (const tool of payload.tools) {
      if (!['function', 'custom'].includes(tool?.type)) {
        throw unsupported('tools', 'Only client-executed function/custom tools are supported; hosted web, file, computer, MCP, and code tools are unavailable.');
      }
    }
  }
  for (const field of ['frequency_penalty', 'presence_penalty']) {
    if (payload[field] != null && payload[field] !== 0) {
      throw unsupported(field, 'The MLX sampling backend does not apply this penalty.');
    }
  }
  if (payload.repetition_penalty != null && payload.repetition_penalty !== 1) {
    throw unsupported('repetition_penalty', 'The MLX sampling backend does not apply this penalty.');
  }
  rejectCacheBreakpoints(payload.input, 'input');
  if (Array.isArray(payload.input)) {
    for (const [index, item] of payload.input.entries()) {
      if (item?.type === 'message' || item?.role) rejectCacheBreakpoints(item.content, `input[${index}].content`);
    }
  }
  rejectCacheBreakpoints(payload.tools, 'tools');
  if (Object.hasOwn(payload, 'prompt_cache_key')) {
    if (typeof payload.prompt_cache_key !== 'string' || payload.prompt_cache_key.length < 1 || payload.prompt_cache_key.length > 256) {
      throw Object.assign(new Error('prompt_cache_key must be a nonempty string of at most 256 characters.'), { status: 400, code: 'invalid_request' });
    }
    if (payload.cache_salt != null && payload.cache_salt !== payload.prompt_cache_key) {
      throw Object.assign(new Error('prompt_cache_key and cache_salt must match when both are supplied.'), { status: 400, code: 'invalid_request' });
    }
    const { prompt_cache_key, ...native } = payload;
    // A local namespace for SGLang RadixCache; this does not select a cloud tier or TTL.
    return { ...native, cache_salt: prompt_cache_key };
  }
  return payload;
}
