import type { Entry } from './module.factory';
import { toBody } from './module.factory';
import type { S2SContentItem } from '@s2s/soul2soul-shared/lit-actions';
import { verifyBodyHash } from '@s2s/soul2soul-shared/lit-actions';
import { s2sContentItemSchema } from '@s2s/soul2soul-shared/rendering/action-io';

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
// WHY CID EQUALITY ALONE IS NOT ENOUGH (integrity)
// -----------------------------------------------
// The archive does NOT store the original content-addressed bytes: it stores
// the PARSED + RE-SERIALISED item (JSON.parse → JSON.stringify, schema-
// normalised). So cid equality can only prove "the archive was built from this
// deal cid" — it cannot be re-checked by hashing the stored item against the
// CID (the hash would differ by construction, not because of tampering).
//
// The cryptographic substitute is the author-signed `public.plaintextHash`
// (= keccak256(utf8(body-as-plaintext-JSON)), computed BEFORE encryption and
// covered by the EIP-712 proof). Every PLAINTEXT item served from the archive
// must therefore pass verifyBodyHash(item.body, item.public.plaintextHash);
// on mismatch the entry is never served and is classified MISS so it is
// refetched from the on-chain deal cid (the freshness oracle, content-
// addressed at the cold path). Without this check whoever could write the
// ENS `content_cache_<publication>` pointer could serve a schema-valid item
// claiming a real deal cid while carrying a fake body — and it would render.
//
// ENCRYPTED items are NOT checked here: their `body` is ciphertext, so hashing
// it against the plaintext plaintextHash is meaningless. That check belongs
// after decryption, which the render path owns.
//
// LEGACY items (no `public.plaintextHash`, minted before the field existed) are
// UNVERIFIABLE, not invalid: they are still served (see checkItemBodyIntegrity).
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
 * Integrity verdict for one stored/fetched item's body.
 *
 *  - 'verified'     — plaintext body hashes to the author-signed plaintextHash;
 *  - 'unverifiable' — no check is possible here (encrypted/ciphertext body, or a
 *                     legacy item that predates plaintextHash) — serve it;
 *  - 'mismatch'     — plaintext body does NOT hash to its own plaintextHash —
 *                     the item is forged/corrupt and must never be served.
 */
export type ItemBodyIntegrity = 'verified' | 'unverifiable' | 'mismatch';

/** True when the item carries a non-empty `public.plaintextHash` to check against. */
const hasPlaintextHash = (item: unknown): boolean => {
  const hash = (item as { public?: { plaintextHash?: unknown } } | null)?.public?.plaintextHash;
  return typeof hash === 'string' && hash !== '';
};

/**
 * Verify a content item's plaintext body against its own author-signed
 * `public.plaintextHash`.
 *
 * Plaintext only. An encrypted item's `body` is ciphertext, so the plaintext
 * hash cannot be checked here — the render path checks it after decryption.
 * A legacy item without a plaintextHash is UNVERIFIABLE, not invalid (serve).
 */
export const checkItemBodyIntegrity = (item: S2SContentItem): ItemBodyIntegrity => {
  // Encrypted: `body` is ciphertext. NEVER hash-check it here (a false
  // 'mismatch' would reject every legitimate encrypted item); the check after
  // decryption belongs to the render path.
  if (item.encryption) return 'unverifiable';
  // Legacy item (pre-plaintextHash): nothing to compare against — unverifiable,
  // NOT invalid. Served as-is; the cold path is content-addressed.
  if (!hasPlaintextHash(item)) return 'unverifiable';
  return verifyBodyHash(item.body, item.public.plaintextHash) ? 'verified' : 'mismatch';
};

// Stand-in hash used only to re-validate a legacy (hash-less) item against the
// shared schema, which requires the field. It is never stored or returned.
const LEGACY_HASH_PLACEHOLDER = '0x' + '0'.repeat(64);

