import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'node:test';

import { DEFAULT_ALLOWED_METHODS } from '../src/config.js';
import { createLogger } from '../src/logging.js';
import { createRateLimiter } from '../src/rateLimit.js';
import { createServer } from '../src/server.js';

import type { CallLogEntry } from '../src/logging.js';
import type { ServerDeps } from '../src/server.js';
import type { Config, FetchFn, RpcErrorObject, RpcResponse } from '../src/types.js';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';

/* ------------------------------------------------------------- fixtures */

const API_KEY = 'sk_test_secret_key_do_not_leak';
const POLICY_ID = 'sp_server_policy';
const SECRET = 'test-secret-that-is-long-enough-32';
const OTHER_SECRET = 'another-secret-that-is-long-enough-';
const ISSUER = 'https://auth.example.com';
const AUDIENCE = 'pimlico-proxy';
const ORIGIN = 'https://app.example.com';
const CHAIN = 8453;
const ALLOWED_METHOD = 'eth_chainId';
const BLOCKED_METHOD = 'eth_sendRawTransaction';
const MAX_BODY_BYTES = 262_144;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    pimlicoApiKey: API_KEY,
    sponsorshipPolicyId: POLICY_ID,
    pimlicoBaseUrl: 'https://api.pimlico.io',
    allowedChainIds: new Set([CHAIN]),
    allowedCalls: [{ target: '0x2222222222222222222222222222222222222222', selector: '*' }],
    allowedMethods: new Set(DEFAULT_ALLOWED_METHODS),
    authMode: 'jwt',
    jwtSecret: SECRET,
    jwtIssuer: ISSUER,
    jwtAudience: AUDIENCE,
    corsOrigins: [ORIGIN],
    rateLimitPerMinute: 60,
    allowNativeValue: false,
    allowDeployment: false,
    allowedFactories: [],
    trustProxy: false,
    upstreamTimeoutMs: 1000,
    ...overrides,
  };
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function sign(payload: Record<string, unknown>, secret = SECRET): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

const NOW_SECONDS = Math.floor(Date.now() / 1000);

function token(sub = 'user-1'): string {
  return sign({ sub, exp: NOW_SECONDS + 3600, iss: ISSUER, aud: AUDIENCE });
}

/* --------------------------------------------------------------- harness */

type RecordedUpstream = { url: string; body: Record<string, unknown> };

type Harness = {
  baseUrl: string;
  upstream: RecordedUpstream[];
  logs: CallLogEntry[];
  lines: string[];
  post: (path: string, body: unknown, headers?: Record<string, string>) => Promise<Response>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  close: () => Promise<void>;
};

type StartOptions = {
  cfg?: Partial<Config>;
  deps?: Partial<ServerDeps>;
};

/** A fake upstream that echoes the method back, so response order is visible. */
function recordingFetch(upstream: RecordedUpstream[]): FetchFn {
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    const body = JSON.parse(raw) as Record<string, unknown>;
    upstream.push({ url, body });
    const chainMatch = /\/v2\/(\d+)\//.exec(url);
    const chainId = chainMatch?.[1] === undefined ? 0 : Number(chainMatch[1]);
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body['id'] ?? null,
        result: { echo: body['method'], chainId },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return fetchFn as unknown as FetchFn;
}

