// cid-view retrievability core tests — pure fake RetrievabilityReadContext, no network.
/* eslint-disable @typescript-eslint/dot-notation -- CID map keys are hashes; bracket access mirrors map semantics */
import { describe, it, expect } from 'vitest';
import type { CidEntry, PublicationCidView } from './types';
import type { RetrievabilityReadContext, RetrievabilitySource } from './retrievability';
import {
  checkCidRetrievability,
  cidsFromView,
  filecoinBackedCidsFromView,
  orderByCopiesAscending,
  orderByStaleness,
  RETRIEVABILITY_SOURCES,
  type CheckState,
} from './retrievability';
import type { CidRetrievabilityMap, CidRetrievabilityStatus } from './retrievability';

const ALL_FALSE: Record<RetrievabilitySource, boolean> = {
  kubo: false,
  pinata: false,
  filebase: false,
  filecoin: false,
};
const ALL_TRUE: Record<RetrievabilitySource, boolean> = {
  kubo: true,
  pinata: true,
  filebase: true,
  filecoin: true,
};

/** Build a minimal view from entries (mirrors deals.test.ts makeView). */
function makeView(entries: Partial<CidEntry>[]): PublicationCidView {
  return {
    publication: 'pub.eth',
    generatedAt: '2026-10-08T00:00:00.000Z',
    entries: entries as CidEntry[],
    sources: { deals: true, config: false, tree: false, archive: false },
    summary: { total: entries.length, uniqueCids: entries.length, byCategory: {} },
  };
}

/** Full status helper for ordering tests. */
function status(
  checkedAt: string,
  copies: number,
  sources: Record<RetrievabilitySource, boolean> = ALL_FALSE,
  state: CheckState = copies > 0 ? 'ok' : 'no-providers',
): CidRetrievabilityStatus {
  return { checkedAt, copies, sources, state };
}

interface FakeCall {
  source: RetrievabilitySource;
  cid: string;
}

/**
 * Fake context: records every probe call, optionally fails a source and/or
 * reports presence per source/cid. Non-async arrow bodies keep eslint's
 * require-await off the shared helpers.
 */
function fakeCtx(opts: {
  present?: (source: RetrievabilitySource, cid: string) => boolean;
  fail?: (source: RetrievabilitySource, cid: string) => boolean;
  delay?: () => Promise<void>;
  calls?: FakeCall[];
} = {}): RetrievabilityReadContext {
  const calls = opts.calls ?? [];
  return {
    hasCopy: async (source: RetrievabilitySource, cid: string) => {
      calls.push({ source, cid });
      if (opts.delay) await opts.delay();
      if (opts.fail?.(source, cid)) throw new Error(`probe failed: ${source}`);
      return opts.present?.(source, cid) ?? false;
    },
  };
}

describe('cidsFromView', () => {
  it('returns unique non-empty trimmed cids in first-appearance order', () => {
    const view = makeView([
      { cid: '  QmB  ' }, // trimmed
      { cid: 'QmA' },
      { cid: 'QmB' }, // duplicate of the trimmed first entry
      { cid: 'QmC' },
      { cid: '   ' }, // blank after trim → skipped
    ]);
    expect(cidsFromView(view)).toEqual(['QmB', 'QmA', 'QmC']);
  });

  it('returns [] for an empty view', () => {
    expect(cidsFromView(makeView([]))).toEqual([]);
  });
});

describe('filecoinBackedCidsFromView', () => {
  it('includes only deal and deal-version cids (deduped)', () => {
    const view = makeView([
      { cid: 'QmDeal', category: 'deal' },
      { cid: 'QmVer', category: 'deal-version' },
      { cid: 'QmOffer', category: 'offer' },
      { cid: 'QmSite', category: 'site-root' },
      { cid: 'QmAsset', category: 'asset' },
      { cid: 'QmDeal', category: 'deal' }, // duplicate
      { cid: 'QmVer2', category: 'deal-version' },
    ]);
    expect([...filecoinBackedCidsFromView(view)].sort()).toEqual(['QmDeal', 'QmVer', 'QmVer2']);
  });

  it('returns an empty set when no deal cids exist', () => {
    const view = makeView([
      { cid: 'QmOffer', category: 'offer' },
      { cid: 'QmSite', category: 'site-root' },
    ]);
    expect(filecoinBackedCidsFromView(view).size).toBe(0);
  });
});

