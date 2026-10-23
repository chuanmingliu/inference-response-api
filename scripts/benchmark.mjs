#!/usr/bin/env node
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createSseParser, requestMetrics, summarize, summaryCsv } from './benchmark-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function integer(name, fallback, minimum = 0) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}.`);
  return value;
}
const settings = {
  repeats: integer('BENCH_REPEATS', 10, 1),
  warmups: integer('BENCH_WARMUPS', 2),
  batch_repeats: integer('BENCH_BATCH_REPEATS', 5, 1),
  batch_warmups: integer('BENCH_BATCH_WARMUPS', 1),
  timeout_ms: integer('BENCH_TIMEOUT_MS', 180000, 1000),
  temperature: 0,
  thinking: false,
  context_rows: integer('BENCH_CONTEXT_ROWS', 120, 1),
};
const allScenarios = [
  { id: 'chat_short', endpoint: 'chat', max_tokens: 64, concurrency: 1, prompt: 'In one sentence, explain why the sky looks blue.', notes: 'Natural completion, maximum 64 output tokens; output lengths may differ.' },
  { id: 'chat_decode_128', endpoint: 'chat', max_tokens: 128, fixed_tokens: 128, concurrency: 1, prompt: 'Write a numbered list of 50 detailed practical tips for tending a small vegetable garden. Explain each tip in complete sentences, including examples.', notes: 'Exactly 128 output tokens requested using max_tokens and ignore_eos; mismatches are errors. min_tokens is unsupported by native Metal.' },
  { id: 'chat_decode_512', endpoint: 'chat', max_tokens: 512, fixed_tokens: 512, concurrency: 1, prompt: 'Write a numbered list of 50 detailed practical tips for tending a small vegetable garden. Explain each tip in complete sentences, including examples.', notes: 'Exactly 512 output tokens requested using max_tokens and ignore_eos; mismatches are errors. min_tokens is unsupported by native Metal.' },
  { id: 'chat_context_2k', endpoint: 'chat', max_tokens: 128, fixed_tokens: 128, concurrency: 1, context: true, notes: 'Approximately 2,000 input tokens; unique early prefix per pair limits prefix reuse. Consult server-reported prompt counts for actual size.' },
  { id: 'chat_context_2k_cached', endpoint: 'chat', max_tokens: 128, fixed_tokens: 128, concurrency: 1, context: true, cached: true, notes: 'Identical approximately 2,000-token input for warmups and measurements; deliberately measures repeated-prompt cache behavior. Cache availability is deployment-dependent.' },
  { id: 'responses_short', endpoint: 'responses', max_tokens: 64, concurrency: 1, prompt: 'In one sentence, explain why the sky looks blue.', notes: 'Natural Responses completion, maximum 64 output tokens; Docker adapter versus native Responses protocol.' },
  { id: 'responses_long', endpoint: 'responses', max_tokens: 256, concurrency: 1, prompt: 'Write a detailed practical guide to tending a small vegetable garden through spring, summer, autumn, and winter. Include an introduction and specific advice for each season.', notes: 'Natural Responses completion, maximum 256 output tokens; lengths can differ, so wall latency alone does not isolate decode performance.' },
  { id: 'chat_concurrency4', endpoint: 'chat', max_tokens: 128, fixed_tokens: 128, concurrency: 4, prompt: 'Write a numbered list of 50 detailed practical tips for tending a small vegetable garden. Explain each tip in complete sentences, including examples.', notes: 'Four simultaneous client requests to one service; exactly 128 output tokens each. Deployed engines permit one active sequence, so this measures queue behavior as well as throughput.' },
  { id: 'responses_concurrency4', endpoint: 'responses', max_tokens: 128, concurrency: 4, prompt: 'Write a detailed description of a walk through a quiet forest. Continue describing sights, sounds, and scents.', notes: 'Four simultaneous Responses requests to one service, maximum 128 tokens each; natural output length. One active engine sequence means requests can queue.' },
];
const selected = process.env.BENCH_CASES?.split(',').filter(Boolean);
if (selected?.some((id) => !allScenarios.some((s) => s.id === id))) throw new Error('BENCH_CASES contains an unknown scenario.');
const scenarios = selected ? allScenarios.filter((s) => selected.includes(s.id)) : allScenarios;
const startedAt = new Date();
const started = performance.now();
const runId = randomUUID().slice(0, 8);
const outputDir = resolve(process.env.BENCH_OUT_DIR ?? resolve(ROOT, 'docs/benchmarks', startedAt.toISOString().replaceAll(':', '-')));
const services = [
  { id: 'docker', label: 'Docker Model Runner + Responses adapter', base_url: (process.env.BENCH_DOCKER_URL ?? 'http://127.0.0.1:8088').replace(/\/+$/, '') },
  { id: 'native', label: 'Native vLLM Metal + native Responses', base_url: (process.env.BENCH_NATIVE_URL ?? 'http://127.0.0.1:8089').replace(/\/+$/, '') },
];
const raw = {
  schema_version: 1,
  run_id: runId,
  started_at: startedAt.toISOString(),
  status: 'starting',
  command: [process.execPath, ...process.argv.slice(1)],
  environment: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('BENCH_'))),
  node_version: process.version,
  settings,
  services,
  scenarios,
  methodology: {
    ordering: 'Alternate Docker/native order every round. Never overlap services. Client concurrency is within one service only.',
    warmups: 'Warmups are retained as raw evidence and excluded from measured summaries.',
    prefix_cache: 'Every uncached request pair has a unique run/round/member tag at the beginning of the first user message. Identical paired prompts are sent to both services. Cached scenario deliberately repeats its exact prompt.',
    ttft: 'Client elapsed time from fetch start to first nonempty content/output_text delta; excludes role, created, and in_progress events.',
    latency: 'Client elapsed time until the HTTP stream ends, including terminal events and usage.',
    approximate_decode_rate: '(server output_tokens - 1) / seconds between first and last nonempty text delta; approximate because SSE chunks can contain multiple tokens and ignore_eos may generate invisible special tokens. Full request wall rate is the primary throughput metric.',
    wall_rate: 'Server output_tokens / full request wall seconds.',
    concurrency_goodput: 'Sum of successful server output token counts / complete batch wall seconds. Never sum per-request rates. Aggregate includes failed batch wall time.',
    percentiles: 'p95 uses nearest rank; median is the central value or mean of the central pair. With 10 serial samples, p95 is the observed maximum.',
    scope: 'Comparison of the two deployed configurations, including different vLLM/Metal versions, gateway/network paths, adapters, and caches; not a controlled isolation of Docker overhead.',
    validation: 'Require HTTP success, text output, terminal event, supported finish/status and server usage. Fixed-output cases additionally require exact output token count. Invalid samples are retained and excluded from latency/rate statistics.',
  },
  batches: [],
};
let interrupted = false;
const activeControllers = new Set();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  raw.interrupted_by = signal;
  for (const controller of activeControllers) controller.abort(new Error(`Benchmark interrupted by ${signal}.`));
});

