/**
 * The HTTP edge: CORS, health, routing, auth, body limits, batch fan-out and
 * logging.
 *
 * Everything that decides whether a call is allowed lives in `rpc.ts`; this
 * module only decides whether a request reaches it. All collaborators arrive
 * through `ServerDeps`, so a test drives the whole edge over a real socket
 * without touching the network or the wall clock. No module-level state: two
 * servers in one process share nothing.
 */
import { createServer as createHttpServer } from 'node:http';

import { AuthError, verifyJwt } from './auth.js';
import { createLogger } from './logging.js';
import { createRateLimiter } from './rateLimit.js';
import { handleCall, rpcError } from './rpc.js';

import type { CallLogEntry } from './logging.js';
import type { RateLimiter } from './rateLimit.js';
import type { Config, FetchFn, RpcRequest, RpcResponse } from './types.js';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';

export type ServerDeps = {
  fetchFn?: FetchFn;
  now?: () => number;
  limiter?: RateLimiter;
  logger?: (entry: CallLogEntry) => void;
};

/** 256 KB of request body, hard. */
const MAX_BODY_BYTES = 262_144;

/** A batch beyond this size is rejected outright rather than fanned out. */
const MAX_BATCH_SIZE = 20;

/** How often the limiter's expired windows are dropped. */
const SWEEP_INTERVAL_MS = 60_000;

const RPC_PATH = /^\/rpc\/(\d+)$/;

const ANONYMOUS = 'anonymous';
const UNKNOWN_IP = 'unknown';

type Ctx = {
  cfg: Config;
  fetchFn: FetchFn;
  now: () => number;
  limiter: RateLimiter;
  log: (entry: CallLogEntry) => void;
};

type CorsHeaders = Record<string, string>;

type ReadBodyResult = { tooLarge: false; body: string } | { tooLarge: true };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** CORS headers for `origin`, plus the always-present `Vary`. */
function corsHeaders(cfg: Config, origin: string | undefined): CorsHeaders {
  if (origin === undefined) return {};
  const headers: CorsHeaders = { vary: 'Origin' };
  if (cfg.corsOrigins.includes(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-methods'] = 'POST';
    headers['access-control-allow-headers'] = 'authorization, content-type';
    headers['access-control-max-age'] = '600';
  }
  return headers;
}

/** `::ffff:1.2.3.4` is the same client as `1.2.3.4`. */
function normalizeIp(value: string | undefined): string {
  if (value === undefined) return UNKNOWN_IP;
  const trimmed = value.trim();
  if (trimmed === '') return UNKNOWN_IP;
  return trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
}

/** The client address, honouring `x-forwarded-for` only when told to. */
function clientIp(cfg: Config, req: IncomingMessage): string {
  const socket = normalizeIp(req.socket.remoteAddress);
  if (!cfg.trustProxy) return socket;
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return socket;
  // The rightmost entry is the one the hop closest to us appended; everything
  // to its left was supplied by the client and can be anything.
  const last = raw.split(',').at(-1);
  return last === undefined || last.trim() === '' ? socket : normalizeIp(last);
}

function pathOf(req: IncomingMessage): string {
  const raw = req.url ?? '/';
  const query = raw.indexOf('?');
  return query === -1 ? raw : raw.slice(0, query);
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  if (match === null) return undefined;
  const value = match[1];
  return value === undefined || value === '' ? undefined : value;
}

/** Write a response once, never throwing into the caller. */
function send(res: ServerResponse, status: number, headers: CorsHeaders, body: string): void {
  try {
    if (res.headersSent) return;
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    res.writeHead(status);
    res.end(body);
  } catch {
    // A dead socket is not a reason to fail the process.
  }
}

function sendJson(res: ServerResponse, status: number, headers: CorsHeaders, value: unknown): void {
  send(res, status, { ...headers, 'content-type': 'application/json' }, JSON.stringify(value));
}

/**
 * Read the body under a hard byte cap.
 *
 * Over the cap the stream is paused and left unread: the caller answers 413
 * with `connection: close`, so Node tears the socket down once the response
 * is flushed. Destroying the socket here instead would reset the connection
 * before the client could read the 413.
 */
function readBody(req: IncomingMessage): Promise<ReadBodyResult> {
  return new Promise<ReadBodyResult>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const settle = (result: ReadBodyResult): void => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onError);
      resolve(result);
    };

    function onData(chunk: Buffer): void {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.pause();
        settle({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    }

    function onEnd(): void {
      settle({ tooLarge: false, body: Buffer.concat(chunks).toString('utf8') });
    }

    function onError(): void {
      settle({ tooLarge: true });
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onError);
  });
}