describe('checkCidRetrievability', () => {
  it('probes every fresh cid against all four sources with correct sources/copies/checkedAt', async () => {
    const calls: FakeCall[] = [];
    const ctx = fakeCtx({ present: (source) => source !== 'filebase', calls });
    const checkedAt = '2026-10-08T00:00:00.000Z';

    const result = await checkCidRetrievability(ctx, ['QmA', 'QmB'], {
      now: () => new Date(checkedAt),
    });

    expect(calls).toHaveLength(8); // 2 cids × 4 sources
    expect(calls.filter((c) => c.cid === 'QmA')).toHaveLength(4);
    expect(calls.filter((c) => c.cid === 'QmB')).toHaveLength(4);
    expect(new Set(calls.map((c) => c.source))).toEqual(new Set(RETRIEVABILITY_SOURCES));

    const expected = {
      checkedAt,
      copies: 3, // filebase absent
      sources: { kubo: true, pinata: true, filebase: false, filecoin: true },
      state: 'ok',
    };
    expect(result['QmA']).toEqual(expected);
    expect(result['QmB']).toEqual(expected);
  });

  it('preserves prev entries for cids not in the checked list', async () => {
    const ctx = fakeCtx({ present: () => true });
    const prev: CidRetrievabilityMap = {
      QmStale: status('2026-01-01T00:00:00.000Z', 0),
    };

    const result = await checkCidRetrievability(ctx, ['QmFresh'], { prev });

    expect(result['QmStale']).toEqual(prev['QmStale']);
    expect(result['QmStale']).toBe(prev['QmStale']); // same reference, untouched
    expect(result['QmFresh']).toBeDefined();
  });

  it('returns prev unchanged (or {}) when cids is empty', async () => {
    const ctx = fakeCtx({ present: () => true });
    const prev: CidRetrievabilityMap = {
      QmA: status('2026-01-01T00:00:00.000Z', 1, ALL_TRUE),
    };

    expect(await checkCidRetrievability(ctx, [], { prev })).toEqual(prev);
    expect(await checkCidRetrievability(ctx, [])).toEqual({});
  });

  it('respects the concurrency cap (max in-flight <= concurrency)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const cids = Array.from({ length: 20 }, (_, i) => `QmCid${String(i)}`);
    const ctx: RetrievabilityReadContext = {
      hasCopy: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return false;
      },
    };

    const result = await checkCidRetrievability(ctx, cids, { concurrency: 3 });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // parallelism actually happened
    expect(Object.keys(result)).toHaveLength(cids.length);
  });

  it('fail-open: a throwing source records error, marks that source false, and does not inflate copies', async () => {
    const ctx = fakeCtx({
      present: () => true,
      fail: (source) => source === 'pinata',
    });

    const result = await checkCidRetrievability(ctx, ['QmA'], {});
    const s = result['QmA'];

    expect(s).toBeDefined();
    expect(s.sources.pinata).toBe(false);
    expect(s.sources.kubo).toBe(true);
    expect(s.copies).toBe(3); // 4 sources − 1 failed probe
    expect(s.state).toBe('ok'); // still has copies — the failure is flagged, not fatal
    expect(s.lastError).toBeTruthy();
    expect(s.lastError).toContain('pinata');
  });

  it('subset sources option → unchecked sources false and not counted', async () => {
    const calls: FakeCall[] = [];
    const ctx = fakeCtx({ present: () => true, calls });

    const result = await checkCidRetrievability(ctx, ['QmA'], {
      sources: ['kubo', 'filecoin'],
    });

    expect(result['QmA'].sources).toEqual({
      kubo: true,
      pinata: false,
      filebase: false,
      filecoin: true,
    });
    expect(result['QmA'].copies).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.source).sort()).toEqual(['filecoin', 'kubo']);
  });

  it('does not mutate the caller prev object', async () => {
    const prev: CidRetrievabilityMap = {
      QmA: status('2026-01-01T00:00:00.000Z', 0),
    };
    const snapshot = JSON.stringify(prev);
    const ctx = fakeCtx({ present: () => true });

    const result = await checkCidRetrievability(ctx, ['QmA'], {
      prev,
      sources: ['kubo'],
      now: () => new Date('2026-10-09T00:00:00.000Z'),
    });

    expect(JSON.stringify(prev)).toBe(snapshot); // caller's prev untouched
    expect(result['QmA']).not.toBe(prev['QmA']); // checked entry replaced
  });
});

