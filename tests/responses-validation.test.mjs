import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRequest, ResponseError } from '../lib/responses/validation.mjs';
import { validateSchema, validateValue, normalizeStrictSchema } from '../lib/responses/schema.mjs';

const profile = { capabilities: { function_calling: true, structured_outputs: true, json_object: true, assistant_phase: true, developer_role: true, parallel_tool_calls: true, reasoning: false } };
const options = { model: 'test-model', profile };
const request = (payload = {}, overrides = {}) => normalizeRequest({ store: false, input: 'Hello', ...payload }, { ...options, ...overrides });
const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
const tool = (changes = {}) => ({ type: 'function', name: 'weather', parameters: schema, ...changes });
const call = (id = 'call_A', changes = {}) => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name: 'weather', arguments: '{"city":"Paris"}', ...changes });
const result = (id = 'call_A', changes = {}) => ({ type: 'function_call_output', id: `result_${id}`, call_id: id, output: 'Sunny', ...changes });

function rejects(fn, param, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ResponseError);
    assert.equal(error.status, 400);
    assert.equal(error.type, 'invalid_request_error');
    assert.equal(error.param, param);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

test('Core admission requires explicit stateless retention before inference', () => {
  for (const store of [undefined, null, true, 0, 'false']) rejects(() => request({ store }), 'store', 'unsupported_parameter');
  rejects(() => request({ background: true }), 'background', 'unsupported_parameter');
  rejects(() => request({ conversation: null }), 'conversation', 'unsupported_parameter');
  rejects(() => request({ previous_response_id: 'resp_old' }), 'previous_response_id');
  assert.equal(request({ previous_response_id: 'resp_old' }, { transport: 'websocket' }).previous_response_id, 'resp_old');
});

test('defaults, nulls, false, zero and empty text have explicit distinct semantics', () => {
  const actual = request({ input: '', instructions: '', temperature: 0, top_p: 0, stream: false, parallel_tool_calls: false, metadata: {}, reasoning: { effort: 'none' }, stream_options: { include_obfuscation: false } });
  assert.deepEqual(actual.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }] }]);
  assert.equal(actual.instructions, '');
  assert.equal(actual.temperature, 0);
  assert.equal(actual.top_p, 0);
  assert.equal(actual.parallel_tool_calls, false);
  assert.equal(actual.stream_options.include_obfuscation, false);
  assert.equal(actual.truncation, 'disabled');
  assert.equal(actual.max_output_tokens, null);
  assert.deepEqual(actual.text, { format: { type: 'text' } });
  const nullable = request({ instructions: null, temperature: null, metadata: null, reasoning: null, stream: null });
  assert.equal(nullable.instructions, null);
  assert.equal(nullable.temperature, 1);
  assert.equal(nullable.stream, false);
  assert.equal(nullable.reasoning, null);
  assert.deepEqual(nullable.metadata, {});
  rejects(() => request({ input: null }), 'input');
  rejects(() => request({ tools: null }), 'tools');
  rejects(() => request({ text: { format: null } }), 'text.format');
  rejects(() => request({ model: null }), 'model');
});

test('unknown and unsupported nested options cannot be silently dropped', () => {
  rejects(() => request({ made_up: true }), 'made_up', 'unknown_parameter');
  rejects(() => request({ service_tier: 'auto' }), 'service_tier');
  rejects(() => request({ prompt_cache_key: '' }), 'prompt_cache_key');
  rejects(() => request({ reasoning: { effort: 'high' } }), 'reasoning.effort');
  rejects(() => request({ reasoning: { effort: 'none', summary: 'auto' } }), 'reasoning.summary');
  rejects(() => request({ text: { verbosity: 'low' } }), 'text.verbosity');
  rejects(() => request({ stream_options: { include_usage: true } }), 'stream_options.include_usage');
  rejects(() => request({ include: ['output_text.logprobs'] }), 'include');
  rejects(() => request({ truncation: 'auto' }), 'truncation');
  rejects(() => request({ input: [{ role: 'user', content: 'Hello', extra: 1 }] }), 'input[0].extra');
});

