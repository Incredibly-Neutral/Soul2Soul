// ============================================================================
// Manuscript types — the authored thing and its proof.
//
// A manuscript is what an author signs: the public metadata (S2SPublicContent),
// the body (S2SContentBody, possibly encrypted), the digest that names it
// (objectId), and the signature over it (S2SProof). The author is the author
// Safe's bare address; the signature is EIP-712 over the canonical form in
// ./identity.
//
// Everything here is dependency-free — no zod, no viem, no ethers import — so
// the types can travel into a Lit Action bundle (INV-7) and into a browser
// plugin without dragging a validator along.
// ============================================================================

// ============================================================================
// Content-Item types (canonical — identity/provenance)
// Replaces the old Lens-era S2SBody/S2SPublicContent/S2SContentItem.
// Author identity: the author Safe's bare address. Signed via EIP-712.
// ============================================================================

/** An author address: the Safe that signs, as a bare 0x address. */
export type Address = `0x${string}`;

/** The PUBLIC, queryable, SIGNED metadata. Every field here is signed via EIP-712. */
export interface S2SPublicContent {
  specVersion: string; // envelope/format version, e.g. "1" — pins canonicalization + algos
  author: Address; // the author Safe
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
  author: Address;
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

/** Either envelope version, discriminated at runtime by public.specVersion */
export type AnyS2SContentItem = S2SContentItem | S2SContentItemV2;

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
