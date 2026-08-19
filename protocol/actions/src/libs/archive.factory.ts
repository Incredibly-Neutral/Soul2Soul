import type { Entry } from './module.factory';
import { toBody } from './module.factory';
import type { S2SContentItem } from '@s2s/soul2soul-shared';
import { s2sContentItemSchema } from '@s2s/soul2soul-shared';

// ───────────────────────────────────────────────────────────────────────────
// Per-publication IPFS content archive.
//
// Stores the FULL canonical content item (S2SContentItem — signed public
// metadata + body + proof + objectId + encryption) for each genesis keyed by
// genesis, together with the source cid it was built from. This is the
// "freshness oracle" consumer: a given genesis entry is FRESH when its stored
// cid still matches the latest cid returned by getDeals(); otherwise it is
// STALE/MISS and must be re-catted and rebuilt.
//
// Each stored item is validated against the existing shared content-item
// schema (s2sContentItemSchema, @s2s/soul2soul-shared) — so the archive
// carries the full public metadata (specVersion, mediaType, plaintextHash,
// ...) that the flat toBody output drops, typed with the real type — never
// `any`.
//
// reconcile()'s OUTPUT stays the flat toBody bodies (the in-flight T3 read
// path consumes exactly that): the archive stores the full item, but fresh
// entries are served as toBody(deal, item) flat bodies.
//
// The core functions are pure/deterministic — no chain or IPFS calls inside —
// so the whole correctness story is unit-testable in isolation. The caller
// wires the I/O (getDeals, catFile, uploadFile) around these functions.
// ───────────────────────────────────────────────────────────────────────────

export const ARCHIVE_FORMAT = 's2s-publication-archive/2';

export interface ArchiveItem {
  cid: string; // latest cid this entry was built from
  item: S2SContentItem; // full canonical content item (validated against s2sContentItemSchema)
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
 * True when `item` is a structurally valid S2SContentItem per the shared
 * content-item schema. Used as the reconcile() wellFormed guard (bias toward
 * inclusion: an unverifiable item is a MISS, refetch — never silently serve).
 */
const isValidItem = (item: unknown): item is S2SContentItem =>
  !!item &&
  typeof item === 'object' &&
  !Array.isArray(item) &&
  s2sContentItemSchema.safeParse(item).success;

/**
 * Parse + validate an archive payload.
 *
 * Any malformed / unparseable / wrong-shape input MUST NOT throw: it fails
 * open to an EMPTY archive (no items), matching the current no-archive
 * behaviour so callers never crash on a corrupt cached blob. Individual
 * malformed items (missing cid, missing item, or an item that fails the
 * existing content-item schema) are dropped here; reconcile() also treats
 * absence as a MISS, so nothing is ever silently lost — a dropped item will
 * simply be refetched.
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
  for (const [genesis, entry] of Object.entries(parsed.items)) {
    if (
      entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof (entry as ArchiveItem).cid === 'string' &&
      (entry as ArchiveItem).cid !== ''
    ) {
      const res = s2sContentItemSchema.safeParse((entry as ArchiveItem).item);
      if (res.success) {
        // Schema enforces the shape at runtime; the branded literals (DidEthr,
        // `0x${string}`) are compile-time refinements the schema can't infer,
        // so the validated data is re-cast to the canonical type.
        items[genesis] = { cid: (entry as ArchiveItem).cid, item: res.data as S2SContentItem };
      }
    }
    // else: malformed / schema-invalid item → omit; reconcile treats it as a MISS (refetch).
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
 *  - archive entry present AND item.cid === deal.cid  → FRESH → `fresh.get(g) = toBody(deal, item)`
 *  - no entry                                         → MISS
 *  - item.cid !== deal.cid                            → STALE
 *  - malformed / unverifiable entry (missing cid or invalid item) → MISS (bias
 *    toward inclusion: refetch rather than silently serve a broken/dropped entry)
 *  - schema-valid entry whose body cannot be flattened (e.g. non-JSON plain
 *    body) → MISS, never throw (fail-open preserved — a corrupt-but-schema-valid
 *    blob is refetched, not crashed on)
 *
 * Both MISS and STALE land in `needsFetch`, where the caller cats
 * `deal.cid` fresh and rebuilds the body.
 *
 * OUTPUT CONTRACT (unchanged): `fresh` carries the flat toBody bodies — the
 * in-flight T3 read path consumes exactly this shape.
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
      !!entry && typeof entry.cid === 'string' && entry.cid !== '' && isValidItem(entry.item);

    if (wellFormed && entry!.cid === deal.cid) {
      try {
        fresh.set(deal.genesis, toBody(deal, entry!.item));
      } catch {
        // Corrupt-but-schema-valid blob (e.g. plain body that isn't parseable
        // JSON): treat as MISS (refetch) — never throw (fail-open preserved,
        // bias toward inclusion unchanged).
        needsFetch.push(deal);
      }
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
 *  - REPLACE/APPEND each refreshed genesis with `{ cid: deal.cid, item }`;
 *  - deal'd-but-not-refreshed geneses stay as-is (absent if never present) —
 *    lazy, slow convergence is intended;
 *  - stamp `format`, `publication` (from prev) and `built` (now).
 */
export function mergeArchive(
  prev: Archive | null,
  deals: Entry[],
  refreshed: Map<string, S2SContentItem>,
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
      items[deal.genesis] = { cid: deal.cid, item: refreshed.get(deal.genesis)! };
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
