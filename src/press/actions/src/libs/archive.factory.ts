/// <reference path="../action_globals.ts" />

import type { Entry } from './module.factory';
import { toBody } from './module.factory';
// The stored item, in whichever layout it was written (`bodies` on v3, `body`
// on v1/v2). Typed on the union so a reader of an archived item cannot reach
// for `item.body` and silently get undefined.
import type { AnyS2SContentItem } from '../../../../shared/dist/manuscript/types';
// The integrity verdict (and its shape gate) lives in ONE module shared with the
// direct read path — see item-integrity.ts. Re-exported below so callers that
// imported these from the archive module keep working.
import { inspectItemIntegrity, isValidContentItem, type ItemIssueCode } from './item-integrity';

export {
  addressOf,
  checkItemBodyIntegrity,
  inspectItemIntegrity,
  isValidContentItem,
  judgeRefetchedItem,
  type ItemIntegrity,
  type ItemIntegrityLevel,
  type ItemIssueCode,
  type RefetchedItemVerdict,
} from './item-integrity';

// ───────────────────────────────────────────────────────────────────────────
// Per-publication IPFS content archive.
//
// Stores the FULL canonical content item (any storage layout — signed public
// metadata + body + proof + objectId + encryption) for each genesis keyed by
// genesis, together with the source cid it was built from. This is the
// "freshness oracle" consumer: a given genesis entry is FRESH when its stored
// cid still matches the latest cid returned by getDeals(); otherwise it is
// STALE/MISS and must be re-catted and rebuilt.
//
// Items are stored as they were parsed (the raw object, NOT a re-normalised
// copy), so the item is preserved byte-for-byte and a legacy hash-less item
// survives a round trip. What IS re-serialised is the archive container itself
// (a JSON object of items), so the *item's* CID cannot be recomputed from the
// archive bytes — content-addressing stops at the container boundary, which is
// why `ArchiveItem.cid` is a claim (compared against getDeals) rather than
// something this module can re-derive.
//
// INTEGRITY — see libs/item-integrity.ts
// ---------------------------------------
// What makes a stored item trustworthy (author binding, plaintext hash,
// objectId digest, proof signer) is defined ONCE in `item-integrity.ts`, which
// documents what each check proves, what it does not, and the residuals. This
// module only wires that verdict to the cache: a 'mismatch' entry is never
// served, it is reported as a MISS and refetched from the on-chain cid. The
// SAME verdict is used by the direct read path (libs/module.factory.ts), so both
// paths agree about an identical item; they differ only in failure shape
// (MISS + refetch here, ContentIntegrityError/skip there).
//
// The core functions are pure/deterministic — no chain or IPFS calls inside —
// so the whole correctness story is unit-testable in isolation. The caller
// wires the I/O (getDeals, catFile, uploadFile) around these functions.
// ───────────────────────────────────────────────────────────────────────────

export const ARCHIVE_FORMAT = 's2s-publication-archive/2';

