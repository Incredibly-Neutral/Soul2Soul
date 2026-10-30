// cid-view deals collector — inventories every CID a publication uses from its
// deal/offer ledger plus the full per-genesis version history.
//
// Best-effort by design: the view is a read-only inventory, so a failing
// sub-call (getDeals / getOffers / getVersions) yields FEWER entries, never a
// throw that would sink the whole publication. Pure function: it only calls the
// ctx read-context methods — no chain/IPFS access.
import type { CidEntry, DealRead, PublicationCidView, VersionRead } from './types';
import type { CidViewReadContext } from './context';

// Contract note: DealRead.timestamp / VersionRead.timestamp are unix seconds
// (numbers). The concrete adapter maps any on-chain bigints → Number before it
// reaches us, so we pass timestamps through untouched.

const VERSION_CONCURRENCY = 8; // max parallel per-genesis version reads

/**
 * Small worker pool — run `fn` over `items` with at most `limit` promises in
 * flight (mirrors the mapWithLimit pattern in tree.ts / config.ts). Never
 * rejects: each item failure is swallowed so one slow/failed read can't abort
 * its siblings (the collector is fail-open).
 */
async function mapWithLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(0, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        await fn(items[index]);
      } catch {
        // swallow per-item failures — the collector is fail-open
      }
    }
  });
  await Promise.all(workers);
}

/** Map a DealRead (live deal/offer row) to its 'deal'/'offer' CidEntry. */
function dealEntry(deal: DealRead): CidEntry {
  return {
    cid: deal.cid,
    category: deal.status,
    source: 'deals' as const,
    genesis: deal.genesis,
    author: deal.author,
    timestamp: deal.timestamp,
  };
}

/**
 * Map one genesis's final version array to '*-version' CidEntries. The LAST
 * entry of the array is the current version (gets the 'current version' note)
 * unless markCurrent is false (revoked genesis — a revoked doc has no live
 * current version).
 */
function versionEntries(
  versions: VersionRead[],
  genesis: string,
  category: 'deal-version' | 'offer-version',
  markCurrent = true,
): CidEntry[] {
  return versions.map((v, i, arr) => ({
    cid: v.cid,
    category,
    source: 'deals' as const,
    genesis,
    timestamp: v.timestamp,
    tombstoned: v.tombstone || undefined,
    note: markCurrent && i === arr.length - 1 ? 'current version' : undefined,
  }));
}

/** Version history for one genesis → '*-version' CidEntries (or [] on failure). */
async function versionsFor(
  ctx: CidViewReadContext,
  genesis: string,
  category: 'deal-version' | 'offer-version',
): Promise<CidEntry[]> {
  let versions: Awaited<ReturnType<CidViewReadContext['getVersions']>> = [];
  try {
    versions = await ctx.getVersions(genesis);
  } catch {
    return [];
  }
  // getVersions returns the FULL history, index 0..n-1, last = current.
  return versionEntries(versions, genesis, category);
}

export async function collectDealCids(ctx: CidViewReadContext): Promise<CidEntry[]> {
  let deals: DealRead[] = [];
  try {
    deals = await ctx.getDeals();
  } catch {
    deals = [];
  }

  let offers: DealRead[] = [];
  try {
    offers = await ctx.getOffers();
  } catch {
    offers = [];
  }

  // Pre-fetch the version history for every genesis in bounded parallel — the
  // hot path (452 serial getVersion reads live today). The map is keyed by
  // `${genesis}\u0000${category}` so a genesis that is both a deal and an
  // offer (pathological) still gets the right category.
  const versionByGenesis = new Map<string, CidEntry[]>();
  const wants: { genesis: string; category: 'deal-version' | 'offer-version' }[] = [];
  for (const deal of deals) wants.push({ genesis: deal.genesis, category: 'deal-version' });
  for (const offer of offers) wants.push({ genesis: offer.genesis, category: 'offer-version' });

  await mapWithLimit(wants, VERSION_CONCURRENCY, async (w) => {
    versionByGenesis.set(
      `${w.genesis}\u0000${w.category}`,
      await versionsFor(ctx, w.genesis, w.category),
    );
  });

  // Emit in the original deals-then-offers order, substituting the pre-fetched
  // per-genesis version entries — deterministic output regardless of fetch order.
  const entries: CidEntry[] = [];
  for (const deal of deals) {
    entries.push(dealEntry(deal));
    entries.push(...(versionByGenesis.get(`${deal.genesis}\u0000deal-version`) ?? []));
  }
  for (const offer of offers) {
    entries.push(dealEntry(offer));
    entries.push(...(versionByGenesis.get(`${offer.genesis}\u0000offer-version`) ?? []));
  }

  return dedupe(entries);
}

