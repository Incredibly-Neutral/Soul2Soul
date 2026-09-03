import { describe, it, expect, vi, afterEach } from 'vitest';
import type { LitService } from '../lit';
import { runAction } from './helpers';

const CID = 'QmbuKJDA9WCJgtS54JQWVUr8WwEvsppC7wAY6RcygubK2o';
const USAGE_KEY = 'u'.repeat(44);

/** AbortError — the same signal `callWithTimeout` relies on to surface a timeout. */
function makeAbortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * A fetch implementation that never resolves on its own — it only rejects when
 * the caller aborts the request signal (exactly what callWithTimeout does after
 * the timeout window). Simulates a stalled Pinata gateway that would otherwise
 * hang forever inside Electron's main process.
 */
function hangingFetch(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(makeAbortError());
      return;
    }
    signal.addEventListener('abort', () => {
      reject(makeAbortError());
    }, { once: true });
  });
}

/**
 * Minimal LitService stub. In the live code-fetch path the fetch throws before
 * executeAction is ever reached, so a real service is never needed.
 */
function litStub(): LitService {
  return { executeAction: vi.fn() } as unknown as LitService;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('runAction live code-CID fetch hardening', () => {
  it('throws a timeout error when the Pinata gateway fetch never resolves', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(hangingFetch));

    const promise = runAction(false, litStub(), CID, {}, USAGE_KEY);
    vi.advanceTimersByTime(30_000);

    await expect(promise).rejects.toThrow('Timed out after 30s');
  });

  it('throws a descriptive error including status and cid on a non-ok gateway response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('upstream error', { status: 502, statusText: 'Bad Gateway' }))),
    );

    await expect(runAction(false, litStub(), CID, {}, USAGE_KEY)).rejects.toThrow(
      `render action code fetch failed for cid=${CID}: HTTP 502`,
    );
  });
});