export interface ArchiveItem {
  cid: string; // latest cid this entry was built from
  item: AnyS2SContentItem; // full canonical content item (validated against s2sContentItemSchema)
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
      // Schema enforces the shape at runtime; the branded literal
      // (`0x${string}`) is a compile-time refinement the schema can't infer, so
      // the validated item is kept as the canonical type. The raw item is kept
      // (not a normalised copy) so a legacy hash-less item survives round-trip.
      if (isValidContentItem((entry as ArchiveItem).item)) {
        items[genesis] = { cid: (entry as ArchiveItem).cid, item: (entry as ArchiveItem).item };
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

/** Tamper/doubt evidence for one archive entry (never served on 'mismatch'). */
export interface IntegrityIssue {
  genesis: string;
  cid: string;
  code: ItemIssueCode;
  reason: string;
}

/**
 * Classify each deal against the archive.
 *
 *  - archive entry present AND entry.cid === deal.cid AND the item passes
 *    inspectItemIntegrity() → FRESH → `fresh.get(g) = toBody(deal, item)`.
 *    'verified' and 'unverifiable' are both served ('unverifiable' means a
 *    specific check could not run — encrypted body, legacy item, malformed
 *    hash, contract-authored signer; the code says which).
 *  - no entry → MISS; item.cid !== deal.cid → STALE; malformed / invalid item
 *    → MISS (bias toward inclusion: refetch rather than serve a broken entry).
 *  - verdict 'mismatch' (author mismatch, missing hash on a specVersion item,
 *    body-vs-plaintextHash mismatch, objectId mismatch, proof-signer mismatch)
 *    → MISS, NEVER served, and recorded in `integrityIssues` so the caller can
 *    surface it through the availability channel. Refetched from the
 *    content-addressed on-chain deal cid, which the pointer writer cannot
 *    forge.
 *  - schema-valid entry whose body cannot be flattened (e.g. non-JSON plain
 *    body) → MISS, never throw (fail-open preserved — a corrupt-but-schema-valid
 *    blob is refetched, not crashed on).
 *
 * Both MISS and STALE land in `needsFetch`, where the caller cats
 * `deal.cid` fresh and rebuilds the body.
 *
 * OUTPUT CONTRACT: `fresh` carries the flat toBody bodies — the in-flight T3
 * read path consumes exactly this shape. `integrityIssues` is ADDITIVE
 * (existing `{ fresh, needsFetch }` destructuring is unaffected).
 */
export function reconcile(
  deals: Entry[],
  archive: Archive | null,
): { fresh: Map<string, any>; needsFetch: Entry[]; integrityIssues: IntegrityIssue[] } {
  const fresh = new Map<string, any>();
  const needsFetch: Entry[] = [];
  const integrityIssues: IntegrityIssue[] = [];

  for (const deal of deals) {
    const entry = archive?.items?.[deal.genesis];

    if (
      entry &&
      typeof entry.cid === 'string' &&
      entry.cid !== '' &&
      entry.cid === deal.cid &&
      isValidContentItem(entry.item)
    ) {
      // Integrity gate — see inspectItemIntegrity/the header. cid equality only
      // proves the archive was built from this deal cid (the container is
      // re-serialised, so the item CID cannot be re-derived); `deal.author` is
      // what binds the item to the publication's on-chain deal set. Mismatch ⇒
      // not served, refetch from the content-addressed on-chain cid (MISS).
      const verdict = inspectItemIntegrity(entry.item, deal.author);
      if (verdict.level === 'mismatch') {
        integrityIssues.push({
          genesis: deal.genesis,
          cid: deal.cid,
          code: verdict.code,
          reason: verdict.reason,
        });
        needsFetch.push(deal);
        continue;
      }
      try {
        fresh.set(deal.genesis, toBody(deal, entry.item));
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

  return { fresh, needsFetch, integrityIssues };
}

/**
 * Merge a fresh `refreshed` map into the previous archive and produce the next
 * archive snapshot.
 *
 *  - start from prev (or an empty archive if null);
 *  - DROP any item whose genesis has no deal (deal-set floor — geneses that
 *    disappeared on-chain are pruned);
 *  - DROP any carried-forward item named in `drop` (see SELF-HEALING below) —
 *    unless it is the publication's ONLY deal, in which case the snapshot keeps
 *    it so the archive stays complete for a single-deal publication (the read
 *    path refuses it either way, so nothing forged is served);
 *  - REPLACE/APPEND each refreshed genesis with `{ cid: deal.cid, item }` (a
 *    dropped genesis that refetches cleanly comes back through here);
 *  - deal'd-but-not-refreshed geneses stay as-is (absent if never present) —
 *    lazy, slow convergence is intended;
 *  - stamp `format`, `publication` (from prev) and `built` (now).
 *
 * SELF-HEALING: reconcile() re-derives the SAME integrity issue for a tampered
 * snapshot entry on every invocation, so carrying that entry forward would make
 * the pointer re-report it forever and never converge. `drop` is how the
 * write-back evicts it: the entry is not copied, the snapshot gets a new cid,
 * and the next reconcile has nothing to flag (the deal is then a plain MISS and
 * is refetched from the on-chain cid, which is where the real item lives).
 */
export function mergeArchive(
  prev: Archive | null,
  deals: Entry[],
  refreshed: Map<string, AnyS2SContentItem>,
  drop: Iterable<string> = [],
): Archive {
  const dealSet = new Set(deals.map((d) => d.genesis));
  const dropped = new Set(drop);
  // Never write an archive that forgets the publication's only deal: an empty
  // snapshot for a live publication is a worse failure mode than a cached blob
  // the reader knows how to reject.
  const evict = deals.length > 1;
  const items: Record<string, ArchiveItem> = {};

  if (prev && prev.items) {
    for (const [genesis, item] of Object.entries(prev.items)) {
      if (!dealSet.has(genesis)) continue;
      if (evict && dropped.has(genesis)) continue;
      items[genesis] = item;
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
