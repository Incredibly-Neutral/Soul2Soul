import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  IPFS_URL,
  MFS_TIMEOUTS,
  kuboMfsPost,
  prepareTempMfs,
  kuboMfsList,
  kuboMfsStat,
  kuboMfsFlush,
  kuboMfsCp,
} from '../../src/lib/ipfs-fs.factory';

type ResponseLike = {
  ok: boolean;
  status?: number;
  statusText?: string;
  json: () => Promise<any>;
  text: () => Promise<string>;
};

const okResponse = (json: unknown): ResponseLike => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => json,
  text: async () => JSON.stringify(json),
});

const errResponse = (text = 'mfs error'): ResponseLike => ({
  ok: false,
  status: 500,
  statusText: 'ERR',
  json: async () => ({ Message: text }),
  text: async () => text,
});

describe('kuboMfsPost', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to the IPFS URL with JSON content-type and an abort signal', async () => {
    fetchMock.mockResolvedValue(okResponse({}));
    const res = await kuboMfsPost('/api/v0/files/stat?arg=x', 5_000);
    expect(res.ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${IPFS_URL}/api/v0/files/stat?arg=x`);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('surfaces ok=false and lets the caller read the error text', async () => {
    fetchMock.mockResolvedValue(errResponse('nope'));
    const res = await kuboMfsPost('/api/v0/files/ls?arg=/tmp/x', 5_000);
    expect(res.ok).toBe(false);
    await expect(res.text()).resolves.toBe('nope');
  });
});

describe('prepareTempMfs', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a fresh temp dir when there is no current root', async () => {
    fetchMock.mockResolvedValue(okResponse({}));
    const tmp = await prepareTempMfs('', 'work-1');
    expect(tmp).toBe('/tmp/work-1');

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `${IPFS_URL}/api/v0/files/mkdir?arg=${encodeURIComponent('/tmp/work-1')}&parents=true`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('copies the existing root into the temp dir when a root is present', async () => {
    fetchMock.mockResolvedValue(okResponse({}));
    const tmp = await prepareTempMfs('bafyRoot', 'work-2');
    expect(tmp).toBe('/tmp/work-2');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v0/files/cp');
    expect(String(fetchMock.mock.calls[0][0])).toContain('arg=/ipfs/bafyRoot');
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      `arg=${encodeURIComponent('/tmp/work-2')}`,
    );
    expect(String(fetchMock.mock.calls[0][0])).toContain('parents=true');
    // cp succeeded -> no mkdir fallback
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to mkdir when the cp fails', async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse('cp failed'))
      .mockResolvedValueOnce(okResponse({}));
    const tmp = await prepareTempMfs('bafyRoot', 'work-3');
    expect(tmp).toBe('/tmp/work-3');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/v0/files/mkdir');
  });

  it('throws when the mkdir fallback also fails', async () => {
    fetchMock.mockResolvedValue(errResponse('mkdir failed'));
    await expect(prepareTempMfs('bafyRoot', 'work-4')).rejects.toThrow(/Failed to create temp MFS dir: mkdir failed/);
  });

  it('throws when a fresh mkdir fails', async () => {
    fetchMock.mockResolvedValue(errResponse('nope'));
    await expect(prepareTempMfs('', 'work-5')).rejects.toThrow(/Failed to create temp MFS dir: nope/);
  });
});

describe('kuboMfsList', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps Links entries to name/hash/size/type', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        Entries: [],
        Links: [
          { Name: 'a.txt', Hash: 'QmA', Size: 10, Tsize: 0 },
          { Name: 'sub', Hash: 'QmB', Size: 0, Tsize: 1 },
        ],
      }),
    );
    const list = await kuboMfsList('/tmp/x');
    expect(list).toEqual([
      { name: 'a.txt', hash: 'QmA', size: 10, type: 'directory' },
      { name: 'sub', hash: 'QmB', size: 0, type: 'file' },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v0/files/ls');
    expect(String(fetchMock.mock.calls[0][0])).toContain(`arg=${encodeURIComponent('/tmp/x')}`);
  });

  it('returns [] when the list call fails', async () => {
    fetchMock.mockResolvedValue(errResponse());
    await expect(kuboMfsList('/tmp/x')).resolves.toEqual([]);
  });
});

describe('kuboMfsStat', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the Hash for a successful stat', async () => {
    fetchMock.mockResolvedValue(okResponse({ Hash: 'bafyStat', Size: 5 }));
    await expect(kuboMfsStat('/tmp/x')).resolves.toBe('bafyStat');
  });

  it('returns null when the stat fails', async () => {
    fetchMock.mockResolvedValue(errResponse());
    await expect(kuboMfsStat('/tmp/x')).resolves.toBeNull();
  });
});

describe('kuboMfsFlush', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('extracts the new root CID from the string form of {"/": cid}', async () => {
    fetchMock.mockResolvedValue(okResponse({ '/': 'bafyFlush' }));
    await expect(kuboMfsFlush('/tmp/x')).resolves.toEqual({ ok: true, cid: 'bafyFlush' });
  });

  it('extracts a plain string Hash / Cid forms', async () => {
    fetchMock.mockResolvedValue(okResponse('bafyString'));
    await expect(kuboMfsFlush('/tmp/x')).resolves.toEqual({ ok: true, cid: 'bafyString' });

    fetchMock.mockResolvedValue(okResponse({ Hash: 'bafyHash' }));
    await expect(kuboMfsFlush('/tmp/x')).resolves.toEqual({ ok: true, cid: 'bafyHash' });

    fetchMock.mockResolvedValue(okResponse({ Cid: { '/': 'bafyNested' } }));
    await expect(kuboMfsFlush('/tmp/x')).resolves.toEqual({ ok: true, cid: 'bafyNested' });
  });

  it('returns ok=false when the flush fails', async () => {
    fetchMock.mockResolvedValue(errResponse());
    await expect(kuboMfsFlush('/tmp/x')).resolves.toEqual({ ok: false, cid: '' });
  });
});

describe('kuboMfsCp', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true and posts with flush=false', async () => {
    fetchMock.mockResolvedValue(okResponse({}));
    await expect(kuboMfsCp('bafySrc', '/tmp/dest')).resolves.toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v0/files/cp');
    expect(String(fetchMock.mock.calls[0][0])).toContain('flush=false');
  });

  it('returns false when the cp fails', async () => {
    fetchMock.mockResolvedValue(errResponse('cp failed'));
    await expect(kuboMfsCp('bafySrc', '/tmp/dest')).resolves.toBe(false);
  });
});
