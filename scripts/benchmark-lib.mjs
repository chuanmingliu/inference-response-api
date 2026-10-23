/** Small, dependency-free helpers shared by the benchmark runner and its tests. */
export function createSseParser(consume) {
  let buffer = '';
  function dispatch(block) {
    let event = 'message';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '');
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) consume({ event, data: data.join('\n') });
  }
  return {
    push(text) {
      buffer += text;
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        dispatch(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
      }
      if (buffer.length > 4 * 1024 * 1024) throw new Error('SSE event exceeds 4 MiB.');
    },
    finish() {
      if (buffer.trim()) dispatch(buffer);
      buffer = '';
    },
  };
}

/** Nearest-rank percentile, deliberately explicit for these small sample sizes. */
export function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1))];
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function stats(values) {
  const numbers = values.filter(Number.isFinite);
  return {
    n: numbers.length,
    min: numbers.length ? Math.min(...numbers) : null,
    median: median(numbers),
    p95: percentile(numbers, 0.95),
    max: numbers.length ? Math.max(...numbers) : null,
  };
}

export function requestMetrics(sample) {
  const tokens = sample.output_tokens;
  const duration = sample.duration_ms;
  const decodeWindow = sample.last_content_ms - sample.first_content_ms;
  return {
    ttft_ms: sample.first_content_ms,
    latency_ms: duration,
    wall_tokens_per_second: Number.isFinite(tokens) && duration > 0 ? tokens / (duration / 1000) : null,
    // SSE chunks need not be one token; this is not an instrumented engine decode rate.
    approximate_decode_tokens_per_second: Number.isFinite(tokens) && tokens > 1
      && sample.first_content_ms !== null && decodeWindow > 0 ? (tokens - 1) / (decodeWindow / 1000) : null,
  };
}

export function summarize(raw) {
  const rows = [];
  for (const scenario of raw.scenarios) {
    for (const service of raw.services) {
      const batches = raw.batches.filter((b) => b.scenario === scenario.id && b.service === service.id && b.phase === 'measured');
      const samples = batches.flatMap((b) => b.samples);
      const good = samples.filter((s) => s.success);
      const successfulBatches = batches.filter((b) => b.samples.length === scenario.concurrency && b.samples.every((s) => s.success));
      rows.push({
        scenario: scenario.id,
        service: service.id,
        label: service.label,
        endpoint: scenario.endpoint,
        concurrency: scenario.concurrency,
        n: samples.length,
        succeeded: good.length,
        errors: samples.length - good.length,
        batches: batches.length,
        successful_batches: successfulBatches.length,
        output_tokens: stats(good.map((s) => s.output_tokens)),
        prompt_tokens: stats(good.map((s) => s.input_tokens)),
        cached_tokens: stats(good.map((s) => s.cached_tokens)),
        ttft_ms: stats(good.map((s) => s.metrics.ttft_ms)),
        latency_ms: stats(good.map((s) => s.metrics.latency_ms)),
        wall_tokens_per_second: stats(good.map((s) => s.metrics.wall_tokens_per_second)),
        approximate_decode_tokens_per_second: stats(good.map((s) => s.metrics.approximate_decode_tokens_per_second)),
        batch_latency_ms: stats(successfulBatches.map((b) => b.duration_ms)),
        batch_goodput_tokens_per_second: stats(successfulBatches.map((b) => b.goodput_tokens_per_second)),
        aggregate_goodput_tokens_per_second: batches.length
          ? batches.reduce((n, b) => n + b.samples.filter((s) => s.success).reduce((v, s) => v + s.output_tokens, 0), 0)
            / (batches.reduce((n, b) => n + b.duration_ms, 0) / 1000)
          : null,
        finished: Object.fromEntries([...new Set(samples.map((s) => s.finish_reason ?? 'missing'))]
          .map((reason) => [reason, samples.filter((s) => (s.finish_reason ?? 'missing') === reason).length])),
        errors_detail: samples.filter((s) => !s.success).map((s) => ({ id: s.id, errors: s.errors })),
        notes: scenario.notes,
      });
    }
  }
  return {
    schema_version: 1,
    started_at: raw.started_at,
    finished_at: raw.finished_at ?? null,
    status: raw.status,
    wall_runtime_ms: raw.wall_runtime_ms,
    settings: raw.settings,
    methodology: raw.methodology,
    rows,
  };
}

export function summaryCsv(summary) {
  const columns = [
    'scenario', 'service', 'concurrency', 'n', 'succeeded', 'errors',
    'output_tokens.min', 'output_tokens.median', 'output_tokens.max',
    'prompt_tokens.median', 'cached_tokens.median',
    'ttft_ms.median', 'ttft_ms.p95', 'latency_ms.median', 'latency_ms.p95',
    'wall_tokens_per_second.median', 'wall_tokens_per_second.p95',
    'approximate_decode_tokens_per_second.median', 'approximate_decode_tokens_per_second.p95',
    'batch_goodput_tokens_per_second.median', 'aggregate_goodput_tokens_per_second',
  ];
  const escape = (value) => value == null ? '' : `"${String(value).replaceAll('"', '""')}"`;
  return [columns.join(','), ...summary.rows.map((row) => columns.map((key) =>
    escape(key.split('.').reduce((value, part) => value?.[part], row))).join(','))].join('\n') + '\n';
}