test('canonical messages preserve every role, content part, identity, refusal and phase', () => {
  const input = [
    { role: 'system', content: 'Policy' },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Guide' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'One' }, { type: 'input_text', text: 'Two' }] },
    { type: 'message', role: 'assistant', id: 'msg_A', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: 'Working', annotations: [] }, { type: 'refusal', refusal: 'Cannot do that' }] },
    { role: 'assistant', content: 'Final' },
  ];
  const actual = request({ input });
  assert.deepEqual(actual.input.map((item) => item.role), ['system', 'developer', 'user', 'assistant', 'assistant']);
  assert.deepEqual(actual.input[2].content, input[2].content);
  assert.deepEqual(actual.input[3], input[3]);
  assert.deepEqual(actual.input[4].content, [{ type: 'output_text', text: 'Final', annotations: [] }]);
  rejects(() => request({ input: [{ role: 'user', phase: 'final_answer', content: 'x' }] }), 'input[0].phase');
  rejects(() => request({ input: [input[3]] }, { profile: { capabilities: { assistant_phase: false } } }), 'input[0].phase');
  rejects(() => request({ input: [input[1]] }, { profile: { capabilities: { developer_role: false } } }), 'input[0].role');
});

test('multimodal, opaque reasoning and undeclared annotation variants reject precisely', () => {
  rejects(() => request({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/a.png' }] }] }), 'input[0].content[0].type');
  rejects(() => request({ input: [{ type: 'reasoning', encrypted_content: 'opaque' }] }), 'input[0].type');
  rejects(() => request({ input: [{ role: 'assistant', content: [{ type: 'output_text', text: 'x', annotations: [{ type: 'url_citation' }] }] }] }), 'input[0].content[0].annotations');
  rejects(() => request({ input: [{ role: 'user', content: [{ type: 'output_text', text: 'wrong role' }] }] }), 'input[0].content[0].type');
});

test('parallel function results correlate by call_id in any result order', () => {
  const input = [call('call_A'), call('call_B'), result('call_B', { output: [{ type: 'input_text', text: 'Cloudy' }] }), result('call_A', { output: '' })];
  assert.deepEqual(request({ input }).input, input);
  assert.notEqual(request({ input }).input[0].id, request({ input }).input[0].call_id);
  const continued = request({ input: [result()] }, { history: [call()], transport: 'websocket' });
  assert.deepEqual(continued.input, [result()], 'predecessor history must not be duplicated in returned input');
});

test('function correlation rejects missing, duplicate, unknown and premature results', () => {
  rejects(() => request({ input: [call()] }), 'input[0].call_id');
  rejects(() => request({ input: [result()] }), 'input[0].call_id');
  rejects(() => request({ input: [result(), call()] }), 'input[0].call_id');
  rejects(() => request({ input: [call(), result('call_B')] }), 'input[1].call_id');
  rejects(() => request({ input: [call(), result(), result('call_A', { id: 'second_result' })] }), 'input[2].call_id');
  rejects(() => request({ input: [call(), result(), call('call_A', { id: 'second_call' })] }), 'input[2].call_id');
  rejects(() => request({ input: [call(), result('call_A', { id: 'fc_call_A' })] }), 'input[1].id');
  rejects(() => request({ input: [result()] }, { history: [call(), result()] }), 'input[0].id');
});

test('function input and result types are validated before backend dispatch', () => {
  for (const arguments_ of ['not JSON', '[]', 'null', '"string"']) rejects(() => request({ input: [call('call_A', { arguments: arguments_ }), result()] }), 'input[0].arguments');
  rejects(() => request({ input: [call(), result('call_A', { output: { arbitrary: true } })] }), 'input[1].output');
  rejects(() => request({ input: [call(), result('call_A', { output: [{ type: 'input_file', file_id: 'file_A' }] })] }), 'input[1].output[0].type');
  rejects(() => request({ input: [call(), result()] }, { profile: { capabilities: { function_calling: false } } }), 'input[0].type');
});

test('incomplete function calls cannot be resumed with caller results', () => {
  for (const status of ['in_progress', 'incomplete']) {
    rejects(() => request({ input: [call('call_A', { status }), result()] }), 'input[1].call_id');
    rejects(() => request({ input: [result()] }, { history: [call('call_A', { status })], transport: 'websocket' }), 'input[0].call_id');
  }
  assert.equal(request({ input: [call('call_A', { status: 'completed' }), result()] }).input[0].status, 'completed');
  rejects(() => request({ input: [call('call_A', { status: 'incomplete', arguments: '{"city":' }), result()] }), 'input[0].arguments');
});

test('omitted strict normalizes nested nullable schemas without mutating the caller', () => {
  const parameters = { type: 'object', properties: { city: { type: ['string', 'null'] }, locations: { type: 'array', items: { type: 'object', properties: { country: { type: 'string', enum: ['FR', 'UK'] } } } } } };
  const before = structuredClone(parameters);
  const normalized = request({ tools: [tool({ parameters })] }).tools[0];
  assert.equal(normalized.strict, true);
  assert.deepEqual(normalized.parameters.required, ['city', 'locations']);
  assert.equal(normalized.parameters.additionalProperties, false);
  assert.deepEqual(normalized.parameters.properties.locations.items.required, ['country']);
  assert.equal(normalized.parameters.properties.locations.items.additionalProperties, false);
  assert.deepEqual(parameters, before);
  assert.doesNotThrow(() => validateValue({ city: null, locations: [{ country: 'FR' }] }, normalized.parameters));
});

test('explicit false and impossible omitted strict normalization retain nonstrict behavior', () => {
  const open = { type: 'object', properties: { city: { type: 'string' } }, additionalProperties: true };
  const fallback = request({ tools: [tool({ parameters: open })] }).tools[0];
  assert.equal(fallback.strict, false);
  assert.deepEqual(fallback.parameters, open);
  const optedOut = request({ tools: [tool({ strict: false, parameters: { type: 'object', properties: {} } })] }).tools[0];
  assert.equal(optedOut.strict, false);
  assert.equal(Object.hasOwn(optedOut.parameters, 'additionalProperties'), false);
  rejects(() => request({ tools: [tool({ strict: true, parameters: open })] }), 'tools[0].parameters.additionalProperties', 'invalid_json_schema');
  rejects(() => request({ tools: [tool({ strict: true, parameters: { type: 'object', properties: { city: { type: 'string' } }, additionalProperties: false } })] }), 'tools[0].parameters.required');
});

test('tool choice supports none, auto, required, forced and allowed function subsets', () => {
  const tools = [tool(), tool({ name: 'time' })];
  for (const choice of ['none', 'auto', 'required', { type: 'function', name: 'weather' }, { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'time' }] }]) assert.deepEqual(request({ tools, tool_choice: choice }).tool_choice, choice);
  rejects(() => request({ tool_choice: 'required' }), 'tool_choice');
  rejects(() => request({ tools, tool_choice: { type: 'function', name: 'unknown' } }), 'tool_choice.name');
  rejects(() => request({ tools, tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'time' }, { type: 'function', name: 'time' }] } }), 'tool_choice.tools[1].name');
  rejects(() => request({ tools: [tool(), tool()] }), 'tools[1].name');
  rejects(() => request({ tools: [{ type: 'web_search' }] }), 'tools[0].type');
  rejects(() => request({ tools: [{ type: 'function', function: { name: 'weather' } }] }), 'tools[0].function');
});

