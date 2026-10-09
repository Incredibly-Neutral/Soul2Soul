// cid-view per-CID retrievability — transport-agnostic core.
//
// For every CID in a publication view, records which platforms currently hold a
// copy (kubo / pinata / filebase / filecoin), the number of copies, and the
// time of last check. The next feature layered on the composed PublicationCidView
// (see coordinator.ts).
//
// Transport-agnostic by design: there is NO fetch / viem / ipfs here. The only
// network surface is the injected `RetrievabilityReadContext.hasCopy` adapter —
// implemented later by safe-app against the real kubo gateway / pinata /
// filebase APIs. Everything else (types, pure view helpers, the check runner,
// the ordering helpers) is unit-testable with a fake context.
//
// Fail-open: checkCidRetrievability never rejects for a per-source probe error —
// a throwing hasCopy marks that source false, records `error` on the status, and
// `copies` counts only confirmed trues. Programming errors (a broken context)
// may still surface.
import type { PublicationCidView } from './types';

export const RETRIEVABILITY_SOURCES = ['kubo', 'pinata', 'filebase', 'filecoin'] as const;
export type RetrievabilitySource = (typeof RETRIEVABILITY_SOURCES)[number];

export interface CidRetrievabilityStatus {
  /** ISO 8601 — time of THIS cid's last check. */
  checkedAt: string;
  /** Count of sources present (0..4). */
  copies: number;
  /** Per-platform copy presence. All four keys always present. */
  sources: Record<RetrievabilitySource, boolean>;
  /** Set when a source probe threw (retryable). */
  error?: string;
}

export type CidRetrievabilityMap = Record<string, CidRetrievabilityStatus>;

/** Transport-agnostic read context (adapter implemented by safe-app later). */
export interface RetrievabilityReadContext {
  /** True when the given platform currently holds a copy of cid. May be derived (no network). */
  hasCopy(source: RetrievabilitySource, cid: string): Promise<boolean>;
}

/**
 * Unique, non-empty, trimmed CIDs from a view, in order of first appearance in
 * view.entries. Returns [] when the view has no entries. Never throws.
 */
export function cidsFromView(view: PublicationCidView): string[] {
  const seen = new Set<string>();
  const cids: string[] = [];
  for (const entry of view.entries) {
    const cid = entry.cid.trim();
    if (cid === '') continue;
    if (seen.has(cid)) continue;
    seen.add(cid);
    cids.push(cid);
  }
  return cids;
}

/**
 * Set of CIDs whose category is 'deal' or 'deal-version' ONLY (on-chain
 * Filecoin deal registrations).
 */
export function filecoinBackedCidsFromView(view: PublicationCidView): Set<string> {
  const cids = new Set<string>();
  for (const entry of view.entries) {
    if (entry.category !== 'deal' && entry.category !== 'deal-version') continue;
    const cid = entry.cid.trim();
    if (cid === '') continue;
    cids.add(cid);
  }
  return cids;
}

export interface CheckCidRetrievabilityOptions {
  /** Cached status (delta baseline). Unchecked CIDs keep their prev entry. */
  prev?: CidRetrievabilityMap;
  /** Sources to probe; defaults to all four. Unchecked sources are recorded false. */
  sources?: readonly RetrievabilitySource[];
  /** Max cids checked in parallel (default 8). */
  concurrency?: number;
  /** Clock override for tests; defaults to new Date(). */
  now?: () => Date;
}

/**
 * Check retrievability for the given CIDs (each is re-checked FRESH) and merge
 * into `prev`: entries for CIDs not in the list are preserved unchanged.
 * The CALLER decides which CIDs to check (priority / stalest-first policy);
 * this function only executes the checks for the passed set.
 *
 * Fail-open: if a source probe throws, that source is recorded false, the
 * status gets `error`, and copies counts only confirmed trues. Must never
 * reject for network reasons. Never mutates the caller's `prev`.
 */
