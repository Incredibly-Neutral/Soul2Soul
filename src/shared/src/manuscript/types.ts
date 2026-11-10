// ============================================================================
// Manuscript types — the authored thing and its proof.
//
// A manuscript is what an author signs: the public metadata (S2SPublicContent),
// the body (S2SContentBody, possibly encrypted), the digest that names it
// (objectId), and the signature over it (S2SProof). Identity is did:ethr;
// the signature is EIP-712 over the canonical form in ./identity.
//
// Everything here is dependency-free — no zod, no viem, no ethers import — so
// the types can travel into a Lit Action bundle (INV-7) and into a browser
// plugin without dragging a validator along.
// ============================================================================

// ============================================================================
// Content-Item types (canonical — identity/provenance)
// Replaces the old Lens-era S2SBody/S2SPublicContent/S2SContentItem.
// Author identity: did:ethr. Signed via EIP-712.
// ============================================================================

/** Canonical author identity form: did:ethr:0x<address> */
export type DidEthr = `did:ethr:0x${string}`;

/** The PUBLIC, queryable, SIGNED metadata. Every field here is signed via EIP-712. */
export interface S2SPublicContent {
  specVersion: string; // envelope/format version, e.g. "1" — pins canonicalization + algos
  author: DidEthr; // was: bare 0x address
  postType: string; // S2S kind (post/page); NOT how to parse the body
  mediaType: string; // how to parse the body, e.g. "text/markdown" | "text/html"
  parent: string;
  position: string;
  publication: string;
  locale: string;
  createdAt: number; // unix seconds; this version's timestamp
  base?: string;
  tags: string[]; // public + queryable → MUST be signed
  attributes?: Record<string, unknown>; // public + queryable → MUST be signed
  plaintextHash: string; // keccak256 of the canonical secret JSON (computed before encryption)
}

/**
 * v2 of the signed public metadata. Same fields in the same order, except the
 * single `createdAt` becomes two signed dates:
 *   creationDate — signing time of the genesis version (the document's birth)
 *   modifiedDate — signing time of this version
 * Both unix seconds. The different struct name and shape give a different type
 * hash, so v1 items keep verifying under S2S_TYPES and v2 items under S2S_TYPES_V2.
 */
export interface S2SPublicContentV2 {
  specVersion: string;
  author: DidEthr;
  postType: string;
  mediaType: string;
  parent: string;
  position: string;
  publication: string;
  locale: string;
  creationDate: number;
  modifiedDate: number;
  base?: string;
  tags: string[];
  attributes?: Record<string, unknown>;
  plaintextHash: string;
}

/** EIP-712 author signature over S2SPublicContent */
export interface S2SProof {
  type: 'eip712';
  signer: `0x${string}`; // recovered address (EOA); verified as a Safe owner of the author's Safe
  signature: `0x${string}`; // author EOA signature over the EIP-712 digest
}

/** The stored object — one flat shape, no discriminated union */
export interface S2SContentItem {
  public: S2SPublicContent; // signed
  objectId: string; // = EIP-712 digest of `public` (available pre-upload, pre-CID)
  proof: S2SProof;
  encryption: boolean; // true → `body` is ciphertext; false → `body` is stringified JSON
  body: string; // ciphertext OR JSON.stringify({ title, slug, content, custom })
}

/** The stored object for a v2 envelope */
export interface S2SContentItemV2 {
  public: S2SPublicContentV2; // signed
  objectId: string;
  proof: S2SProof;
  encryption: boolean;
  body: string;
}

/**
 * The key the protocol's PKP holds; every item has this body.
 *
 * A body map is keyed by key holder name: `s2s` is the protocol key, and a
 * publication with its own key adds its own entry beside it. The name is the
 * key holder, not a CID or a fingerprint, so a reader asks for "the s2s body"
 * and a publication asks for "my body" without resolving anything first.
 */
export const S2S_BODIES_KEY = 's2s';

/**
 * The stored object, storage layout v3: one body per key holder, keyed by the
 * key holder's name (`s2s` today; a publication with its own key adds its own
 * entry). The envelope is unchanged — still specVersion 2 — so objectId,
 * plaintextHash and the EIP-712 type hash are the same bytes as the v2 item's.
 *
 * v3 storage pairs with the v2 envelope; a v1-envelope item is never rewritten.
 */
