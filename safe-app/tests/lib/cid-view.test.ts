// tests/lib/cid-view.test.ts — unit tests for the safe-app cid-view context
// adapter (src/lib/cid-view.ts).
//
// Mock strategy: no network, no iframe, no wallet.
//   @/lib/evm.js                      -> evmRead (ENS records reads are stubbed)
//   @s2s/soul2soul-shared/safe-app    -> fake S2SIPFSMethods (fetchFromKubo /
//                                        dagGet) + buildPublicationCidView stub
//   toBytes32Id                       -> LOCAL viem helper in src/lib/cid-view.ts
//                                        (never touches the root shared barrel)
//   store.getRecord                   -> vi.spyOn on the real store singleton
//   global fetch                      -> per-CID ls/cat stubs (adapter's raw
//                                        Kubo POSTs)
//
// The adapter under test (buildSafeAppCidViewContext) wires SafeIntegration +
// protocolInfo into a CidViewReadContext; the fake SafeIntegration carries a
// fake publicationModule with getVersionCount/getVersion and a fake
// getAllDealsAndOffers.

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { evmRead } from '../../src/lib/evm';
import { store } from '../../src/state/index.js';
import {
  buildSafeAppCidViewContext,
  checkRetrievability,
  fetchCidView,
  loadRetrievabilityMap,
  saveRetrievabilityMap,
} from '../../src/lib/cid-view';
import type {
  CidEntry,
  CidRetrievabilityMap,
  CidViewReadContext,
  PublicationCidView,
  RetrievabilitySource,
} from '@s2s/soul2soul-shared/safe-app';

const ipfsMocks = vi.hoisted(() => {
  const instances: Array<{
    fetchFromKubo: ReturnType<typeof vi.fn>;
    dagGet: ReturnType<typeof vi.fn>;
    ls: ReturnType<typeof vi.fn>;
    cat: ReturnType<typeof vi.fn>;
  }> = [];
  return {
    instances,
    buildPublicationCidView: vi.fn(async (_ctx: unknown, _publication: string) => ({})),
    ipfsClass: class FakeIPFS {
      fetchFromKubo = vi.fn(async () => ({}));
      dagGet = vi.fn(async () => null);
      ls = vi.fn(async () => []);
      cat = vi.fn(async () => '');
      constructor(..._args: unknown[]) {
        instances.push(this);
      }
    },
  };
});

vi.mock('@s2s/soul2soul-shared/safe-app', async () => {
  // The lib now ALSO imports the shared retrievability core (real symbols) —
  // provide them from the shared source tree (relative path, mirroring the
  // component test's coordinator load) rather than the heavy root barrel.
  const retrievability = await import('../../../shared/src/cid-view/retrievability.ts');
  const validation = await import('../../../shared/src/cid-view/validation.ts');
  const parser = await import('../../../shared/src/cid-view/retrieval-parser.ts');
  const client = await import('../../../shared/src/cid-view/ipfs-check-client.ts');
  return {
    S2SIPFSMethods: ipfsMocks.ipfsClass,
    buildPublicationCidView: ipfsMocks.buildPublicationCidView,
    cidsFromView: retrievability.cidsFromView,
    orderByCopiesAscending: retrievability.orderByCopiesAscending,
    orderByStaleness: retrievability.orderByStaleness,
    RETRIEVABILITY_SOURCES: retrievability.RETRIEVABILITY_SOURCES,
    parseCidRetrievabilityMap: validation.parseCidRetrievabilityMap,
    hostIsFilecoinSp: parser.hostIsFilecoinSp,
    checkRetrievability: client.checkRetrievability,
  };
});

vi.mock('@/lib/evm.js', () => ({ evmRead: vi.fn() }));

// --- fixtures ---------------------------------------------------------------

const DEALS = [
  {
    genesis: '0xgen1',
    author: '0xAuthor1',
    cid: 'bafydeal1',
    timestamp: 1700000000n,
    status: 'deal' as const,
  },
  {
    genesis: '0xgen2',
    author: '0xAuthor2',
    cid: 'bafydeal2',
    timestamp: 1700001000n,
    status: 'deal' as const,
  },
];
const OFFERS = [
  {
    genesis: '0xgen3',
    author: '0xAuthor3',
    cid: 'bafyoffer1',
    timestamp: 1700002000n,
    status: 'offer' as const,
  },
];