export async function checkCidRetrievability(
  ctx: RetrievabilityReadContext,
  cids: readonly string[],
  options: CheckCidRetrievabilityOptions = {},
): Promise<CidRetrievabilityMap> {
  const prev = options.prev ?? {};
  const sources = options.sources ?? RETRIEVABILITY_SOURCES;
  const concurrency = options.concurrency ?? 8;
  const now = options.now ?? (() => new Date());

  // Clone — never mutate the caller's prev. Unchecked CIDs keep their entries.
  const result: CidRetrievabilityMap = { ...prev };

  // Dedupe while preserving order: the same CID twice in the list is one check.
  const seen = new Set<string>();
  const uniqueCids: string[] = [];
  for (const cid of cids) {
    if (seen.has(cid)) continue;
    seen.add(cid);
    uniqueCids.push(cid);
  }

  const checked = await mapWithLimit(uniqueCids, concurrency, (cid) =>
    checkOneCid(ctx, cid, sources, now),
  );

  for (const [cid, status] of checked) {
    result[cid] = status;
  }
  return result;
}

/** Probe one CID against the selected sources and fold the result into a status. */
async function checkOneCid(
  ctx: RetrievabilityReadContext,
  cid: string,
  sources: readonly RetrievabilitySource[],
  now: () => Date,
): Promise<[string, CidRetrievabilityStatus]> {
  const flags: Record<RetrievabilitySource, boolean> = {
    kubo: false,
    pinata: false,
    filebase: false,
    filecoin: false,
  };
  const failures: string[] = [];

  // Sources within a CID are probed sequentially so in-flight work never
  // exceeds the concurrency cap (which is a cap on parallel CIDs).
  for (const source of sources) {
    try {
      const present = await ctx.hasCopy(source, cid);
      flags[source] = present;
    } catch (err) {
      flags[source] = false;
      failures.push(`${source}: ${errorMessage(err)}`);
    }
  }

  let copies = 0;
  for (const present of Object.values(flags)) {
    if (present) copies += 1;
  }

  const status: CidRetrievabilityStatus = {
    checkedAt: now().toISOString(),
    copies,
    sources: flags,
  };
  if (failures.length > 0) {
    status.error = failures.join('; ');
  }
  return [cid, status];
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message !== '') return err.message;
  return String(err);
}

/**
 * Run `fn` over `items` with at most `limit` promises in flight, preserving
 * input order in the result. Mirrors the mapWithLimit pattern in tree.ts /
 * config.ts / deals.ts (result-returning variant).
 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  let next = 0;
  const results = new Array<R>(items.length);
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * Look up a status, distinguishing "never checked" (cid absent from the map)
 * from a real status — the map's index signature hides that distinction.
 */
function lookup(map: CidRetrievabilityMap, cid: string): CidRetrievabilityStatus | undefined {
  return cid in map ? map[cid] : undefined;
}

/** ISO 8601 UTC strings compare lexicographically; oldest = smallest. */
function compareCheckedAt(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Fewest copies first; tie-break by stalest checkedAt; never-checked first.
 * Stable: exact ties keep the input order. Pure — used by the safe-app
 * background recheck loop to prioritize CIDs that are at risk.
 */
export function orderByCopiesAscending(
  cids: readonly string[],
  map: CidRetrievabilityMap,
): string[] {
  return cids
    .map((cid, index) => ({ cid, index, status: lookup(map, cid) }))
    .sort((a, b) => {
      // Never-checked first, preserving input order among themselves.
      if (a.status === undefined && b.status !== undefined) return -1;
      if (a.status !== undefined && b.status === undefined) return 1;
      if (a.status !== undefined && b.status !== undefined) {
        const byCopies = a.status.copies - b.status.copies;
        if (byCopies !== 0) return byCopies;
        const byAge = compareCheckedAt(a.status.checkedAt, b.status.checkedAt);
        if (byAge !== 0) return byAge;
      }
      return a.index - b.index;
    })
    .map((x) => x.cid);
}

/**
 * Oldest checkedAt first; never-checked first. Stable: ties keep the input
 * order. Pure — used by the safe-app stalest-first background recheck loop.
 */
export function orderByStaleness(cids: readonly string[], map: CidRetrievabilityMap): string[] {
  return cids
    .map((cid, index) => ({ cid, index, status: lookup(map, cid) }))
    .sort((a, b) => {
      if (a.status === undefined && b.status !== undefined) return -1;
      if (a.status !== undefined && b.status === undefined) return 1;
      if (a.status !== undefined && b.status !== undefined) {
        const byAge = compareCheckedAt(a.status.checkedAt, b.status.checkedAt);
        if (byAge !== 0) return byAge;
      }
      return a.index - b.index;
    })
    .map((x) => x.cid);
}