/**
 * Drop exact duplicates (same cid + category + genesis), keeping the LAST
 * occurrence per key while preserving first-seen order (Map values iterate in
 * first-insertion order). Keeping the last matters because versionEntries
 * marks only the final version entry with 'current version' — when two
 * versions of one genesis share a cid (allowed: the contract only rejects
 * EmptyCid), the note-bearing entry must survive dedupe.
 */
function dedupe(entries: CidEntry[]): CidEntry[] {
  const byKey = new Map<string, CidEntry>();
  for (const e of entries) {
    byKey.set(`${e.cid}\u0000${e.category}\u0000${e.genesis ?? ''}`, e);
  }
  return [...byKey.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// Incremental collection — warm-path primitives a later stage uses to diff a
// fresh deal/version read against a cached DealCidSnapshot.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A frozen slice of the deal layer: the last-known live deal/offer rows plus
 * the full per-genesis version history known at that time. Produced by
 * deriveDealCidSnapshot from a PublicationCidView; consumed by
 * collectDealCidsIncremental to diff against live state.
 *
 * COMPLETENESS CONTRACT: cold getVersions is all-or-nothing per genesis
 * (returns [] on any failure), so a cold-built cache has either count>0
 * (complete) or count 0 (incomplete — caught by the count-0 guard in
 * collectDealCidsIncremental). The incremental range fetch is also
 * all-or-nothing per genesis; on failure cachedCount stays stale, so
 * complete=false — the coordinator (next stage) then falls back to a cold
 * rebuild, which self-heals. The caller must only invoke the incremental path
 * when the previous refresh reported complete:true.
 */
export interface DealCidSnapshot {
  deals: DealRead[];
  offers: DealRead[];
  /**
   * genesis → full known version history (cached from a prior complete refresh).
   * A revoked genesis stays here across hops — this is what lets the revoked
   * branch of emitIncrementalEntries retain its history even after the live row
   * (and therefore the 'deal'/'offer' entry) is gone from the view.
   */
  versions: Partial<Record<string, VersionRead[]>>;
  /**
   * genesis → category, carried across hops so a revoked genesis whose live row
   * has been dropped from the view can still be emitted with the correct
   * 'deal-version' vs 'offer-version' category. 'deal' wins on a pathological
   * deal+offer collision (a genesis is a deal by construction).
   */
  genesisKind: Record<string, 'deal' | 'offer'>;
}

/** Result of an incremental deal-layer refresh. */
export interface IncrementalDealResult {
  /** Full deal-source entries (current deal/offer entries + version entries incl. cached history). */
  entries: CidEntry[];
  /** True iff the deal+version layer is fully known after this refresh. */
  complete: boolean;
  /** Fingerprint of the live state just read ('' if the live read failed). */
  fingerprint: string;
}

/**
 * Reconstruct a DealCidSnapshot from an existing PublicationCidView — the
 * baseline for the next incremental refresh. Tolerant of missing optional
 * fields: deal/offer entries without a genesis or cid are skipped; author
 * defaults to ''; missing timestamps default to 0.
 */
export function deriveDealCidSnapshot(view: PublicationCidView): DealCidSnapshot {
  const deals: DealRead[] = [];
  const offers: DealRead[] = [];
  const versions: Record<string, VersionRead[]> = {};
  const genesisKind: Record<string, 'deal' | 'offer'> = {};
  for (const e of view.entries) {
    if (e.category === 'deal' || e.category === 'offer') {
      if (!e.genesis || !e.cid) continue;
      (e.category === 'deal' ? deals : offers).push({
        genesis: e.genesis,
        author: e.author ?? '',
        cid: e.cid,
        timestamp: e.timestamp ?? 0,
        status: e.category,
      });
      // a live row always pins the category ('deal' wins on a pathological collision)
      genesisKind[e.genesis] = e.category;
    } else if (e.category === 'deal-version' || e.category === 'offer-version') {
      if (!e.genesis) continue;
      (versions[e.genesis] ??= []).push({
        cid: e.cid,
        timestamp: e.timestamp ?? 0,
        tombstone: Boolean(e.tombstoned),
      });
      // version entries are the source of truth for a revoked genesis (whose row
      // is gone); 'deal-version' wins over 'offer-version' on a collision.
      if (e.category === 'deal-version') {
        genesisKind[e.genesis] = 'deal';
      } else if (!(e.genesis in genesisKind)) {
        genesisKind[e.genesis] = 'offer';
      }
    }
  }
  return { deals, offers, versions, genesisKind };
}

/**
 * Canonical fingerprint of the live deal/offer state: JSON of the sorted-by-
 * genesis [genesis, cid, timestamp, status] tuples.
 *
 * Soundness: an unchanged fingerprint gates "no version changes anywhere" — a
 * version append changes the live row's cid or timestamp, a revocation removes
 * the row, a first publish adds a row. KNOWN CORNER (accepted): two appends to
 * ONE genesis in the SAME block where both carry an identical cid leave the
 * live row's cid AND timestamp unchanged, so the fingerprint does not change
 * and the incremental fast path skips the new version slot while complete
 * stays true. The appended CID is already inventoried via the earlier version
 * entry, so impact is limited to the version-slot count. A same-cid append in
 * a LATER block changes the live row's timestamp and is caught.
 */
export function dealFingerprint(deals: DealRead[], offers: DealRead[]): string {
  const tuples: [string, string, number, DealRead['status']][] = [...deals, ...offers].map((d) => [
    d.genesis,
    d.cid,
    d.timestamp,
    d.status,
  ]);
  tuples.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    if (a[2] !== b[2]) return a[2] - b[2];
    return a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0;
  });
  return JSON.stringify(tuples);
}

