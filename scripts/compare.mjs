import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const services = [{ name: 'Docker Model Runner', url: 'http://127.0.0.1:8088' }, { name: 'Native vLLM Metal', url: 'http://127.0.0.1:8089' }];
const results = services.map(service => ({ ...service, samples: [] }));
const prompt = 'Explain how a rain cloud forms in about 80 words. Use plain language. /no_think';
for (const result of results) result.config = await fetch(`${result.url}/api/config`).then(r => r.json());
for (let round = -1; round < 3; round++) {
  for (const result of results) {
    const start = performance.now();
    const response = await fetch(`${result.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: result.config.model, messages: [{ role: 'user', content: prompt }], max_tokens: 128, temperature: 0, chat_template_kwargs: { enable_thinking: false }, stream: true, stream_options: { include_usage: true } }),
      signal: AbortSignal.timeout(120000),
    });
    assert(response.ok, `${result.name}: HTTP ${response.status}: ${!response.ok ? await response.text() : ''}`);
    let firstTokenMs, usage, text = '', buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          const data = JSON.parse(line.slice(6));
          assert(!data.error, JSON.stringify(data.error));
          const delta = data.choices?.[0]?.delta?.content;
          if (delta) { firstTokenMs ??= performance.now() - start; text += delta; }
          if (data.usage) usage = data.usage;
        }
      }
    }
    const elapsedMs = performance.now() - start;
    assert(text.trim() && usage?.completion_tokens, `${result.name}: missing output/usage`);
    const sample = { round, elapsed_ms: Math.round(elapsedMs), first_token_ms: Math.round(firstTokenMs), output_tokens: usage.completion_tokens, tokens_per_second_wall_clock: +(usage.completion_tokens / elapsedMs * 1000).toFixed(1), text };
    if (round >= 0) result.samples.push(sample);
    console.log(JSON.stringify({ service: result.name, warmup: round < 0, ...sample }));
  }
}
for (const result of results) {
  const average = key => +(result.samples.reduce((sum, x) => sum + x[key], 0) / result.samples.length).toFixed(1);
  result.average = { elapsed_ms: average('elapsed_ms'), first_token_ms: average('first_token_ms'), tokens_per_second_wall_clock: average('tokens_per_second_wall_clock') };
}
const snapshot = { checked_at: new Date().toISOString(), note: 'Three sequential warm-cache samples per service after one warm-up. Same model and chat settings; runtime versions differ. Local smoke comparison, not an isolated engine benchmark. Throughput uses full request wall time.', prompt, results };
await writeFile(new URL('../docs/comparison.json', import.meta.url), JSON.stringify(snapshot, null, 2) + '\n');
console.log(JSON.stringify(results.map(({ name, average }) => ({ name, ...average })), null, 2));