describe('orderByCopiesAscending', () => {
  it('sorts fewest copies first, stalest checkedAt on ties', () => {
    const map: CidRetrievabilityMap = {
      Qm3: status('2026-10-01T00:00:00.000Z', 3, ALL_TRUE),
      Qm0a: status('2026-10-01T00:00:00.000Z', 0),
      Qm0b: status('2026-09-01T00:00:00.000Z', 0),
      Qm1: status('2026-10-05T00:00:00.000Z', 1, {
        kubo: true,
        pinata: false,
        filebase: false,
        filecoin: false,
      }),
    };

    expect(orderByCopiesAscending(['Qm3', 'Qm0a', 'Qm0b', 'Qm1'], map)).toEqual([
      'Qm0b', // copies 0, stalest checkedAt
      'Qm0a', // copies 0, newer checkedAt
      'Qm1',
      'Qm3',
    ]);
  });

  it('puts never-checked cids first (input order), then checked by copies', () => {
    const map: CidRetrievabilityMap = {
      Qm0: status('2026-10-01T00:00:00.000Z', 0),
      Qm1: status('2026-10-01T00:00:00.000Z', 1),
    };

    expect(orderByCopiesAscending(['Qm0', 'QmNeverA', 'Qm1', 'QmNeverB'], map)).toEqual([
      'QmNeverA',
      'QmNeverB',
      'Qm0',
      'Qm1',
    ]);
  });

  it('keeps stable input order on exact ties', () => {
    const map: CidRetrievabilityMap = {
      QmA: status('2026-01-01T00:00:00.000Z', 2),
      QmB: status('2026-01-01T00:00:00.000Z', 2),
    };

    expect(orderByCopiesAscending(['QmB', 'QmA', 'QmC'], map)).toEqual(['QmC', 'QmB', 'QmA']);
  });
});

describe('orderByStaleness', () => {
  it('sorts oldest checkedAt first, never-checked first', () => {
    const map: CidRetrievabilityMap = {
      QmNew: status('2026-10-08T00:00:00.000Z', 4, ALL_TRUE),
      QmOld: status('2026-01-01T00:00:00.000Z', 0),
      QmMid: status('2026-06-01T00:00:00.000Z', 2),
    };

    expect(orderByStaleness(['QmNew', 'QmOld', 'QmMid', 'QmNever'], map)).toEqual([
      'QmNever',
      'QmOld',
      'QmMid',
      'QmNew',
    ]);
  });

  it('keeps stable input order for equal checkedAt', () => {
    const map: CidRetrievabilityMap = {
      QmA: status('2026-01-01T00:00:00.000Z', 1),
      QmB: status('2026-01-01T00:00:00.000Z', 1),
    };

    expect(orderByStaleness(['QmB', 'QmA'], map)).toEqual(['QmB', 'QmA']);
  });
});
