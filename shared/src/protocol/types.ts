// ============================================================================
// Protocol types — single source of truth for all shared types in s2s.
// Every other package imports these; no type is defined in more than one place.
// ============================================================================

// ============================================================================
// Protocol Info
// ============================================================================

export interface S2SProtocolInfo {
  gateway: string; // collapsed data+assets READ gateway
  ensRegistry: string; // kept — pub flow's registerSubdomain target
  ensRecords: string; // kept
  publicationFactory: string; // NEW (was neutralpress safe_publication_factory setting)
  recordsFactory: string; // NEW (was neutralpress safe_records_factory setting)
  pkp: string; // flattened to the eth address (was PKP {tokenId,publicKey,ethAddress})
  litActions: {
    prep: string; // was litActionPrep (unchanged)
    render: string; // was litActionSingle (RENAMED)
    update: string; // was litActionRootUpdate (RENAMED); cbor merged INTO this action
    // CID of the dedicated maintain-cache action. OPTIONAL: present only once
    // the action is built + pinned + its lit_action_maintainCache record is
    // written on-chain. The orchestrator fires the parallel cache-maintenance
    // action only when this is non-empty (graceful — the render inline
    // write-back remains the fallback until then).
    maintainCache?: string;
  };
}

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

// ============================================================================
// Helpers
// ============================================================================

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

// ============================================================================
// Template Data
// ============================================================================

export interface S2STemplateData {
  id: string;
  controller: string;
  tags: string[];
  parent: number;
  language: string;
  position: number;
  encrypted: string;
  postType: string;
  publications: string[];
  collections?: any;
  path: string;
  base?: string;
  custom: any;
  content: string;
  creationDate: string;
  modifiedDate: string;
}

// ============================================================================
// Collection, Ripple, Template Config, Mapping, Job
// ============================================================================

export type CollectionSortBy = 'position' | 'creationDate' | 'modifiedDate' | 'title';

export interface S2SCollection {
  filters?: any[];
  sortBy?: CollectionSortBy;
  slug: string;
}

export interface S2SRipple {
  origins: string[];
  destination: string;
  reference: string;
  query?: any;
  filters?: any[];
  trigger_filters?: Array<Record<string, string>>;
}

export interface S2STemplateConfig {
  reference: string;
  file: string | null;
  path: string | null;
  collections?: S2SCollection[];
  filters?: any[];
}

export interface IMapping {
  templateConfig: S2STemplateConfig[];
  ripples: S2SRipple[];
}

export interface S2SJob {
  id: string;
  templateConfig: S2STemplateConfig;
  path?: string;
  templateData?: S2STemplateData;
  html: string;
  revoked?: boolean;
}

// ============================================================================
// Part 2 — S2S Secrets split
// ============================================================================

/**
 * Acquisition primitive — PRESENT-INERT, FUTURE-ACTIVE.
 * Today everything is { source: "byok", value: T }. The "subscription" arm
 * is a marked seam, intentionally unspecified until the paid service exists.
 */
export type Metered<T> =
  | { source: 'byok'; value: T }
  | { source: 'subscription' /* TODO: fetch/refresh details when service exists */ };

/** Helper: extract value from a Metered; throws if source is subscription (not implemented yet). */
export const useMetered = <T>(m: Metered<T>): T => {
  if (m.source === 'byok') return m.value;
  throw new Error('subscription-sourced capabilities not implemented yet');
};

/**
 * Consumption interfaces — grouped by UTILITY, not by billing.
 */

/** Consumed by the signer / TxRunner / oxo-core account layer.
 *  NOTE: defined here but belongs in oxo-core; shared only imports its type. */
export interface S2SSignerSecrets {
  privateKey: string; // EOA key — also the filecoin-self payer
  rpc: string; // was rpc_key / VITE_DRPC_API_KEY
  pimlico: Metered<string>; // metered capability #1 (bundler/paymaster)
}

/** Consumed by the shared publication flow + Assets/Config builders. */
export interface S2SPublishSecrets {
  github: string; // user-owned PAT — durable, NOT metered
  storage: StorageCredential; // see below
  litUsage?: Metered<string>; // metered #3 — OPTIONAL; hardcoded const until gating lands
}

export type StorageCredential =
  | { kind: 'pinata'; jwt: string }
  | { kind: 'filecoin-self' } // reuses S2SSignerSecrets.privateKey; no secret of its own
  | { kind: 'filecoin-session'; session: Metered<FilecoinSessionKeyData>; rpcUrl: string }
  | { kind: 'kubo-only' };

export interface FilecoinSessionKeyData {
  privateKey: string;
  expiration: number; // unix seconds
  rootAddress: string; // funded account that delegated this session
}
