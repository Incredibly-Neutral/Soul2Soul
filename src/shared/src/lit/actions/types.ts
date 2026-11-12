import { S2SJob } from '../../rendering/types';

export type ActionResult<T> =
  | { ok: true; action: string; data: T; trace: any[] }
  | { ok: false; action: string; error: string; trace: any[] };

/**
 * Structured data-availability entry produced by the render action.
 * Every data-fetch failure is classified as exactly one kind:
 *   - "config"   — publication config fetch/parse failure (FATAL)
 *   - "template" — render template fetch/parse failure (FATAL)
 *   - "data"     — content/data-source fetch failure, e.g. IPFS cat of a
 *                  content CID or a decrypt failure (NON-FATAL, skip-and-continue)
 */
export interface DataAvailabilityEntry {
  kind: 'config' | 'template' | 'data';
  /** bytes32 genesis id (present for "data" entries) */
  genesis?: string;
  /** IPFS CID of the unavailable resource (present when known) */
  cid?: string;
  /** Human-readable failure reason */
  reason: string;
  /** Whether this failure prevents the render from completing */
  fatal: boolean;
}

export interface PrepInput {
  publication: string;
  contentIds: string[];
  configCid?: string;
  prevRootCid?: string;
  endpoints: {
    ipfsGateway?: string;
    ipfsGatewayAuth?: string;
    rpcs: { L1: string[]; L2: string[] };
  };
}
export interface PrepData {
  jobs: S2SJob[];
  remove?: { path: string; replacedBy?: string }[];
}

export interface SingleInput {
  job: S2SJob;
  signature: string;
  authorSafeAddress: string;
  publication: string;
  configCid?: string;
  preview?: boolean;
  maintainCache?: boolean;
  // The id(s) the caller rendered (the orchestrator's contentIds). The render
  // action scopes its on-chain hasDeal revoke check to these ids ONLY — a
  // cascade/ripple destination (e.g. home) is never hasDeal-checked, because
  // a destination pinned via query.genesis may never have been a deal.
  triggeredContentIds?: string[];
  endpoints: {
    ipfsGateway?: string;
    ipfsGatewayAuth?: string;
    rpcs: { L1: string[]; L2: string[] };
  };
}
export interface SingleData {
  job: S2SJob;
  html?: string;
  timestamp: string;
  // True on a successful render that observed archive drift (cache write-back
  // would fire / did fire). The orchestrator uses this as the signal to fire
  // the dedicated maintain-cache action in its own fresh session. Optional for
  // backward compatibility with existing render callers/envelopes.
  maintainCache?: boolean;
  /** Structured availability report: every data-fetch failure classified by kind. */
  availability?: DataAvailabilityEntry[];
}

// ============================================================================
// EVM Update (merged/evm) — updates IPFS root CID on-chain
// ============================================================================
export interface EvmUpdateInput {
  publication: string;
  jobs: S2SJob[];
  signature: string;
  authorSafeAddress: string;
  preview?: boolean;
  // Reset drops the existing MFS tree (incl. home index.html), keeps assets,
  // and rewrites contenthash_wrapped. Publication-owner gated (canReset).
  reset?: boolean;
  remove?: { path: string; replacedBy?: string }[];
  endpoints: {
    ipfsGateway?: string;
    ipfsGatewayAuth?: string;
    rpcs: { L1: string[]; L2: string[] };
  };
}

export interface EvmUpdateData {
  cid: string;
  trace?: any[];
}

// ============================================================================
// Maintain-Cache (parallel per-publication archive pointer write)
// ============================================================================
// Fired by the orchestrator after a successful render whose envelope flagged
// pending cache drift. Runs in its OWN fresh Lit session (own 50-request budget,
// young provider) mirroring the conditions under which the update action's
// setText is provably reliable — versus the render inline write-back firing at
// the tail of a heavy session. See press/actions/src/maintain-cache/main.ts.
export interface MaintainCacheInput {
  publication: string;
  signature: string;
  authorSafeAddress: string;
  preview?: boolean;
  endpoints: {
    ipfsGateway?: string;
    ipfsGatewayAuth?: string;
    rpcs: { L1: string[]; L2: string[] };
  };
}

export interface MaintainCacheData {
  cid: string;
  wrote: boolean;
}

// One-shot cache-pointer repoint for a publication (recovery action). Given a
// caller-provided prebuilt archive CID it validates the archive (cat + parse +
// reconcile must cover every on-chain deal) then writes
// `content_cache_<publication>` via the PKP. Gated by canReset (publication
// Safe owner — stricter than canPublish). See
// press/actions/src/repoint-archive/main.ts.
export interface RepointArchiveInput {
  publication: string;
  signature: string;
  authorSafeAddress: string;
  // Prebuilt archive CID to point the cache at (e.g. from the off-chain
  // rebuild — press/scripts/lit/rebuild-archive.ts).
  archiveCid: string;
  preview?: boolean;
  endpoints: {
    ipfsGateway?: string;
    ipfsGatewayAuth?: string;
    rpcs: { L1: string[]; L2: string[] };
  };
}

export interface RepointArchiveData {
  cid: string;
  wrote: boolean;
}

// Decrypt (author draft) — opens a draft the author Safe keeps, and refuses
// unless the signer was an owner of that Safe when the version was appended. The
// caller names the Safe, never a module: the action resolves the Safe's drafts
// log and owner-history module from the Safe's own enabled-module list, requires
// the drafts log to name that Safe for the genesis, and reads `isOwnerAt` at the
// genesis's append block (live `isOwner` when a pre-upgrade version records block
// 0). Only then is the blob cat'd, and the plaintext is released only if it
// hashes to the signed `public.plaintextHash`. See lit/actions/decrypt.ts.
export interface DecryptParams {
  /** Lit PKP id that holds the decryption key. */
  pkpId: string;
  /** The draft: a raw CID/objectId (keccak256-normalised) or a bytes32 0x+64hex id. */
  genesis: string;
  /** The author Safe whose drafts log holds the genesis, and whose ownership is tested. */
  authorSafe: string;
  /** Signature over `hashMessage('lit actions auth')` from the caller's wallet. */
  signature: string;
  rpcs: { L2: string[] };
  /** IPFS gateway base URL, e.g. `https://ipfs.io`. */
  gateway: string;
}

export interface DecryptData {
  /** The string the author signed, exactly as decrypted — the hash input. */
  plaintext: string;
  /** The Safe the drafts log names as this genesis's author (the Safe the caller passed). */
  author: string;
  /** CID of the version `fetch` returned (the latest append). */
  cid: string;
}
