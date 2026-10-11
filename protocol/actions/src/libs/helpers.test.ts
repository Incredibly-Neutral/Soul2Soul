import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setRpcAuth, fetchWithTimeout } from './helpers';

// ============================================================================
// setRpcAuth + fetchWithTimeout — Kubo RPC bearer-token injection.
//
// The data gateway (ipfs.transport-union.dev) token-gates write RPC commands
// (add, dag/put, pin/add, files/*) behind an `Authorization: Bearer <token>`
// check. Each action's main() calls setRpcAuth(endpoints.ipfsGatewayAuth) once,
// and fetchWithTimeout injects the header — but ONLY on `/api/v0/` URLs, so the
// token never leaks to GitHub/Filecoin/runner fetches. Reads are public on the
// gateway, but sending the token on them too is harmless and keeps the actions
// working once Kubo node-wide API.Authorizations is enabled (defense-in-depth).
// ============================================================================

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
  // swap in the mock
  (globalThis as any).fetch = mockFetch;
  setRpcAuth(undefined); // clean state between tests
});

afterEach(() => {
  setRpcAuth(undefined);
});

const collectHeaders = (url: string, options: RequestInit = {}) => {
  const h = new Headers(options.headers as Record<string, string> | undefined);
  return { url, auth: h.get('Authorization') ?? null };
};

describe('setRpcAuth / fetchWithTimeout header injection', () => {
  it('sends NO Authorization header when no token is set (even on /api/v0/ URLs)', async () => {
    await fetchWithTimeout('https://ipfs.transport-union.dev/api/v0/files/cp?arg=/a&arg=/b', {
      method: 'POST',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, options] = mockFetch.mock.calls[0];
    const headers = new Headers(options.headers as Record<string, string>);
    expect(headers.get('Authorization')).toBeNull();
  });

  it('injects the Authorization header on /api/v0/ URLs after setRpcAuth', async () => {
    setRpcAuth('Bearer supersecret');
    await fetchWithTimeout('https://ipfs.transport-union.dev/api/v0/dag/put', { method: 'POST' });
    const [, options] = mockFetch.mock.calls[0];
    const headers = new Headers(options.headers as Record<string, string>);
    expect(headers.get('Authorization')).toBe('Bearer supersecret');
  });

  it('does NOT leak the token to non-Kubo RPC URLs', async () => {
    setRpcAuth('Bearer supersecret');
    // GitHub upload, Filecoin pin, Lit runner — none of these may see the token.
    await fetchWithTimeout('https://api.github.com/repos/x/y/releases', {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json' },
    });
    await fetchWithTimeout('https://uploads.filebase.com/', { method: 'POST' });
    const called = mockFetch.mock.calls.map(([url, options]: [string, RequestInit]) =>
      collectHeaders(url, options),
    );
    expect(called.every((c) => c.auth === null)).toBe(true);
    expect(called).toHaveLength(2);
  });

  it('preserves caller-supplied headers and adds Authorization (merge, not overwrite)', async () => {
    setRpcAuth('Bearer tok');
    await fetchWithTimeout('https://ipfs.transport-union.dev/api/v0/add', {
      method: 'POST',
      headers: { 'X-Trace': 'abc', 'Content-Type': 'application/json' },
    });
    const [, options] = mockFetch.mock.calls[0];
    const headers = new Headers(options.headers as Record<string, string>);
    expect(headers.get('Authorization')).toBe('Bearer tok');
    expect(headers.get('X-Trace')).toBe('abc');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('clears the token when setRpcAuth() is called with undefined', async () => {
    setRpcAuth('Bearer tok');
    setRpcAuth(undefined);
    await fetchWithTimeout('https://ipfs.transport-union.dev/api/v0/cat?arg=bafy', {
      method: 'POST',
    });
    const [, options] = mockFetch.mock.calls[0];
    const headers = new Headers(options.headers as Record<string, string>);
    expect(headers.get('Authorization')).toBeNull();
  });

  it('overwrites a caller-supplied Authorization on /api/v0/ (canonical token wins)', async () => {
    setRpcAuth('Bearer canonical');
    await fetchWithTimeout('https://ipfs.transport-union.dev/api/v0/pin/add', {
      method: 'POST',
      headers: { Authorization: 'Bearer stale' },
    });
    const [, options] = mockFetch.mock.calls[0];
    const headers = new Headers(options.headers as Record<string, string>);
    expect(headers.get('Authorization')).toBe('Bearer canonical');
  });
});
