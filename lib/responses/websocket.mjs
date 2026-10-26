import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { historyBytes, snapshotHistory } from './history.mjs';

const fault = (message, code = 'invalid_request', param = null, status = 400) =>
  Object.assign(new Error(message), { code, param, status, type: status === 429 ? 'rate_limit_error' : 'invalid_request_error' });

function errorDetails(error) {
  return {
    type: error.type ?? (error.status >= 500 ? 'server_error' : 'invalid_request_error'),
    code: error.code ?? 'internal_error',
    message: error.status || error.code ? error.message : 'The response could not be created.',
    param: error.param ?? null,
  };
}

function rejectUpgrade(socket, error) {
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  const body = JSON.stringify({ error: errorDetails(error) });
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

/** One ordered writer shared by generation events and recoverable request errors. */
function createWriter(ws, { maxBufferedBytes, sendTimeoutMs, onFatal }) {
  let tail = Promise.resolve();
  let pendingBytes = 0;
  return (event) => {
    const data = JSON.stringify(event);
    const bytes = Buffer.byteLength(data);
    if (pendingBytes + ws.bufferedAmount + bytes > maxBufferedBytes) {
      onFatal();
      ws.close(1013, 'Outbound buffer limit exceeded');
      ws.terminate();
      return Promise.reject(fault('The client is not consuming response events fast enough.', 'slow_consumer', null, 429));
    }
    pendingBytes += bytes;
    const operation = tail.then(() => new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) return reject(fault('WebSocket disconnected.', 'client_disconnected'));
      let finished = false;
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        ws.off('close', disconnected);
        if (error) { onFatal(); reject(error); } else resolve();
      };
      const disconnected = () => finish(fault('WebSocket disconnected.', 'client_disconnected'));
      const timer = setTimeout(() => {
        finish(fault('WebSocket write timed out.', 'slow_consumer', null, 429));
        ws.terminate();
      }, sendTimeoutMs);
      timer.unref();
      ws.once('close', disconnected);
      ws.send(data, (error) => finish(error));
    })).finally(() => { pendingBytes -= bytes; });
    tail = operation.catch(() => {});
    return operation;
  };
}

function createPayload(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw fault('Each WebSocket message must be a JSON object.');
  if (event.type !== 'response.create') throw fault('Only response.create is supported; steering and Realtime events are unavailable.', 'unsupported_event', 'type');
  for (const field of ['stream_id', 'stream', 'background']) {
    if (Object.hasOwn(event, field)) throw fault(`${field} is unavailable in the basic WebSocket profile. Streaming is implicit.`, 'unsupported_parameter', field);
  }
  if (event.generate !== undefined && event.generate !== true) throw fault('Warmup (generate:false) is unavailable; generate may only be true.', 'unsupported_parameter', 'generate');
  if (event.store !== false) throw fault('The transient Core profile requires explicit store:false.', 'unsupported_parameter', 'store');
  const { type, generate, ...payload } = event;
  return payload;
}

