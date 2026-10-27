/// <reference path="../action_globals.ts" />

import type { Entry } from './module.factory';
import { toBody } from './module.factory';
import type { S2SContentItem } from '@s2s/soul2soul-shared/lit-actions';
import { verifyBodyHash } from '@s2s/soul2soul-shared/lit-actions';
import { s2sContentItemSchema } from '@s2s/soul2soul-shared/rendering/action-io';
// `S2S_DOMAIN` / `S2S_TYPES` / `buildSigningView` are NOT re-exported from
// @s2s/soul2soul-shared/lit-actions (only `jcs` and `verifyBodyHash` are) and
// shared/** is out of scope here, so the compiled identity helpers are imported
// directly — the same pattern data.ctrlr.ts already uses for
// shared/dist/protocol/types. Both files are dependency-free (no zod, no viem),
// so they stay bundle-safe inside a Lit Action.
import { S2S_DOMAIN, S2S_TYPES } from '../../../../shared/dist/protocol/types';
import { buildSigningView } from '../../../../shared/dist/identity/signing-view';

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
// Items are stored as they were parsed (the raw object, NOT a re-normalised
// copy), so `item.body` is preserved byte-for-byte and a legacy hash-less item
// survives a round trip. What IS re-serialised is the archive container itself
// (a JSON object of items), so the *item's* CID cannot be recomputed from the
// archive bytes — content-addressing stops at the container boundary, which is
// why `ArchiveItem.cid` is a claim (compared against getDeals) rather than
// something this module can re-derive.
//
// INTEGRITY — what inspectItemIntegrity() actually proves
// ------------------------------------------------------
// Because the CID cannot be re-derived here, a schema-valid item wearing a
// real deal cid could carry a fake body, and whoever can write the ENS
// `content_cache_<publication>` pointer controls the whole blob. The checks
// below are the substitute, in ascending order of strength:
//
//   1. AUTHOR BINDING (the load-bearing one): `public.author` must equal
//      `deal.author` from getDeals() — the on-chain deal set is the oracle, and
//      the pointer writer cannot change it. Without this, a self-consistent
//      forged item (attacker's own author + own hash + own proof) verifies
//      trivially, because every check below is satisfied *within* the blob.
//   2. PLAINTEXT HASH: `keccak256(utf8(item.body))` must equal
//      `public.plaintextHash`. This binds the body bytes to the signed public
//      block; it does NOT bind them to the author (see 3/4).
//   3. OBJECT ID: `item.objectId` must equal the EIP-712 digest of
//      `public` — so `public` (including plaintextHash) is the block the author
//      actually attested to, not one rewritten around a new body.
//   4. PROOF SIGNER: recovering the EIP-712 signer from `proof.signature` must
//      match `proof.signer`.
//
// RESIDUAL (documented, not hidden): the recovered signer is NOT required to
// equal `public.author`, because a Safe/contract-authored item is signed by an
// owner EOA, and proving that EOA is an owner of that Safe needs an RPC read
// this pure module cannot do. Those items are served at level 'unverifiable'
// (code 'signature-not-author'), bound by the author address only. Consequence:
// an attacker who copies the real `deal.author` into `public.author`, sets
// `plaintextHash = keccak(their body)` and signs with their own key satisfies
// 1–4 and is served. Closing that needs on-chain ownership proof (isOwner) of
// the signing EOA on the publication Safe — reported as a follow-up, not done
// here.
//
// ENCRYPTED items: their `body` is ciphertext, so 2 cannot run here (they are
// served at 'unverifiable' / 'encrypted' after 1, 3, 4). The PLAINTEXT of a
// rendered encrypted item is verified after decryption in
// `render/data.ctrlr.ts` (initTemplateData → verifyDecryptedPlaintext), against
// the item's `public.plaintextHash`. Encrypted items inside a render
// *collection* are decrypted in render/main.ts and are NOT verified there —
// that call site is outside this module and is reported as a follow-up.
//
// LEGACY items (no `specVersion` AND no `plaintextHash`) are UNVERIFIABLE, not
// invalid: they are served (author binding still applies). A missing
// `plaintextHash` on a `specVersion` item is NOT legacy — it is a mismatch
// (refused), so the field cannot be stripped to opt out of the check.
//
// A MALFORMED `plaintextHash` (present but not a 32-byte hex digest) is
// 'unverifiable', NOT 'mismatch': the schema only requires a non-empty string,
// so a third-party writer with a different hash function must not be silently
// erased forever. It is served and reported as a doubt, never as tampering.
//
// VERDICTS: 'verified' (all applicable checks passed) / 'unverifiable' (some
// check cannot be performed in this runtime — served, reason recorded) /
// 'mismatch' (a check failed — NEVER served, classified MISS and refetched from
// the content-addressed on-chain cid).
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
 * Integrity verdict level for one stored/fetched item.
 *
 *  - 'verified'     — every applicable check passed;
 *  - 'unverifiable' — a check cannot be performed in this runtime (encrypted
 *                     body, legacy item, malformed hash, contract-authored
 *                     signer, no typed-data signer available). SERVED; `code`
 *                     says which check and why;
 *  - 'mismatch'     — a check FAILED: the item is forged/corrupt and must never
 *                     be served (refetch from the content-addressed deal cid).
 */
