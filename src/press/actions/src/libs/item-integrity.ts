/// <reference path="../action_globals.ts" />

import { verifyBodyHash } from '@s2s/soul2soul-shared/lit-actions';
import { s2sContentItemSchema } from '@s2s/soul2soul-shared/rendering/action-io';
// `S2S_DOMAIN` / `signingEnvelope` are NOT re-exported from
// @s2s/soul2soul-shared/lit-actions (only `jcs` and `verifyBodyHash` are) and
// shared/** is out of scope here, so the compiled identity helpers are imported
// directly — the same pattern data.ctrlr.ts already uses for
// shared/dist/manuscript/types. Both files are dependency-free (no zod, no viem),
// so they stay bundle-safe inside a Lit Action.
import {
  type AnyS2SContentItem,
  S2S_DOMAIN,
  bodyForKey,
} from '../../../../shared/dist/manuscript/types';
import { signingEnvelope } from '../../../../shared/dist/manuscript/identity/signing-view';

// ───────────────────────────────────────────────────────────────────────────
// ONE definition of "this stored item may be served".
//
// Two read paths consume it and must never disagree about the same item:
//
//   ARCHIVE path (writeable cache)         DIRECT path (content-addressed)
//   getDeals() + cat(content_cache_…)      getLatestEntry() + cat(deal cid)
//   libs/archive.factory.ts                libs/module.factory.ts
//     reconcile() → inspectItemIntegrity()   fetchById() → checkItemIntegrity()
//     mismatch ⇒ MISS, refetch               mismatch ⇒ ContentIntegrityError
//                                            (page fails; collections skip)
//
// WHERE THE TWO PATHS DIFFER — and only here:
//
//  1. FAILURE SHAPE, not verdict. A 'mismatch' is never served by either path,
//     but the archive path turns it into a MISS + refetch (a cache entry can be
//     repaired) while the direct path has nothing to refetch — the content IS
//     the cid — so it fails the page (fetchById/fetchItemById throw
//     ContentIntegrityError) or drops the item (collections return an ItemSkip).
//  2. NOTHING ELSE. In particular the direct path is NOT protected by
//     content-addressing: `catFile` is an HTTP GET to `endpoints.ipfsGateway`
//     and NO code on either path recomputes the multihash over the bytes it
//     received. A substituted blob therefore arrives looking exactly like a
//     real deal's item, and these checks are the SOLE control on both paths.
//     That is why the residual below (signature-not-author) is live for anyone
//     who controls the gateway, and why the verdict is not "defence in depth"
//     anywhere: it is the defence, everywhere.
//
// INTEGRITY — what inspectItemIntegrity() actually proves
// ------------------------------------------------------
// A schema-valid item can carry a fake body while wearing a real cid, because
// the item's own CID cannot be recomputed once it is stored inside a container
// (or is handed to us by a gateway). The checks below are the substitute, in
// ascending order of strength:
//
//   1. AUTHOR BINDING: `public.author` must equal the deal's author
//      (`Entry.author` from getDeals()/getLatestEntry()). Without this, a
//      self-consistent forged item (attacker's own author + own hash + own
//      proof) verifies trivially, because every check below is satisfied
//      *within* the blob.
//   2. PLAINTEXT HASH: `keccak256(utf8(bodies.s2s))` must equal the item's own
//      signed `public.plaintextHash`. This binds the body bytes to the public
//      block; on its own it does NOT bind them to the author (see 3/4).
//   3. OBJECT ID: `item.objectId` must equal the EIP-712 digest of `public` —
//      so `public` (including plaintextHash) is the block the author actually
//      attested to, not one rewritten around a new body.
//   4. PROOF SIGNER: recovering the EIP-712 signer from `proof.signature` must
//      match `proof.signer`.
//
// RESIDUAL (documented, not hidden): the recovered signer is NOT required to
// equal `public.author`, because a Safe/contract-authored item is signed by an
// owner EOA, and proving that EOA owns that Safe needs an RPC read this pure
// module cannot do. Those items are served at 'unverifiable'
// (code 'signature-not-author'), bound by the author address only. Consequence:
// an attacker who copies the real deal author into `public.author`, sets
// `plaintextHash = keccak(their body)` and signs with their own key satisfies
// 1–4 and is served. Closing that needs on-chain ownership proof (isOwner) of
// the signing EOA on the publication Safe — a follow-up at the I/O edge.
//
// ENCRYPTED items: their `s2s` body is ciphertext, so 2 cannot run here (they are
// served at 'unverifiable' / 'encrypted' after 1, 3, 4). The PLAINTEXT is
// verified after decryption, against the item's `public.plaintextHash`, at both
// places it exists: the page body in `render/data.ctrlr.ts`
// (initTemplateData → verifyDecrypted) and every encrypted item inside a render
// COLLECTION in `render/main.ts` (verifyDecryptedBody(item, d.raw)). Both hash
// the decryptor's raw string — the bytes the author signed — and both drop /
// fail the item on mismatch; neither is left unverified.
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
// VERDICTS: 'verified' (all applicable checks passed) / 'unverifiable' (a check
// cannot be performed in this runtime or on this item — served, reason
// recorded) / 'mismatch' (a check failed — NEVER served).
//
// Everything here is pure/deterministic — no chain or IPFS calls — so the whole
// correctness story is unit-testable in isolation. Callers wire the I/O and
// pass in the deal author they already have.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Integrity verdict level for one stored/fetched item.
 *
 *  - 'verified'     — every applicable check passed;
 *  - 'unverifiable' — a check cannot be performed in this runtime (encrypted
 *                     body, legacy item, malformed hash, contract-authored
 *                     signer, no typed-data signer available). SERVED; `code`
 *                     says which check and why;
 *  - 'mismatch'     — a check FAILED: the item is forged/corrupt and must never
 *                     be served.
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

