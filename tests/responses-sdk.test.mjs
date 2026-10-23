import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import OpenAI from 'openai';
import { ResponsesWS } from 'openai/resources/responses/ws';
import { createServer } from '../server.mjs';

// Actual official SDK helpers exercise our local service and deterministic engine.
// Semantic assertions supplement SDK parsing; these are not captured wire or
// hardware acceptance fixtures (see spec V01, V05, V06 and WS01/WS04).
const MODEL = 'sdk-fixture-model';
const KEY = 'sdk-fixture-secret';
const parameters = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
const weatherTool = { type: 'function', name: 'lookup_weather', strict: true, parameters };
const common = { model: MODEL, store: false, max_output_tokens: 128 };
const textOf = (response) => response.output.filter((item) => item.type === 'message').flatMap((item) => item.content).filter((part) => part.type === 'output_text').map((part) => part.text).join('');

async function fixture(t) {
  const requests = [];
  const engine = {
    async countInputTokens() { return { input_tokens: 11, context_length: 32768 }; },
    async *generate(request, { history = [] }) {
      requests.push(structuredClone({ request, history }));
      const toolResult = request.input.find((item) => item.type === 'function_call_output');
      if (request.tools.length && request.tool_choice !== 'none' && !toolResult) {
        yield { type: 'tool_delta', index: 0, id: 'call_sdk_weather', name: 'lookup_weather', arguments: '{"city":' };
        yield { type: 'tool_delta', index: 0, arguments: '"Paris"}' };
        yield { type: 'usage', usage: { prompt_tokens: 11, completion_tokens: 6 } };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        const text = request.text.format.type === 'json_schema' ? '{"city":"Paris"}' : toolResult ? 'Paris is sunny.' : history.length ? 'You said sapphire.' : '你好，SDK!';
        yield { type: 'text_delta', delta: text.slice(0, 3) };
        yield { type: 'text_delta', delta: text.slice(3) };
        yield { type: 'usage', usage: { prompt_tokens: 11, completion_tokens: 6 } };
        yield { type: 'finish', reason: 'stop' };
      }
    },
  };
  const server = createServer({ model: MODEL, engine, responsesMode: 'service', runtimeProfile: 'vllm-metal', apiKey: KEY, logger: () => {} });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new OpenAI({ apiKey: KEY, baseURL: `${origin}/v1`, maxRetries: 0, timeout: 5000 });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { client, requests };
}

function verifyResponse(response, { text = true } = {}) {
  assert.equal(response.object, 'response');
  assert.equal(response.status, 'completed');
  assert.equal(response.error, null);
  assert.equal(response.incomplete_details, null);
  assert.equal(response.store, false);
  assert.match(response.id, /^resp_/);
  assert.equal(new Set(response.output.map((item) => item.id)).size, response.output.length);
  assert.deepEqual(response.usage, { input_tokens: 11, output_tokens: 6, total_tokens: 17 });
  if (text) {
    assert.ok(textOf(response));
    assert.equal(response.output_text, textOf(response));
  }
}

test('official Node SDK create computes output_text from canonical Items and exposes admission errors', async (t) => {
  const { client, requests } = await fixture(t);
  const response = await client.responses.create({ ...common, input: 'Hello' });
  verifyResponse(response);
  assert.equal(response.output_text, '你好，SDK!');
  assert.equal(requests[0].request.input[0].content[0].text, 'Hello');
  await assert.rejects(client.responses.create({ model: MODEL, input: 'Omitted storage' }), (error) => {
    assert.ok(error instanceof OpenAI.BadRequestError);
    assert.equal(error.code, 'unsupported_parameter');
    assert.equal(error.param, 'store');
    return true;
  });
  assert.equal(requests.length, 1, 'admission rejection must precede inference');
});

test('official Node Responses stream finalResponse agrees with deltas, Items and terminal snapshot', async (t) => {
  const { client } = await fixture(t);
  const stream = client.responses.stream({ ...common, input: 'Hello', stream_options: { include_obfuscation: false } });
  const events = [];
  for await (const event of stream) events.push(event);
  const response = await stream.finalResponse();
  verifyResponse(response);
  const deltas = events.filter((event) => event.type === 'response.output_text.delta');
  assert.equal(deltas.map((event) => event.delta).join(''), response.output_text);
  assert.ok(deltas.length > 1);
  for (const event of deltas) {
    assert.equal(response.output[event.output_index].id, event.item_id);
    assert.equal(response.output[event.output_index].content[event.content_index].type, 'output_text');
    assert.equal(Object.hasOwn(event, 'obfuscation'), false);
  }
  const terminals = events.filter((event) => ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type));
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].type, 'response.completed');
  assert.equal(terminals[0].response.id, response.id);
  assert.equal(textOf(terminals[0].response), response.output_text);
});

