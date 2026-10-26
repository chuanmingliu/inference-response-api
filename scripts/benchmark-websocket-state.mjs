#!/usr/bin/env node
// Real local WebSocket transport + real gateway/engine adapter, deterministic
// in-process tokenizer/inference fixtures. Measures gateway overhead, not GPU
// performance or hosted OpenAI speed. Can load an older checkout for comparison.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import WebSocket from 'ws';

const { values } = parseArgs({ options: {
  implementation: { type: 'string', default: '.' }, profile: { type: 'string', default: 'vllm-metal' },
  runs: { type: 'string', default: '20' }, turns: { type: 'string', default: '20' },
  'tool-result-bytes': { type: 'string', default: '8192' }, report: { type: 'string' },
} });
const runs = Number(values.runs), turns = Number(values.turns), resultBytes = Number(values['tool-result-bytes']);
if (![runs, turns, resultBytes].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error('Benchmark sizes must be positive integers.');
const root = resolve(values.implementation);
const { createServer } = await import(pathToFileURL(resolve(root, 'server.mjs')));
const { createEngineAdapter } = await import(pathToFileURL(resolve(root, 'lib/responses/engine.mjs')));
const frame = (value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
let calls = 0;
const engine = createEngineAdapter({ upstream: 'http://fixture.invalid/v1', profile: values.profile, fetchImpl: async (url, init) => {
  // Parse the actual serialized request just as a local engine would. No
  // network request or real token count is made by this synthetic fixture.
  const body = JSON.parse(init.body);
  if (!body.messages?.length) throw new Error('Missing engine messages');
  if (!url.pathname.endsWith('chat/completions')) return Response.json({ count: 100, max_model_len: 32768 });
  return new Response(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${++calls}`, type: 'function', function: { name: 'inspect', arguments: '{}' } }] }, finish_reason: null }] })
    + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    + frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } }) + frame('[DONE]'),
  { headers: { 'content-type': 'text/event-stream' } });
} });
const server = createServer({ engine, model: 'benchmark-fixture', responsesMode: 'service', runtimeProfile: values.profile, logger: () => {} });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const tool = { type: 'function', name: 'inspect', strict: true, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } };
const toolResult = 'x'.repeat(resultBytes);

async function workflow() {
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/responses`);
  await once(ws, 'open');
  const times = [], firstDeltas = [];
  let input = 'Inspect the project.', previous, sentBytes = 0;
  const started = performance.now();
  try {
    for (let turn = 0; turn < turns; turn++) {
      const event = { type: 'response.create', model: 'benchmark-fixture', store: false, input,
        tools: [tool], tool_choice: 'required', parallel_tool_calls: false, max_output_tokens: 32,
        stream_options: { include_obfuscation: false }, ...(previous && { previous_response_id: previous }) };
      const encoded = JSON.stringify(event);
      sentBytes += Buffer.byteLength(encoded);
      const turnStarted = performance.now();
      const response = await new Promise((resolveResponse, reject) => {
        let first = null;
        const timer = setTimeout(() => finish(new Error('Fixture response timed out')), 10000);
        const finish = (error, value) => {
          clearTimeout(timer); ws.off('message', receive); ws.off('error', failed); ws.off('close', closed);
          if (error) reject(error); else { firstDeltas.push(first); resolveResponse(value); }
        };
        const failed = (error) => finish(error);
        const closed = () => finish(new Error('Unexpected WebSocket close'));
        const receive = (data) => {
          const value = JSON.parse(data);
          if (first === null && value.type === 'response.function_call_arguments.delta') first = performance.now() - turnStarted;
          if (value.type === 'error' || value.type === 'response.failed') finish(new Error(JSON.stringify(value)));
          if (value.type === 'response.completed') finish(null, value.response);
        };
        ws.on('message', receive); ws.once('error', failed); ws.once('close', closed); ws.send(encoded);
      });
      times.push(performance.now() - turnStarted);
      previous = response.id;
      const call = response.output.find((item) => item.type === 'function_call');
      if (!call || firstDeltas.at(-1) === null) throw new Error('Fixture did not produce a complete tool call');
      input = [{ type: 'function_call_output', call_id: call.call_id, output: toolResult }];
    }
    return { duration_ms: performance.now() - started, turn_ms: times, first_delta_ms: firstDeltas, sent_bytes: sentBytes };
  } finally {
    const closed = once(ws, 'close'); ws.close(); await closed;
  }
}

try {
  for (let warmup = 0; warmup < 3; warmup++) await workflow();
  const samples = [];
  for (let run = 0; run < runs; run++) samples.push(await workflow());
  const median = (values) => { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
  const report = { recorded_at: new Date().toISOString(), node: process.version, cpu: cpus()[0].model,
    scope: 'Local WebSocket gateway tool-loop overhead with deterministic engine/tokenizer fixtures. Excludes real inference and real tool execution. Not a GPU or hosted API benchmark.',
    implementation: root, profile: values.profile, runs, warmups: 3, turns, tool_result_bytes: resultBytes,
    median_workflow_ms: median(samples.map((sample) => sample.duration_ms)),
    median_first_delta_ms: median(samples.flatMap((sample) => sample.first_delta_ms)),
    median_last_turn_ms: median(samples.map((sample) => sample.turn_ms.at(-1))), samples };
  if (values.report) await writeFile(values.report, JSON.stringify(report, null, 2) + '\n');
  const { samples: _, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
} finally {
  server.closeAllConnections(); await new Promise((resolveClose) => server.close(resolveClose));
}
