import { normalizeRequest, ResponseError } from './validation.mjs';
import { ResponseAssembler } from './events.mjs';

/** Hardware-independent, transient lifecycle; this class never journals content. */
export class ResponsesService {
  constructor({ model, profile, engine, maxConcurrent = 4, maxConcurrentPerTenant = 2, maxInputBytes = 1024 * 1024, maxOutputBytes = 4 * 1024 * 1024, logger = () => {} }) {
    for (const [name, value] of Object.entries({ maxConcurrent, maxConcurrentPerTenant, maxInputBytes, maxOutputBytes })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`);
    }
    this.model = model;
    this.profile = profile;
    this.engine = engine;
    this.maxConcurrent = maxConcurrent;
    this.maxConcurrentPerTenant = maxConcurrentPerTenant;
    this.maxInputBytes = maxInputBytes;
    this.maxOutputBytes = maxOutputBytes;
    this.logger = logger;
    this.active = 0;
    this.tenants = new Map();
  }

  prepare(payload, { transport = 'http', history = [] } = {}) {
    const request = normalizeRequest(payload, { model: this.model, profile: this.profile, transport, history });
    request.max_output_tokens ??= this.profile.default_max_output_tokens ?? 1024;
    if (request.max_output_tokens > this.profile.context_length) throw new ResponseError(400, 'max_output_tokens exceeds the model context window.', 'context_length_exceeded', 'max_output_tokens');
    const bytes = Buffer.byteLength(JSON.stringify([history, request]));
    if (bytes > this.maxInputBytes) throw new ResponseError(413, 'The complete request and continuation history exceed the service input byte limit.', 'request_too_large', 'input');
    return request;
  }

  acquire(tenant) {
    const current = this.tenants.get(tenant) ?? 0;
    if (this.active >= this.maxConcurrent || current >= this.maxConcurrentPerTenant) {
      const error = new ResponseError(429, 'The service is at its active generation limit. Retry after an active response finishes.', 'rate_limit_exceeded');
      error.retryAfter = 1;
      throw error;
    }
    this.active++;
    this.tenants.set(tenant, current + 1);
    return () => {
      this.active--;
      const remaining = this.tenants.get(tenant) - 1;
      if (remaining) this.tenants.set(tenant, remaining); else this.tenants.delete(tenant);
    };
  }

  async run(request, { history = [], signal, onEvent, requestId, tenant = 'local' } = {}) {
    const release = this.acquire(tenant);
    const started = performance.now();
    let firstToken = null;
    let assembler;
    try {
      signal?.throwIfAborted();
      if (this.profile.admission?.count_input_tokens) {
        if (!this.engine.countInputTokens) throw new ResponseError(503, 'This runtime requires exact token admission, but no tokenizer adapter is configured.', 'tokenizer_unavailable');
        const count = await this.engine.countInputTokens(request, { history, signal, requestId });
        if (count.context_length !== undefined && (!Number.isSafeInteger(count.context_length) || count.context_length < 1)) throw new ResponseError(502, 'The engine returned an invalid context length.', 'invalid_upstream_response');
        const context = Math.min(this.profile.context_length, count.context_length ?? this.profile.context_length);
        if (!Number.isSafeInteger(count.input_tokens) || count.input_tokens < 0) throw new ResponseError(502, 'The engine returned an invalid input token count.', 'invalid_upstream_response');
        if (count.input_tokens + request.max_output_tokens > context) throw new ResponseError(400, `Input plus reserved output exceeds the ${context}-token model context.`, 'context_length_exceeded', 'input');
      }
      assembler = new ResponseAssembler(request, { onEvent, maxOutputBytes: this.maxOutputBytes });
      await assembler.start();
      try {
        for await (const event of this.engine.generate(request, { history, signal, requestId })) {
          signal?.throwIfAborted();
          if (firstToken === null && ['text_delta', 'tool_delta', 'refusal_delta'].includes(event.type)) firstToken = performance.now() - started;
          await assembler.consume(event);
        }
        signal?.throwIfAborted();
        await assembler.finish();
      } catch (error) {
        // No generation retry: a new attempt must never append a divergent answer.
        if (signal?.aborted && !['upstream_timeout', 'request_timeout'].includes(signal.reason?.code)) throw signal.reason ?? error;
        await assembler.fail(signal?.aborted ? signal.reason : error);
      }
      const response = assembler.snapshot();
      return { response, history: structuredClone([...history, ...request.input, ...response.output]) };
    } finally {
      release();
      // Operational data only. Never log input, output, arguments, or credentials.
      try { this.logger({ event: 'response_finished', request_id: requestId, response_id: assembler?.response.id,
        runtime_profile: this.profile.id, status: assembler?.response.status ?? 'rejected',
        duration_ms: Math.round(performance.now() - started), ttft_ms: firstToken === null ? null : Math.round(firstToken),
        usage: assembler?.response.usage ?? null }); } catch { /* Telemetry cannot change a committed outcome. */ }
    }
  }
}
