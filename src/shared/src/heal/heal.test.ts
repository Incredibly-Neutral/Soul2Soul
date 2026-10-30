// heal primitive tests — the shared "pin a remote CID everywhere" runner.
//
// Exercises the real healCid against a stubbed global fetch: kubo pin/add
// against the remote gateway, pinata + filebase through the REAL
// pinCidFromRemote (so the wire shapes those providers send stay locked), and
// the injected filecoin uploader. Fail-open behavior (one provider rejects,
// the rest still run) is covered by making the fetch mock throw per-URL.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  healCid,
  HEAL_PROVIDERS,
  type HealConfig,
  type HealFilecoinUploader,
} from './heal';

const SOURCE = 'https://ipfs.transport-union.dev';
const CID = 'QmTestHealCid123456789012345678901234567890';

/** Route a mocked global fetch by URL so each provider hits its own endpoint. */
function stubFetch(
  routes: Record<string, () => Response>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string | URL | Request, _init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : String(url);
    const handler = Object.entries(routes).find(([needle]) => href.includes(needle))?.[1];
    if (!handler) throw new Error(`no mock route for ${href}`);
    return handler();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Minimal JSON 200 response (pinCidFromRemote reads `.json()`). */
function jsonOk(): Response {
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function uploader(
  copyCount: number,
  extra: { pieceCid?: string; copies?: Array<{ provider: string; dealId?: string }> } = {},
): HealFilecoinUploader {
  return vi.fn(async () => ({ copyCount, ...extra })) as unknown as HealFilecoinUploader;
}

function baseConfig(over: Partial<HealConfig> = {}): HealConfig {
  return { source: SOURCE, ...over };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('HEAL_PROVIDERS', () => {
  it('default provider array is kubo, pinata, filebase, filecoin', () => {
    expect(HEAL_PROVIDERS).toEqual(['kubo', 'pinata', 'filebase', 'filecoin']);
  });
});

describe('kubo pin/add', () => {
  it('POSTs to ${source}/api/v0/pin/add?arg=<cid>, ok on 2xx', async () => {
    const fetchMock = stubFetch({
      '/api/v0/pin/add': () => new Response(null, { status: 200 }),
    });
    const outcome = await healCid(CID, baseConfig(), ['kubo']);

    expect(outcome.ok).toBe(true);
    expect(outcome.partial).toBe(false);
    expect(outcome.sources).toEqual({ kubo: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe(`${SOURCE}/api/v0/pin/add?arg=${CID}`);
    expect(init?.method).toBe('POST');
    // no token configured → no Authorization header
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
    expect(outcome.results[0]?.ok).toBe(true);
  });

  it('sends Bearer kuboToken when set', async () => {
    const fetchMock = stubFetch({
      '/api/v0/pin/add': () => new Response(null, { status: 200 }),
    });
    await healCid(CID, baseConfig({ kuboToken: 'tok-123' }), ['kubo']);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });

  it('records error and ok=false on 5xx, and never rejects', async () => {
    stubFetch({
      '/api/v0/pin/add': () => new Response('boom', { status: 503, statusText: 'Service Unavailable' }),
    });
    const outcome = await healCid(CID, baseConfig(), ['kubo']);
    expect(outcome.ok).toBe(false);
    expect(outcome.sources).toEqual({});
    expect(outcome.results[0]?.ok).toBe(false);
    expect(outcome.results[0]?.error).toContain('503');
  });
});

describe('pinata + filebase through the real pinCidFromRemote', () => {
  it('runs both against their real endpoints and returns ok', async () => {
    const fetchMock = stubFetch({
      'https://api.pinata.cloud/pinning/pinByHash': jsonOk,
      'https://api.filebase.io/v1/ipfs/pins': jsonOk,
    });
    const outcome = await healCid(
      CID,
      baseConfig({ pinataJwt: 'pinata-tok', filebaseToken: 'filebase-tok' }),
      ['pinata', 'filebase'],
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.partial).toBe(false);
    expect(outcome.sources).toEqual({ pinata: true, filebase: true });

    const urls = fetchMock.mock.calls.map((c) => c[0]) as string[];
    expect(urls).toEqual([
      'https://api.pinata.cloud/pinning/pinByHash',
      'https://api.filebase.io/v1/ipfs/pins',
    ]);
    // pinata is a pull-from-remote (sourceIpfs.apiUrl = source/api/v0)
    const pinataBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      pinataOptions: { sourceIpfs: { apiUrl: string } };
    };
    expect(pinataBody.pinataOptions.sourceIpfs.apiUrl).toBe(`${SOURCE}/api/v0`);
    expect(outcome.results.map((r) => [r.provider, r.ok])).toEqual([
      ['pinata', true],
      ['filebase', true],
    ]);
  });

  it('propagates a false pinCidFromRemote return as a not-ok result', async () => {
    stubFetch({
      'https://api.pinata.cloud/pinning/pinByHash': () =>
        new Response('nope', { status: 500, statusText: 'Internal Server Error' }),
    });
    const outcome = await healCid(CID, baseConfig({ pinataJwt: 'x' }), ['pinata']);
    expect(outcome.ok).toBe(false);
    expect(outcome.results[0]?.ok).toBe(false);
    expect(outcome.results[0]?.error).toContain('pinata');
  });
});

describe('filecoin', () => {
  it('calls the injected uploader with (cid, source); ok when copyCount >= 2', async () => {
    const up = uploader(2, {
      pieceCid: 'bagaCoezTest',
      copies: [
        { provider: 'filecoin', dealId: 'deal-1' },
        { provider: 'filecoin', dealId: 'deal-2' },
      ],
    });
    const outcome = await healCid(CID, baseConfig({ filecoin: up }), ['filecoin']);

    expect(up).toHaveBeenCalledTimes(1);
    expect(up).toHaveBeenCalledWith(CID, SOURCE);
    expect(outcome.ok).toBe(true);
    const result = outcome.results[0];
    expect(result?.ok).toBe(true);
    expect(result?.copyCount).toBe(2);
    expect(result?.pieceCid).toBe('bagaCoezTest');
    expect(result?.copies?.length).toBe(2);
    expect(outcome.sources).toEqual({ filecoin: true });
  });

  it('not-ok + error when copyCount < 2', async () => {
    const up = uploader(1);
    const outcome = await healCid(CID, baseConfig({ filecoin: up }), ['filecoin']);
    expect(outcome.ok).toBe(false);
    expect(outcome.results[0]?.ok).toBe(false);
    expect(outcome.results[0]?.copyCount).toBe(1);
    expect(outcome.results[0]?.error).toContain('1');
    expect(outcome.results[0]?.error).toContain('2');
  });

  it('records a clear error when no uploader is configured', async () => {
    const outcome = await healCid(CID, baseConfig(), ['filecoin']);
    expect(outcome.ok).toBe(false);
    expect(outcome.results[0]?.ok).toBe(false);
    expect(outcome.results[0]?.error).toBe('no filecoin uploader configured');
  });
});

describe('fail-open', () => {
  it('one provider rejecting → others still run; partial true; sources only the ok ones', async () => {
    const fetchMock = stubFetch({
      // kubo: network dies
      '/api/v0/pin/add': () => {
        throw new Error('network down');
      },
      'https://api.pinata.cloud/pinning/pinByHash': jsonOk,
      'https://api.filebase.io/v1/ipfs/pins': jsonOk,
    });
    const up = uploader(2);
    const outcome = await healCid(
      CID,
      baseConfig({ pinataJwt: 'p', filebaseToken: 'f', filecoin: up }),
      ['kubo', 'pinata', 'filebase', 'filecoin'],
    );

    // all four still attempted
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(up).toHaveBeenCalledTimes(1);
    // kubo failed, three ok
    expect(outcome.ok).toBe(false);
    expect(outcome.partial).toBe(true);
    expect(outcome.sources).toEqual({ pinata: true, filebase: true, filecoin: true });
    const kubo = outcome.results.find((r) => r.provider === 'kubo');
    expect(kubo?.ok).toBe(false);
    expect(kubo?.error).toContain('network down');
    expect(outcome.results.every((r) => r.ms !== undefined)).toBe(true);
  });
});

describe('normalization', () => {
  it('trims whitespace and strips the ipfs:// prefix before healing', async () => {
    const up = uploader(2);
    const outcome = await healCid(`  ipfs://${CID}  `, baseConfig({ filecoin: up }), ['filecoin']);
    expect(outcome.cid).toBe(CID);
    expect(up).toHaveBeenCalledWith(CID, SOURCE);
    expect(outcome.ok).toBe(true);
  });

  it('returns a non-throwing empty outcome when nothing remains after normalize', async () => {
    for (const garbage of ['', '   ', 'ipfs://', '  ipfs://  ']) {
      const outcome = await healCid(garbage, baseConfig({ filecoin: uploader(2) }));
      expect(outcome).toEqual({
        cid: garbage,
        results: [],
        ok: false,
        partial: false,
        sources: {},
      });
    }
  });

  it('defaults to HEAL_PROVIDERS (all four) when providers omitted', async () => {
    const fetchMock = stubFetch({
      '/api/v0/pin/add': () => new Response(null, { status: 200 }),
      'https://api.pinata.cloud/pinning/pinByHash': jsonOk,
      'https://api.filebase.io/v1/ipfs/pins': jsonOk,
    });
    const up = uploader(2);
    const outcome = await healCid(CID, baseConfig({ pinataJwt: 'p', filebaseToken: 'f', filecoin: up }));
    expect(outcome.results.map((r) => r.provider)).toEqual(['kubo', 'pinata', 'filebase', 'filecoin']);
    expect(outcome.ok).toBe(true);
    expect(outcome.partial).toBe(false);
    expect(outcome.sources).toEqual({
      kubo: true,
      pinata: true,
      filebase: true,
      filecoin: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
