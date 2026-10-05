import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LitService } from '../lit';
import { runAction } from './helpers';

// ============================================================================
// runAction (preview branch) — defensive handling of the Bun runner response.
//
// Regression: the PREP stage failed with a raw
//   SyntaxError: Unexpected token 'I', "Internal S"... is not valid JSON
// because the preview branch did an UNWRAPPED `await r.json()` on the fetch
// response. When the runner returns HTTP 500 with a plain-text body (Hono's
// default 'Internal Server Error'), `r.json()` threw that opaque SyntaxError.
// The hardened branch reads the body as text, parses defensively, and converts
// a non-JSON body into an actionable Error('runner <status> returned non-JSON…').
// ============================================================================

const RUNNER_URL = 'https://runner.test/run';
const CID = 'bafytestcid';
const INPUTS = { publication: 'test' };

/** Minimal lit mock — never called in preview mode (runAction uses fetch only). */
const mockLit = {} as unknown as LitService;

let fetchMock: ReturnType<typeof vi.fn>;

/** A minimal Response-like object with a configurable status + text body. */
function textResponse(body: string, status: number): Response {
  return { status, text: () => Promise.resolve(body) } as unknown as Response;
}

/** A Response-like object whose body is a serialized JSON envelope. */
function jsonResponse(body: unknown, status = 200): Response {
  return textResponse(JSON.stringify(body), status);
}

beforeEach(() => {
  process.env.S2S_RUNNER_URL = RUNNER_URL;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  delete process.env.S2S_RUNNER_URL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('runAction preview branch', () => {
  it('rejects with an actionable non-JSON message (not a raw SyntaxError) on a plain-text 500', async () => {
    fetchMock.mockResolvedValue(textResponse('Internal Server Error', 500));

    const err = await runAction(true, mockLit, CID, INPUTS).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect((err as Error).message).toContain('non-JSON');
    expect((err as Error).message).toContain('500');
    expect((err as Error).message).toContain('Internal Server Error');
  });

  it('returns wrapped.response on the happy path (200 JSON envelope, success:true)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, response: { ok: true } }));

    const result = await runAction(true, mockLit, CID, INPUTS);

    expect(result).toEqual({ ok: true });
  });

  it('preserves the request shape and attaches an AbortSignal.timeout to the fetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, response: { ok: true } }));

    await runAction(true, mockLit, CID, INPUTS);

    expect(fetchMock).toHaveBeenCalledWith(
      RUNNER_URL,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cid: CID, inputs: INPUTS }),
        signal: expect.any(AbortSignal) as AbortSignal,
      }),
    );
  });

  it('truncates long plain-text bodies to 200 chars in the error message', async () => {
    fetchMock.mockResolvedValue(textResponse('x'.repeat(500), 502));

    const err = await runAction(true, mockLit, CID, INPUTS).catch((e: unknown) => e);

    expect((err as Error).message).toBe(`runner 502 returned non-JSON: ${'x'.repeat(200)}`);
  });

  it('keeps the success===false logging behavior and still returns wrapped.response', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(
      jsonResponse({ success: false, error: 'boom', response: { ok: false } }),
    );

    const result = await runAction(true, mockLit, CID, INPUTS);

    expect(result).toEqual({ ok: false });
    expect(logSpy).toHaveBeenCalledWith('bun serverless call failed: boom');
    logSpy.mockRestore();
  });
});
