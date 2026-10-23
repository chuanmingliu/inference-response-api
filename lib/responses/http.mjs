import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { ResponseError } from './validation.mjs';

export function errorEnvelope(error) {
  return { error: { message: error.message, type: error.type ?? (error.status >= 500 ? 'server_error' : 'invalid_request_error'), param: error.param ?? null, code: error.code ?? 'server_error' } };
}

/** API keys map to explicit tenants. Client credentials never reach an engine. */
export function createAuthenticator({ apiKeys, apiKey } = {}) {
  if (typeof apiKeys === 'string') {
    try { apiKeys = JSON.parse(apiKeys); } catch { throw new Error('API_KEYS must be a JSON object mapping API keys to tenant IDs.'); }
  }
  if (apiKeys !== undefined && (!apiKeys || Array.isArray(apiKeys) || typeof apiKeys !== 'object' || !Object.keys(apiKeys).length)) throw new Error('API_KEYS must be a nonempty JSON object mapping API keys to tenant IDs.');
  if (apiKey !== undefined && typeof apiKey !== 'string') throw new Error('API_KEY must be a string.');
  const entries = Object.entries(apiKeys ?? (apiKey ? { [apiKey]: 'default' } : {}));
  if (entries.some(([key, tenant]) => !key || typeof tenant !== 'string' || !tenant)) throw new Error('API_KEYS entries need nonempty keys and tenant IDs.');
  const hashes = entries.map(([key, tenant]) => [createHash('sha256').update(key).digest(), tenant]);
  const authenticate = (req) => {
    if (!hashes.length) return 'local';
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
    const hash = createHash('sha256').update(match?.[1] ?? '').digest();
    let tenant = null;
    for (const [expected, candidate] of hashes) if (timingSafeEqual(hash, expected)) tenant = candidate;
    if (!match || !tenant) throw new ResponseError(401, 'A valid Bearer API key is required.', 'invalid_api_key');
    return tenant;
  };
  authenticate.mode = hashes.length ? 'bearer' : 'local-development';
  return authenticate;
}

export function sendResponseError(res, error) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  const status = error.status ?? (error.name === 'TimeoutError' ? 504 : 500);
  if (status === 429) res.setHeader('retry-after', String(error.retryAfter ?? 1));
  if (status === 401) res.setHeader('www-authenticate', 'Bearer');
  const payload = JSON.stringify(errorEnvelope({ ...error, status, message: error.message ?? 'Internal server error.' }));
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(payload);
}

async function readJson(req, limit, signal) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new ResponseError(415, 'Use Content-Type: application/json.', 'unsupported_media_type');
  const declared = req.headers['content-length'];
  if (declared && Number(declared) > limit) { req.resume(); throw new ResponseError(413, 'Request body is too large.', 'request_too_large'); }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', disconnected);
      signal.removeEventListener('abort', aborted);
    };
    const fail = (error) => { cleanup(); req.resume(); reject(error); };
    const data = (chunk) => {
      size += chunk.length;
      if (size > limit) fail(new ResponseError(413, 'Request body is too large.', 'request_too_large'));
      else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ResponseError(400, 'Request body must be valid JSON.', 'invalid_json')); }
    };
    const aborted = () => fail(signal.reason);
    const disconnected = () => fail(new ResponseError(499, 'Client disconnected.', 'client_disconnected'));
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', disconnected);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

function writeEvent(res, event, { signal, timeoutMs = 10000 } = {}) {
  signal?.throwIfAborted();
  if (res.destroyed || res.writableEnded) throw new ResponseError(499, 'Client disconnected.', 'client_disconnected');
  const data = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  if (res.write(data)) return;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new ResponseError(408, 'The streaming reader is too slow.', 'slow_consumer')), timeoutMs);
    timer.unref();
    const cleanup = () => { clearTimeout(timer); res.off('drain', drained); res.off('close', closed); res.off('error', fail); signal?.removeEventListener('abort', aborted); };
    const drained = () => { cleanup(); resolve(); };
    const fail = (error) => { cleanup(); reject(error); };
    const closed = () => fail(new ResponseError(499, 'Client disconnected.', 'client_disconnected'));
    const aborted = () => fail(signal.reason);
    res.once('drain', drained); res.once('close', closed); res.once('error', fail);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

export async function handleResponses(req, res, { service, authenticate, bodyLimit = 1024 * 1024, requestTimeoutMs = 180000, slowConsumerTimeoutMs = 10000 }) {
  const requestId = res.getHeader('x-request-id') ?? `req_${randomUUID().replaceAll('-', '')}`;
  res.setHeader('x-request-id', requestId);
  res.setHeader('x-responses-mode', 'service');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ResponseError(504, 'Generation timed out.', 'upstream_timeout')), requestTimeoutMs);
  timer.unref();
  const disconnected = () => { if (!res.writableEnded) controller.abort(new ResponseError(499, 'Client disconnected.', 'client_disconnected')); };
  req.once('aborted', disconnected); res.once('close', disconnected);
  try {
    const tenant = authenticate(req);
    const url = new URL(req.url, 'http://localhost');
    if (url.search) throw new ResponseError(400, 'Query parameters are not supported for response creation.', 'unsupported_parameter');
    const payload = await readJson(req, bodyLimit, controller.signal);
    const request = service.prepare(payload);
    const result = await service.run(request, { signal: controller.signal, requestId, tenant,
      onEvent: request.stream ? async (event) => {
        if (!res.headersSent) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
          res.flushHeaders();
        }
        const writeSignal = ['upstream_timeout', 'request_timeout'].includes(controller.signal.reason?.code) ? undefined : controller.signal;
        try { await writeEvent(res, event, { signal: writeSignal, timeoutMs: slowConsumerTimeoutMs }); }
        catch (error) { controller.abort(error); throw error; }
      } : undefined,
    });
    if (request.stream) res.end();
    else {
      const body = JSON.stringify(result.response);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    }
  } catch (error) {
    if (controller.signal.aborted && res.headersSent && !res.destroyed && !res.writableEnded && error.status !== 499) {
      // No new engine work after a timeout. An interrupted transport is not success.
      res.destroy();
    } else sendResponseError(res, error);
  } finally {
    clearTimeout(timer);
    req.off('aborted', disconnected); res.off('close', disconnected);
  }
}