const PROTOCOL_INFO = { ensRecords: '0xEnsRecords' } as any;

interface FakePublicationModule {
  getVersionCount: ReturnType<typeof vi.fn>;
  getVersion: ReturnType<typeof vi.fn>;
}

function makeSafe(opts: {
  deals?: typeof DEALS;
  offers?: typeof OFFERS;
  module?: FakePublicationModule | null;
  throwOnGetAll?: boolean;
}) {
  return {
    publicationModule: opts.module ?? null,
    getAllDealsAndOffers: vi.fn(async () => {
      if (opts.throwOnGetAll) throw new Error('chain down');
      return { deals: opts.deals ?? [], offers: opts.offers ?? [] };
    }),
  } as any;
}

function makeModule(versionRows: Array<{ cid: string; timestamp: bigint; tombstone: boolean }>) {
  return {
    getVersionCount: vi.fn(async () => BigInt(versionRows.length)),
    getVersion: vi.fn(async (_id: string, index: number) => versionRows[index]),
  } as FakePublicationModule;
}

let storeGetRecordSpy: ReturnType<typeof vi.spyOn>;

describe('buildSafeAppCidViewContext', () => {
  beforeEach(() => {
    ipfsMocks.instances.length = 0;
    ipfsMocks.buildPublicationCidView.mockReset();
    vi.mocked(evmRead).mockReset();
    storeGetRecordSpy = vi.spyOn(store, 'getRecord').mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('readDeals maps deal rows with bigint timestamp → number and status deal', async () => {
    const safe = makeSafe({ deals: DEALS, offers: [] });
    const ctx = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo: PROTOCOL_INFO });

    const deals = await ctx.getDeals();
    expect(deals).toEqual([
      {
        genesis: '0xgen1',
        author: '0xAuthor1',
        cid: 'bafydeal1',
        timestamp: 1700000000,
        status: 'deal',
      },
      {
        genesis: '0xgen2',
        author: '0xAuthor2',
        cid: 'bafydeal2',
        timestamp: 1700001000,
        status: 'deal',
      },
    ]);
    expect(safe.getAllDealsAndOffers).toHaveBeenCalledTimes(1);
  });

  it('readOffers maps offer rows with status offer', async () => {
    const safe = makeSafe({ deals: [], offers: OFFERS });
    const ctx = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo: PROTOCOL_INFO });

    const offers = await ctx.getOffers();
    expect(offers).toEqual([
      {
        genesis: '0xgen3',
        author: '0xAuthor3',
        cid: 'bafyoffer1',
        timestamp: 1700002000,
        status: 'offer',
      },
    ]);
  });

  it('readVersions reads count then each version (incl. tombstone), normalising the genesis id', async () => {
    const rows = [
      { cid: 'bafyver0', timestamp: 1700000000n, tombstone: false },
      { cid: 'bafyver1', timestamp: 1700000100n, tombstone: true },
    ];
    const module = makeModule(rows);
    const safe = makeSafe({ module });
    const ctx = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo: PROTOCOL_INFO });

    const versions = await ctx.getVersions('0xgen1');
    expect(versions).toEqual([
      { cid: 'bafyver0', timestamp: 1700000000, tombstone: false },
      { cid: 'bafyver1', timestamp: 1700000100, tombstone: true },
    ]);
    // '0xgen1' is not a bytes32 id, so the local helper keccak256s it into a
    // 0x-prefixed 64-hex id before hitting the publication module.
    const [id] = module.getVersionCount.mock.calls[0] as [string];
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(id).toBe(keccak256(toBytes('0xgen1')));
    expect(module.getVersion).toHaveBeenCalledTimes(2);
  });

  it('readVersions normalises an already-bytes32 genesis and passes it through lowercased', async () => {
    const rows = [{ cid: 'bafyver0', timestamp: 1700000000n, tombstone: false }];
    const module = makeModule(rows);
    const safe = makeSafe({ module });
    const ctx = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo: PROTOCOL_INFO });

    const mixed = '0x' + 'AB'.repeat(32); // valid bytes32, uppercase hex
    await ctx.getVersions(mixed);
    const [id] = module.getVersionCount.mock.calls[0] as [string];
    expect(id).toBe(mixed.toLowerCase());
  });

  it('readVersions returns [] when the publication module is missing', async () => {
    const safe = makeSafe({ module: null });
    const ctx = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo: PROTOCOL_INFO });
    await expect(ctx.getVersions('0xgen1')).resolves.toEqual([]);
  });

  it('readConfig returns {cid, config} from a fake configCid via fetchFromKubo', async () => {
    storeGetRecordSpy.mockReturnValue('bafyconfig');
    const config = { templateCid: 'bafytemplate', assetsCid: 'bafyassets', name: 'test.eth' };
    const safe = makeSafe({});
    const ctx = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo: PROTOCOL_INFO });
    ipfsMocks.instances[0].fetchFromKubo.mockResolvedValue(config);

    const result = await ctx.getConfig();
    expect(result).toEqual({ cid: 'bafyconfig', config });
    expect(ipfsMocks.instances[0].fetchFromKubo).toHaveBeenCalledWith('bafyconfig');
  });

  it('readConfig returns {cid:"", config:{}} when there is no config record', async () => {
    const safe = makeSafe({});
    const ctx = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo: PROTOCOL_INFO });
    await expect(ctx.getConfig()).resolves.toEqual({ cid: '', config: {} });
    expect(ipfsMocks.instances[0].fetchFromKubo).not.toHaveBeenCalled();
  });

  it('readEnsText returns the evmRead value (L2 ENS records contract)', async () => {
    vi.mocked(evmRead).mockResolvedValue('bafyroot');
    const safe = makeSafe({});
    const ctx = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo: PROTOCOL_INFO });

    await expect(ctx.getEnsText('0xnode', 'contenthash_wrapped')).resolves.toBe('bafyroot');
    expect(evmRead).toHaveBeenCalledWith(8453, '0xEnsRecords', expect.any(Array), 'getText', [
      '0xnode',
      'contenthash_wrapped',
    ]);
  });

  it('dagGet delegates to the shared S2SIPFSMethods instance', async () => {
    const safe = makeSafe({});
    const ctx = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo: PROTOCOL_INFO });
    ipfsMocks.instances[0].dagGet.mockResolvedValue([{ path: 'about/index.html', cid: 'bafyt' }]);

    await expect(ctx.dagGet('bafytemplate')).resolves.toEqual([
      { path: 'about/index.html', cid: 'bafyt' },
    ]);
    expect(ipfsMocks.instances[0].dagGet).toHaveBeenCalledWith('bafytemplate');
  });

  it('ls maps Kubo links to {name, hash, size} via POST /api/v0/ls', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        Objects: [
          {
            Links: [
              { Name: 'index.html', Hash: 'bafyleaf', Size: 123, Type: 2 },
              { Name: 'assets', Hash: 'bafydir', Size: 0, Type: 1 },
            ],
          },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const safe = makeSafe({});
    const ctx = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo: PROTOCOL_INFO });

    await expect(ctx.ls('bafyroot')).resolves.toEqual([
      { name: 'index.html', hash: 'bafyleaf', size: 123 },
      { name: 'assets', hash: 'bafydir', size: 0 },
    ]);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/v0/ls?arg=bafyroot');
    expect(fetchMock.mock.calls[0][1]!.method).toBe('POST');
    vi.unstubAllGlobals();
  });

  it('cat returns the raw archive text via POST /api/v0/cat', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, text: async () => '{"items":{}}' })),
    );
    const safe = makeSafe({});
    const ctx = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo: PROTOCOL_INFO });

    await expect(ctx.cat('bafyarchive')).resolves.toBe('{"items":{}}');
    vi.unstubAllGlobals();
  });

  // --- fail-open degradation --------------------------------------------------

  it('rethrows getDeals/getOffers when getAllDealsAndOffers throws (collectors are the fail-open boundary)', async () => {
    const safe = makeSafe({ throwOnGetAll: true });
    const ctx = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo: PROTOCOL_INFO });
    // getDeals/getOffers rethrow so the shared incremental collector can flag
    // complete:false; the cold collector catches these itself.
    await expect(ctx.getDeals()).rejects.toThrow('chain down');
    await expect(ctx.getOffers()).rejects.toThrow('chain down');
  });

  it('getVersionsRange accepts a caller-supplied count and skips its internal count read', async () => {
    const rows = [
      { cid: 'bafyver0', timestamp: 1700000000n, tombstone: false },
      { cid: 'bafyver1', timestamp: 1700000100n, tombstone: true },
    ];
    const module = makeModule(rows);
    const safe = makeSafe({ module });
    const ctx = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo: PROTOCOL_INFO });

    const versions = await ctx.getVersionsRange('0xgen1', 0, 2);
    expect(versions).toEqual([
      { cid: 'bafyver0', timestamp: 1700000000, tombstone: false },
      { cid: 'bafyver1', timestamp: 1700000100, tombstone: true },
    ]);
    // count was supplied → no redundant internal count read
    expect(module.getVersionCount).not.toHaveBeenCalled();
    expect(module.getVersion).toHaveBeenCalledTimes(2);
  });

  it('degrades getVersions to [] when the module call throws', async () => {
    const module = makeModule([]);
    module.getVersionCount.mockRejectedValue(new Error('rpc down'));
    const safe = makeSafe({ module });
    const ctx = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo: PROTOCOL_INFO });
    await expect(ctx.getVersions('0xgen1')).resolves.toEqual([]);
  });

  it('degrades readConfig to {cid, config:{}} when fetchFromKubo throws', async () => {
    storeGetRecordSpy.mockReturnValue('bafyconfig');
    const safe = makeSafe({});
    const ctx = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo: PROTOCOL_INFO });
    ipfsMocks.instances[0].fetchFromKubo.mockRejectedValue(new Error('ipfs down'));

    await expect(ctx.getConfig()).resolves.toEqual({ cid: 'bafyconfig', config: {} });
  });

  it('degrades readEnsText to "" when evmRead throws or ensRecords is absent', async () => {
    vi.mocked(evmRead).mockRejectedValue(new Error('rpc down'));
    const safe = makeSafe({});
    const ctx = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo: PROTOCOL_INFO });
    await expect(ctx.getEnsText('0xnode', 'contenthash_wrapped')).resolves.toBe('');

    // No ensRecords → no evmRead call, still "".
    vi.mocked(evmRead).mockClear();
    const ctx2 = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo: {} as any });
    await expect(ctx2.getEnsText('0xnode', 'contenthash_wrapped')).resolves.toBe('');
    expect(evmRead).not.toHaveBeenCalled();
  });

  it('degrades dagGet to null when the shared call throws', async () => {
    const safe = makeSafe({});
    const ctx = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo: PROTOCOL_INFO });
    ipfsMocks.instances[0].dagGet.mockRejectedValue(new Error('dag down'));
    await expect(ctx.dagGet('bafytemplate')).resolves.toBeNull();
  });

  it('degrades ls to [] on a leaf (empty Links), non-ok, or thrown error', async () => {
    const safe = makeSafe({});
    const ctx = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo: PROTOCOL_INFO });

    // Leaf: Links: [] → [].
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ Objects: [{ Links: [] }] }) })),
    );
    await expect(ctx.ls('bafyleaf')).resolves.toEqual([]);
    vi.unstubAllGlobals();

    // Non-ok → [].
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    await expect(ctx.ls('bafyleaf')).resolves.toEqual([]);
    vi.unstubAllGlobals();

    // Thrown → [].
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('timeout');
      }),
    );
    await expect(ctx.ls('bafyleaf')).resolves.toEqual([]);
    vi.unstubAllGlobals();
  });

  it('degrades cat to "" on non-ok or thrown error', async () => {
    const safe = makeSafe({});
    const ctx = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo: PROTOCOL_INFO });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, text: async () => 'err' })),
    );
    await expect(ctx.cat('bafyarchive')).resolves.toBe('');
    vi.unstubAllGlobals();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('timeout');
      }),
    );
    await expect(ctx.cat('bafyarchive')).resolves.toBe('');
    vi.unstubAllGlobals();
  });

  it('fetchCidView builds the context and delegates to buildPublicationCidView', async () => {
    ipfsMocks.buildPublicationCidView.mockResolvedValue({ publication: 'test.eth' } as any);
    const safe = makeSafe({ deals: DEALS });
    const view = await fetchCidView(
      { safeIntegration: safe, protocolInfo: PROTOCOL_INFO },
      'test.eth',
    );
    expect(view).toEqual({ publication: 'test.eth' });
    expect(ipfsMocks.buildPublicationCidView).toHaveBeenCalledTimes(1);
    // The ctx arg passed to buildPublicationCidView is a full context.
    const ctxArg = ipfsMocks.buildPublicationCidView.mock.calls[0][0] as CidViewReadContext;
    expect(typeof ctxArg.getDeals).toBe('function');
    expect(typeof ctxArg.getVersions).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Retrievability adapter — ipfs-check batch endpoint
// ---------------------------------------------------------------------------

/** Minimal schema-valid view for the pure retrievability functions. */
function retrievabilityView(entries: CidEntry[] = []): PublicationCidView {
  return {
    publication: 'test.eth',
    generatedAt: '2026-01-01T00:00:00.000Z',
    entries,
    sources: { deals: false, config: false, tree: false, archive: false },
    summary: { total: entries.length, uniqueCids: entries.length, byCategory: {} },
  };
}

/** Two distinct cids: one s2s deal, one config. */
function validView(): PublicationCidView {
  return retrievabilityView([
    { cid: 'bafydeal1', category: 'deal', source: 'deals' },
    { cid: 'bafyconfig', category: 'config', source: 'config' },
  ]);
}

/** Build a Response whose body is a streaming NDJSON document (as the real endpoint). */
function ndjsonResponse(lines: string[]): Response {
  return new Response(lines.join('\n') + '\n', {
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

const SOURCES_FALSE = { kubo: false, pinata: false, filebase: false, filecoin: false };

describe('retrievability adapter', () => {
  // node-env unit tests have no window.localStorage — provide a tiny stub so
  // the lib's cache path (load/save, fail-open) is exercised for real.
  const storage = new Map<string, string>();
  beforeAll(() => {
    Object.defineProperty(globalThis, 'window', {
      value: {
        localStorage: {
          getItem: (k: string) => storage.get(k) ?? null,
          setItem: (k: string, v: string) => void storage.set(k, v),
        },
      },
      configurable: true,
    });
  });
  beforeEach(() => {
    storage.clear();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });


  it('checkRetrievability: 120 cids @3 → 40 batched POSTs, streams results, merges prev, persists', async () => {
    const cids = Array.from({ length: 120 }, (_, i) => `bafychunk${String(i).padStart(3, '0')}`);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { cids: string[] };
      const lines = body.cids.map((cid) => JSON.stringify({ cid, ms: 1, result: [] }));
      return ndjsonResponse(lines);
    });
    vi.stubGlobal('fetch', fetchMock);

    const prev: CidRetrievabilityMap = {
      bafyprev: {
        checkedAt: '2026-01-01T00:00:00.000Z',
        copies: 1,
        sources: { kubo: true, pinata: false, filebase: false, filecoin: false },
        state: 'ok',
      },
    };
    const onResult = vi.fn();
    const map = await checkRetrievability('test.eth', validView(), cids, { prev, onResult });

    expect(fetchMock).toHaveBeenCalledTimes(40);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body)).cids).toHaveLength(3);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]!.body)).cids).toHaveLength(3);
    expect(JSON.parse(String(fetchMock.mock.calls[39][1]!.body)).cids).toHaveLength(3);
    expect(onResult).toHaveBeenCalledTimes(120);
    // merged with prev; every posted cid got a status
    expect(map.bafyprev).toEqual(prev.bafyprev);
    expect(Object.keys(map).length).toBe(121);
    // persisted to localStorage under the publication key
    const saved = JSON.parse(window.localStorage.getItem('s2s.cidview.test.eth.retrievability')!);
    expect(Object.keys(saved).length).toBe(121);
    expect(saved.bafychunk000).toBeDefined();
  });

  it('checkRetrievability: raw /batch response body captured to localStorage', async () => {
    const fetchMock = vi.fn(async () =>
      ndjsonResponse([
        JSON.stringify({ cid: 'bafyraw', ms: 1, result: [] }),
        JSON.stringify({ cid: 'bafyraw2', ms: 1, result: [] }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const map = await checkRetrievability('test.eth', validView(), ['bafyraw', 'bafyraw2'], {});
    const rawLog = JSON.parse(
      window.localStorage.getItem('s2s.cidview.test.eth.rawbatch')!,
    ) as Array<{ cids: number; raw: string }>;
    expect(rawLog).toHaveLength(1);
    expect(rawLog[0].cids).toBe(2);
    expect(rawLog[0].raw).toContain('"cid":"bafyraw"');
    expect(map.bafyraw).toBeDefined();
    expect(map.bafyraw2).toBeDefined();
  });

  it('checkRetrievability: raw /batch log is a bounded ring (drops oldest)', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { cids: string[] };
      const lines = body.cids.map((cid) => JSON.stringify({ cid, ms: 1, result: [] }));
      return ndjsonResponse(lines);
    });
    vi.stubGlobal('fetch', fetchMock);
    for (let i = 0; i < 10; i += 1) {
      await checkRetrievability('test.eth', validView(), [`bafyring${i}`], {});
    }
    const rawLog = JSON.parse(
      window.localStorage.getItem('s2s.cidview.test.eth.rawbatch')!,
    ) as Array<{ raw: string }>;
    expect(rawLog).toHaveLength(8); // RAW_BATCH_LOG_MAX_ENTRIES
    expect(rawLog[rawLog.length - 1].raw).toContain('"cid":"bafyring9"');
    expect(rawLog[0].raw).not.toContain('"cid":"bafyring0"');
  });

  it('checkRetrievability: empty cids → no fetch, empty map', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const map = await checkRetrievability('test.eth', validView(), [], {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(map).toEqual({});
  });

  it('checkRetrievability: throwing fetch marks every chunk cid with an error status (fail-open)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock);
    const map = await checkRetrievability('test.eth', validView(), ['bafya', 'bafyb'], {});
    expect(map.bafya.state).toBe('failed');
    expect(map.bafya.lastError).toBe('network down');
    expect(map.bafya.copies).toBe(0);
    expect(map.bafya.sources).toEqual(SOURCES_FALSE);
    expect(map.bafyb.state).toBe('failed');
    expect(map.bafyb.lastError).toBe('network down');
  });

  it('checkRetrievability: abort rethrows and does NOT record error statuses', async () => {
    const prev: CidRetrievabilityMap = {
      bafya: {
        checkedAt: '2026-01-01T00:00:00.000Z',
        copies: 1,
        sources: { kubo: true, pinata: false, filebase: false, filecoin: false },
        state: 'ok',
      },
    };
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      throw new Error('AbortError');
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      checkRetrievability('test.eth', validView(), ['bafya'], { prev, signal: controller.signal }),
    ).rejects.toThrow();
    // The previous cache is preserved — the aborted cid is not marked as an error.
    const saved = JSON.parse(window.localStorage.getItem('s2s.cidview.test.eth.retrievability')!);
    expect(saved).toEqual(prev);
  });

  it('loadRetrievabilityMap / saveRetrievabilityMap round-trip, fail-open on corrupt/schema-invalid', () => {
    const map: CidRetrievabilityMap = {
      bafydeal1: {
        checkedAt: '2026-01-01T00:00:00.000Z',
        copies: 1,
        sources: { kubo: false, pinata: false, filebase: false, filecoin: true },
        state: 'ok',
      },
    };
    saveRetrievabilityMap('test.eth', map);
    expect(loadRetrievabilityMap('test.eth')).toEqual(map);
    // corrupt JSON → null
    window.localStorage.setItem('s2s.cidview.test.eth.retrievability', 'not json');
    expect(loadRetrievabilityMap('test.eth')).toBeNull();
    // schema-invalid (zod reject) → null
    window.localStorage.setItem(
      's2s.cidview.test.eth.retrievability',
      JSON.stringify({ bafydeal1: { nope: true } }),
    );
    expect(loadRetrievabilityMap('test.eth')).toBeNull();
  });
});