/**
 * Emit the deterministic incremental entry order: live deals ('deal' then its
 * version entries), live offers ('offer' then its version entries), then
 * revoked-genesis version entries (prev deals order, then prev offers order —
 * history retained, NO 'current version' note since a revoked doc has no live
 * current).
 */
function emitIncrementalEntries(
  liveDeals: DealRead[],
  liveOffers: DealRead[],
  versions: Partial<Record<string, VersionRead[]>>,
  prev: DealCidSnapshot,
): CidEntry[] {
  const entries: CidEntry[] = [];
  const liveSet = new Set<string>();
  for (const deal of liveDeals) {
    liveSet.add(deal.genesis);
    entries.push(dealEntry(deal));
    entries.push(...versionEntries(versions[deal.genesis] ?? [], deal.genesis, 'deal-version'));
  }
  for (const offer of liveOffers) {
    liveSet.add(offer.genesis);
    entries.push(dealEntry(offer));
    entries.push(...versionEntries(versions[offer.genesis] ?? [], offer.genesis, 'offer-version'));
  }
  // Revoked genesis (in prev, not live): keep its cached version history, no
  // live 'deal'/'offer' entry and no 'current version' note (a revoked doc has
  // no live current). Retention is keyed off prev.versions (which survives every
  // hop) — NOT prev.deals/prev.offers (whose rows vanish from the view after the
  // first revoked refresh) — so a revoked genesis's history is retained across an
  // ARBITRARY number of consecutive refreshes, byte-identical each time.
  // Deterministic order: prev.deals-order revoked, then prev.offers-order
  // revoked, then any remaining prev.versions-only genese (their category comes
  // from prev.genesisKind, falling back to 'deal').
  const revokedSeen = new Set<string>();
  const emitRevoked = (genesis: string, category: 'deal-version' | 'offer-version'): void => {
    if (liveSet.has(genesis) || revokedSeen.has(genesis)) return;
    revokedSeen.add(genesis);
    entries.push(...versionEntries(versions[genesis] ?? [], genesis, category, false));
  };
  for (const d of prev.deals) emitRevoked(d.genesis, 'deal-version');
  for (const o of prev.offers) emitRevoked(o.genesis, 'offer-version');
  for (const genesis of Object.keys(prev.versions)) {
    if (liveSet.has(genesis) || revokedSeen.has(genesis)) continue;
    revokedSeen.add(genesis);
    const category = prev.genesisKind[genesis] === 'offer' ? 'offer-version' : 'deal-version';
    entries.push(...versionEntries(versions[genesis] ?? [], genesis, category, false));
  }
  return dedupe(entries);
}

