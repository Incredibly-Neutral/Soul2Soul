// cid-view ipfs-check-client tests — the batch transport layer.
//
// statusFromCheckLine: pure mapping over the parser (real fixtures covered in
// retrieval-parser.test.ts; here we assert the client's own conventions —
// error lines, non-array results, platform verdicts via a synthetic provider).
// checkRetrievability: chunked orchestration with an INJECTED fake cache (no
// window/localStorage — the storage-agnostic core), stubbed global fetch.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PublicationCidView } from './types';
import type { CidRetrievabilityMap, CidRetrievabilityStatus, RetrievabilitySource } from './retrievability';
import type { IpfsCheckProvider } from './retrieval-parser';
import {
  checkRetrievability,
  statusFromCheckLine,
  type IpfsCheckBatchCache,
} from './ipfs-check-client';

const SOURCES_FALSE: Record<RetrievabilitySource, boolean> = {
  kubo: false,
  pinata: false,
  filebase: false,
  filecoin: false,
};

/** Default provider: a kubo peer that found the cid over Bitswap. */
function provider(over: Partial<IpfsCheckProvider> = {}): IpfsCheckProvider {
  return {
    ID: '12D3KooWTest',
    Addrs: [],
    AgentVersion: 'unknown-agent/1.0',
    Source: 'ipni',
    DataAvailableOverBitswap: { Enabled: true, Found: true },
    ...over,
  };
}

/** Minimal schema-valid view (the batch client keeps it void; shape only). */
function view(cids: string[]): PublicationCidView {
  return {
    publication: 'test.eth',
    generatedAt: '2026-01-01T00:00:00.000Z',
    entries: cids.map((cid, i) => ({ cid, category: i % 2 === 0 ? 'config' : 'deal', source: 'config' })),
    sources: { deals: false, config: false, tree: false, archive: false },
    summary: { total: cids.length, uniqueCids: cids.length, byCategory: {} },
  };
}

