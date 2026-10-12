import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { S2SIPFSMethods } from './index';

// ============================================================================
// S2SIPFSMethods — Kubo RPC bearer-token injection.
//
// The data gateway token-gates write RPC commands (add, dag/put, files/*).
// This client (used by neutralpress new-publication and the safe-app) must send
// `Authorization: Bearer <token>` on every Kubo RPC call once the token is
// configured, or its writes 401.
// ============================================================================

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
  (globalThis as any).fetch = mockFetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const make = (token?: string) =>
  new S2SIPFSMethods('ipfs.transport-union.dev', 'pinata-jwt', '', '', token);

const headersOf = () => {
  const [, options] = mockFetch.mock.calls[0];
  return new Headers(options.headers as Record<string, string>);
};

describe('S2SIPFSMethods kubo auth injection', () => {
  it('sends NO Authorization header when no token is configured', async () => {
    const ipfs = make();
    await ipfs.fetchFromKubo('bafyabc');
    expect(headersOf().get('Authorization')).toBeNull();
  });

  it('injects Authorization: Bearer <token> on kuboPost (MFS + dag/get + cat)', async () => {
    const ipfs = make('sekret');
    await ipfs.mfsList('/tmp/x'); // routes through kuboPost
    expect(headersOf().get('Authorization')).toBe('Bearer sekret');
  });

  it('injects the token on addToKubo (/api/v0/add)', async () => {
    const ipfs = make('sekret');
    await ipfs.addToKubo('hello', 'f.txt');
    expect(headersOf().get('Authorization')).toBe('Bearer sekret');
  });

  it('injects the token on dagPut (/api/v0/dag/put)', async () => {
    const ipfs = make('sekret');
    mockFetch.mockResolvedValue(new Response('{"Cid":{"/":"QmX"}}', { status: 200 }));
    await ipfs.dagPut('{"a":1}', 'dag.json');
    expect(headersOf().get('Authorization')).toBe('Bearer sekret');
  });

  it('does NOT leak the Kubo token to Filebase/Pinata uploads', async () => {
    const ipfs = make('sekret');
    mockFetch.mockResolvedValue(new Response('{"Hash":"QmX"}', { status: 200 }));
    await ipfs.uploadToPinata('data', 'f.txt', 'filebase');
    // Header is `Bearer <filebaseToken>` (empty here) — never the Kubo token.
    expect(headersOf().get('Authorization')).toBe('Bearer');
  });
});