/**
 * Re-emit the previous snapshot's entries verbatim (used when a live read
 * fails). Live deal/offer rows and their version history are retained; the
 * 'current version' note is only emitted for genese that were live at snapshot
 * time (a revoked genesis keeps its history without a current note).
 */
function snapshotToEntries(prev: DealCidSnapshot): CidEntry[] {
  const entries: CidEntry[] = [];
  for (const deal of prev.deals) entries.push(dealEntry(deal));
  for (const offer of prev.offers) entries.push(dealEntry(offer));
  const liveSet = new Set<string>();
  for (const d of prev.deals) liveSet.add(d.genesis);
  for (const o of prev.offers) liveSet.add(o.genesis);
  for (const [genesis, versions] of Object.entries(prev.versions)) {
    entries.push(
      ...versionEntries(
        versions ?? [],
        genesis,
        prev.genesisKind[genesis] === 'offer' ? 'offer-version' : 'deal-version',
        liveSet.has(genesis),
      ),
    );
  }
  return dedupe(entries);
}

/**
 * Incremental refresh of the deal+version layer against a cached snapshot.
 *
 *  1. Live deals + offers (fail-open) — a failing read retains the last-known
 *     data and reports complete:false; never throws.
 *  2. If the live fingerprint equals the previous one AND every live genesis has
 *     a non-empty cached history (contract fact 1), the version layer cannot
 *     have changed → zero getVersionCount/getVersionsRange calls.
 *  3. Otherwise a bounded-parallel per-genesis diff fetches only the appended
 *     tail (or the full history when a cached genesis is incomplete / brand new).
 *     A LIVE genesis always has >= 1 version on-chain, so a count of 0 there
 *     means the count read failed (adapters fail-open to 0) → complete:false.
 *     A tail fetch that returns fewer entries than count - cachedCount (the
 *     safe-app caps a range at 100 versions; beyond the cap the note may land
 *     on a stale version) also clears complete so the caller can rebuild cold.
 *  4. Revoked genesis (in prev, not live) keep their cached version history.
 *
 * complete is true only if every getDeals/getOffers/getVersionCount/
 * getVersionsRange call in this refresh succeeded, no live genesis was left
 * with cachedCount 0 via a count-0 fallthrough, and no live genesis ended with
 * a truncated (short) version history.
 */