/**
 * How a failure kind is spelled at the boundary. `DataAvailabilityEntry` (the
 * cross-action skip type) carries no `cause` field, so the KIND and the CODE
 * have to survive inside the free-text `reason` — prose alone left a client
 * unable to tell "forged" from "gateway was down" except by parsing English.
 *
 * Every skip reason produced by ANY read path (direct collection fetch, archive
 * read, refetch rejection) is therefore built by {@link skipReason} and starts
 * with one of exactly two prefixes:
 *
 *     integrity(<code>): <detail>      e.g. integrity(hash-mismatch): …
 *     unavailable: <detail>
 *
 * `<code>` is an {@link ItemIssueCode}. Grep it, or match
 * `/^(integrity\(([a-z-]+)\)|unavailable): /`. Adding `cause?: ItemFailureKind`
 * (plus `code?: ItemIssueCode`) to `DataAvailabilityEntry` is the clean fix and
 * needs a change to shared/** — deliberately not done here.
 */
export type SkipCause = 'integrity' | 'unavailable';

export const SKIP_REASON_RE = /^(integrity\(([a-z-]+)\)|unavailable): /;

export const skipReason = (cause: SkipCause, code: ItemIssueCode | null, detail: string): string =>
  cause === 'integrity' ? `integrity(${code ?? 'unknown'}): ${detail}` : `unavailable: ${detail}`;

/**
 * The body bytes this press reads: the protocol's entry in the item's body map.
 *
 * Storage layout v3 carries `bodies`, one body per key holder; v1/v2 carry a
 * single `body`. Both resolve through the same shared helper, so a legacy item
 * stays readable. `StoredContentItem` loosens `public` for legacy tolerance and
 * is therefore not assignable to the shared union — the widening lives here and
 * nowhere else. Undefined when the item has no `s2s` body at all; every caller
 * below turns that into the failure it already had.
 */
export const storedBody = (item: {
  body?: unknown;
  bodies?: unknown;
}): string | undefined => bodyForKey(item as unknown as AnyS2SContentItem);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** 32-byte hex digest. Shared with verifyDecryptedBody so the at-rest and
 * post-decryption gates agree about what "a hash we can check" means. */
export const HASH32_RE = /^0x[0-9a-fA-F]{64}$/;

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

/**
 * EIP-712 digest of the item's `public` block, or null when unavailable.
 *
 * The struct and the signing view are picked by `public.specVersion` (see
 * signingEnvelope): '2' signs S2SContentV2, whose creationDate + modifiedDate
 * replace v1's single createdAt. A v1 item keeps its own type hash, so its
 * digest is unchanged and old items still verify.
 */
