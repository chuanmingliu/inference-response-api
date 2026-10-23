import { createServer as createHttpServer } from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { prepareResponseRequest, adaptChatResponse, streamChatAsResponses } from './responses.mjs';
import { SGLANG_RESPONSES_CAPABILITIES, responseLifecycleMethod, prepareSglangResponseRequest } from './sglang-responses.mjs';
import { ResponsesService } from './lib/responses/service.mjs';
import { createEngineAdapter } from './lib/responses/engine.mjs';
import { getRuntimeProfile } from './lib/responses/profiles.mjs';
import { createAuthenticator, handleResponses, sendResponseError } from './lib/responses/http.mjs';
import { attachResponsesWebSocket } from './lib/responses/websocket.mjs';
import { ResponseError } from './lib/responses/validation.mjs';
import responsesManifest from './config/responses-capabilities.json' with { type: 'json' };

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL = 'huggingface.co/mlx-community/qwen3-0.6b-4bit:latest';
const DEFAULT_UPSTREAM = 'http://127.0.0.1:12434/engines/vllm-metal/v1';
const SERVICE_NAMES = { docker: 'Docker Model Runner', native: 'Native vLLM Metal', sglang: 'SGLang MLX' };
const SNAPSHOT_FILES = { docker: 'service-status.json', native: 'service-status-native.json', sglang: 'service-status-sglang.json' };
const BODY_LIMIT = 1024 * 1024;
const PROXY_ROUTES = new Map([
  ['/v1/models', 'GET'],
  ['/v1/responses', 'POST'],
  ['/v1/chat/completions', 'POST'],
]);
const COMPARISON_ROUTES = new Map([
  ...PROXY_ROUTES,
  ['/api/config', 'GET'], ['/api/status', 'GET'], ['/healthz', 'GET'], ['/readyz', 'GET'],
]);
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function sendJson(res, status, body, head = false) {
  const content = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(content),
    'cache-control': 'no-store',
  });
  res.end(head ? undefined : content);
}

function sendError(res, status, message, code) {
  if (res.destroyed) return;
  if (res.headersSent) return res.destroy();
  sendJson(res, status, {
    error: { message, type: 'gateway_error', code },
  });
}

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const fail = (error) => { cleanup(); reject(error); };
    const onError = (error) => fail(error);
    const onAborted = () => fail(httpError(400, 'Client disconnected.', 'client_disconnected'));
    const onEnd = () => { cleanup(); resolveBody(Buffer.concat(chunks)); };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(httpError(413, 'Request body exceeds the 1 MiB limit.', 'body_too_large'));
        req.resume();
      } else chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