test('function and structured generation are checked against runtime capabilities', () => {
  rejects(() => request({ tools: [tool()] }, { profile: { capabilities: { function_calling: false } } }), 'tools[0]');
  rejects(() => request({ tools: [tool()] }, { profile: { capabilities: { function_calling: true, structured_outputs: false } } }), 'tools[0].strict');
  const noParallel = { capabilities: { ...profile.capabilities, parallel_tool_calls: false } };
  rejects(() => request({ tools: [tool()] }, { profile: noParallel }), 'parallel_tool_calls');
  assert.equal(request({ tools: [tool()], parallel_tool_calls: false }, { profile: noParallel }).parallel_tool_calls, false);
  rejects(() => request({ text: { format: { type: 'json_schema', name: 'answer', schema, strict: true } } }, { profile: { capabilities: { structured_outputs: false } } }), 'text.format');
  rejects(() => request({ text: { format: { type: 'json_object' } } }, { profile: { capabilities: { json_object: false } } }), 'text.format');
});

test('structured output normalizes the flat Responses text.format shape', () => {
  const format = { type: 'json_schema', name: 'answer', schema, strict: true };
  assert.deepEqual(request({ text: { format } }).text, { format });
  const { strict, ...withoutStrict } = format;
  assert.equal(request({ text: { format: withoutStrict } }).text.format.strict, false);
  assert.deepEqual(request({ text: { format: { type: 'json_object' } } }).text, { format: { type: 'json_object' } });
  rejects(() => request({ text: { format: { type: 'json_schema', json_schema: { name: 'answer', schema } } } }), 'text.format.json_schema');
});