export type ItemIntegrityLevel = 'verified' | 'unverifiable' | 'mismatch';

/** Machine-readable reason, so callers/tests can pin the exact bucket. */
export type ItemIssueCode =
  | 'verified'
  | 'malformed-item'
  | 'author-unparseable'
  | 'author-mismatch'
  | 'encrypted'
  | 'legacy-item'
  | 'hash-missing'
  | 'hash-malformed'
  | 'hash-mismatch'
  | 'proof-missing'
  | 'objectid-mismatch'
  | 'objectid-malformed'
  | 'proof-signer-mismatch'
  | 'signature-unrecoverable'
  | 'signature-not-author';

export interface ItemIntegrity {
  level: ItemIntegrityLevel;
  code: ItemIssueCode;
  reason: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH32_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Normalise an address-shaped string to a lowercase 0x address. Accepts both a
 * plain address (what getDeals() returns for a deal) and the `did:ethr:0x…`
 * form (what an item's `public.author` carries). Returns null when the value is
 * not an address at all — callers treat that as "cannot bind" (fail closed for
 * the item side, since the item is attacker-controlled).
 */
export const addressOf = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const raw = value.startsWith('did:ethr:') ? value.slice('did:ethr:'.length) : value;
  return ADDRESS_RE.test(raw) ? raw.toLowerCase() : null;
};

/**
 * The ambient ethers v5 `utils` inside a Lit Action (EIP-712 digest +
 * ecrecover). In unit tests the global is absent unless stubbed, in which case
 * the signature checks downgrade to 'unverifiable' instead of throwing.
 */
const ambientEthersUtils = (): any => {
  try {
    return typeof ethers !== 'undefined' ? ((ethers as any)?.utils ?? null) : null;
  } catch {
    return null;
  }
};

/** EIP-712 digest of the item's `public` block, or null when unavailable. */
const signingDigest = (pub: Record<string, unknown>): string | null => {
  const hash = ambientEthersUtils()?._TypedDataEncoder?.hash;
  if (typeof hash !== 'function') return null;
  try {
    return hash(S2S_DOMAIN, S2S_TYPES, buildSigningView(pub as any));
  } catch {
    return null;
  }
};

const mismatch = (code: ItemIssueCode, reason: string): ItemIntegrity => ({
  level: 'mismatch',
  code,
  reason,
});

/**
 * Inspect one content item and decide whether it may be served.
 *
 * `dealAuthor` is `Entry.author` from getDeals() (the on-chain oracle). Pass it
 * whenever it is available: without it the author binding — the check that
 * actually stops a self-consistent forged blob — cannot run. See the header for
 * what each check does and prove, and for the documented residuals.
 *
 * Never throws; a malformed item is 'mismatch' / 'malformed-item'.
 */
export const inspectItemIntegrity = (item: unknown, dealAuthor?: string | null): ItemIntegrity => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return mismatch('malformed-item', 'item is not an object');
  }
  const it = item as Record<string, any>;
  const pub = it.public;
  if (!pub || typeof pub !== 'object' || Array.isArray(pub)) {
    return mismatch('malformed-item', 'item.public is missing');
  }
  if (typeof it.body !== 'string') {
    return mismatch('malformed-item', 'item.body is not a string');
  }

  // ── 1. author binding (load-bearing) ──
  const itemAuthor = addressOf(pub.author);
  if (itemAuthor === null) {
    return mismatch(
      'author-unparseable',
      `public.author is not an address/DID: ${String(pub.author)}`,
    );
  }
  if (typeof dealAuthor === 'string' && dealAuthor !== '') {
    const dealAddr = addressOf(dealAuthor);
    // An unparseable DEAL author comes from the chain, not the blob — that is a
    // broken deployment, not tampering, so it only downgrades to unverifiable.
    if (dealAddr !== null && dealAddr !== itemAuthor) {
      return mismatch(
        'author-mismatch',
        `public.author ${itemAuthor} does not match deal author ${dealAddr}`,
      );
    }
  }

  // Downgrade-only bookkeeping: the first check that cannot be performed wins
  // the `code`, so every caller gets one concrete reason.
  let level: ItemIntegrityLevel = 'verified';
  let code: ItemIssueCode = 'verified';
  let reason = '';
  const flag = (c: ItemIssueCode, r: string) => {
    if (level === 'verified') {
      level = 'unverifiable';
      code = c;
      reason = r;
    }
  };

  const specVersion = typeof pub.specVersion === 'string' && pub.specVersion !== '';

  // ── 2. plaintext hash (plaintext bodies only) ──
  if (it.encryption === true) {
    flag('encrypted', 'encrypted body: plaintextHash is checked after decryption, not here');
  } else {
    const hash = pub.plaintextHash;
    const hasHash = typeof hash === 'string' && hash !== '';
    if (!hasHash) {
      if (specVersion) {
        // Not legacy: a specVersion item claims a hash. Stripping it must not
        // be a way to opt out of verification.
        return mismatch('hash-missing', 'public.plaintextHash is missing on a specVersion item');
      }
      flag('legacy-item', 'legacy item (no specVersion, no plaintextHash): unverifiable');
    } else if (!HASH32_RE.test(hash as string)) {
      // Present but not a digest: cannot check. NOT tampering — the schema only
      // requires a non-empty string, so this must not erase content forever.
      flag('hash-malformed', `public.plaintextHash is not a 32-byte hex digest: ${String(hash)}`);
    } else if (!verifyBodyHash(it.body, hash as string)) {
      return mismatch('hash-mismatch', 'body does not hash to public.plaintextHash');
    }
  }

  // ── 3./4. objectId + proof signer ──
  //
  // A legacy item (no specVersion) predates the pinned EIP-712 shape: its
  // digest is not reproducible from `public` by construction, so only the
  // author binding above applies. Never served as 'verified' — 'unverifiable'
  // with code 'legacy-item', which is what the caller sees.
  if (!specVersion) {
    flag(
      'legacy-item',
      'no specVersion: the EIP-712 digest is not reproducible — author-bound only',
    );
    return { level, code, reason };
  }

  const proof = it.proof;
  if (
    !proof ||
    typeof proof !== 'object' ||
    Array.isArray(proof) ||
    typeof proof.signature !== 'string' ||
    proof.signature === ''
  ) {
    return mismatch('proof-missing', 'proof.signature is missing on a specVersion item');
  }

  const digest = signingDigest(pub);
  if (!digest) {
    flag(
      'signature-unrecoverable',
      'no typed-data signer in this runtime: objectId/signature not checked',
    );
    return { level, code, reason };
  }

  if (typeof it.objectId === 'string' && HASH32_RE.test(it.objectId)) {
    if (it.objectId.toLowerCase() !== digest.toLowerCase()) {
      return mismatch(
        'objectid-mismatch',
        `objectId ${it.objectId} is not the EIP-712 digest of public (${digest})`,
      );
    }
  } else {
    flag('objectid-malformed', 'objectId is not a 32-byte hex digest: unverifiable');
  }

  let recovered: string | null = null;
  try {
    const rec = ambientEthersUtils()?.recoverAddress?.(digest, proof.signature);
    recovered = typeof rec === 'string' ? rec.toLowerCase() : null;
  } catch {
    recovered = null;
  }

  if (!recovered) {
    flag(
      'signature-unrecoverable',
      'signature is not EOA-recoverable (contract wallet / EIP-1271?) : unverifiable',
    );
    return { level, code, reason };
  }

  const claimedSigner = addressOf(proof.signer);
  if (claimedSigner !== null && claimedSigner !== recovered) {
    return mismatch(
      'proof-signer-mismatch',
      `recovered signer ${recovered} does not match proof.signer ${claimedSigner}`,
    );
  }

  if (recovered !== itemAuthor) {
    // Documented residual: Safe / contract-authored items are signed by an
    // owner EOA. Proving that ownership needs a chain read this module cannot
    // do, so the item is bound by the author address only.
    flag(
      'signature-not-author',
      `recovered signer ${recovered} is not public.author ${itemAuthor} (contract-authored item?): bound by author address only`,
    );
  }

  return { level, code, reason };
};