const signingDigest = (pub: Record<string, unknown>): string | null => {
  const hash = ambientEthersUtils()?._TypedDataEncoder?.hash;
  if (typeof hash !== 'function') return null;
  try {
    const { types, view } = signingEnvelope(pub as any);
    return hash(S2S_DOMAIN, types, view);
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
 * `dealAuthor` is the on-chain deal author (`Entry.author` from
 * getDeals()/getLatestEntry()). Pass it whenever it is available: without it
 * the author binding — the check that stops a self-consistent forged blob —
 * cannot run. See the module header for what each check proves and for the
 * documented residuals.
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
  const body = storedBody(it);
  if (typeof body !== 'string') {
    // Same verdict as a missing `body` always got: the item cannot be read as
    // an item, which is 'malformed', not forged.
    return mismatch('malformed-item', 'item carries no s2s body (item.body / item.bodies.s2s)');
  }

  // ── 1. author binding ──
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
    } else if (!verifyBodyHash(body, hash as string)) {
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
const LEGACY_OBJECT_ID = '0x' + '0'.repeat(64);
const LEGACY_SIGNER = '0x' + '0'.repeat(40);

/** True when the item carries a non-empty `public.plaintextHash` to check against. */
const hasPlaintextHash = (item: unknown): boolean => {
  const hash = (item as { public?: { plaintextHash?: unknown } } | null)?.public?.plaintextHash;
  return typeof hash === 'string' && hash !== '';
};

/**
 * True when `item` is a structurally valid content item per the shared
 * content-item schema (the shape gate, BEFORE any integrity verdict). The
 * schema is the union over the three storage layouts — v1/v2 `body`, v3
 * `bodies` — so an item written today and an item written before the body map
 * both pass.
 *
 * LEGACY TOLERANCE: the shared schema requires `public.specVersion`,
 * `public.mediaType` and `public.plaintextHash`; an item minted before those
 * fields existed is UNVERIFIABLE, not invalid. When the item carries no
 * `specVersion` at all, it is re-validated with those three fields filled in and
 * accepted (inspectItemIntegrity then reports 'legacy-item'). An item WITH a
 * specVersion must satisfy the schema as written — a missing field there is a
 * shape defect, and any other schema failure still rejects.
 */
export const isValidContentItem = (item: unknown): item is AnyS2SContentItem => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  if (s2sContentItemSchema.safeParse(item).success) return true;
  const pub = (item as { public?: unknown }).public;
  if (!pub || typeof pub !== 'object' || Array.isArray(pub)) return false;
  const patched: Record<string, any> = {
    ...(item as Record<string, unknown>),
    public: { ...(pub as Record<string, unknown>) },
  };
  if (typeof patched.public.specVersion !== 'string' || patched.public.specVersion === '') {
    // Legacy shape: validate it against the fields that existed BEFORE the
    // specVersion-1 envelope, not against today's required set. `specVersion`
    // and `plaintextHash` are filled in so the shared schema's required-ness
    // does not reject every old item; `mediaType` is the one other field the
    // envelope added, and an item without a specVersion cannot have been minted
    // with it.
    //
    // This patch is used ONLY for validation — the object that gets served is
    // always the caller's own, never this copy.
    patched.public.specVersion = LEGACY_SPEC_VERSION;
    if (typeof patched.public.mediaType !== 'string' || patched.public.mediaType === '') {
      patched.public.mediaType = 'application/octet-stream';
    }
    // `objectId` and `proof` arrived with the same envelope; without them an item
    // is legacy by definition (and there is nothing for the digest/signer checks
    // to run on — inspectItemIntegrity stops at 'legacy-item').
    if (typeof patched.objectId !== 'string' || patched.objectId === '') {
      patched.objectId = LEGACY_OBJECT_ID;
    }
    if (!patched.proof || typeof patched.proof !== 'object') {
      patched.proof = { type: 'eip712', signer: LEGACY_SIGNER, signature: LEGACY_OBJECT_ID };
    }
  }
  if (!hasPlaintextHash(item)) patched.public.plaintextHash = LEGACY_HASH_PLACEHOLDER;
  return s2sContentItemSchema.safeParse(patched).success;
};

/**
 * Judge a freshly refetched (cold-path) item: the ONE caching/serving policy
 * shared by the render read path and maintain-cache, so a corrupt item is
 * neither served nor written back by one consumer while the other refuses it.
 *
 * `usable` is true for 'verified' and 'unverifiable' (unverifiable is served by
 * design — see the module header); false only for 'mismatch'.
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
