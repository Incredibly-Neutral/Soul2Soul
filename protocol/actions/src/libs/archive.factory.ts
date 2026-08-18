import type { Entry } from './module.factory';

// ───────────────────────────────────────────────────────────────────────────
// Per-publication IPFS content archive.
//
// Stores the flat toBody output for each genesis keyed by genesis, together
// with the source cid it was built from. This is the "freshness oracle"
// consumer: a given genesis entry is FRESH when its stored cid still matches
// the latest cid returned by getDeals(); otherwise it is STALE/MISS and must
// be re-catted and rebuilt.
//
// The core functions are pure/deterministic — no chain or IPFS calls inside —
// so the whole correctness story is unit-testable in isolation. The caller
// wires the I/O (getDeals, catFile, uploadFile) around these functions.
// ───────────────────────────────────────────────────────────────────────────

export const ARCHIVE_FORMAT = 's2s-publication-archive/1';

export interface ArchiveItem {
  cid: string; // latest cid this entry was built from
  body: any; // flat toBody output
}

export interface Archive {
  format: string;
  publication: string;
  built: string; // iso8601
  items: Record<string, ArchiveItem>;
}

export const emptyArchive = (publication = ''): Archive => ({
  format: ARCHIVE_FORMAT,
  publication,
  built: new Date().toISOString(),
  items: {},
});

/**
 * Parse + validate an archive payload.
 *
 * Any malformed / unparseable / wrong-shape input MUST NOT throw: it fails
 * open to an EMPTY archive (no items), matching the current no-archive
 * behaviour so callers never crash on a corrupt cached blob. Individual
 * malformed items (missing cid, missing body, wrong shape) are dropped here;
 * reconcile() also treats absence as a MISS, so nothing is ever silently lost
 * — a dropped item will simply be refetched.
 */
export function parseArchive(json: string): Archive {
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return emptyArchive();
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return emptyArchive();
  }
  if (parsed.format !== ARCHIVE_FORMAT) {
    return emptyArchive();
  }
  if (typeof parsed.publication !== 'string') {
    return emptyArchive();
  }
  if (!parsed.items || typeof parsed.items !== 'object' || Array.isArray(parsed.items)) {
    return emptyArchive();
  }

  const items: Record<string, ArchiveItem> = {};
  for (const [genesis, item] of Object.entries(parsed.items)) {
    if (
      item &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      typeof (item as ArchiveItem).cid === 'string' &&
      (item as ArchiveItem).cid !== '' &&
      (item as ArchiveItem).body !== undefined &&
      (item as ArchiveItem).body !== null
    ) {
      items[genesis] = { cid: (item as ArchiveItem).cid, body: (item as ArchiveItem).body };
    }
    // else: malformed item → omit; reconcile treats it as a MISS (refetch).
  }

  return {
    format: ARCHIVE_FORMAT,
    publication: parsed.publication,
    built: typeof parsed.built === 'string' ? parsed.built : new Date().toISOString(),
    items,
  };
}

/**
 * Classify each deal against the archive.
 *
 *  - archive entry present AND item.cid === deal.cid  → FRESH → `fresh.get(g) = body`
 *  - no entry                                         → MISS
 *  - item.cid !== deal.cid                            → STALE
 *  - malformed / unverifiable entry (missing cid or body) → MISS (bias toward
 *    inclusion: refetch rather than silently serve a broken/dropped entry)
 *
 * Both MISS and STALE land in `needsFetch`, where the caller cats
 * `deal.cid` fresh and rebuilds the body.
 */
export function reconcile(
  deals: Entry[],
  archive: Archive | null,
): { fresh: Map<string, any>; needsFetch: Entry[] } {
  const fresh = new Map<string, any>();
  const needsFetch: Entry[] = [];

  for (const deal of deals) {
    const entry = archive?.items?.[deal.genesis];
    const wellFormed =
      !!entry &&
      typeof entry.cid === 'string' &&
      entry.cid !== '' &&
      entry.body !== undefined &&
      entry.body !== null;

    if (wellFormed && entry!.cid === deal.cid) {
      fresh.set(deal.genesis, entry!.body);
    } else {
      needsFetch.push(deal);
    }
  }

  return { fresh, needsFetch };
}

/**
 * Merge a fresh `refreshed` map into the previous archive and produce the next
 * archive snapshot.
 *
 *  - start from prev (or an empty archive if null);
 *  - DROP any item whose genesis has no deal (deal-set floor — geneses that
 *    disappeared on-chain are pruned);
 *  - REPLACE/APPEND each refreshed genesis with `{ cid: deal.cid, body }`;
 *  - deal'd-but-not-refreshed geneses stay as-is (absent if never present) —
 *    lazy, slow convergence is intended;
 *  - stamp `format`, `publication` (from prev) and `built` (now).
 */
export function mergeArchive(
  prev: Archive | null,
  deals: Entry[],
  refreshed: Map<string, any>,
): Archive {
  const dealSet = new Set(deals.map((d) => d.genesis));
  const items: Record<string, ArchiveItem> = {};

  if (prev && prev.items) {
    for (const [genesis, item] of Object.entries(prev.items)) {
      if (dealSet.has(genesis)) {
        items[genesis] = item;
      }
    }
  }

  for (const deal of deals) {
    if (refreshed.has(deal.genesis)) {
      items[deal.genesis] = { cid: deal.cid, body: refreshed.get(deal.genesis) };
    }
  }

  return {
    format: ARCHIVE_FORMAT,
    publication: prev?.publication ?? '',
    built: new Date().toISOString(),
    items,
  };
}

/** Serialize an archive for upload (callers push via uploadFile). */
export function serialize(archive: Archive): string {
  return JSON.stringify(archive);
}