test('schema subset enforces nested objects, nullable fields, arrays and enums', () => {
  const nested = normalizeStrictSchema({ type: 'object', properties: { entries: { type: 'array', items: { type: 'object', properties: { value: { anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'null' }] } } } } } });
  assert.deepEqual(validateSchema(nested, { strict: true }), nested);
  const value = { entries: [{ value: null }, { value: 'b' }] };
  assert.equal(validateValue(value, nested), value);
  rejects(() => validateValue({ entries: [{ value: 'c' }] }, nested), 'value', 'invalid_schema_value');
  rejects(() => validateValue({ entries: [{}] }, nested), 'value', 'invalid_schema_value');
  rejects(() => validateValue({ entries: [{ value: 'a', extra: true }] }, nested), 'value', 'invalid_schema_value');
  rejects(() => validateValue({ entries: [1] }, nested), 'value', 'invalid_schema_value');
});

test('unsupported constraints never disappear through strict normalization fallback', () => {
  for (const keyword of ['pattern', 'minimum', '$ref', '$defs', 'allOf', 'format', 'minItems']) {
    const unsupportedSchema = { type: 'object', properties: {}, [keyword]: 'unsupported' };
    rejects(() => validateSchema(unsupportedSchema), `schema.${keyword}`, 'invalid_json_schema');
    rejects(() => request({ tools: [tool({ parameters: unsupportedSchema })] }), `tools[0].parameters.${keyword}`, 'invalid_json_schema');
  }
  rejects(() => validateSchema({ type: 'object', properties: {}, required: ['undeclared'] }), 'schema.required');
  rejects(() => validateSchema({ type: 'string', enum: ['a', 1] }), 'schema.enum');
  rejects(() => validateSchema({ type: 'array' }), 'schema.items');
  rejects(() => validateSchema({ type: 'object', additionalProperties: { type: 'string' } }), 'schema.additionalProperties');
});

test('schema complexity is bounded before inference or decoder compilation', () => {
  let deep = { type: 'string' };
  for (let level = 0; level < 22; level += 1) deep = { type: 'array', items: deep };
  assert.throws(() => validateSchema(deep), (error) => error.code === 'invalid_json_schema' && /20-level/.test(error.message));
  rejects(() => validateSchema({ type: 'string', description: 'x'.repeat(65_537) }), 'schema');
  const cyclic = { type: 'array' }; cyclic.items = cyclic;
  rejects(() => validateSchema(cyclic), 'schema');
});

test('sampling, metadata and output limits reject malformed values', () => {
  for (const temperature of [-0.1, 2.1, NaN, Infinity, '1']) rejects(() => request({ temperature }), 'temperature');
  for (const top_p of [-0.1, 1.1, '0.5']) rejects(() => request({ top_p }), 'top_p');
  for (const max_output_tokens of [0, -1, 1.5, '10', Number.MAX_SAFE_INTEGER + 1]) rejects(() => request({ max_output_tokens }), 'max_output_tokens');
  rejects(() => request({ metadata: { key: 1 } }), 'metadata.key');
  rejects(() => request({ metadata: { key: 'x'.repeat(513) } }), 'metadata.key');
  rejects(() => request({ metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`key${i}`, 'value'])) }), 'metadata');
});