/** A call with a usable `jsonrpc`/`method`, or `undefined`. */
function toCall(value: unknown): RpcRequest | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value['jsonrpc'] !== '2.0') return undefined;
  const method = value['method'];
  if (typeof method !== 'string') return undefined;
  if ('id' in value) {
    const id = value['id'];
    const valid = id === null || typeof id === 'string' || typeof id === 'number';
    if (!valid) return undefined;
  }
  return value as unknown as RpcRequest;
}

function toCalls(parsed: unknown): RpcRequest[] | undefined {
  if (Array.isArray(parsed)) {
    if (parsed.length === 0 || parsed.length > MAX_BATCH_SIZE) return undefined;
    const calls: RpcRequest[] = [];
    for (const entry of parsed) {
      const call = toCall(entry);
      if (call === undefined) return undefined;
      calls.push(call);
    }
    return calls;
  }
  const call = toCall(parsed);
  return call === undefined ? undefined : [call];
}

export function createServer(cfg: Config, deps: ServerDeps = {}): HttpServer {
  const logger = deps.logger ?? createLogger();
  const ctx: Ctx = {
    cfg,
    fetchFn: deps.fetchFn ?? fetch,
    now: deps.now ?? Date.now,
    limiter: deps.limiter ?? createRateLimiter(cfg.rateLimitPerMinute),
    log: (entry: CallLogEntry): void => {
      try {
        logger(entry);
      } catch {
        // A broken logger must never break the request it is logging.
      }
    },
  };

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse): void => {
    // Late socket errors must never surface as an unhandled 'error' event.
    req.on('error', (): void => undefined);
    res.on('error', (): void => undefined);
    void handleRequest(ctx, req, res);
  });
  sweepOnInterval(server, ctx.limiter, ctx.now);
  return server;
}

/**
 * Drop expired rate-limit windows on a timer, so one caller cycling through
 * many addresses cannot grow the map without bound. The timer is unref'd, so
 * it never keeps the process alive, and stopped when the server closes.
 */
function sweepOnInterval(server: HttpServer, limiter: RateLimiter, now: () => number): void {
  const sweep = (): void => {
    try {
      limiter.sweep(now());
    } catch {
      // A sweep must never take the process down.
    }
  };

  sweep();
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  timer.unref();

  server.on('close', (): void => {
    clearInterval(timer);
  });
}

async function handleRequest(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Computed before the clock read, so even the 500 below keeps its CORS headers.
  const cors = corsHeaders(ctx.cfg, req.headers.origin);
  try {
    await route(ctx, req, res, cors);
  } catch {
    sendJson(res, 500, cors, { error: 'internal error' });
  }
}

