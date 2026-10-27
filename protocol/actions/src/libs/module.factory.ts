import { evmRead } from './evm';
import { catFile } from './ipfs.factory';
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
 * The stored body does not hash to the author-signed `public.plaintextHash`.
 * Thrown by the direct read path (fetchItemById/fetchById); callers must fail
 * the job instead of rendering or republishing unverified content.
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
  /** The stored bytes are not the bytes the author signed (hash mismatch). */
  | 'integrity'
  /** The item could not be read at all (IPFS cat, JSON parse, malformed item). */
  | 'unavailable';

export type ItemCheck = { ok: true } | { ok: false; reason: string };

export type ItemRead =
  | { ok: true; item: StoredContentItem }
  | { ok: false; kind: ItemFailureKind; reason: string; error?: unknown };

/** A skipped collection item: the availability shape plus its failure kind. */
export type ItemSkip = Pick<DataAvailabilityEntry, 'genesis' | 'cid' | 'reason'> & {
  cause: ItemFailureKind;
};

/**
 * The ONE definition of "this item is plaintext" — shared by toBody (how the
 * body is flattened) and checkItemIntegrity (whether the stored body can be
 * hashed). An item that omits `encryption` is plaintext, exactly as toBody has
 * always treated it; keeping two predicates is how a body gets flattened as
 * plaintext yet never checked.
 */
export const isPlaintextItem = (item: { encryption?: unknown }): boolean => !item.encryption;

/**
 * Verify a stored item's plaintext body against its own signed
 * `public.plaintextHash`.
 *
 * - Encrypted items store CIPHERTEXT: nothing to check here (verify after
 *   decryption with {@link verifyDecryptedBody}).
 * - Items with no `plaintextHash` (legacy, pre-specVersion-1) are accepted
 *   unverified **by design** — verification is opt-in on the item's own
 *   self-declared hash, so "every rendered body was hash-checked" is NOT true
 *   for legacy content.
 * - A plaintext item whose `body` is not a string, or is not the exact bytes
 *   that hash to `plaintextHash`, fails with kind `integrity`.
 *
 * The hash is taken over the STORED STRING, never a re-serialisation: that is
 * the only way to assert "the bytes the author hashed".
 */
export const checkItemIntegrity = (entry: Entry, item: StoredContentItem): ItemCheck => {
  const expected = item.public.plaintextHash;
  if (!expected) return { ok: true };
  if (!isPlaintextItem(item)) return { ok: true };
  const where = `${entry.genesis} (cid ${entry.cid})`;
  if (typeof item.body !== 'string') {
    return { ok: false, reason: `plaintext body missing for ${where}: item.body is not a string` };
  }
  if (!verifyBodyHash(item.body, expected)) {
    return {
      ok: false,
      reason: `plaintext hash mismatch for ${where}: the stored body does not match public.plaintextHash`,
    };
  }
  return { ok: true };
};

/** Enough of a parsed IPFS body to flatten safely (the public envelope). */
const isStoredContentItem = (value: unknown): value is StoredContentItem => {
  if (value == null || typeof value !== 'object') return false;
  const pub = (value as { public?: unknown }).public;
  return pub != null && typeof pub === 'object';
};

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
      reason: `IPFS retrieval failed: ${e instanceof Error ? e.message : String(e)}`,
      error: e,
    };
  }
  if (!isStoredContentItem(parsed)) {
    return {
      ok: false,
      kind: 'unavailable',
      reason: `malformed content item ${entry.genesis} (cid ${entry.cid}): no public envelope`,
    };
  }
  const item = parsed;

  const check = checkItemIntegrity(entry, item);
  if (!check.ok) return { ok: false, kind: 'integrity', reason: check.reason };

  if (isPlaintextItem(item)) {
    try {
      JSON.parse(item.body);
    } catch (e) {
      return {
        ok: false,
        kind: 'unavailable',
        reason: `stored body is not valid plaintext JSON for ${entry.genesis} (cid ${entry.cid}): ${e instanceof Error ? e.message : String(e)}`,
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
export const verifyDecryptedBody = (item: PlaintextHashCarrier, raw: unknown): boolean => {
  const expected = item.public?.plaintextHash ?? item.plaintextHash;
  if (!expected) return true; // legacy: nothing was signed to compare against
  // Only the decryptor's own STRING can be checked. A parsed object would have
  // to be re-serialised first, and JSON.stringify(parsed) is NOT the bytes the
  // author hashed: JCS orders integer-like keys lexically ({"10":…,"2":…}) while
  // JSON.stringify emits them numerically ({"2":…,"10":…}). That both rejects
  // correctly signed items and accepts differently-formatted forgeries, so a
  // non-string is treated as unverifiable (fail closed).
  if (typeof raw !== 'string') return false;
  return verifyBodyHash(raw, expected);
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
