import { evmRead } from './evm';
import { catFile } from './ipfs.factory';
import {
  HASH32_RE as INTEGRITY_HASH32_RE,
  inspectItemIntegrity,
  isValidContentItem,
  skipReason,
  type ItemIssueCode,
} from './item-integrity';
import { verifyBodyHash } from '@s2s/soul2soul-shared/lit-actions';
import type {
  S2SContentItem,
  S2SPublicContent,
  DataAvailabilityEntry,
} from '@s2s/soul2soul-shared/lit-actions';

// ── Module ABIs (Base) ────────────────────────────────────────────────────
// Entry tuple returned by getLatest / getDeals / getOffers.
const ENTRY_COMPONENTS = [
  { name: 'genesis', type: 'bytes32' },
  { name: 'author', type: 'address' },
  { name: 'cid', type: 'string' },
  { name: 'timestamp', type: 'uint256' },
];

const MODULE_ABI = [
  {
    type: 'function',
    name: 'getLatest',
    stateMutability: 'view',
    inputs: [{ name: 'genesis', type: 'bytes32' }],
    outputs: [{ name: '', type: 'tuple', components: ENTRY_COMPONENTS }],
  },
  {
    type: 'function',
    name: 'getDeals',
    stateMutability: 'view',
    inputs: [
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'tuple[]', components: ENTRY_COMPONENTS }],
  },
];

// Version tuple returned by getVersion / getVersionCount.
const VERSION_COMPONENTS = [
  { name: 'cid', type: 'string' },
  { name: 'timestamp', type: 'uint256' },
  { name: 'tombstone', type: 'bool' },
];