export function normalizeModelId(model) {
  return String(model).toLowerCase()
    .replace(/^(?:https?:\/\/)?(?:hf\.co|huggingface\.co)\//, '')
    .replace(/:latest$/, '');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function deploymentHtml(markdown) {
  // Source is displayed as escaped text. No raw HTML or executable Markdown is accepted.
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Local Qwen · Deployment guide</title><style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;background:#101419;color:#e0e7ec;font:15px/1.75 system-ui,sans-serif}
main{max-width:1040px;margin:0 auto;padding:48px 28px}a{color:#8bdacc}nav{margin-bottom:32px;display:flex;gap:20px;flex-wrap:wrap}h1{font-size:30px;letter-spacing:-.03em}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.8 ui-monospace,SFMono-Regular,monospace;padding:28px;background:#192027;border:1px solid #303c43;border-radius:16px}
</style><main><nav><a href="/">← Playground</a><a href="/docs">Deployment</a><a href="/docs/sglang">SGLang</a><a href="/docs/features">Responses features</a><a href="/docs/docker-update">Docker update</a></nav><h1>Deployment guide</h1><pre>${escapeHtml(markdown)}</pre></main></html>`;
}

/** Create an isolated gateway; no listener is opened until caller invokes listen(). */
export function createServer(options = {}) {
  const model = options.model ?? process.env.MODEL ?? DEFAULT_MODEL;
  const upstream = (options.upstream ?? process.env.UPSTREAM_BASE_URL ?? process.env.DMR_BASE_URL ?? DEFAULT_UPSTREAM).replace(/\/+$/, '');
  const upstreamUrl = new URL(upstream);
  if (!['http:', 'https:'].includes(upstreamUrl.protocol) || upstreamUrl.username || upstreamUrl.password) {
    throw new Error('UPSTREAM_BASE_URL / DMR_BASE_URL must be an HTTP(S) URL without embedded credentials.');
  }
  const publicDir = resolve(options.publicDir ?? resolve(ROOT, 'public'));
  const docsDir = resolve(options.docsDir ?? resolve(ROOT, 'docs'));
  const probeTimeoutMs = options.probeTimeoutMs ?? 5000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 180000;
  const bodyLimit = options.bodyLimit ?? BODY_LIMIT;
  const responsesMode = options.responsesMode ?? process.env.RESPONSES_MODE ?? 'service';
  if (!['service', 'adapter', 'native'].includes(responsesMode)) throw new Error('RESPONSES_MODE must be service, adapter, or native.');
  const serviceId = options.serviceId ?? process.env.SERVICE_ID ?? (responsesMode === 'native' ? 'native' : 'docker');
  if (!Object.hasOwn(SERVICE_NAMES, serviceId)) throw new Error('SERVICE_ID must be docker, native, or sglang.');
  const snapshotFile = options.snapshotFile ?? process.env.SNAPSHOT_FILE ?? SNAPSHOT_FILES[serviceId];
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(snapshotFile)) throw new Error('SNAPSHOT_FILE must be a JSON filename inside docs.');
  const backend = options.backend ?? process.env.BACKEND_LABEL ?? 'vllm-metal';
  const serviceName = options.serviceName ?? process.env.SERVICE_NAME ?? SERVICE_NAMES[serviceId];
  const comparisonServices = new Map();
  for (const [id, base, setting] of [
    ['native', options.nativeServiceBase ?? process.env.NATIVE_SERVICE_BASE_URL ?? '', 'NATIVE_SERVICE_BASE_URL'],
    ['sglang', options.sglangServiceBase ?? process.env.SGLANG_SERVICE_BASE_URL ?? '', 'SGLANG_SERVICE_BASE_URL'],
  ]) {
    if (!base || id === serviceId) continue;
    const normalized = base.replace(/\/+$/, '');
    const target = new URL(normalized);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
      throw new Error(`${setting} must be a fixed HTTP(S) service URL without credentials, query, or fragment.`);
    }
    comparisonServices.set(id, normalized);
  }
  const logger = options.logger ?? ((entry) => console.log(JSON.stringify(entry)));
  const profile = typeof options.runtimeProfile === 'object' ? options.runtimeProfile : getRuntimeProfile(options.runtimeProfile ?? process.env.RUNTIME_PROFILE ?? ({ native: 'vllm-metal', sglang: 'sglang-metal', docker: 'dmr-metal' }[serviceId]));
  const authenticate = createAuthenticator({ apiKeys: options.apiKeys ?? (process.env.API_KEYS || undefined), apiKey: options.apiKey ?? process.env.API_KEY });
  const upstreamApiKey = options.upstreamApiKey ?? process.env.UPSTREAM_API_KEY;
  const responsesService = responsesMode === 'service' ? new ResponsesService({
    model, profile, engine: options.engine ?? createEngineAdapter({ upstream, model, profile, upstreamApiKey }), logger,
    maxConcurrent: options.maxConcurrent ?? Number(process.env.RESPONSES_MAX_CONCURRENT ?? 4),
    maxConcurrentPerTenant: options.maxConcurrentPerTenant ?? Number(process.env.RESPONSES_MAX_CONCURRENT_PER_TENANT ?? 2),
    maxInputBytes: options.maxInputBytes ?? bodyLimit, maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024,
  }) : null;
  const startedAt = new Date().toISOString();
  const config = {
    model,
    backend,
    service_id: serviceId,
    service_name: serviceName,
    snapshot_file: snapshotFile,
    context_length: Number(options.contextLength ?? process.env.CONTEXT_LENGTH ?? 32768),
    upstream,
    responses_mode: responsesMode,
    responses_capabilities: responsesMode === 'service' ? {
      ...profile.capabilities, stateless: true, websocket: true, websocket_continuation: true,
      persistence: false, previous_response_id: false, background: false, retrieve: false,
      cancel: false, delete: false, input_items: false, images: false,
      required_store: false, storage: 'none', runtime_profile: profile.id,
      authentication: authenticate.mode, acceptance: profile.acceptance,
    } : responsesMode === 'adapter' ? {
      text: true, streaming: true, stateless: true,
      tools: false, images: false, persistence: false, background: false,
      previous_response_id: false, retrieve: false, cancel: false, delete: false, input_items: false,
    } : serviceId === 'sglang' ? SGLANG_RESPONSES_CAPABILITIES : {
      text: true, streaming: true, stateless: true, images: false,
      persistence: false, previous_response_id: false, background: false,
      retrieve: false, cancel: false, delete: false, input_items: false,
    },
    endpoints: {
      responses: '/v1/responses',
      chat_completions: '/v1/chat/completions',
      models: '/v1/models',
    },
    deployment_doc: serviceId === 'sglang' ? '/docs/sglang' : '/docs',
    comparison: {
      available: comparisonServices.size > 0,
      services: [
        { id: serviceId, name: serviceName, base_path: '' },
        ...[...comparisonServices.keys()].map((id) => ({ id, name: SERVICE_NAMES[id], base_path: `/compare/${id}` })),
      ],
    },
  };

  async function getStatus() {
    const status = {
      api_reachable: false,
      selected_model_present: false,
      ready: false,
      model,
      backend,
      service_id: serviceId,
      service_name: serviceName,
      backend_verified: false,
      upstream,
      checked_at: new Date().toISOString(),
      availability_scope: 'model_catalog',
      models: [],
      inference: {
        verified: false,
        note: `This check reads the model catalog only. Run a generation request to verify ${serviceName} inference.`,
      },
    };
    try {
      const response = await fetch(`${upstream}/models`, {
        signal: AbortSignal.timeout(probeTimeoutMs),
        headers: { accept: 'application/json' },
        redirect: 'error',
      });
      status.api_reachable = true;
      status.upstream_status = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        status.error = `Model catalog returned HTTP ${response.status}.`;
      } else {
        const body = await response.json();
        if (!Array.isArray(body.data)) throw new Error('Model catalog does not contain a data array.');
        status.models = body.data.filter((entry) => typeof entry?.id === 'string').map((entry) => entry.id);
        status.selected_model_present = status.models.some((id) => normalizeModelId(id) === normalizeModelId(model));
        status.ready = status.selected_model_present;
        if (!status.ready) status.error = 'The selected model is not present in the model catalog.';
      }
    } catch (error) {
      status.error = error.name === 'TimeoutError' ? 'Model catalog request timed out.' : `Model catalog unavailable: ${error.message}`;
    }
    try {
      status.deployment_verification = JSON.parse(await readFile(resolve(docsDir, snapshotFile), 'utf8'));
      status.verification_source = 'saved_snapshot';
    } catch { /* A missing or unreadable historical snapshot must not change live availability. */ }
    return status;
  }

  async function proxy(req, res, pathname, search, comparisonBase = null, comparisonId = null) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeoutMs);
    timer.unref();
    const onDisconnected = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', onDisconnected);
    res.once('close', onDisconnected);
    try {
      let body;
      let prepared;
      const isSglang = comparisonId === 'sglang' || (!comparisonBase && serviceId === 'sglang' && responsesMode === 'native');
      const cancel = isSglang && responseLifecycleMethod(pathname) === 'POST';
      if (isSglang && responseLifecycleMethod(pathname) && search) {
        throw httpError(400, 'Response retrieval/cancellation does not support query options; streaming resume and output filtering are unavailable.', 'unsupported_parameter');
      }
      if (req.method === 'POST') {
        if (!cancel && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
          throw httpError(415, 'Use Content-Type: application/json.', 'unsupported_media_type');
        }
        body = await readBody(req, bodyLimit);
        let payload;
        if (cancel && body.length === 0) {
          // The official SDK sends cancel without JSON or a Content-Type header.
          body = undefined;
        } else {
          if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
            throw httpError(415, 'Use Content-Type: application/json.', 'unsupported_media_type');
          }
          try { payload = JSON.parse(body.toString('utf8')); } catch {
            throw httpError(400, 'Request body must be valid JSON.', 'invalid_json');
          }
          if (cancel && (!payload || Array.isArray(payload) || typeof payload !== 'object' || Object.keys(payload).length)) {
            throw httpError(400, 'Cancel accepts an empty body or an empty JSON object.', 'invalid_request');
          }
        }
        if (!comparisonBase && pathname === '/v1/responses' && responsesMode === 'adapter') {
          prepared = prepareResponseRequest(payload, model);
          body = Buffer.from(JSON.stringify(prepared.chat));
        } else if (isSglang && pathname === '/v1/responses') {
          body = Buffer.from(JSON.stringify(prepareSglangResponseRequest(payload)));
        }
      }
      const headers = { accept: req.headers.accept ?? 'application/json' };
      if (body) headers['content-type'] = 'application/json';
      // Authorization is forwarded only when explicitly supplied by this request.
      if (comparisonBase || responsesMode !== 'service') {
        if (req.headers.authorization) headers.authorization = req.headers.authorization;
      } else if (upstreamApiKey) headers.authorization = `Bearer ${upstreamApiKey}`;
      const upstreamPath = prepared ? '/chat/completions' : pathname.slice('/v1'.length);
      const target = comparisonBase ? `${comparisonBase}${pathname}${search}` : `${upstream}${upstreamPath}${search}`;
      const response = await fetch(target, {
        method: req.method,
        headers,
        body,
        signal: controller.signal,
        redirect: 'error',
      });
      if (prepared && response.ok) {
        res.setHeader('x-responses-mode', 'chat-completions-adapter');
        if (prepared.chat.stream) {
          if (!response.headers.get('content-type')?.includes('text/event-stream')) {
            await response.body?.cancel();
            throw httpError(502, 'The upstream did not return a chat event stream.', 'invalid_upstream_response');
          }
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
          res.flushHeaders();
          await streamChatAsResponses(response, res, prepared);
        } else {
          const chat = await response.json();
          sendJson(res, 200, adaptChatResponse(chat, prepared));
        }
        return;
      }
      const responseHeaders = { 'cache-control': 'no-store' };
      for (const name of ['content-type', 'retry-after', 'x-request-id', 'openai-processing-ms']) {
        const value = response.headers.get(name);
        if (value) responseHeaders[name] = value;
      }
      if (responseHeaders['content-type']?.includes('text/event-stream')) {
        responseHeaders['x-accel-buffering'] = 'no';
      }
      res.writeHead(response.status, responseHeaders);
      res.flushHeaders();
      if (!response.body) res.end();
      else await pipeline(Readable.fromWeb(response.body), res, { signal: controller.signal });
    } catch (error) {
      if (res.destroyed || req.aborted) return;
      sendError(res, error.status ?? (timedOut ? 504 : 502),
        error.status ? error.message : timedOut ? 'The upstream request timed out.' : comparisonBase ? 'Cannot reach the comparison service. Check its status and the deployment guide.' : 'Cannot reach the configured inference service. Check /api/status and the deployment guide.',
        error.code ?? (timedOut ? 'upstream_timeout' : 'upstream_unavailable'));
    } finally {
      clearTimeout(timer);
      req.off('aborted', onDisconnected);
      res.off('close', onDisconnected);
    }
  }

  const server = createHttpServer(async (req, res) => {
    const started = performance.now();
    let pathname = '/';
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    if (responsesMode === 'service') res.setHeader('x-request-id', `req_${randomUUID().replaceAll('-', '')}`);
    res.once('finish', () => logger({
      time: new Date().toISOString(), method: req.method, path: pathname,
      status: res.statusCode, duration_ms: Math.round(performance.now() - started),
    }));
    try {
      const url = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\0') || pathname.includes('\\')) throw httpError(400, 'Invalid path.', 'invalid_path');
      if (responsesMode === 'service' && (pathname.startsWith('/v1/') || /^\/compare\/(native|sglang)\/v1\//.test(pathname))) authenticate(req);
      if (responsesMode === 'service' && pathname === '/v1/responses') {
        if (req.method !== 'POST') { res.setHeader('allow', 'POST'); throw new ResponseError(405, 'Use POST or WebSocket upgrade for this endpoint.', 'method_not_allowed'); }
        return await handleResponses(req, res, { service: responsesService, authenticate, bodyLimit, requestTimeoutMs, slowConsumerTimeoutMs: options.slowConsumerTimeoutMs });
      }
      if (responsesMode === 'service' && (pathname.startsWith('/v1/responses/') || pathname === '/v1/conversations' || pathname.startsWith('/v1/conversations/'))) {
        throw new ResponseError(400, 'This resource is unavailable in the transient Core profile. Retained lifecycle, token-count routes, compaction and Conversations are not advertised.', 'unsupported_endpoint');
      }
      if (pathname.startsWith('/compare/')) {
        const match = /^\/compare\/(native|sglang)(\/.*)$/.exec(pathname);
        if (!match) throw httpError(404, 'Unknown comparison service.', 'not_found');
        const [, comparisonId, comparisonPath] = match;
        const method = COMPARISON_ROUTES.get(comparisonPath) ?? (comparisonId === 'sglang' ? responseLifecycleMethod(comparisonPath) : undefined);
        if (!method) throw httpError(404, 'Unknown comparison endpoint.', 'not_found');
        if (req.method !== method) {
          res.setHeader('allow', method);
          throw httpError(405, `Use ${method} for this endpoint.`, 'method_not_allowed');
        }
        const comparisonBase = comparisonServices.get(comparisonId);
        if (!comparisonBase) throw httpError(503, 'This comparison service is not configured.', 'comparison_unavailable');
        return await proxy(req, res, comparisonPath, url.search, comparisonBase, comparisonId);
      }
      const method = PROXY_ROUTES.get(pathname) ?? (serviceId === 'sglang' && responsesMode === 'native' ? responseLifecycleMethod(pathname) : undefined);
      if (method) {
        if (req.method !== method) {
          res.setHeader('allow', method);
          throw httpError(405, `Use ${method} for this endpoint.`, 'method_not_allowed');
        }
        return await proxy(req, res, pathname, url.search);
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('allow', 'GET, HEAD');
        throw httpError(405, 'This endpoint accepts GET or HEAD.', 'method_not_allowed');
      }
      const head = req.method === 'HEAD';
      if (pathname === '/healthz') return sendJson(res, 200, { ok: true, service: 'local-qwen-playground', service_id: serviceId, started_at: startedAt }, head);
      if (pathname === '/api/config') return sendJson(res, 200, config, head);
      if (pathname === '/api/capabilities') return sendJson(res, 200, { ...responsesManifest, mode: responsesMode, capabilities: config.responses_capabilities, runtime: profile }, head);
      if (pathname === '/api/status' || pathname === '/readyz') {
        const status = await getStatus();
        return sendJson(res, pathname === '/readyz' && !status.ready ? 503 : 200, status, head);
      }
      if (pathname === '/api/deployment') {
        try {
          const snapshot = JSON.parse(await readFile(resolve(docsDir, snapshotFile), 'utf8'));
          return sendJson(res, 200, { available: true, snapshot }, head);
        } catch (error) {
          if (error.code === 'ENOENT') return sendJson(res, 200, { available: false }, head);
          throw httpError(500, 'Deployment snapshot is not readable.', 'invalid_deployment_snapshot');
        }
      }
      const guideFile = { '/docs': 'DEPLOYMENT.md', '/docs/': 'DEPLOYMENT.md', '/docs/responses': 'RESPONSES-CORE.md', '/docs/sglang': 'SGLANG.md', '/docs/sglang/': 'SGLANG.md', '/docs/features': 'RESPONSES-FEATURES.md', '/docs/features/': 'RESPONSES-FEATURES.md', '/docs/docker-update': 'DOCKER-METAL-UPDATE.md', '/docs/docker-update/': 'DOCKER-METAL-UPDATE.md' }[pathname];
      if (guideFile) {
        let markdown;
        try { markdown = await readFile(resolve(docsDir, guideFile), 'utf8'); } catch (error) {
          if (error.code === 'ENOENT') throw httpError(404, 'Deployment guide has not been created yet.', 'not_found');
          throw error;
        }
        const content = deploymentHtml(markdown);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(content), 'cache-control': 'no-cache' });
        return res.end(head ? undefined : content);
      }
      if (pathname.startsWith('/api/') || pathname.startsWith('/v1/')) throw httpError(404, 'Unknown API endpoint.', 'not_found');
      const filePath = resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!filePath.startsWith(`${publicDir}${sep}`)) throw httpError(403, 'Path is outside the public directory.', 'forbidden');
      let info;
      let realFilePath;
      try { realFilePath = await realpath(filePath); info = await stat(realFilePath); } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw httpError(404, 'File not found.', 'not_found');
        throw error;
      }
      const realPublicDir = await realpath(publicDir);
      if (!realFilePath.startsWith(`${realPublicDir}${sep}`)) throw httpError(403, 'Path is outside the public directory.', 'forbidden');
      if (!info.isFile()) throw httpError(404, 'File not found.', 'not_found');
      const content = await readFile(realFilePath);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
        'content-length': content.length,
        'cache-control': 'no-cache',
      });
      res.end(head ? undefined : content);
    } catch (error) {
      if (responsesMode === 'service' && error.status) return sendResponseError(res, error);
      sendError(res, error.status ?? (error instanceof URIError ? 400 : 500),
        error.status ? error.message : error instanceof URIError ? 'Invalid URL encoding.' : 'Internal gateway error.',
        error.code ?? (error instanceof URIError ? 'invalid_path' : 'internal_error'));
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  if (responsesService) {
    const sockets = attachResponsesWebSocket(server, { service: responsesService, authenticate, requestTimeoutMs, maxPayload: bodyLimit, ...options.websocket });
    const closeHttp = server.close.bind(server);
    server.close = (callback) => { void sockets.close().then(() => closeHttp(callback)); return server; };
    server.responsesService = responsesService;
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 8088);
  const server = createServer();
  server.listen(port, host, () => console.log(JSON.stringify({
    event: 'listening', host, port, model: process.env.MODEL ?? DEFAULT_MODEL,
    upstream: process.env.UPSTREAM_BASE_URL ?? process.env.DMR_BASE_URL ?? DEFAULT_UPSTREAM,
  })));
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
