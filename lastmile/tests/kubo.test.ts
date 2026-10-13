import { afterEach, describe, expect, it, vi } from 'vitest';
import { KuboClient } from '../src/kubo';

const BASE = 'http://127.0.0.1:25011/';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('KuboClient.pinAdd', () => {
  it('POSTs /ipfs/<cid> (encoded) to pin/add and returns { cid, pinned: true }', async () => {
    const cid = 'QmRecursiveTestCid000000000000000000000001';
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    stubFetch(async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse({ Pins: [cid] });
    });

    const client = new KuboClient(BASE);
    const result = await client.pinAdd(cid);

    expect(capturedUrl).toBe(`http://127.0.0.1:25011/api/v0/pin/add?arg=%2Fipfs%2F${cid}`);
    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({ cid, pinned: true });
  });

  it('strips a trailing slash from the base URL', async () => {
    let capturedUrl = '';
    stubFetch(async (url) => {
      capturedUrl = url;
      return jsonResponse({ Pins: ['QmX'] });
    });
    await new KuboClient('http://127.0.0.1:25011//').pinAdd('QmX');
    expect(capturedUrl.startsWith('http://127.0.0.1:25011/api/v0/pin/add')).toBe(true);
  });

  it('throws on non-2xx with status and a body snippet', async () => {
    stubFetch(async () =>
      jsonResponse({ Message: 'context deadline exceeded', Code: 0, Type: 'error' }, 500),
    );
    const client = new KuboClient(BASE);
    await expect(client.pinAdd('QmBroken')).rejects.toThrow(
      /kubo pinAdd failed for QmBroken: 500 .*context deadline exceeded/,
    );
  });
});

describe('KuboClient.unpin', () => {
  it('resolves on a successful pin/rm', async () => {
    stubFetch(async (url) => {
      expect(url).toBe('http://127.0.0.1:25011/api/v0/pin/rm?arg=QmX');
      return jsonResponse({ Pins: ['QmX'] });
    });
    await expect(new KuboClient(BASE).unpin('QmX')).resolves.toBeUndefined();
  });

  it('treats a 404 "not pinned" error body as a no-op', async () => {
    stubFetch(async () =>
      jsonResponse({ Message: 'not pinned or pinned indirectly', Code: 0, Type: 'error' }, 404),
    );
    await expect(new KuboClient(BASE).unpin('QmX')).resolves.toBeUndefined();
  });

  it('treats a 500 "not pinned" error body as a no-op', async () => {
    stubFetch(async () =>
      jsonResponse({ Message: 'not pinned or pinned indirectly', Code: 0, Type: 'error' }, 500),
    );
    await expect(new KuboClient(BASE).unpin('QmX')).resolves.toBeUndefined();
  });

  it('throws on other errors', async () => {
    stubFetch(async () => jsonResponse({ Message: 'boom' }, 500));
    await expect(new KuboClient(BASE).unpin('QmX')).rejects.toThrow(/kubo unpin failed for QmX: 500/);
  });
});

describe('KuboClient.listPins', () => {
  it('POSTs pin/ls?type=recursive and parses the Keys object', async () => {
    let capturedUrl = '';
    stubFetch(async (url) => {
      capturedUrl = url;
      return jsonResponse({
        Keys: {
          QmA: { Type: 'recursive' },
          QmB: { Type: 'recursive' },
        },
      });
    });

    const pins = await new KuboClient(BASE).listPins();

    expect(capturedUrl).toBe('http://127.0.0.1:25011/api/v0/pin/ls?type=recursive');
    expect(pins).toEqual(['QmA', 'QmB']);
  });

  it('returns [] when Keys is absent', async () => {
    stubFetch(async () => jsonResponse({}));
    await expect(new KuboClient(BASE).listPins()).resolves.toEqual([]);
  });
});