async function route(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  cors: CorsHeaders,
): Promise<void> {
  const startedAt = ctx.now();
  const ip = clientIp(ctx.cfg, req);
  const latency = (): number => Math.round(ctx.now() - startedAt);

  const logHttp = (status: number, extra: Partial<CallLogEntry> = {}): void => {
    ctx.log({
      method: 'unknown',
      chainId: 0,
      userId: null,
      outcome: 'http_error',
      status,
      latencyMs: latency(),
      ip,
      ...extra,
    });
  };

  if (req.method === 'OPTIONS') {
    send(res, 204, cors, '');
    return;
  }

  // An origin that is not allowlisted is refused outright, not merely denied
  // CORS headers: a safelisted `text/plain` POST never gets a preflight, so
  // header-only CORS would still let another site's page reach the pipeline.
  const origin = req.headers.origin;
  if (origin !== undefined && !ctx.cfg.corsOrigins.includes(origin)) {
    logHttp(403);
    sendJson(res, 403, cors, { error: 'forbidden' });
    return;
  }

  const path = pathOf(req);

  if (path === '/healthz') {
    if (req.method === 'GET') {
      sendJson(res, 200, {}, { ok: true });
    } else {
      sendJson(res, 405, { allow: 'GET, OPTIONS' }, { error: 'method not allowed' });
    }
    return;
  }

  const match = RPC_PATH.exec(path);
  const rawChainId = match?.[1];
  if (req.method !== 'POST' || rawChainId === undefined) {
    sendJson(res, 404, cors, { error: 'not found' });
    return;
  }

  const chainId = Number(rawChainId);

  // Auth first: an unauthenticated caller must not learn which chain ids are
  // configured by comparing 401 against 404.
  let userId: string;
  if (ctx.cfg.authMode === 'none') {
    userId = ANONYMOUS;
  } else {
    const token = bearerToken(req.headers.authorization);
    if (token === undefined) {
      logHttp(401, { chainId });
      sendJson(res, 401, cors, { error: 'unauthorized' });
      return;
    }
    const secret = ctx.cfg.jwtSecret;
    if (secret === undefined) throw new Error('jwt auth mode without a secret');
    try {
      userId = verifyJwt(token, secret, {
        issuer: ctx.cfg.jwtIssuer,
        audience: ctx.cfg.jwtAudience,
      }).userId;
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      logHttp(401, { chainId });
      sendJson(res, 401, cors, { error: 'unauthorized' });
      return;
    }
  }

  if (!Number.isSafeInteger(chainId) || !ctx.cfg.allowedChainIds.has(chainId)) {
    logHttp(404, { chainId });
    sendJson(res, 404, cors, { error: 'unknown chain' });
    return;
  }

  const read = await readBody(req);
  if (read.tooLarge) {
    logHttp(413, { chainId, userId });
    send(
      res,
      413,
      { ...cors, 'content-type': 'application/json', connection: 'close' },
      JSON.stringify({ error: 'body too large' }),
    );
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.body);
  } catch {
    logHttp(400, { chainId, userId });
    sendJson(res, 400, cors, rpcError(undefined, -32700, 'parse error'));
    return;
  }

  const calls = toCalls(parsed);
  if (calls === undefined) {
    logHttp(400, { chainId, userId });
    sendJson(res, 400, cors, rpcError(undefined, -32600, 'invalid request'));
    return;
  }

  // One clock read for the whole batch, so a batch is charged one window.
  const at = ctx.now();
  const limited = calls.map((call: RpcRequest): boolean => {
    const userAllowed = ctx.limiter.check(`user:${userId}`, at).allowed;
    const ipAllowed = ctx.limiter.check(`ip:${ip}`, at).allowed;
    return !userAllowed || !ipAllowed;
  });

  const responses = await Promise.all(
    calls.map(async (call: RpcRequest, index: number): Promise<RpcResponse> => {
      if (limited[index] === true) return rpcError(call.id, -32005, 'rate limited');
      try {
        return await handleCall(call, chainId, ctx.cfg, ctx.fetchFn);
      } catch {
        return rpcError(call.id, -32603, 'internal error');
      }
    }),
  );

  const status = limited.some((entry: boolean): boolean => entry) ? 429 : 200;

  for (const [index, response] of responses.entries()) {
    const call = calls[index];
    if (call === undefined) continue;
    const ok = 'result' in response;
    ctx.log({
      method: call.method,
      chainId,
      userId,
      outcome: ok ? 'ok' : 'rpc_error',
      status,
      ...(ok ? {} : { code: response.error.code }),
      latencyMs: latency(),
      ip,
    });
  }

  const payload: unknown = Array.isArray(parsed)
    ? responses
    : (responses[0] ?? rpcError(undefined, -32603, 'internal error'));
  sendJson(res, status, cors, payload);
}