test('official Node SDK function round trip replays Item IDs and correlates results by call_id', async (t) => {
  const { client, requests } = await fixture(t);
  const prompt = [{ role: 'user', content: 'Find the weather for Paris.' }];
  const first = await client.responses.create({ ...common, input: prompt, tools: [weatherTool], tool_choice: { type: 'function', name: 'lookup_weather' }, parallel_tool_calls: false });
  verifyResponse(first, { text: false });
  const call = first.output.find((item) => item.type === 'function_call');
  assert.ok(call);
  assert.notEqual(call.id, call.call_id);
  assert.equal(call.call_id, 'call_sdk_weather');
  assert.equal(call.name, 'lookup_weather');
  assert.deepEqual(JSON.parse(call.arguments), { city: 'Paris' });
  const replay = [...prompt, ...first.output, { type: 'function_call_output', call_id: call.call_id, output: '{"weather":"sunny"}' }];
  const second = await client.responses.create({ ...common, input: replay, tools: [weatherTool], tool_choice: 'none' });
  verifyResponse(second);
  assert.equal(second.output_text, 'Paris is sunny.');
  const canonicalCall = requests[1].request.input.find((item) => item.type === 'function_call');
  assert.equal(canonicalCall.id, call.id);
  assert.equal(canonicalCall.call_id, call.call_id);
  await assert.rejects(client.responses.create({ ...common, input: [...prompt, ...first.output] }), (error) => error instanceof OpenAI.BadRequestError && error.param === 'input[1].call_id');
  assert.equal(requests.length, 2);
});

test('official Node streamed function helper assembles arguments and parses strict tool arguments', async (t) => {
  const { client } = await fixture(t);
  const stream = client.responses.stream({ ...common, input: 'Find Paris weather.', tools: [weatherTool], tool_choice: 'required' });
  const events = [];
  for await (const event of stream) events.push(event);
  const response = await stream.finalResponse();
  verifyResponse(response, { text: false });
  const call = response.output.find((item) => item.type === 'function_call');
  assert.deepEqual(call.parsed_arguments, { city: 'Paris' });
  const deltas = events.filter((event) => event.type === 'response.function_call_arguments.delta');
  assert.equal(deltas.map((event) => event.delta).join(''), call.arguments);
  for (const event of deltas) assert.equal(event.item_id, call.id);
  const done = events.find((event) => event.type === 'response.function_call_arguments.done');
  assert.equal(done.arguments, call.arguments);
  assert.equal(done.item_id, call.id);
  assert.equal(response.output_text, '');
});

test('official Node responses.parse produces output_parsed using flat strict text.format', async (t) => {
  const { client, requests } = await fixture(t);
  // The official parser accepts the plain JSON-schema format, so no Zod runtime
  // or imitation SDK helper is needed for this workflow.
  const response = await client.responses.parse({ ...common, input: 'Return Paris.', text: { format: { type: 'json_schema', name: 'city_answer', schema: parameters, strict: true } } });
  verifyResponse(response);
  assert.deepEqual(response.output_parsed, { city: 'Paris' });
  assert.deepEqual(response.output[0].content[0].parsed, response.output_parsed);
  assert.equal(requests[0].request.text.format.type, 'json_schema');
  assert.equal(requests[0].request.text.format.strict, true);
});

function socketTurn(socket, payload) {
  return new Promise((resolve, reject) => {
    const events = [];
    const cleanup = () => { clearTimeout(timer); socket.off('event', receive); socket.off('error', failed); };
    const failed = (error) => { cleanup(); reject(error); };
    const receive = (event) => {
      events.push(event);
      if (event.type === 'error') return failed(new Error(JSON.stringify(event.error)));
      if (['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) {
        cleanup(); resolve({ response: event.response, events });
      }
    };
    const timer = setTimeout(() => failed(new Error('SDK WebSocket turn timed out')), 5000);
    socket.on('event', receive);
    socket.on('error', failed);
    socket.send({ type: 'response.create', ...payload });
  });
}

test('official Node ResponsesWS transport creates and continues a transient response', async (t) => {
  const { client, requests } = await fixture(t);
  const socket = new ResponsesWS(client, { handshakeTimeout: 5000 });
  socket.on('error', () => {}); // Per-turn listeners assert errors; cleanup is intentional.
  try {
    const first = await socketTurn(socket, { ...common, input: 'Remember sapphire.' });
    const second = await socketTurn(socket, { ...common, input: 'Which word?', previous_response_id: first.response.id });
    for (const { response, events } of [first, second]) {
      assert.equal(response.status, 'completed');
      assert.equal(response.store, false);
      assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index));
      assert.equal(events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta).join(''), textOf(response));
      assert.equal(events.at(-1).type, 'response.completed');
    }
    assert.equal(second.response.previous_response_id, first.response.id);
    assert.equal(textOf(second.response), 'You said sapphire.');
    assert.notEqual(first.response.id, second.response.id);
    assert.equal(requests[1].history.length, 2);
    assert.equal(requests[1].history[0].content[0].text, 'Remember sapphire.');
    assert.equal(requests[1].request.input.length, 1);
  } finally { socket.close(); }
});
