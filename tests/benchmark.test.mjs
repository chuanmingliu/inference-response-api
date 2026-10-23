import test from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser, median, percentile, requestMetrics, summarize } from '../scripts/benchmark-lib.mjs';

test('SSE parser handles CRLF split across chunks, comments, multi-line data and terminal tail', () => {
  const events = [];
  const parser = createSseParser((event) => events.push(event));
  parser.push(': heartbeat\r\nevent: delta\r');
  parser.push('\ndata: first\r\ndata: second\r\n\r');
  parser.push('\ndata: [DONE]');
  parser.finish();
  assert.deepEqual(events, [
    { event: 'delta', data: 'first\nsecond' },
    { event: 'message', data: '[DONE]' },
  ]);
});

test('small-sample percentile uses nearest rank and median averages the middle pair', () => {
  assert.equal(percentile([7, 1, 5, 3, 9, 2, 4, 6, 8, 10], 0.95), 10);
  assert.equal(median([7, 1, 5, 3]), 4);
  assert.equal(median([null, NaN, Infinity]), null);
});

test('decode approximation and wall rate use distinct time windows', () => {
  assert.deepEqual(requestMetrics({ output_tokens: 101, duration_ms: 3000, first_content_ms: 500, last_content_ms: 2500 }), {
    ttft_ms: 500, latency_ms: 3000, wall_tokens_per_second: 101 / 3,
    approximate_decode_tokens_per_second: 50,
  });
  assert.equal(requestMetrics({ output_tokens: 1, duration_ms: 10, first_content_ms: 5, last_content_ms: 5 }).approximate_decode_tokens_per_second, null);
});

test('summary excludes warmups and failed samples; batch goodput uses elapsed batch time', () => {
  const sample = (success, tokens) => ({ success, output_tokens: tokens, input_tokens: 20, cached_tokens: 0, finish_reason: 'length', errors: [], metrics: { ttft_ms: 100, latency_ms: 2000, wall_tokens_per_second: 50, approximate_decode_tokens_per_second: 60 } });
  const raw = { scenarios: [{ id: 'test', concurrency: 2 }], services: [{ id: 'a' }], batches: [
    { scenario: 'test', service: 'a', phase: 'warmup', duration_ms: 100, samples: [sample(true, 999)] },
    { scenario: 'test', service: 'a', phase: 'measured', duration_ms: 2000, goodput_tokens_per_second: 100, samples: [sample(true, 100), sample(true, 100)] },
    { scenario: 'test', service: 'a', phase: 'measured', duration_ms: 2000, goodput_tokens_per_second: 50, samples: [sample(true, 100), sample(false, 10)] },
  ] };
  const row = summarize(raw).rows[0];
  assert.equal(row.n, 4);
  assert.equal(row.succeeded, 3);
  assert.equal(row.errors, 1);
  assert.equal(row.output_tokens.max, 100);
  assert.equal(row.aggregate_goodput_tokens_per_second, 75);
  assert.equal(row.batch_goodput_tokens_per_second.median, 100);
});
