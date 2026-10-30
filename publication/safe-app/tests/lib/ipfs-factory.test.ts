import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchFromIPFS, add, dagPut, dagExport } from '../../src/lib/ipfs.factory';

type FetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
  json: () => Promise<any>;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

function makeResponse(overrides: Partial<FetchResponse> & { bodyText?: string }): FetchResponse {
  const body = overrides.bodyText ?? '';
  return {
    ok: overrides.ok ?? true,
    status: overrides.status ?? 200,
    statusText: overrides.statusText ?? 'OK',
    text: async () => body,
    json: async () => JSON.parse(body),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  };
}

describe('fetchFromIPFS', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the cat endpoint with the gateway and cid, then parses JSON', async () => {
    fetchMock.mockResolvedValue(makeResponse({ bodyText: '{"ok":true}' }));
    const result = await fetchFromIPFS('https://gateway.example', 'QmCid');
    expect(result).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway.example/api/v0/cat?arg=QmCid');
    expect(init?.method).toBe('POST');
  });

  it('throws with the status text when the response is not ok', async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 500, statusText: 'boom', bodyText: 'err body' }));
    await expect(fetchFromIPFS('https://gw', 'QmX')).rejects.toThrow(/Failed to fetch from IPFS: 500 boom/);
  });

  it('throws a specific error for non-JSON bodies', async () => {
    fetchMock.mockResolvedValue(makeResponse({ bodyText: '<html>not json</html>' }));
    await expect(fetchFromIPFS('https://gw', 'QmX')).rejects.toThrow('Invalid JSON response from IPFS');
  });
});

describe('add', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs multipart form-data to /api/v0/add and returns result.Hash', async () => {
    fetchMock.mockResolvedValue(makeResponse({ bodyText: '{"Hash":"QmAdded","Name":"x"}' }));
    const result = await add('hello', 'x.txt', 'ipfs.local');
    expect(result).toBe('QmAdded');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ipfs.local/api/v0/add');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    const fd = init?.body as FormData;
    expect(fd.get('file')).toBeInstanceOf(Blob);
    expect((fd.get('file') as Blob).type).toBe('text/plain');
  });

  it('uses only-hash=true when onlyHash is set', async () => {
    fetchMock.mockResolvedValue(makeResponse({ bodyText: '{"Hash":"QmOnly"}' }));
    await add('data', 'x', 'ipfs.local', true);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://ipfs.local/api/v0/add?only-hash=true');
  });

  it('normalizes the endpoint (strips protocol and trailing slashes)', async () => {
    fetchMock.mockResolvedValue(makeResponse({ bodyText: '{"Hash":"QmN"}' }));
    await add('data', 'x', 'http://ipfs.local:5001/');
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://ipfs.local:5001/api/v0/add');
  });

  it('falls back to Cid and Cid[/] fields for the hash', async () => {
    fetchMock.mockResolvedValue(makeResponse({ bodyText: '{"Cid":{"/":"bafyX"}}' }));
    await expect(add('data', 'x', 'gw')).resolves.toBe('bafyX');

    fetchMock.mockResolvedValue(makeResponse({ bodyText: '{"Cid":"bafyY"}' }));
    await expect(add('data', 'x', 'gw')).resolves.toBe('bafyY');
  });

  it('throws a descriptive error when the request fails', async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 401, statusText: 'Unauthorized', bodyText: 'no' }));
    await expect(add('data', 'x', 'gw')).rejects.toThrow(/IPFS add failed: 401 Unauthorized/);
  });
});

describe('dagPut', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to /api/v0/dag/put and returns the Cid[/] value', async () => {
    fetchMock.mockResolvedValue(makeResponse({ bodyText: '{"Cid":{"/":"bafydag"}}' }));
    const result = await dagPut('{"a":1}', 'dag.json', 'ipfs.local');
    expect(result).toBe('bafydag');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ipfs.local/api/v0/dag/put');
    expect(init?.method).toBe('POST');
    const fd = init?.body as FormData;
    expect((fd.get('object data') as Blob).type).toBe('application/json');
  });

  it('falls back to Cid string form when Cid[/] is absent', async () => {
    fetchMock.mockResolvedValue(makeResponse({ bodyText: '{"Cid":"bafydag2"}' }));
    await expect(dagPut('{}', 'x', 'gw')).resolves.toBe('bafydag2');
  });

  it('throws when only Hash is present (Cid[/] access is unguarded in the source)', async () => {
    fetchMock.mockResolvedValue(makeResponse({ bodyText: '{"Hash":"QmH"}' }));
    await expect(dagPut('{}', 'x', 'gw')).rejects.toThrow();
  });

  it('throws on failure', async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 500, statusText: 'ERR', bodyText: 'x' }));
    await expect(dagPut('{}', 'x', 'gw')).rejects.toThrow(/DAG put failed: 500 ERR/);
  });
});

describe('dagExport', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to /api/v0/dag/export with the cid arg and returns the bytes', async () => {
    const body = new TextEncoder().encode('CAR-DATA');
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      json: async () => ({}),
      arrayBuffer: async () => body.buffer as ArrayBuffer,
    });
    const result = await dagExport('bafyX', 'ipfs.local');
    expect(result).toEqual(new Uint8Array(body));
    expect(fetchMock.mock.calls[0][0]).toBe('https://ipfs.local/api/v0/dag/export?arg=bafyX');
  });

  it('throws on failure', async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 404, statusText: 'Not Found', bodyText: '' }));
    await expect(dagExport('bafyX', 'gw')).rejects.toThrow(/DAG export failed: 404 Not Found/);
  });
});