export async function collectDealCidsIncremental(
  ctx: CidViewReadContext,
  prev: DealCidSnapshot,
): Promise<IncrementalDealResult> {
  // 1. Live deals + offers (fail-open).
  let liveDeals: DealRead[];
  try {
    liveDeals = await ctx.getDeals();
  } catch {
    return { entries: snapshotToEntries(prev), complete: false, fingerprint: '' };
  }
  let liveOffers: DealRead[];
  try {
    liveOffers = await ctx.getOffers();
  } catch {
    return { entries: snapshotToEntries(prev), complete: false, fingerprint: '' };
  }

  // 2. Fingerprints — an unchanged live state is the no-version-changes gate.
  const liveFp = dealFingerprint(liveDeals, liveOffers);
  const prevFp = dealFingerprint(prev.deals, prev.offers);
  const fpMatch = liveFp === prevFp;

  // Index live + prev entries by genesis (deals take precedence on overlap).
  const liveByGenesis = new Map<string, DealRead>();
  for (const d of liveDeals) if (!liveByGenesis.has(d.genesis)) liveByGenesis.set(d.genesis, d);
  for (const o of liveOffers) if (!liveByGenesis.has(o.genesis)) liveByGenesis.set(o.genesis, o);
  const prevByGenesis = new Map<string, DealRead>();
  for (const d of prev.deals) if (!prevByGenesis.has(d.genesis)) prevByGenesis.set(d.genesis, d);
  for (const o of prev.offers) if (!prevByGenesis.has(o.genesis)) prevByGenesis.set(o.genesis, o);

  const liveOrder = [...liveByGenesis.keys()];
  const cachedCount = (g: string): number => prev.versions[g]?.length ?? 0;

  // 3. Unchanged-fingerprint fast path: zero version calls when every live
  //    genesis already has a non-empty cached history.
  if (fpMatch && liveOrder.every((g) => cachedCount(g) > 0)) {
    return {
      entries: emitIncrementalEntries(liveDeals, liveOffers, prev.versions, prev),
      complete: true,
      fingerprint: liveFp,
    };
  }

  // 4. Per-genesis diff (bounded parallel). Only the genesis that need it make
  //    version calls; a failure keeps what's cached and clears complete.
  const versions: Record<string, VersionRead[]> = Object.fromEntries(
    Object.entries(prev.versions).map(([g, vs]) => [g, [...(vs ?? [])]]),
  );
  let complete = true;
  await mapWithLimit(liveOrder, VERSION_CONCURRENCY, async (genesis) => {
    const liveEntry = liveByGenesis.get(genesis);
    const prevEntry = prevByGenesis.get(genesis);
    const cached = prev.versions[genesis] ?? [];
    const cc = cached.length;
    const matches =
      liveEntry?.cid === prevEntry?.cid && liveEntry?.timestamp === prevEntry?.timestamp;
    try {
      if (matches && cc > 0) {
        // unchanged + cached complete → keep cached, no calls
      } else if (matches) {
        // cc === 0 → the earlier fetch was incomplete; refetch FULL history.
        // A live genesis always has >= 1 version on-chain, so a count of 0
        // (adapter fail-open) means the count read failed → incomplete.
        if (!ctx.getVersionCount || !ctx.getVersionsRange)
          throw new Error('getVersionCount/getVersionsRange not implemented');
        const n = await ctx.getVersionCount(genesis);
        if (n > 0) {
          const fetched = await ctx.getVersionsRange(genesis, 0, n);
          versions[genesis] = fetched;
          // fewer than n entries = capped (MAX_VERSIONS) or a failed/partial range read
          if (fetched.length < n) complete = false;
        } else {
          // count 0 on a live genesis → read failed; keep [] cached but flag incomplete
          complete = false;
        }
      } else {
        // new or changed entry → fetch only the appended tail
        if (!ctx.getVersionCount || !ctx.getVersionsRange)
          throw new Error('getVersionCount/getVersionsRange not implemented');
        const n = await ctx.getVersionCount(genesis);
        if (n === 0) {
          // live genesis with count 0 → read failed (adapter fail-open); keep cached
          complete = false;
        } else if (n > cc) {
          const fetched = await ctx.getVersionsRange(genesis, cc, n);
          versions[genesis] = [...cached, ...fetched];
          // fewer than n-cc appended = capped tail or a failed/partial range read
          if (fetched.length < n - cc) complete = false;
        }
        // n <= cc → keep cached (the version array did not grow)
      }
    } catch {
      // count/range read failed → keep whatever is cached; this refresh is incomplete
      complete = false;
    }
  });

  // 5+6. Emit deterministically (live deals → live offers → revoked versions).
  return {
    entries: emitIncrementalEntries(liveDeals, liveOffers, versions, prev),
    complete,
    fingerprint: liveFp,
  };
}