async function save() {
  raw.wall_runtime_ms = performance.now() - started;
  const summary = summarize(raw);
  await mkdir(outputDir, { recursive: true });
  for (const [name, content] of [
    ['raw.json', JSON.stringify(raw, null, 2) + '\n'],
    ['summary.json', JSON.stringify(summary, null, 2) + '\n'],
    ['summary.csv', summaryCsv(summary)],
  ]) {
    await writeFile(resolve(outputDir, `${name}.tmp`), content);
    await rename(resolve(outputDir, `${name}.tmp`), resolve(outputDir, name));
  }
}

async function fetchMetadata(service) {
  for (const path of ['/api/config', '/readyz']) {
    const response = await fetch(`${service.base_url}${path}`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    service[path === '/api/config' ? 'config' : 'readiness'] = { status: response.status, checked_at: new Date().toISOString(), body };
    if (!response.ok) throw new Error(`${service.id} ${path} returned HTTP ${response.status}: ${text}`);
  }
  if (!service.config.body.model || !service.config.body.context_length) throw new Error(`${service.id} configuration lacks model/context metadata.`);
}

function promptFor(scenario, phase, round, member) {
  const tag = scenario.cached ? `${runId}:cached:${scenario.id}` : `${runId}:${scenario.id}:${phase}:${round}:${member}`;
  let body = scenario.prompt;
  if (scenario.context) {
    const lines = Array.from({ length: settings.context_rows }, (_, index) => `Entry ${String(index + 1).padStart(3, '0')}: amber river stones rest beside the quiet garden path.`);
    body = `Read these inventory notes:\n${lines.join('\n')}\n\nWrite a detailed paragraph describing the recurring scene in these notes. Mention the river, stones, and garden, then expand with sensory details.`;
  }
  return `Request tag ${tag}. Ignore the tag when answering.\n${body}`;
}

function payloadFor(service, scenario, prompt) {
  const base = { model: service.config.body.model, temperature: 0, stream: true };
  if (scenario.endpoint === 'responses') return { ...base, input: prompt, max_output_tokens: scenario.max_tokens, store: false };
  return {
    ...base,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: scenario.max_tokens,
    ...(scenario.fixed_tokens ? { ignore_eos: true } : {}),
    chat_template_kwargs: { enable_thinking: false },
    stream_options: { include_usage: true },
  };
}

async function runRequest(service, scenario, phase, round, member, prompt) {
  const payload = payloadFor(service, scenario, prompt);
  const endpoint = scenario.endpoint === 'chat' ? '/v1/chat/completions' : '/v1/responses';
  const sample = {
    id: `${scenario.id}:${phase}:${round}:${member}:${service.id}`,
    started_at: new Date().toISOString(),
    request: { url: service.base_url + endpoint, payload },
    http_status: null, output_text: '', reasoning_text: '', usage: null,
    input_tokens: null, output_tokens: null, cached_tokens: null,
    first_content_ms: null, last_content_ms: null, terminal_event: null,
    finish_reason: null, response_status: null, events: [], raw_sse: '', errors: [],
  };
  const begin = performance.now();
  const controller = new AbortController();
  activeControllers.add(controller);
  const timeout = setTimeout(() => controller.abort(new Error(`Request exceeded ${settings.timeout_ms} ms.`)), settings.timeout_ms);
  try {
    const response = await fetch(sample.request.url, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(payload), signal: controller.signal, redirect: 'error',
    });
    sample.http_status = response.status;
    sample.headers_ms = performance.now() - begin;
    sample.response_headers = Object.fromEntries(response.headers.entries());
    if (!response.ok) {
      sample.error_body = await response.text();
      throw new Error(`HTTP ${response.status}: ${sample.error_body}`);
    }
    if (!/text\/event-stream/i.test(response.headers.get('content-type') ?? '')) throw new Error('Expected an SSE response.');
    const parser = createSseParser(({ event, data }) => {
      const at = performance.now() - begin;
      if (data === '[DONE]') {
        sample.events.push({ at_ms: at, event, data });
        sample.terminal_event = '[DONE]';
        return;
      }
      let json;
      try { json = JSON.parse(data); } catch { throw new Error(`Invalid SSE JSON: ${data.slice(0, 300)}`); }
      sample.events.push({ at_ms: at, event, json });
      if (json.error) sample.errors.push(json.error.message ?? JSON.stringify(json.error));
      const type = json.type ?? event;
      let delta;
      if (scenario.endpoint === 'chat') {
        const choice = json.choices?.[0];
        delta = choice?.delta?.content;
        const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
        if (typeof reasoning === 'string') sample.reasoning_text += reasoning;
        if (choice?.finish_reason) sample.finish_reason = choice.finish_reason;
        if (json.usage) sample.usage = json.usage;
      } else {
        if (type === 'response.output_text.delta') delta = json.delta;
        if (type.includes('reasoning') && typeof json.delta === 'string') sample.reasoning_text += json.delta;
        if (['response.completed', 'response.incomplete', 'response.failed'].includes(type)) {
          sample.terminal_event = type;
          sample.response_status = json.response?.status ?? type.slice('response.'.length);
          sample.finish_reason = sample.response_status === 'incomplete'
            ? json.response?.incomplete_details?.reason ?? 'incomplete' : sample.response_status;
          if (json.response?.usage) sample.usage = json.response.usage;
          if (json.response?.error) sample.errors.push(json.response.error.message ?? JSON.stringify(json.response.error));
        }
      }
      if (typeof delta === 'string' && delta.length) {
        sample.first_content_ms ??= at;
        sample.last_content_ms = at;
        sample.output_text += delta;
      }
    });
    const decoder = new TextDecoder();
    if (!response.body) throw new Error('No response body.');
    for await (const chunk of response.body) {
      const text = decoder.decode(chunk, { stream: true });
      sample.raw_sse += text;
      parser.push(text);
    }
    const tail = decoder.decode();
    sample.raw_sse += tail;
    parser.push(tail);
    parser.finish();
  } catch (error) {
    sample.errors.push(error.message);
  } finally {
    clearTimeout(timeout);
    activeControllers.delete(controller);
    sample.duration_ms = performance.now() - begin;
  }
  if (sample.usage) {
    sample.output_tokens = sample.usage.completion_tokens ?? sample.usage.output_tokens ?? null;
    sample.input_tokens = sample.usage.prompt_tokens ?? sample.usage.input_tokens ?? null;
    sample.cached_tokens = sample.usage.prompt_tokens_details?.cached_tokens ?? sample.usage.input_tokens_details?.cached_tokens ?? null;
  }
  if (!sample.output_text.length) sample.errors.push('No nonempty output text delta received.');
  if (!sample.terminal_event) sample.errors.push('No terminal stream event received.');
  if (scenario.endpoint === 'chat' && !['stop', 'length', 'eos_token'].includes(sample.finish_reason)) sample.errors.push(`Missing/unsupported finish reason: ${sample.finish_reason}`);
  if (scenario.endpoint === 'responses' && !['completed', 'incomplete'].includes(sample.response_status)) sample.errors.push(`Missing/unsuccessful Responses status: ${sample.response_status}`);
  if (scenario.endpoint === 'responses' && sample.response_status === 'incomplete' && sample.finish_reason !== 'max_output_tokens') sample.errors.push(`Unexpected incomplete Responses reason: ${sample.finish_reason}`);
  if (!Number.isInteger(sample.output_tokens) || sample.output_tokens < 1) sample.errors.push('Missing/invalid server output token usage.');
  if (!Number.isInteger(sample.input_tokens) || sample.input_tokens < 1) sample.errors.push('Missing/invalid server input token usage.');
  if (scenario.fixed_tokens && sample.output_tokens !== scenario.fixed_tokens) sample.errors.push(`Fixed-output mismatch: expected ${scenario.fixed_tokens}, received ${sample.output_tokens}.`);
  sample.success = sample.errors.length === 0;
  sample.metrics = requestMetrics(sample);
  return sample;
}

