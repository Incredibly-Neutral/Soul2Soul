// ============================================================================
// Protocol types — what an implementation publishes about itself, and the
// secrets consumed to talk to it.
//
// S2SProtocolInfo is the IMPLEMENTATION record: contract addresses, gateway,
// PKP, and the CIDs of the actions this deployment runs. It is read from the
// controller's on-chain records (see getProtocolInfo) — it is not part of the
// protocol text, and a different implementation may publish a different one.
//
// The authored thing lives in ../manuscript. The publication's design
// (template config, collections, ripples) lives in ../publication. The
// renderer's job lives in ../rendering.
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
    // CID of the one-shot repoint-archive action. OPTIONAL: present only once
    // the action is built + pinned + its lit_action_repointArchive record is
    // written on-chain. Read by recovery tooling; the orchestrator does not
    // fire it automatically.
    repointArchive?: string;
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
