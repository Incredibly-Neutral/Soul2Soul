/**
 * Regression test: the serverless `/run` runner must return JSON on EVERY
 * error path.
 *
 * Root cause (fixed): the request-setup phase — `await c.req.json()` and
 * `fetchFromIPFS(cid)` — ran OUTSIDE the try/catch that only wrapped action
 * execution. When body parsing failed (malformed JSON) or the IPFS gateway
 * fetch threw (e.g. 403), the error escaped to Hono's default error handler,
 * which returns a PLAIN-TEXT "Internal Server Error" (HTTP 500). The
 * JSON-only neutralpress render PREP client chokes on that body
 * (`SyntaxError: Unexpected token 'I', "Internal S"... is not valid JSON`).
 *
 * Assertions (all against the real Hono `app`, with global `fetch` mocked):
 *   - malformed JSON body           -> 400, JSON {error:/invalid JSON body/}
 *   - cid whose gateway fetch 403s  -> 502, JSON {error:/IPFS failed/}
 *   - inline `code`                 -> 200, JSON {success:true}
 *   - action that throws            -> 500, JSON (not text/plain)
 *   - no code and no cid            -> 400, JSON {error:'require code or cid'}
 *   - uncaught handler error        -> 500, JSON via app.onError
 *   - no error response is text/plain
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { app } from './server.ts';

// Throwaway throwing route to exercise `app.onError`. Must be registered before
// any `app.request()` dispatch — Hono's SmartRouter builds its matcher on the
// first dispatch and rejects later route additions.
app.get('/__test_uncaught_throw__', () => {
  throw new Error('uncaught boom');
});

const post = (body: unknown) =>
  app.request('/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const expectJsonContentType = (res: Response) => {
  expect(res.headers.get('content-type')).toMatch(/application\/json/);
  expect(res.headers.get('content-type')).not.toMatch(/text\/plain/);
};

describe('POST /run error handling (JSON on all paths)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 JSON for a malformed JSON body (the exact 'Internal S' leak)", async () => {
    const res = await post('Internal Server Error');
    expect(res.status).toBe(400);
    expectJsonContentType(res);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/invalid JSON body/);
  });

  it('returns 502 JSON when the IPFS gateway fetch fails (403)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => ({ ok: false, status: 403, statusText: 'Forbidden' }) as unknown as Response),
    );
    const res = await post({ cid: 'bafytest-403' });
    expect(res.status).toBe(502);
    expectJsonContentType(res);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/IPFS failed/);
  });

  it('returns 200 JSON {success:true} for inline code', async () => {
    const res = await post({
      code: 'function main(params) { return { echoed: params.echo }; }',
      inputs: { echo: 'hi' },
    });
    expect(res.status).toBe(200);
    expectJsonContentType(res);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      response: { echoed: 'hi' },
    });
  });

  it('returns 500 JSON when the action itself throws', async () => {
    const res = await post({ code: "function main() { throw new Error('action boom'); }" });
    expect(res.status).toBe(500);
    expectJsonContentType(res);
    await expect(res.json()).resolves.toMatchObject({ error: 'action boom' });
  });

  it('returns 400 JSON when neither code nor cid is provided', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expectJsonContentType(res);
    await expect(res.json()).resolves.toMatchObject({ error: 'require code or cid' });
  });

  it('app.onError returns JSON (never text/plain) for an uncaught handler error', async () => {
    const res = await app.request('/__test_uncaught_throw__');
    expect(res.status).toBe(500);
    expectJsonContentType(res);
    await expect(res.json()).resolves.toMatchObject({ error: 'uncaught boom' });
  });
});