/** Convenience: just the level (see inspectItemIntegrity for the reason). */
export const checkItemBodyIntegrity = (
  item: unknown,
  dealAuthor?: string | null,
): ItemIntegrityLevel => inspectItemIntegrity(item, dealAuthor).level;

// Stand-ins used only to re-validate a legacy item against the shared schema,
// which requires both fields. Never stored or returned.
const LEGACY_HASH_PLACEHOLDER = '0x' + '0'.repeat(64);
const LEGACY_SPEC_VERSION = '0';

/** True when the item carries a non-empty `public.plaintextHash` to check against. */
const hasPlaintextHash = (item: unknown): boolean => {
  const hash = (item as { public?: { plaintextHash?: unknown } } | null)?.public?.plaintextHash;
  return typeof hash === 'string' && hash !== '';
};

/**
 * True when `item` is a structurally valid S2SContentItem per the shared
 * content-item schema (the shape gate, BEFORE any integrity verdict).
 *
 * LEGACY TOLERANCE: the shared schema requires `public.specVersion` and
 * `public.plaintextHash`; an item minted before those fields existed is
 * UNVERIFIABLE, not invalid. When the only things missing are those two fields,
 * the item is re-validated with placeholders and accepted (inspectItemIntegrity
 * then reports 'legacy-item'). Any other schema failure still rejects it.
 */