async function start(t: TestContext, options: StartOptions = {}): Promise<Harness> {
  const cfg = makeConfig(options.cfg);
  const upstream: RecordedUpstream[] = [];
  const logs: CallLogEntry[] = [];
  const lines: string[] = [];

  const logger = createLogger((line: string): void => {
    lines.push(line);
    logs.push(JSON.parse(line) as CallLogEntry);
  });

  const server = createServer(cfg, {
    fetchFn: recordingFetch(upstream),
    logger,
    ...options.deps,
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  t.after(close);

  const request = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${baseUrl}${path}`, init);

  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  return { baseUrl, upstream, logs, lines, post, request, close };
}

async function json(response: Response): Promise<unknown> {
  return (await response.json()) as unknown;
}

function asError(response: RpcResponse | undefined): RpcErrorObject {
  assert.ok(response !== undefined, 'expected a response');
  assert.ok('error' in response, 'expected an error response');
  return response.error;
}

function asResult(response: RpcResponse | undefined): unknown {
  assert.ok(response !== undefined, 'expected a response');
  assert.ok('result' in response, 'expected a result response');
  return response.result;
}

/* ------------------------------------------------------------------ CORS */

describe('cors', () => {
  test('an allowed origin gets the exact allow-origin header', async (t) => {
    const h = await start(t);

    const response = await h.post(
      `/rpc/${CHAIN}`,
      { jsonrpc: '2.0', id: 1, method: ALLOWED_METHOD },
      { origin: ORIGIN, authorization: `Bearer ${token()}` },
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(response.headers.get('access-control-allow-methods'), 'POST');
    assert.equal(
      response.headers.get('access-control-allow-headers'),
      'authorization, content-type',
    );
    assert.equal(response.headers.get('access-control-max-age'), '600');
    assert.equal(response.headers.get('vary'), 'Origin');
  });

  test('a disallowed origin gets no CORS headers at all', async (t) => {
    const h = await start(t);

    const response = await h.post(
      `/rpc/${CHAIN}`,
      { jsonrpc: '2.0', id: 1, method: ALLOWED_METHOD },
      { origin: 'https://evil.example.com', authorization: `Bearer ${token()}` },
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('access-control-allow-methods'), null);
    assert.equal(response.headers.get('access-control-allow-headers'), null);
    assert.equal(response.headers.get('access-control-max-age'), null);
    assert.equal(response.headers.get('vary'), 'Origin');
  });

  test('OPTIONS answers 204 with the preflight headers and no upstream call', async (t) => {
    const h = await start(t);

    const response = await h.request(`/rpc/${CHAIN}`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });

    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(response.headers.get('access-control-allow-methods'), 'POST');
    assert.equal(
      response.headers.get('access-control-allow-headers'),
      'authorization, content-type',
    );
    assert.equal(h.upstream.length, 0);
  });
});

/* -------------------------------------------------- health and routing */

describe('health and routing', () => {
  test('GET /healthz needs no auth', async (t) => {
    const h = await start(t);

    const response = await h.request('/healthz');

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.deepEqual(await json(response), { ok: true });
    assert.equal(h.logs.length, 0);
  });

  test('POST /healthz is 405', async (t) => {
    const h = await start(t);

    const response = await h.post('/healthz', { anything: true });

    assert.equal(response.status, 405);
  });

  test('an unknown path and an unknown chain are both 404', async (t) => {
    const h = await start(t);

    const unknownPath = await h.post(`/proxy/${CHAIN}`, {
      jsonrpc: '2.0',
      method: ALLOWED_METHOD,
    });
    assert.equal(unknownPath.status, 404);
    assert.deepEqual(await json(unknownPath), { error: 'not found' });

    const unknownChain = await h.post('/rpc/1', { jsonrpc: '2.0', method: ALLOWED_METHOD });
    assert.equal(unknownChain.status, 404);
    assert.deepEqual(await json(unknownChain), { error: 'unknown chain' });

    assert.equal(h.upstream.length, 0);
  });

  test('GET on the rpc path is 404', async (t) => {
    const h = await start(t);

    const response = await h.request(`/rpc/${CHAIN}`);

    assert.equal(response.status, 404);
  });
});

/* ------------------------------------------------------------------ auth */

describe('auth', () => {
  test('a missing token is 401 with no reason echoed', async (t) => {
    const h = await start(t);

    const response = await h.post(`/rpc/${CHAIN}`, {
      jsonrpc: '2.0',
      id: 1,
      method: ALLOWED_METHOD,
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await json(response), { error: 'unauthorized' });
    assert.equal(h.upstream.length, 0);
  });

  test('a malformed token is 401', async (t) => {
    const h = await start(t);

    const response = await h.post(
      `/rpc/${CHAIN}`,
      { jsonrpc: '2.0', id: 1, method: ALLOWED_METHOD },
      { authorization: 'Bearer not-a-token' },
    );

    assert.equal(response.status, 401);
    assert.deepEqual(await json(response), { error: 'unauthorized' });
  });

  test('an expired token is 401 and the reason is not echoed', async (t) => {
    const h = await start(t);
    const expired = sign({ sub: 'user-1', exp: NOW_SECONDS - 10, iss: ISSUER, aud: AUDIENCE });

    const response = await h.post(
      `/rpc/${CHAIN}`,
      { jsonrpc: '2.0', id: 1, method: ALLOWED_METHOD },
      { authorization: `Bearer ${expired}` },
    );

    assert.equal(response.status, 401);
    const raw = await response.text();
    assert.equal(raw, '{"error":"unauthorized"}');
    assert.equal(raw.includes('expired'), false);
  });

  test('a bad signature is 401', async (t) => {
    const h = await start(t);
    const forged = sign({ sub: 'user-1', exp: NOW_SECONDS + 3600 }, OTHER_SECRET);

    const response = await h.post(
      `/rpc/${CHAIN}`,
      { jsonrpc: '2.0', id: 1, method: ALLOWED_METHOD },
      { authorization: `Bearer ${forged}` },
    );

    assert.equal(response.status, 401);
    assert.equal(h.upstream.length, 0);
    assert.equal(h.logs.length, 1);
    assert.equal(h.logs[0]?.outcome, 'http_error');
    assert.equal(h.logs[0]?.status, 401);
    assert.equal(h.logs[0]?.userId, null);
  });

  test("authMode 'none' needs no token and logs anonymous", async (t) => {
    const h = await start(t, { cfg: { authMode: 'none' } });

    const response = await h.post(`/rpc/${CHAIN}`, {
      jsonrpc: '2.0',
      id: 1,
      method: ALLOWED_METHOD,
    });

    assert.equal(response.status, 200);
    assert.equal(h.logs.length, 1);
    assert.equal(h.logs[0]?.userId, 'anonymous');
    assert.equal(h.logs[0]?.outcome, 'ok');
  });
});

/* -------------------------------------------------------- body and shape */

describe('body and shape', () => {
  test('invalid JSON is 400 with -32700', async (t) => {
    const h = await start(t);

    const response = await h.post(`/rpc/${CHAIN}`, '{not json', {
      authorization: `Bearer ${token()}`,
    });

    assert.equal(response.status, 400);
    const body = (await json(response)) as RpcResponse;
    assert.equal(asError(body).code, -32700);
    assert.equal(body.id, null);
    assert.equal(h.upstream.length, 0);
  });

  test('a wrong shape is 400 with -32600', async (t) => {
    const h = await start(t);
    const headers = { authorization: `Bearer ${token()}` };
    const bad: unknown[] = [
      [],
      [{ jsonrpc: '1.0', method: ALLOWED_METHOD }],
      [{ jsonrpc: '2.0', method: 42 }],
      [{ jsonrpc: '2.0', method: ALLOWED_METHOD, id: { nested: true } }],
      Array.from({ length: 21 }, () => ({ jsonrpc: '2.0', method: ALLOWED_METHOD })),
    ];

    for (const payload of bad) {
      const response = await h.post(`/rpc/${CHAIN}`, payload, headers);
      assert.equal(response.status, 400, `payload: ${JSON.stringify(payload).slice(0, 40)}`);
      const body = (await json(response)) as RpcResponse;
      assert.equal(asError(body).code, -32600);
      assert.equal(body.id, null);
    }

    assert.equal(h.upstream.length, 0);
  });

  test('a batch of exactly 20 is accepted', async (t) => {
    const h = await start(t);
    const batch = Array.from({ length: 20 }, (_, id) => ({
      jsonrpc: '2.0',
      id,
      method: ALLOWED_METHOD,
    }));

    const response = await h.post(`/rpc/${CHAIN}`, batch, {
      authorization: `Bearer ${token()}`,
    });

    assert.equal(response.status, 200);
    const body = (await json(response)) as unknown[];
    assert.equal(body.length, 20);
  });

  test('a body over 256 KB is 413', async (t) => {
    const h = await start(t);

    const response = await h.post(`/rpc/${CHAIN}`, 'x'.repeat(MAX_BODY_BYTES + 1024), {
      authorization: `Bearer ${token()}`,
    });

    assert.equal(response.status, 413);
    assert.deepEqual(await json(response), { error: 'body too large' });
    assert.equal(h.upstream.length, 0);
  });
});

/* ------------------------------------------------------------ forwarding */

describe('forwarding', () => {
  test('a single allowed call returns the upstream result', async (t) => {
    const h = await start(t);

    const response = await h.post(
      `/rpc/${CHAIN}`,
      { jsonrpc: '2.0', id: 7, method: ALLOWED_METHOD },
      { authorization: `Bearer ${token()}` },
    );

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    const body = (await json(response)) as RpcResponse;
    assert.equal(body.id, 7);
    assert.deepEqual(asResult(body), { echo: ALLOWED_METHOD, chainId: CHAIN });
    assert.equal(h.upstream.length, 1);
    assert.match(h.upstream[0]?.url ?? '', new RegExp(`/v2/${CHAIN}/rpc\\?apikey=`));
  });

  test('a batch of three returns three responses in request order', async (t) => {
    const h = await start(t);
    const methods = ['eth_chainId', 'eth_supportedEntryPoints', 'pimlico_getUserOperationGasPrice'];

    const response = await h.post(
      `/rpc/${CHAIN}`,
      methods.map((method, id) => ({ jsonrpc: '2.0', id, method })),
      { authorization: `Bearer ${token()}` },
    );

    assert.equal(response.status, 200);
    const body = (await json(response)) as RpcResponse[];
    assert.equal(body.length, 3);
    assert.deepEqual(
      body.map((entry) => (entry as { result: { echo: string } }).result.echo),
      methods,
    );
    assert.deepEqual(
      body.map((entry) => entry.id),
      [0, 1, 2],
    );
    assert.equal(h.logs.length, 3);
  });

  test('a blocked method in a batch fails only that entry', async (t) => {
    const h = await start(t);

    const response = await h.post(
      `/rpc/${CHAIN}`,
      [
        { jsonrpc: '2.0', id: 1, method: ALLOWED_METHOD },
        { jsonrpc: '2.0', id: 2, method: BLOCKED_METHOD },
        { jsonrpc: '2.0', id: 3, method: 'eth_supportedEntryPoints' },
      ],
      { authorization: `Bearer ${token()}` },
    );

    assert.equal(response.status, 200);
    const body = (await json(response)) as RpcResponse[];
    assert.equal(body.length, 3);
    assert.deepEqual(asResult(body[0]), { echo: ALLOWED_METHOD, chainId: CHAIN });
    assert.equal(asError(body[1]).code, -32601);
    assert.ok(asResult(body[2]) !== undefined);
    assert.equal(h.upstream.length, 2);
    assert.equal(h.logs[1]?.outcome, 'rpc_error');
    assert.equal(h.logs[1]?.code, -32601);
  });
});

/* ----------------------------------------------------------- rate limits */

describe('rate limiting', () => {
  test('the third call over a budget of two is -32005 with 429', async (t) => {
    const h = await start(t, { cfg: { rateLimitPerMinute: 2 } });
    const headers = { authorization: `Bearer ${token()}` };
    const call = { jsonrpc: '2.0', id: 1, method: ALLOWED_METHOD };

    assert.equal((await h.post(`/rpc/${CHAIN}`, call, headers)).status, 200);
    assert.equal((await h.post(`/rpc/${CHAIN}`, call, headers)).status, 200);

    const limited = await h.post(`/rpc/${CHAIN}`, call, headers);
    assert.equal(limited.status, 429);
    const body = (await json(limited)) as RpcResponse;
    assert.equal(asError(body).code, -32005);
    assert.equal(asError(body).message, 'rate limited');
    assert.equal(h.upstream.length, 2);
    assert.equal(h.logs[2]?.status, 429);
  });

  test('a batch of three costs three calls', async (t) => {
    const h = await start(t, { cfg: { rateLimitPerMinute: 3 } });
    const headers = { authorization: `Bearer ${token()}` };
    const batch = Array.from({ length: 3 }, (_, id) => ({
      jsonrpc: '2.0',
      id,
      method: ALLOWED_METHOD,
    }));

    const response = await h.post(`/rpc/${CHAIN}`, batch, headers);
    assert.equal(response.status, 200);

    const first = batch[0];
    assert.ok(first !== undefined);
    const after = await h.post(`/rpc/${CHAIN}`, first, headers);
    assert.equal(after.status, 429, 'a batch of three must exhaust a budget of three');
  });

  test('an injected limiter is the one charged', async (t) => {
    const limiter = createRateLimiter(1);
    const h = await start(t, { deps: { limiter }, cfg: { rateLimitPerMinute: 60 } });
    const headers = { authorization: `Bearer ${token()}` };
    const call = { jsonrpc: '2.0', id: 1, method: ALLOWED_METHOD };

    assert.equal((await h.post(`/rpc/${CHAIN}`, call, headers)).status, 200);
    assert.equal((await h.post(`/rpc/${CHAIN}`, call, headers)).status, 429);
    assert.equal(limiter.size, 2, 'one counter for the user and one for the ip');
  });
});

/* ------------------------------------------------------------ trustProxy */

describe('client ip', () => {
  test('trustProxy reads the first x-forwarded-for entry', async (t) => {
    const h = await start(t, { cfg: { trustProxy: true } });

    const response = await h.post(
      `/rpc/${CHAIN}`,
      { jsonrpc: '2.0', id: 1, method: ALLOWED_METHOD },
      { authorization: `Bearer ${token()}`, 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    );

    assert.equal(response.status, 200);
    assert.equal(h.logs[0]?.ip, '203.0.113.9');
  });

  test('trustProxy false ignores the header', async (t) => {
    const h = await start(t, { cfg: { trustProxy: false } });

    await h.post(
      `/rpc/${CHAIN}`,
      { jsonrpc: '2.0', id: 1, method: ALLOWED_METHOD },
      { authorization: `Bearer ${token()}`, 'x-forwarded-for': '203.0.113.9' },
    );

    assert.equal(h.logs[0]?.ip, '127.0.0.1');
  });
});

/* --------------------------------------------------------------- logging */

describe('logging', () => {
  test('one line per call with method, chainId, userId and outcome', async (t) => {
    const h = await start(t);

    await h.post(
      `/rpc/${CHAIN}`,
      [
        { jsonrpc: '2.0', id: 1, method: 'eth_chainId' },
        { jsonrpc: '2.0', id: 2, method: BLOCKED_METHOD },
      ],
      { authorization: `Bearer ${token('user-42')}` },
    );

    assert.equal(h.logs.length, 2);
    assert.equal(h.lines.length, 2);
    assert.equal(h.logs[0]?.method, 'eth_chainId');
    assert.equal(h.logs[1]?.method, BLOCKED_METHOD);
    for (const entry of h.logs) {
      assert.equal(entry.chainId, CHAIN);
      assert.equal(entry.userId, 'user-42');
      assert.equal(Number.isInteger(entry.latencyMs), true);
    }
    assert.equal(h.logs[0]?.outcome, 'ok');
    assert.equal(h.logs[1]?.outcome, 'rpc_error');
    assert.equal(h.logs[1]?.code, -32601);
  });

  test('a rejected request logs exactly one http_error line', async (t) => {
    const h = await start(t);

    await h.post(`/rpc/${CHAIN}`, '{not json', { authorization: `Bearer ${token()}` });

    assert.equal(h.logs.length, 1);
    assert.equal(h.logs[0]?.outcome, 'http_error');
    assert.equal(h.logs[0]?.status, 400);
    assert.equal(h.logs[0]?.method, 'unknown');
  });

  test('log lines carry no api key, policy id or body', async (t) => {
    const h = await start(t);

    await h.post(
      `/rpc/${CHAIN}`,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'pm_sponsorUserOperation',
        params: [{ callData: '0xdead' }],
      },
      { authorization: `Bearer ${token()}` },
    );
    await h.post(
      `/rpc/${CHAIN}`,
      { jsonrpc: '2.0', id: 1, method: ALLOWED_METHOD },
      { authorization: `Bearer ${token()}` },
    );

    assert.ok(h.lines.length >= 2);
    for (const line of h.lines) {
      assert.equal(line.includes(API_KEY), false);
      assert.equal(line.includes(POLICY_ID), false);
      assert.equal(line.includes('0xdead'), false);
      assert.equal(line.includes('/v2/'), false);
    }
  });
});

/* ------------------------------------------------------------- lifecycle */

describe('lifecycle', () => {
  test('createServer never listens by itself', () => {
    const server = createServer(makeConfig());

    assert.equal(server.listening, false);
    server.close();
  });

  test('two servers do not share a limiter', async (t) => {
    const first = await start(t, { cfg: { rateLimitPerMinute: 1 } });
    const second = await start(t, { cfg: { rateLimitPerMinute: 1 } });
    const headers = { authorization: `Bearer ${token()}` };
    const call = { jsonrpc: '2.0', id: 1, method: ALLOWED_METHOD };

    assert.equal((await first.post(`/rpc/${CHAIN}`, call, headers)).status, 200);
    assert.equal((await first.post(`/rpc/${CHAIN}`, call, headers)).status, 429);
    assert.equal(
      (await second.post(`/rpc/${CHAIN}`, call, headers)).status,
      200,
      'the second server has its own budget',
    );
  });

  test('an unexpected throw is a 500 with no stack trace', async (t) => {
    const h = await start(t, {
      deps: {
        now: (): number => {
          throw new Error('clock exploded');
        },
      },
    });

    const response = await h.post(
      `/rpc/${CHAIN}`,
      { jsonrpc: '2.0', id: 1, method: ALLOWED_METHOD },
      { authorization: `Bearer ${token()}` },
    );

    assert.equal(response.status, 500);
    const raw = await response.text();
    assert.deepEqual(JSON.parse(raw), { error: 'internal error' });
    assert.equal(raw.includes('clock exploded'), false);
    assert.equal(raw.includes('at '), false);
  });
});
