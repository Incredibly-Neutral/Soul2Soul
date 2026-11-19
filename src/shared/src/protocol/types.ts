// ============================================================================
// Manifest types — what an implementation publishes about itself, and the
// secrets consumed to talk to it.
//
// S2SManifest is the IMPLEMENTATION record: contract addresses, gateway,
// PKP, and the CIDs of the actions this deployment runs. It is read from the
// controller's on-chain records (see getManifest) — it is not part of the
// protocol text, and a different implementation may publish a different one.
//
// The name is deliberate. The protocol is Polyphony, the paper; this is one
// implementation's manifest: references to code, not the code. A manifest
// lists what a release ships — addresses and content addresses — and carries
// the version the sender published it as.
//
// The authored thing lives in ../manuscript. The publication's design
// (template config, collections, ripples) lives in ../publication. The
// renderer's job lives in ../rendering.
// ============================================================================

// ============================================================================
// Manifest
// ============================================================================

export interface S2SManifest {
  /**
   * The version of the manifest document, `x.y.z`, or `d.x.y` on the dev lane
   * (a build under test that is never the live document). Read from the on-chain
   * record, not from the controller: `VERSION()` reports the contract's own
   * version, the manifest's major.minor, and is compared on that prefix.
   */
  version: string;
  gateway: string; // collapsed data+assets READ gateway
  ensRegistry: string; // kept — pub flow's registerSubdomain target
  ensRecords: string; // kept
  publicationFactory: string; // NEW (was neutralpress safe_publication_factory setting)
  recordsFactory: string; // NEW (was neutralpress safe_records_factory setting)
  /**
   * The module factory: `publication_factory` in the protocol record. One
   * factory deploys every kind of module, keyed by (safe, kind), and answers
   * `moduleAddress(safe, kind)` for each of them. Empty string when the record
   * does not name one, which is a deployment no Safe app can create modules on.
   */
  moduleFactory: string;
  /**
   * The controller's own publication module, resolved from the module list and
   * the factory above: a CREATE2 factory's prediction first, the `NAME()` scan
   * when the factory cannot answer. Optional because a caller may have built
   * this record without resolving modules (`DEV`-injected fixtures, older
   * settings objects).
   */
  publicationModule?: string;
  pkp: string; // flattened to the eth address (was PKP {tokenId,publicKey,ethAddress})
  litActions: {
    prep: string; // was litActionPrep (unchanged)
    render: string; // was litActionSingle (RENAMED)
    update: string; // was litActionRootUpdate (RENAMED); cbor merged INTO this action
    // CID of the dedicated maintain-cache action. OPTIONAL: present only once
    // the action is built, pinned and written into this document's
    // `litActions.maintainCache`. The orchestrator fires the parallel
    // cache-maintenance action only when this is present (graceful — the render
    // inline write-back remains the fallback until then).
    maintainCache?: string;
    // CID of the one-shot repoint-archive action. OPTIONAL: present only once
    // the action is built, pinned and written into `litActions.repointArchive`.
    // Read by recovery tooling; the orchestrator does not fire it
    // automatically.
    repointArchive?: string;
    // CID of the encrypt action, which seals a body under the PKP. OPTIONAL:
    // present only once it is written into `litActions.encrypt`; a field that
    // was never written reads back as absent, not as "".
    encrypt?: string;
    // CID of the decrypt action, which opens an author's draft behind
    // GATES-1. OPTIONAL, same rule as `encrypt`.
    decrypt?: string;
  };
}

// ============================================================================
// Secrets
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
  | { kind: 'filebase'; token: string; bucket: string }
  | { kind: 'filecoin-self' } // reuses S2SSignerSecrets.privateKey; no secret of its own
  | { kind: 'filecoin-session'; session: Metered<FilecoinSessionKeyData>; rpcUrl: string }
  | { kind: 'kubo-only' };

export interface FilecoinSessionKeyData {
  privateKey: string;
  expiration: number; // unix seconds
  rootAddress: string; // funded account that delegated this session
}
