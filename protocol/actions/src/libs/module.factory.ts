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

  if (item.encryption) {
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
  const item = JSON.parse(await catFile(gateway!, entry.cid)) as StoredContentItem;

  if (item.encryption === false && item.public?.plaintextHash) {
    if (!verifyBodyHash(item.body, item.public.plaintextHash)) {
      throw new ContentIntegrityError(
        `plaintext hash mismatch for ${genesis} (cid ${entry.cid}): the body does not match public.plaintextHash`,
        genesis,
        entry.cid,
      );
    }
  }

  return { entry, item };
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
 * is the canonical JSON). For encrypted items the check moves to the first
 * point the plaintext exists — right after decryption — and this helper is
 * called with the decrypted JSON. Accepts the canonical content item
 * (`item.public.plaintextHash`) or a flat fetch body (which toBody now carries
 * `plaintextHash` on).
 *
 * Returns true when there is nothing to check (legacy item: no plaintextHash),
 * so callers can use it unconditionally without failing old content.
 */
export const verifyDecryptedBody = (
  item: PlaintextHashCarrier,
  decryptedJson: unknown,
): boolean => {
  const expected = item.public?.plaintextHash ?? item.plaintextHash;
  if (!expected) return true;
  const json = typeof decryptedJson === 'string' ? decryptedJson : JSON.stringify(decryptedJson);
  if (typeof json !== 'string') return false;
  return verifyBodyHash(json, expected);
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
 * Variant of fetchByPublication that also collects structured skip records for
 * the data-availability report. Callers that need availability classification
 * (render action) use this directly; callers that don't (prep) keep using
 * fetchByPublication.
 */
export const fetchByPublicationWithSkips = async (
  publicationModule: string,
  rpcs?: string[],
  gateway?: string,
): Promise<{ bodies: any[]; skips: Pick<DataAvailabilityEntry, 'genesis' | 'cid' | 'reason'>[] }> => {
  const entries = await getDeals(publicationModule, rpcs);
  const bodies: any[] = [];
  const skips: Pick<DataAvailabilityEntry, 'genesis' | 'cid' | 'reason'>[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const item = JSON.parse(await catFile(gateway!, entry.cid));
        bodies.push(toBody(entry, item));
      } catch (e) {
        const reason = `IPFS retrieval failed: ${e instanceof Error ? e.message : String(e)}`;
        console.warn(`fetchByPublication: skip ${entry.genesis} (${entry.cid})`, reason);
        skips.push({ genesis: entry.genesis, cid: entry.cid, reason });
      }
    }),
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
  skips: Pick<DataAvailabilityEntry, 'genesis' | 'cid' | 'reason'>[];
}> => {
  const entries = await getDeals(publicationModule, rpcs);
  const bodies: any[] = [];
  const items = new Map<string, S2SContentItem>();
  const skips: Pick<DataAvailabilityEntry, 'genesis' | 'cid' | 'reason'>[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const item = JSON.parse(await catFile(gateway!, entry.cid));
        items.set(entry.genesis, item as S2SContentItem);
        bodies.push(toBody(entry, item));
      } catch (e) {
        const reason = `IPFS retrieval failed: ${e instanceof Error ? e.message : String(e)}`;
        console.warn(`fetchByPublicationDetailed: skip ${entry.genesis} (${entry.cid})`, reason);
        skips.push({ genesis: entry.genesis, cid: entry.cid, reason });
      }
    }),
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