async function runBatch(service, scenario, phase, round, prompts) {
  const begin = performance.now();
  const samples = await Promise.all(prompts.map((prompt, member) => runRequest(service, scenario, phase, round, member, prompt)));
  const duration = performance.now() - begin;
  const batch = {
    scenario: scenario.id, service: service.id, phase, round,
    started_at: samples[0].started_at, concurrency: scenario.concurrency,
    duration_ms: duration,
    goodput_tokens_per_second: samples.filter((s) => s.success).reduce((n, s) => n + s.output_tokens, 0) / (duration / 1000),
    samples,
  };
  raw.batches.push(batch);
  await save();
  console.log(JSON.stringify({ event: 'batch', scenario: scenario.id, service: service.id, phase, round,
    succeeded: samples.filter((s) => s.success).length, requests: samples.length,
    duration_ms: Math.round(duration), output_tokens: samples.map((s) => s.output_tokens),
    errors: samples.flatMap((s) => s.errors) }));
}

try {
  await save();
  console.log(JSON.stringify({ event: 'start', output_dir: outputDir, settings, scenarios: scenarios.map((s) => s.id) }));
  for (const service of services) await fetchMetadata(service);
  const normalize = (model) => model.toLowerCase().replace(/^(?:https?:\/\/)?(?:hf\.co|huggingface\.co)\//, '').replace(/:latest$/, '');
  if (normalize(services[0].config.body.model) !== normalize(services[1].config.body.model)) throw new Error('Services report different model identities.');
  if (services[0].config.body.context_length !== services[1].config.body.context_length) throw new Error('Services report different context limits.');
  raw.status = 'running';
  await save();
  outer: for (const [scenarioIndex, scenario] of scenarios.entries()) {
    const warmups = scenario.concurrency > 1 ? settings.batch_warmups : settings.warmups;
    const repeats = scenario.concurrency > 1 ? settings.batch_repeats : settings.repeats;
    for (const [phase, count] of [['warmup', warmups], ['measured', repeats]]) {
      for (let round = 0; round < count; round++) {
        const prompts = Array.from({ length: scenario.concurrency }, (_, member) => promptFor(scenario, phase, round, member));
        const order = (round + scenarioIndex) % 2 === 0 ? services : [...services].reverse();
        for (const service of order) {
          if (interrupted) break outer;
          await runBatch(service, scenario, phase, round, prompts);
        }
      }
    }
  }
  raw.status = interrupted ? 'interrupted' : raw.batches.some((b) => b.samples.some((s) => !s.success)) ? 'completed_with_errors' : 'completed';
} catch (error) {
  raw.status = 'failed';
  raw.fatal_error = error.stack ?? error.message;
  console.error(raw.fatal_error);
} finally {
  raw.finished_at = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ event: 'finished', status: raw.status, wall_runtime_ms: raw.wall_runtime_ms, output_dir: outputDir }));
  if (raw.status !== 'completed') process.exitCode = interrupted ? 130 : 1;
}