function createConnection(ws, req, tenant, options) {
  const { service, authenticate, requestTimeoutMs, maxQueue, maxQueuedBytes, maxContextBytes,
    maxConnectionMs, heartbeatIntervalMs, idleTimeoutMs } = options;
  const write = createWriter(ws, { ...options, onFatal: () => stop() });
  let queue = [];
  let queuedBytes = 0;
  let running = false;
  let closed = false;
  let active;
  let latest = null;
  let lastActivity = Date.now();
  let awaitingPong = false;
  const sendError = (error) => write({ type: 'error', error: errorDetails(error) });
  const stop = () => {
    if (closed) return;
    closed = true;
    queue = [];
    queuedBytes = 0;
    latest = null;
    active?.abort(fault('WebSocket disconnected.', 'client_disconnected'));
    clearInterval(heartbeat);
    clearTimeout(lifetime);
  };

  async function execute(entry) {
    const continuation = entry.event?.previous_response_id != null;
    try {
      let currentTenant;
      try { currentTenant = authenticate(req); } catch (error) {
        await sendError(error);
        stop();
        ws.close(1008, 'Authorization expired');
        return;
      }
      if (currentTenant !== tenant) {
        await sendError(fault('The connection authorization changed.', 'invalid_api_key', null, 401));
        stop();
        ws.close(1008, 'Authorization changed');
        return;
      }
      if (entry.error) throw entry.error;
      const payload = createPayload(entry.event);
      const parent = payload.previous_response_id;
      if (parent != null && (!latest || parent !== latest.id)) {
        throw fault('The previous response is unavailable on this connection. Replay the full input with no previous_response_id.', 'previous_response_not_found', 'previous_response_id');
      }
      // An explicit parent is resolved at execution time, never substituted with
      // whatever happens to be latest when a queued request starts.
      const history = parent == null ? [] : latest.history;
      const request = await service.prepare(payload, { transport: 'websocket', history });
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      if (parent != null && request.model !== latest.model) throw fault('A continuation must use the same model as its previous response.', 'model_mismatch', 'model');
      active = new AbortController();
      const timer = setTimeout(() => active?.abort(fault('Response generation timed out.', 'request_timeout', null, 504)), requestTimeoutMs);
      timer.unref();
      let result;
      try {
        result = await service.run(request, {
          history, tenant, signal: active.signal, requestId: `req_${randomUUID().replaceAll('-', '')}`,
          onEvent: async (event) => { lastActivity = Date.now(); await write(event); },
        });
      } finally {
        clearTimeout(timer);
        active = undefined;
      }
      if (closed) return;
      // Context lives only on this socket. Neither persistence nor backend KV
      // reuse can recover it after eviction, rotation, or connection loss.
      if (result?.response && ['completed', 'incomplete'].includes(result.response.status) && !result.response.error && Array.isArray(result.history)) {
        latest = historyBytes(result.history) <= maxContextBytes
          ? { id: result.response.id, model: request.model, history: snapshotHistory(result.history) }
          : null;
      } else {
        latest = null;
      }
    } catch (error) {
      // This profile has only the default lane. A failed continuation invalidates
      // its predecessor; no cross-lane fork cache is advertised.
      if (continuation) latest = null;
      if (!closed && ws.readyState === WebSocket.OPEN) await sendError(error).catch(() => {});
    }
  }

  async function drain() {
    if (running || closed) return;
    running = true;
    try {
      while (queue.length && !closed && ws.readyState === WebSocket.OPEN) {
        const entry = queue.shift();
        queuedBytes -= entry.bytes;
        await execute(entry);
      }
    } finally { running = false; }
  }

  ws.on('message', (data, binary) => {
    if (closed) return;
    lastActivity = Date.now();
    const bytes = data.byteLength;
    if (queue.length >= maxQueue || queuedBytes + bytes > maxQueuedBytes) {
      sendError(fault('The WebSocket request queue is full.', 'queue_limit_exceeded', null, 429)).catch(() => {});
      return;
    }
    let event;
    let error;
    if (binary) error = fault('Binary WebSocket messages are unsupported.', 'invalid_message');
    else {
      try { event = JSON.parse(data.toString()); } catch { error = fault('The WebSocket message must contain valid JSON.', 'invalid_json'); }
    }
    queue.push({ event, error, bytes });
    queuedBytes += bytes;
    void drain();
  });
  ws.on('pong', () => { awaitingPong = false; });
  ws.on('error', stop);
  ws.once('close', stop);
  const heartbeat = setInterval(() => {
    if (awaitingPong || Date.now() - lastActivity > idleTimeoutMs) {
      stop();
      ws.terminate();
      return;
    }
    awaitingPong = true;
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, heartbeatIntervalMs);
  heartbeat.unref();
  const lifetime = setTimeout(() => {
    stop();
    ws.close(1001, 'Connection lifetime reached; reconnect and replay context');
    const forceClose = setTimeout(() => ws.terminate(), 1000);
    forceClose.unref();
  }, maxConnectionMs);
  lifetime.unref();
}

/** Basic transient default-lane Responses WebSocket transport over a shared core. */
export function attachResponsesWebSocket(server, {
  service, authenticate, requestTimeoutMs = 180000, maxPayload = 1024 * 1024,
  maxQueue = 8, maxQueuedBytes = 1024 * 1024, maxBufferedBytes = 1024 * 1024,
  maxContextBytes = 1024 * 1024, maxConnectionMs = 3600000,
  heartbeatIntervalMs = 30000, idleTimeoutMs = 300000, sendTimeoutMs = 30000,
  maxConnections = 64, maxConnectionsPerTenant = 8,
} = {}) {
  if (!service?.prepare || !service?.run || typeof authenticate !== 'function') throw new TypeError('WebSocket requires a Responses service and authenticate function.');
  const limits = { requestTimeoutMs, maxPayload, maxQueue, maxQueuedBytes, maxBufferedBytes, maxContextBytes,
    maxConnectionMs, heartbeatIntervalMs, idleTimeoutMs, sendTimeoutMs, maxConnections, maxConnectionsPerTenant };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${key} must be a positive integer.`);
  }
  if (maxConnectionMs > 3600000) throw new TypeError('WebSocket connections may not exceed 60 minutes.');
  const options = { service, authenticate, ...limits };
  const wss = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false });
  const tenants = new Map();
  let closing = false;
  const upgrade = (req, socket, head) => {
    socket.on('error', () => {});
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/v1/responses') throw fault('Unknown WebSocket endpoint.', 'not_found', null, 404);
      if (url.search) throw fault('WebSocket query parameters are unsupported; authenticate with a Bearer header.', 'unsupported_parameter');
      if (req.method !== 'GET') throw fault('WebSocket upgrade requires GET.', 'method_not_allowed', null, 405);
      const tenant = authenticate(req);
      if (typeof tenant !== 'string' || !tenant) throw fault('Authentication did not resolve a tenant.', 'invalid_api_key', null, 401);
      if (closing || wss.clients.size >= maxConnections || (tenants.get(tenant) ?? 0) >= maxConnectionsPerTenant) throw fault('WebSocket connection capacity is exhausted.', 'connection_limit_exceeded', null, 429);
      wss.handleUpgrade(req, socket, head, (ws) => {
        tenants.set(tenant, (tenants.get(tenant) ?? 0) + 1);
        ws.once('close', () => {
          const count = (tenants.get(tenant) ?? 1) - 1;
          if (count) tenants.set(tenant, count); else tenants.delete(tenant);
        });
        createConnection(ws, req, tenant, options);
        wss.emit('connection', ws, req);
      });
    } catch (error) { rejectUpgrade(socket, error); }
  };
  server.on('upgrade', upgrade);
  let closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    // Keep the rejecting upgrade handler until the HTTP listener is closed.
    closePromise = new Promise((resolve) => {
      for (const ws of wss.clients) ws.terminate();
      wss.close(resolve);
    });
    return closePromise;
  };
  server.once('close', () => { server.off('upgrade', upgrade); void close(); });
  return { wss, close };
}