/**
 * True when `item` is a structurally valid S2SContentItem per the shared
 * content-item schema. Used as the reconcile() wellFormed guard (bias toward
 * inclusion: an unverifiable item is a MISS, refetch — never silently serve).
 *
 * LEGACY TOLERANCE: the shared schema requires `public.plaintextHash`, but
 * items minted before that field existed are UNVERIFIABLE, not invalid. When
 * the ONLY thing missing is the hash, the item is re-validated with a
 * placeholder and accepted (checkItemBodyIntegrity then returns
 * 'unverifiable'). Any other schema failure still rejects it.
 */
const isValidItem = (item: unknown): item is S2SContentItem => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  if (s2sContentItemSchema.safeParse(item).success) return true;
  if (hasPlaintextHash(item)) return false;
  const pub = (item as { public?: unknown }).public;
  if (!pub || typeof pub !== 'object' || Array.isArray(pub)) return false;
  return s2sContentItemSchema.safeParse({
    ...(item as Record<string, unknown>),
    public: { ...(pub as Record<string, unknown>), plaintextHash: LEGACY_HASH_PLACEHOLDER },
  }).success;
};

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
      // Schema enforces the shape at runtime; the branded literals (DidEthr,
      // `0x${string}`) are compile-time refinements the schema can't infer, so
      // the validated item is kept as the canonical type. The raw item is kept
      // (not a normalised copy) so a legacy hash-less item survives round-trip.
      if (isValidItem((entry as ArchiveItem).item)) {
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

/**
 * Classify each deal against the archive.
 *
 *  - archive entry present AND item.cid === deal.cid AND the item's plaintext
 *    body hashes to its own plaintextHash → FRESH → `fresh.get(g) = toBody(deal, item)`
 *  - no entry                                         → MISS
 *  - item.cid !== deal.cid                            → STALE
 *  - malformed / unverifiable entry (missing cid or invalid item) → MISS (bias
 *    toward inclusion: refetch rather than silently serve a broken/dropped entry)
 *  - plaintext item whose body does NOT hash to its own `public.plaintextHash`
 *    → MISS (forged/corrupt — NEVER served), also reported in `integrityFailures`
 *    so the caller can surface it; refetched from the content-addressed deal cid.
 *    Encrypted items are NOT hash-checked here (ciphertext body — the render
 *    path checks after decryption); legacy items without a hash are served.
 *  - schema-valid entry whose body cannot be flattened (e.g. non-JSON plain
 *    body) → MISS, never throw (fail-open preserved — a corrupt-but-schema-valid
 *    blob is refetched, not crashed on)
 *
 * Both MISS and STALE land in `needsFetch`, where the caller cats
 * `deal.cid` fresh and rebuilds the body.
 *
 * OUTPUT CONTRACT: `fresh` carries the flat toBody bodies — the in-flight T3
 * read path consumes exactly this shape. `integrityFailures` is an ADDITIVE
 * field (existing destructuring is unaffected): the deals whose archive entry
 * was rejected for a plaintextHash mismatch, i.e. tamper evidence.
 */
export function reconcile(
  deals: Entry[],
  archive: Archive | null,
): { fresh: Map<string, any>; needsFetch: Entry[]; integrityFailures: Entry[] } {
  const fresh = new Map<string, any>();
  const needsFetch: Entry[] = [];
  const integrityFailures: Entry[] = [];

  for (const deal of deals) {
    const entry = archive?.items?.[deal.genesis];

    if (
      entry &&
      typeof entry.cid === 'string' &&
      entry.cid !== '' &&
      entry.cid === deal.cid &&
      isValidItem(entry.item)
    ) {
      // Integrity gate: a plaintext item's body MUST hash to its own
      // author-signed plaintextHash before it is served. cid equality only
      // proves the archive was built from this deal cid (the archive stores
      // re-serialised items, so the CID cannot be re-hashed) — a forged body
      // wearing a real cid is exactly the attack this catches. Mismatch ⇒ not
      // served, refetch from the content-addressed on-chain cid (MISS).
      if (checkItemBodyIntegrity(entry.item) === 'mismatch') {
        integrityFailures.push(deal);
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

  return { fresh, needsFetch, integrityFailures };
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