export interface S2SContentItemV3 {
  public: S2SPublicContentV2; // signed
  objectId: string;
  proof: S2SProof;
  encryption: boolean;
  bodies: Record<string, string>; // key holder name → ciphertext or stringified JSON
}

/**
 * Any stored item, over the three storage layouts. v1/v2 carry a single `body`;
 * v3 carries `bodies`. Discriminate on the presence of `bodies`, not on
 * public.specVersion: a v3 item is still an envelope v2 item.
 */
export type AnyS2SContentItem = S2SContentItem | S2SContentItemV2 | S2SContentItemV3;

/** What goes into the body field of S2SContentItem (the content, optionally encrypted) */
export interface S2SContentBody {
  title: string;
  slug: string;
  content: string;
  custom?: Record<string, unknown>;
}

// ============================================================================
// EIP-712 constants
// ============================================================================

export const S2S_DOMAIN = {
  name: 'S2S Content',
  version: '1',
  chainId: 8453, // Base
} as const;

export const S2S_TYPES = {
  S2SContent: [
    { name: 'specVersion', type: 'string' },
    { name: 'author', type: 'string' },
    { name: 'plaintextHash', type: 'bytes32' },
    { name: 'postType', type: 'string' },
    { name: 'mediaType', type: 'string' },
    { name: 'parent', type: 'string' },
    { name: 'position', type: 'string' },
    { name: 'publication', type: 'string' },
    { name: 'locale', type: 'string' },
    { name: 'createdAt', type: 'uint256' },
    { name: 'base', type: 'string' },
    { name: 'tagsHash', type: 'bytes32' },
    { name: 'attributesHash', type: 'bytes32' },
  ],
};

export const S2S_TYPES_V2 = {
  S2SContentV2: [
    { name: 'specVersion', type: 'string' },
    { name: 'author', type: 'string' },
    { name: 'plaintextHash', type: 'bytes32' },
    { name: 'postType', type: 'string' },
    { name: 'mediaType', type: 'string' },
    { name: 'parent', type: 'string' },
    { name: 'position', type: 'string' },
    { name: 'publication', type: 'string' },
    { name: 'locale', type: 'string' },
    { name: 'creationDate', type: 'uint256' },
    { name: 'modifiedDate', type: 'uint256' },
    { name: 'base', type: 'string' },
    { name: 'tagsHash', type: 'bytes32' },
    { name: 'attributesHash', type: 'bytes32' },
  ],
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * The bodies of an item, whatever storage layout it was written in. v3 returns
 * its map; v1/v2 wrap their single `body` under the protocol's key.
 */
export function itemBodies(item: AnyS2SContentItem): Record<string, string> {
  if ('bodies' in item) return item.bodies;
  return { [S2S_BODIES_KEY]: item.body };
}

/**
 * The body a given key holder can read. Defaults to the protocol's key, which
 * every item has; undefined when that holder has no entry.
 */
export function bodyForKey(
  item: AnyS2SContentItem,
  key: string = S2S_BODIES_KEY,
): string | undefined {
  return itemBodies(item)[key];
}

export function toDidEthr(address: string): DidEthr {
  const addr = address.startsWith('0x') ? address : `0x${address}`;
  return `did:ethr:${addr}` as DidEthr;
}

export function eoaOf(did: DidEthr): `0x${string}` {
  return did.replace('did:ethr:', '') as `0x${string}`;
}

// ============================================================================
// Body — discriminated union on encryption (LEGACY, keep for action compatibility)
// Superseded by the flat S2SContentItem above
// ============================================================================

export interface S2SBodyBase {
  id: string; // Lens post ID
  author: string; // Ethereum address
  locale: string;
  parent: string;
  position: string;
  postType: string;
  creationDate: string;
  modifiedDate: string;
  tags: string[];
  attributes?: any;
  publication?: string;
  base?: string;
}

export interface S2SBodyPlain extends S2SBodyBase {
  encryption: false;
  content: string;
  title: string;
  slug: string;
  custom?: any;
}

export interface S2SBodyEncrypted extends S2SBodyBase {
  encryption: true;
}

export type S2SBody = S2SBodyPlain | S2SBodyEncrypted;