const VERSION_ABI = [
  {
    type: 'function',
    name: 'getVersion',
    stateMutability: 'view',
    inputs: [
      { name: 'genesis', type: 'bytes32' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'tuple', components: VERSION_COMPONENTS }],
  },
  {
    type: 'function',
    name: 'getVersionCount',
    stateMutability: 'view',
    inputs: [{ name: 'genesis', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
];

export interface Entry {
  genesis: string;
  author: string;
  cid: string;
  timestamp: number;
}

const toEntry = (e: any): Entry => ({
  genesis: e.genesis,
  author: e.author,
  cid: e.cid,
  timestamp: Number(e.timestamp),
});

/**
 * A content item as read from IPFS.
 *
 * Newer items are the full canonical S2SContentItem (objectId/proof plus
 * public.plaintextHash/specVersion/mediaType). Legacy items predate that
 * envelope, so those identity fields are OPTIONAL here while the fields the
 * render path has always read (public.author …) stay required.
 */
export type StoredContentItem = Omit<S2SContentItem, 'objectId' | 'proof' | 'public'> & {
  objectId?: string;
  proof?: S2SContentItem['proof'];
  public: Partial<Omit<S2SPublicContent, 'author'>> & Pick<S2SPublicContent, 'author'>;
};

/** Anything carrying a plaintext hash: the canonical item or a flat toBody body. */
export interface PlaintextHashCarrier {
  public?: { plaintextHash?: string } | null;
  plaintextHash?: string;
}

/**
 * The stored item failed the integrity verdict — it is not what the author
 * signed (see item-integrity.ts: author binding, plaintextHash, objectId
 * digest, proof signer). Thrown by the direct read path
 * (fetchItemById/fetchById); callers must fail the job instead of rendering or
 * republishing unverified content. The message names the verdict code.
 *
 * Collection paths do NOT throw — they return an {@link ItemSkip} instead, so
 * one bad item cannot take a whole page down.
 */
export class ContentIntegrityError extends Error {
  readonly genesis: string;
  readonly cid: string;

  constructor(message: string, genesis: string, cid: string) {
    super(message);
    this.name = 'ContentIntegrityError';
    this.genesis = genesis;
    this.cid = cid;
  }
}

/** Why a single stored item could not be used. */
export type ItemFailureKind =
  /**
   * The item arrived and failed the integrity verdict: a hash / author /
   * objectId / proof check did not hold. Never served; see item-integrity.ts.
   */
  | 'integrity'
  /** The item could not be read at all (IPFS cat, JSON parse, malformed item). */
  | 'unavailable';

export type ItemCheck =
  | { ok: true }
  /** `code` is the exact integrity verdict bucket (see item-integrity.ts). */
  | { ok: false; code: ItemIssueCode; reason: string };

export type ItemRead =
  | { ok: true; item: StoredContentItem }
  | { ok: false; kind: ItemFailureKind; reason: string; error?: unknown };

/** A skipped collection item: the availability shape plus its failure kind. */
export type ItemSkip = Pick<DataAvailabilityEntry, 'genesis' | 'cid' | 'reason'> & {
  cause: ItemFailureKind;
};

/**
 * The ONE definition of "this item is plaintext" — shared by toBody (how the
 * body is flattened) and the integrity verdict (whether the stored body can be
 * hashed at all, or must be checked after decryption). An item that omits
 * `encryption` is plaintext, exactly as toBody has always treated it; keeping
 * two predicates is how a body gets flattened as plaintext yet never checked.
 */
export const isPlaintextItem = (item: { encryption?: unknown }): boolean => !item.encryption;

/**
 * Items the direct path serves WITHOUT a full proof — one log line per verdict
 * code per invocation (a Lit Action module is created per render, so this is
 * per render, not per item).
 */
const warnedWeakVerdicts = new Set<ItemIssueCode>();

/**
 * Inspect a stored item with the ONE verdict definition shared with the archive
 * read path ({@link inspectItemIntegrity} in item-integrity.ts), bound to the
 * deal author from the chain.
 *
 * WHY THE DIRECT PATH NOW RUNS THE FULL VERDICT. It used to check only
 * `plaintextHash`, i.e. "this body matches the hash inside this blob" — which a
 * forger satisfies by hashing their own body. The check that actually means
 * something is the author binding, and the direct path had none. Both paths read
 * the same publication, so both must answer "may this item be served?" the same
 * way; otherwise the cheap read (archive) is stronger than the authoritative
 * one.
 *
 * WHAT THE DIRECT PATH RELIES ON. Nothing but this verdict. `catFile` is an
 * HTTP GET to `endpoints.ipfsGateway`, and NOTHING on either read path
 * recomputes the multihash over the bytes it received — so a gateway that
 * substitutes a blob (or a lying `/api/v0/cat` response) is indistinguishable
 * from an honest one *before* these checks. The archive path is not weaker
 * here either: its pointer is writeable AND its bytes come from the same
 * gateway. Both paths therefore rest on the same three things — the author
 * binding from the chain, the author's signature, and the plaintext hash — and
 * on neither is the check "defence in depth". That is why 'signature-not-author'
 * is a live residual for anyone who controls the gateway (see item-integrity.ts).
 *
 * WEAKER PATH, BY DESIGN (served, logged once per code per invocation):
 *   - 'encrypted'            — ciphertext body; check the plaintext after
 *                              decryption ({@link verifyDecryptedBody});
 *   - 'legacy-item'          — no specVersion: the EIP-712 digest is not
 *                              reproducible, so only the author binds it;
 *   - 'hash-malformed' / 'objectid-malformed' — present but not a digest: a
 *                              third-party writer with another encoding must not
 *                              have their content erased forever;
 *   - 'signature-unrecoverable' / 'signature-not-author' — contract wallet or
 *                              no typed-data signer in this runtime (closing the
 *                              latter needs an on-chain isOwner read).
 * Those items are served and reported as doubts, never as tampering. A
 * 'mismatch' is never served: collections skip it (kind 'integrity'), and
 * fetchById/fetchItemById throw {@link ContentIntegrityError}.
 */
export const checkItemIntegrity = (entry: Entry, item: StoredContentItem): ItemCheck => {
  const verdict = inspectItemIntegrity(item, entry.author);

  if (verdict.level === 'mismatch') {
    return {
      ok: false,
      code: verdict.code,
      reason: `integrity check failed for ${entry.genesis} (cid ${entry.cid}): ${verdict.code} — ${verdict.reason}`,
    };
  }

  if (verdict.level === 'unverifiable') {
    // Bounded noise: one line per code per invocation, with the first genesis
    // that hit it — the per-item detail is on the body/skip that carries it.
    if (!warnedWeakVerdicts.has(verdict.code)) {
      warnedWeakVerdicts.add(verdict.code);
      console.warn(
        `item integrity: serving ${entry.genesis} unverified (${verdict.code}): ${verdict.reason}`,
      );
    }
  }

  return { ok: true };
};

/**
 * Clear the once-per-code warning latch. A Lit Action module is instantiated
 * per render so production never needs this; tests share one module instance.
 */
export const resetIntegrityWarningLatch = (): void => warnedWeakVerdicts.clear();

/**
 * THE choke point for reading one stored item: exactly one cat, then parse,
 * shape check, integrity check, and a parse of the plaintext body (so a
 * successful read is guaranteed to flatten with toBody). Every entry point —
 * `fetchById`, `fetchItemById`, `fetchByPublicationWithSkips`,
 * `fetchByPublicationDetailed` — goes through here, so no path can serve an
 * unverified body. Callers that cannot fail (collections) turn a `!ok` result
 * into an {@link ItemSkip}; the direct path turns `integrity` into a
 * {@link ContentIntegrityError}.
 */
export const readItemByEntry = async (entry: Entry, gateway?: string): Promise<ItemRead> => {
  let parsed: unknown;
  try {
    // `gateway ?? ''` rather than `gateway!`: a missing gateway must fail the
    // cat (→ unavailable) instead of stringifying to `undefined/api/v0/cat`.
    parsed = JSON.parse(await catFile(gateway ?? '', entry.cid));
  } catch (e) {
    return {
      ok: false,
      kind: 'unavailable',
      reason: skipReason(
        'unavailable',
        null,
        `IPFS retrieval failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
      error: e,
    };
  }
  // SHAPE GATE FIRST, and the SAME one the archive path applies (parseArchive →
  // isValidContentItem). It used to be "anything with a public object", so the
  // two doors disagreed about the same bytes: an item missing `public.tags`, or
  // carrying `public.author = 'nobody'`, was served by fetchById and refused by
  // reconcile. A malformed item is 'unavailable' on both paths — the bytes
  // could not be read as an item, which is not the same claim as "forged".
  if (!isValidContentItem(parsed)) {
    return {
      ok: false,
      kind: 'unavailable',
      reason: skipReason(
        'unavailable',
        null,
        `malformed content item ${entry.genesis} (cid ${entry.cid}): not a valid S2SContentItem`,
      ),
    };
  }
  const item = parsed;

  const check = checkItemIntegrity(entry, item);
  if (!check.ok) {
    // Same taxonomy as the archive path (data.ctrlr causeOf): an item that
    // cannot be read (malformed) is 'unavailable'; an item that arrived and is
    // not what the author signed is 'integrity'.
    return {
      ok: false,
      kind: check.code === 'malformed-item' ? 'unavailable' : 'integrity',
      reason: skipReason(
        check.code === 'malformed-item' ? 'unavailable' : 'integrity',
        check.code,
        check.reason,
      ),
    };
  }

  if (isPlaintextItem(item)) {
    try {
      JSON.parse(item.body);
    } catch (e) {
      return {
        ok: false,
        kind: 'unavailable',
        reason: skipReason(
          'unavailable',
          null,
          `stored body is not valid plaintext JSON for ${entry.genesis} (cid ${entry.cid}): ${e instanceof Error ? e.message : String(e)}`,
        ),
        error: e,
      };
    }
  }

  return { ok: true, item };
};

// ── Adapter: S2SContentItem (IPFS) → flat S2SBody (what the pipeline expects) ──
// Mirrors the old lens formatSingle: encrypted → body carries the ciphertext;
// plain → spread the parsed body. Keeps downstream (data.ctrlr, decrypt,
// config.ctrl) unchanged.
//
// IDENTITY IS CARRIED ALONGSIDE the legacy flat fields (additively — every
// pre-existing field keeps its name and value): a page must be able to say
// WHICH version (cid/objectId) and WHICH plaintext (plaintextHash) it renders.
// Legacy items may omit objectId/proof/plaintextHash/specVersion/mediaType; a
// missing identity field is simply absent from the result, never thrown on and
// never defaulted (the schema check stays where it is).
export const toBody = (entry: Entry, item: StoredContentItem): any => {
  const p = item.public;
  const identity = {
    cid: entry.cid, // REAL deal cid — never a bytes32 id
    objectId: item.objectId,
    plaintextHash: p.plaintextHash,
    specVersion: p.specVersion,
    mediaType: p.mediaType,
    proof: item.proof,
  };
  const base = {
    id: entry.genesis, // job identity is the genesis
    author: p.author, // did:ethr:0x... — pass through from IPFS
    locale: p.locale,
    parent: p.parent,
    position: p.position,
    postType: p.postType,
    creationDate: String(p.createdAt), // this version's timestamp
    modifiedDate: String(p.createdAt),
    tags: p.tags,
    attributes: p.attributes,
    publication: p.publication,
    base: p.base,
    ...identity,
  };

  if (!isPlaintextItem(item)) {
    // content is the ciphertext string; decrypt.ts does JSON.parse(body.content)
    return { ...base, encryption: true, content: item.body };
  }

  const parsed = JSON.parse(item.body); // { title, slug, content, custom? }
  return {
    ...base,
    encryption: false,
    content: parsed.content,
    title: parsed.title,
    slug: parsed.slug,
    custom: parsed.custom,
  };
};

// ── Reads ─────────────────────────────────────────────────────────────────

export const getLatestEntry = async (
  genesis: string,
  publicationModule: string,
  rpcs?: string[],
): Promise<Entry> => {
  const e = await evmRead('L2', publicationModule, MODULE_ABI, 'getLatest', [genesis], rpcs);
  return toEntry(e);
};

/** Enumerate all deals for this publication (paginated). Entry.cid is the latest. */
export const getDeals = async (
  publicationModule: string,
  rpcs?: string[],
  pageSize = 100,
): Promise<Entry[]> => {
  const out: Entry[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page: any[] = await evmRead(
      'L2',
      publicationModule,
      MODULE_ABI,
      'getDeals',
      [offset, pageSize],
      rpcs,
    );
    for (const e of page) out.push(toEntry(e));
    if (page.length < pageSize) break;
  }
  return out;
};

// ── Drop-in replacements for lens.factory ─────────────────────────────────

/**
 * Read the latest version of a document as BOTH its deal entry and its full
 * content item — exactly ONE cat per fetch.
 *
 * Integrity (direct read path): when the item is plaintext (`encryption ===
 * false`) the stored `body` IS the canonical plaintext JSON the author signed
 * over (`public.plaintextHash`), so it is verified here. A mismatch throws
 * {@link ContentIntegrityError}: the caller must fail the job rather than
 * render (or republish) a body the author never signed. Items with no
 * `plaintextHash` (legacy, pre-specVersion-1) are not failed — there is
 * nothing to check against.
 *
 * Encrypted items store ciphertext, so the plaintext cannot be checked here;
 * use {@link verifyDecryptedBody} once the body has been decrypted.
 */
export const fetchItemById = async (
  genesis: string,
  publicationModule: string,
  rpcs?: string[],
  gateway?: string,
): Promise<{ entry: Entry; item: StoredContentItem } | undefined> => {
  const entry = await getLatestEntry(genesis, publicationModule, rpcs);
  if (!entry.cid) return undefined;

  const read = await readItemByEntry(entry, gateway);
  if (!read.ok) {
    if (read.kind === 'integrity') {
      throw new ContentIntegrityError(read.reason, entry.genesis, entry.cid);
    }
    // Unchanged behaviour: a cat/parse failure propagates to the caller.
    if (read.error instanceof Error) throw read.error;
    throw new Error(read.reason);
  }
  return { entry, item: read.item };
};

/**
 * Replaces lens.factory `fetchById`. Reads latest cid from the module, cats
 * from IPFS once (via fetchItemById, which also verifies a plaintext body's
 * hash), and flattens with toBody. Same return shape as before.
 */
export const fetchById = async (
  genesis: string,
  publicationModule: string,
  rpcs?: string[],
  gateway?: string,
): Promise<any> => {
  const res = await fetchItemById(genesis, publicationModule, rpcs, gateway);
  if (!res) return undefined;
  return toBody(res.entry, res.item);
};

/**
 * Verify a DECRYPTED body against the item's signed `plaintextHash`.
 *
 * The direct read path can only check plaintext items in situ (the stored body
 * IS the canonical JSON). For encrypted items the check moves to the first
 * point the plaintext exists — right after decryption — and this helper is
 * called with the decryptor's RAW string (see decryptRaw in libs/decrypt.ts),
 * never with a re-serialisation. Accepts the canonical content item
 * (`item.public.plaintextHash`) or a flat fetch body (which toBody now carries
 * `plaintextHash` on).
 *
 * Returns true when there is nothing to check (legacy item: no plaintextHash),
 * so callers can use it unconditionally without failing old content.
 */
export type DecryptedBodyVerdict = 'verified' | 'weak' | 'uncheckable' | 'mismatch';

export const verifyDecryptedBody = (
  item: PlaintextHashCarrier,
  raw: unknown,
): DecryptedBodyVerdict => {
  const expected = item.public?.plaintextHash ?? item.plaintextHash;
  // No hash: nothing was signed to compare against. `uncheckable` (NOT
  // `verified`) so a caller can log the doubt instead of claiming a check it
  // could not run.
  if (!expected) return 'uncheckable';
  // Present but not a digest. inspectItemIntegrity deliberately treats this as a
  // DOUBT ('hash-malformed', served) rather than tampering; mirroring it here
  // keeps the post-decryption gate from being strictly harder than the at-rest
  // one, which would drop a third-party-hash-encoded encrypted item from every
  // collection and fail the page job.
  if (!INTEGRITY_HASH32_RE.test(expected)) return 'weak';
  // Only the decryptor's own STRING can be checked. A parsed object would have
  // to be re-serialised first, and JSON.stringify(parsed) is NOT the bytes the
  // author hashed: JCS orders integer-like keys lexically ({"10":…,"2":…}) while
  // JSON.stringify emits them numerically ({"2":…,"10":…}). That both rejects
  // correctly signed items and accepts differently-formatted forgeries, so a
  // non-string fails closed as 'mismatch'.
  if (typeof raw !== 'string') return 'mismatch';
  return verifyBodyHash(raw, expected) ? 'verified' : 'mismatch';
};

/**
 * Replaces lens.factory `fetchByQuery` for the "filter by publication" case.
 * The module instance IS the publication, so this is getDeals() + cat each cid.
 */
export const fetchByPublication = async (
  publicationModule: string,
  rpcs?: string[],
  gateway?: string,
): Promise<any[]> => {
  const { bodies } = await fetchByPublicationWithSkips(publicationModule, rpcs, gateway);
  return bodies;
};

/**
 * ONE pass over a publication's deals: getDeals → readItemByEntry (the single
 * cat + integrity choke point) → toBody. Bodies come out in DEAL ORDER and a
 * bad item becomes an {@link ItemSkip} (never an exception, never a rendered
 * body), carrying `cause` so a caller can tell a hash mismatch from an
 * unavailable blob.
 *
 * Both collection readers and the archive drift refetch must use this (or
 * readItemByEntry directly) — a cat+toBody pair anywhere else is a hole: a
 * forged body would flow straight into filter/sort and onto the page.
 */
const readPublicationItems = async (
  caller: string,
  publicationModule: string,
  rpcs?: string[],
  gateway?: string,
): Promise<{
  bodies: any[];
  items: Map<string, S2SContentItem>;
  entries: Entry[];
  skips: ItemSkip[];
}> => {
  const entries = await getDeals(publicationModule, rpcs);
  const reads = await Promise.all(entries.map((entry) => readItemByEntry(entry, gateway)));

  const bodies: any[] = [];
  const items = new Map<string, S2SContentItem>();
  const skips: ItemSkip[] = [];
  entries.forEach((entry, i) => {
    const read = reads[i];
    if (!read.ok) {
      console.warn(`${caller}: skip ${entry.genesis} (${entry.cid})`, read.reason);
      skips.push({
        genesis: entry.genesis,
        cid: entry.cid,
        reason: read.reason,
        cause: read.kind,
      });
      return;
    }
    // read.item is the same object read off IPFS; the map is the archive seed
    // (canonical items), so keep its declared type.
    items.set(entry.genesis, read.item as S2SContentItem);
    bodies.push(toBody(entry, read.item));
  });
  return { bodies, items, entries, skips };
};

/**
 * Variant of fetchByPublication that also collects structured skip records for
 * the data-availability report. Callers that need availability classification
 * (render action) use this directly; callers that don't (prep) keep using
 * fetchByPublication.
 */
export const fetchByPublicationWithSkips = async (
  publicationModule: string,
  rpcs?: string[],
  gateway?: string,
): Promise<{ bodies: any[]; skips: ItemSkip[] }> => {
  const { bodies, skips } = await readPublicationItems(
    'fetchByPublication',
    publicationModule,
    rpcs,
    gateway,
  );
  return { bodies, skips };
};

/**
 * Bootstrap variant of fetchByPublication for the cache-maintainer render's
 * NO-ARCHIVE path (archive pointer empty — cache never bootstrapped).
 *
 * Returns the SAME flat bodies as fetchByPublication (single pass, byte-identical
 * ordering) but ALSO captures, in that same single cat per entry, the full
 * canonical S2SContentItem (keyed by genesis) and the deal entries — exactly
 * what the T4 write-back needs to SEED the first archive snapshot. There is NO
 * second fetch: build bodies and archive-source items together.
 *
 * `fetchByPublication` itself is left untouched (its array-of-bodies return
 * type is contractual — prep/main.ts reads it).
 */
export const fetchByPublicationDetailed = async (
  publicationModule: string,
  rpcs?: string[],
  gateway?: string,
): Promise<{
  bodies: any[];
  items: Map<string, S2SContentItem>;
  entries: Entry[];
  skips: ItemSkip[];
}> => {
  const { bodies, skips, entries, items } = await readPublicationItems(
    'fetchByPublicationDetailed',
    publicationModule,
    rpcs,
    gateway,
  );
  return { bodies, items, entries, skips };
};

export interface Version {
  cid: string;
  timestamp: number;
  tombstone: boolean;
}

const toVersion = (v: any): Version => ({
  cid: v.cid,
  timestamp: Number(v.timestamp),
  tombstone: v.tombstone,
});

/** Read the last version of a genesis from the on-chain log (previous slug). */
export const getVersion = async (
  genesis: string,
  publicationModule: string,
  rpcs?: string[],
): Promise<Version | null> => {
  const count: number = await evmRead(
    'L2',
    publicationModule,
    VERSION_ABI,
    'getVersionCount',
    [genesis],
    rpcs,
  );
  if (count <= 1) return null; // no previous version to diff against
  const v = await evmRead(
    'L2',
    publicationModule,
    VERSION_ABI,
    'getVersion',
    [genesis, count - 2],
    rpcs,
  );
  return toVersion(v);
};