/** Build a Response whose body is a streaming NDJSON document (as the real endpoint). */
function ndjsonResponse(lines: string[]): Response {
  return new Response(lines.join('\n') + '\n', {
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

/** A Map-backed cache fulfilling the injected IpfsCheckBatchCache contract. */
function fakeCache(): {
  cache: IpfsCheckBatchCache;
  store: Map<string, CidRetrievabilityMap>;
  raws: { publication: string; cids: number; raw: string }[];
} {
  const store = new Map<string, CidRetrievabilityMap>();
  const raws: { publication: string; cids: number; raw: string }[] = [];
  const cache: IpfsCheckBatchCache = {
    load: (p) => store.get(p) ?? null,
    save: (p, m) => void store.set(p, m),
    logRaw: (p, n, raw) => void raws.push({ publication: p, cids: n, raw }),
  };
  return { cache, store, raws };
}

describe('statusFromCheckLine', () => {
  const now = () => '2026-01-01T00:00:00.000Z';

  it('error line → failed, keeps the previous result, records lastError/lastErrorAt', () => {
    const prev: CidRetrievabilityStatus = {
      checkedAt: '2025-12-31T00:00:00.000Z',
      copies: 2,
      sources: { kubo: true, pinata: true, filebase: false, filecoin: false },
      state: 'ok',
    };
    const status = statusFromCheckLine({ cid: 'bafyconfig', error: 'boom' }, { now, prev });
    // Last-known result preserved — a failed check never reads as lost data.
    expect(status).toEqual({
      ...prev,
      state: 'failed',
      lastError: 'boom',
      lastErrorAt: now(),
    });
    // Without a previous result: empty baseline + failed flag.
    const fresh = statusFromCheckLine({ cid: 'bafyconfig', error: 'boom' }, { now });
    expect(fresh.copies).toBe(0);
    expect(fresh.sources).toEqual(SOURCES_FALSE);
    expect(fresh.state).toBe('failed');
    expect(fresh.lastError).toBe('boom');
  });

  it('non-array result (MutableResolution) → no-providers, all-false, no error', () => {
    const status = statusFromCheckLine(
      { cid: 'bafyconfig', result: { MutableResolution: { Path: '/ipns/foo' } } },
      { now },
    );
    expect(status.copies).toBe(0);
    expect(status.sources).toEqual(SOURCES_FALSE);
    expect(status.state).toBe('no-providers');
    expect(status.lastError).toBeUndefined();
  });

  it('empty provider list → no-providers (nobody announces it)', () => {
    const status = statusFromCheckLine({ cid: 'bafydeal1', result: [] }, { now });
    expect(status.sources).toEqual(SOURCES_FALSE);
    expect(status.state).toBe('no-providers');
    expect(status.providersFound).toBe(0);
  });

  it('serving providers → ok, platforms classified, providersFound reported', () => {
    const status = statusFromCheckLine(
      {
        cid: 'bafyconfig',
        ms: 42,
        result: [
          provider({ ID: '12D3KooWfilebase', Addrs: ['/dns4/bitswap.filebase.io/tcp/4001'] }),
          provider({ ID: '12D3KooWkubo', AgentVersion: 'kubo/0.29.0/' }),
          provider({
            ID: '12D3KooWsp',
            AgentVersion: 'boost-v2.3.0',
            DataAvailableOverBitswap: { Enabled: true, Found: false },
          }),
        ],
      },
      { now },
    );
    expect(status.sources.filebase).toBe(true);
    expect(status.sources.kubo).toBe(true);
    expect(status.sources.filecoin).toBe(false); // not found → not counted
    expect(status.sources.pinata).toBe(false);
    expect(status.copies).toBe(2);
    expect(status.state).toBe('ok');
    expect(status.providersFound).toBe(3);
    expect(status.ms).toBe(42);
  });

  it('two Filecoin SPs serving → providersBySource names both (2-dot case)', () => {
    const status = statusFromCheckLine(
      {
        cid: 'bafysp2',
        result: [
          provider({
            ID: '12D3KooWsp1',
            Addrs: ['/dns/main.ezpdpz.net/tcp/443/https'],
            DataAvailableOverHTTP: { Enabled: true, Found: true },
          }),
          provider({
            ID: '12D3KooWsp2',
            Addrs: ['/dns/main2.ezpdpz.net/tcp/443/https'],
            DataAvailableOverHTTP: { Enabled: true, Found: true },
          }),
        ],
      },
      { now },
    );
    expect(status.sources.filecoin).toBe(true);
    expect(status.providersBySource?.filecoin).toEqual([
      'ezpdpz-main (SP 1)',
      'ezpdpz-main2 (SP 32)',
    ]);
    expect(status.providersBySource?.kubo).toBeUndefined();
    // copies is per-platform: 2 SPs are still a single filecoin copy.
    expect(status.copies).toBe(1);
    expect(status.state).toBe('ok');
  });

  it('no serving providers → providersBySource omitted', () => {
    const status = statusFromCheckLine(
      { cid: 'bafynothing', result: [] },
      { now },
    );
    expect(status.providersBySource).toBeUndefined();
    expect(status.state).toBe('no-providers');
  });

  it('providers reached but none had the cid → not-served', () => {
    const status = statusFromCheckLine(
      {
        cid: 'bafyconfig',
        result: [provider({ DataAvailableOverBitswap: { Enabled: true, Found: false } })],
      },
      { now },
    );
    expect(status.copies).toBe(0);
    expect(status.sources).toEqual(SOURCES_FALSE);
    expect(status.state).toBe('not-served');
  });

  it('every provider unreachable → inconclusive, preserves the previous result', () => {
    const unreachable = provider({
      ConnectionError: 'failed to dial',
      DataAvailableOverBitswap: { Enabled: true, Found: false },
    });
    // With a previous result: last-known sources/copies/checkedAt are kept.
    const prev: CidRetrievabilityStatus = {
      checkedAt: '2025-12-31T00:00:00.000Z',
      copies: 1,
      sources: { kubo: true, pinata: false, filebase: false, filecoin: false },
      state: 'ok',
    };
    const withPrev = statusFromCheckLine(
      { cid: 'bafyconfig', ms: 9, result: [unreachable] },
      { now, prev },
    );
    expect(withPrev.copies).toBe(1); // last-known kept — not zeroed
    expect(withPrev.sources.kubo).toBe(true);
    expect(withPrev.checkedAt).toBe('2025-12-31T00:00:00.000Z'); // stays unfresh → retried
    expect(withPrev.state).toBe('inconclusive');
    expect(withPrev.lastError).toBe('all providers unreachable');
    // Without a previous result: all-false baseline + inconclusive flag, and
    // checkedAt stays '' so the cid is never treated as fresh → retried next
    // auto pass (consistent with the failed path).
    const fresh = statusFromCheckLine({ cid: 'bafyconfig', result: [unreachable] }, { now });
    expect(fresh.copies).toBe(0);
    expect(fresh.sources).toEqual(SOURCES_FALSE);
    expect(fresh.state).toBe('inconclusive');
    expect(fresh.checkedAt).toBe('');
    expect(fresh.lastError).toBe('all providers unreachable');
    expect(fresh.lastErrorAt).toBe(now());
  });

  it('one serving provider among unreachable ones → ok', () => {
    const status = statusFromCheckLine(
      {
        cid: 'bafyconfig',
        result: [
          provider({
            ID: '12D3KooWdown',
            ConnectionError: 'failed to dial',
            DataAvailableOverBitswap: { Enabled: true, Found: false },
          }),
          provider({ ID: '12D3KooWup', AgentVersion: 'kubo/0.29.0/' }),
        ],
      },
      { now },
    );
    expect(status.copies).toBe(1);
    expect(status.state).toBe('ok');
  });

  it('real ipfs-check provider (filebase megaphone node) → filebase only, ok', () => {
    // Observed live from https://ipfs-check.transport-union.dev/batch for the
    // s3nl.soul2soul.eth site root — a Filebase node serving the cid over
    // Bitswap (agent "megaphone", /dnsaddr/bitswap.filebase.io, source IPNI).
    const filebaseMegaphone: IpfsCheckProvider = {
      ID: '12D3KooWGtYkBAaqJMJEmywMxaCiNP7LCEFUAFiLEBASe232c2VH',
      Addrs: ['/dnsaddr/bitswap.filebase.io'],
      AgentVersion: 'megaphone',
      Source: 'IPNI',
      DataAvailableOverBitswap: { Enabled: true, Found: true },
      DataAvailableOverHTTP: { Enabled: false, Found: false },
    };
    const status = statusFromCheckLine({ cid: 'bafyroot', result: [filebaseMegaphone] }, { now });
    expect(status.sources.filebase).toBe(true);
    expect(status.sources.kubo).toBe(false);
    expect(status.sources.pinata).toBe(false);
    expect(status.sources.filecoin).toBe(false);
    expect(status.copies).toBe(1);
    expect(status.state).toBe('ok');
    expect(status.providersFound).toBe(1);
  });

  it('dedupes providers by ID (first occurrence wins)', () => {
    const status = statusFromCheckLine(
      {
        cid: 'bafyconfig',
        result: [
          provider({ ID: '12D3KooWdup', AgentVersion: 'kubo/0.29.0/' }),
          provider({ ID: '12D3KooWdup', AgentVersion: 'something-else/' }),
        ],
      },
      { now },
    );
    expect(status.providersFound).toBe(1);
    expect(status.copies).toBe(1);
    expect(status.state).toBe('ok');
  });

  it('s2s deal cids with no providers do NOT imply a filecoin copy (no-providers)', () => {
    // bafydeal1 is an s2s publication deal (author + publication), NOT a
    // Filecoin storage deal — with no serving provider in the report it must
    // NOT light the filecoin dot.
    const status = statusFromCheckLine({ cid: 'bafydeal1', result: [] }, { now });
    expect(status.sources.filecoin).toBe(false);
    expect(status.copies).toBe(0);
    expect(status.sources).toEqual(SOURCES_FALSE);
    expect(status.state).toBe('no-providers');
  });
});

describe('checkRetrievability', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('chunks at batchSize, streams results, merges prev, persists after each chunk', async () => {
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { cids: string[] };
      const lines = body.cids.map((cid) => JSON.stringify({ cid, ms: 1, result: [] }));
      return ndjsonResponse(lines);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { cache, store, raws } = fakeCache();
    const prev: CidRetrievabilityMap = {
      bafyprev: {
        checkedAt: '2026-01-01T00:00:00.000Z',
        copies: 1,
        sources: { kubo: true, pinata: false, filebase: false, filecoin: false },
        state: 'ok',
      },
    };
    const onResult = vi.fn();
    const cids = ['bafy1', 'bafy2', 'bafy3', 'bafy4', 'bafy5', 'bafy6'];
    const map = await checkRetrievability('test.eth', view(cids), cids, {
      prev,
      cache,
      batchSize: 3,
      onResult,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as { cids: string[] }).cids).toEqual([
      'bafy1',
      'bafy2',
      'bafy3',
    ]);
    expect((JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string) as { cids: string[] }).cids).toEqual([
      'bafy4',
      'bafy5',
      'bafy6',
    ]);
    expect(onResult).toHaveBeenCalledTimes(6);
    expect(map.bafyprev).toEqual(prev.bafyprev);
    expect(Object.keys(map).length).toBe(7);
    // persisted after each chunk + raw body logged per batch
    expect(store.get('test.eth')).toEqual(map);
    expect(raws.map((r) => r.cids)).toEqual([3, 3]);
    expect(raws[0].raw).toContain('"cid":"bafy1"');
  });

  it('empty cids → no fetch, persists the baseline', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { cache, store } = fakeCache();
    const map = await checkRetrievability('test.eth', view([]), [], { cache });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(map).toEqual({});
    expect(store.get('test.eth')).toEqual({});
  });

  it('throwing fetch marks every chunk cid failed, keeping any last-known result (fail-open)', async () => {
    const fetchMock = vi.fn(() => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { cache } = fakeCache();
    const prev: CidRetrievabilityMap = {
      bafya: {
        checkedAt: '2026-01-01T00:00:00.000Z',
        copies: 1,
        sources: { kubo: true, pinata: false, filebase: false, filecoin: false },
        state: 'ok',
      },
    };
    const map = await checkRetrievability('test.eth', view(['bafya', 'bafyb']), ['bafya', 'bafyb'], {
      cache,
      prev,
      batchSize: 3,
    });
    // bafya had a last-known result → preserved, just flagged failed.
    expect(map.bafya.state).toBe('failed');
    expect(map.bafya.lastError).toBe('network down');
    expect(map.bafya.copies).toBe(1);
    expect(map.bafya.sources.kubo).toBe(true);
    // bafyb had no previous result → empty baseline + failed flag.
    expect(map.bafyb.state).toBe('failed');
    expect(map.bafyb.lastError).toBe('network down');
    expect(map.bafyb.copies).toBe(0);
    expect(map.bafyb.sources).toEqual(SOURCES_FALSE);
  });

  it('abort rethrows and preserves the baseline (no error statuses recorded)', async () => {
    const { cache, store } = fakeCache();
    const prev: CidRetrievabilityMap = {
      bafya: {
        checkedAt: '2026-01-01T00:00:00.000Z',
        copies: 1,
        sources: { kubo: true, pinata: false, filebase: false, filecoin: false },
        state: 'ok',
      },
    };
    store.set('test.eth', { ...prev });
    const controller = new AbortController();
    const fetchMock = vi.fn(() => {
      controller.abort();
      throw new Error('AbortError');
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      checkRetrievability('test.eth', view(['bafya']), ['bafya'], {
        cache,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    // The previous cache is preserved — the aborted cid is not marked as an error.
    expect(store.get('test.eth')).toEqual(prev);
  });

  it('without a cache, everything degrades to no-ops (no storage, still returns)', async () => {
    const fetchMock = vi.fn(() =>
      ndjsonResponse([JSON.stringify({ cid: 'bafyno', ms: 1, result: [] })]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const map = await checkRetrievability('test.eth', view(['bafyno']), ['bafyno'], {
      batchSize: 3,
    });
    expect(map.bafyno.copies).toBe(0);
    expect(map.bafyno.sources).toEqual(SOURCES_FALSE);
    expect(map.bafyno.state).toBe('no-providers');
    expect(map.bafyno.lastError).toBeUndefined();
  });
});