export const isValidContentItem = (item: unknown): item is S2SContentItem => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  if (s2sContentItemSchema.safeParse(item).success) return true;
  const pub = (item as { public?: unknown }).public;
  if (!pub || typeof pub !== 'object' || Array.isArray(pub)) return false;
  const patched: Record<string, any> = {
    ...(item as Record<string, unknown>),
    public: { ...(pub as Record<string, unknown>) },
  };
  if (typeof patched.public.specVersion !== 'string' || patched.public.specVersion === '') {
    patched.public.specVersion = LEGACY_SPEC_VERSION;
  }
  if (!hasPlaintextHash(item)) patched.public.plaintextHash = LEGACY_HASH_PLACEHOLDER;
  return s2sContentItemSchema.safeParse(patched).success;
};

/** Keep the old name working for callers/tests written against it. */
const isValidItem = isValidContentItem;

/**
 * Judge a freshly refetched (cold-path) item: the ONE caching/serving policy
 * shared by the render read path and maintain-cache, so a corrupt item is
 * neither served nor written back by one consumer while the other refuses it.
 *
 * `usable` is true for 'verified' and 'unverifiable' (unverifiable is served by
 * design — see the header); false only for 'mismatch'.
 */
export interface RefetchedItemVerdict {
  usable: boolean;
  integrity: ItemIntegrity;
}

export const judgeRefetchedItem = (
  item: unknown,
  dealAuthor: string | null | undefined,
  genesis: string,
  cid: string,
): RefetchedItemVerdict => {
  if (!isValidContentItem(item)) {
    return {
      usable: false,
      integrity: {
        level: 'mismatch',
        code: 'malformed-item',
        reason: `refetched content is not a valid content item (${genesis})`,
      },
    };
  }
  const integrity = inspectItemIntegrity(item, dealAuthor);
  return { usable: integrity.level !== 'mismatch', integrity };
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
      isValidItem(entry.item)
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
