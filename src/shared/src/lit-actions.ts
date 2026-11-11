// TYPES
export type { S2SJob } from './rendering/types';
export type { S2STemplateConfig, S2SRipple } from './publication/types';
export type { S2SPublicationConfig } from './publication';
export type { S2SProtocolInfo } from './protocol';
export type { S2SContentInfo } from './metadata';
export type {
  S2SBody,
  S2SContentItem,
  S2SPublicContent,
  S2SProof,
  S2SContentBody,
} from './manuscript';
export type {
  ActionResult,
  DataAvailabilityEntry,
  DecryptData,
  DecryptParams,
  EvmUpdateData,
  EvmUpdateInput,
  MaintainCacheData,
  MaintainCacheInput,
  RepointArchiveData,
  RepointArchiveInput,
  PrepData,
  PrepInput,
  SingleData,
  SingleInput,
} from './lit';

// ABIS
export * from './contracts';
export { toBytes32Id } from './manuscript/identity/contract-id';

// PURE
// export { validateProtocol, validateConfig } from './publication';

// Metadata (JSON-LD provenance) — canonicalisation + content URL rules, shared
// by the renderer (sign) and the update gate (verify) so the signed bytes can
// never drift.
export {
  canonicalizeProofPayload,
  canonicalizeProofPayloadLegacy,
  canonicalizeLegacy,
  proofCanonicalizationOf,
  PROOF_CANONICALIZATION_JCS,
  type ProofCanonicalization,
  isIpfsCid,
  ipfsContentUrl,
  extractHashableHtml,
  hasHtmlBlock,
  insertJsonLdScript,
  stripUndefinedDeep,
  hasSpecV1Terms,
} from './metadata';

// Identity — JCS canonical JSON + body-hash verification. Hashing needs no
// chain library (keccak from @noble/hashes bundles); the EIP-712 signature half
// takes ethers from the runtime's `ethers` global rather than importing it —
// see manuscript/identity/ethers-ambient.ts and src/action-entries.test.ts.
// NOTHING reachable from this entry may import an action-build external
// (ethers, node builtins): it compiles to require() and the action dies at load.
export { jcs } from './manuscript/identity/jcs';
export { verifyBodyHash } from './manuscript/identity/verify-content';

// Contenthash helpers (zod-free, safe for Lit Actions — INV-7)
export {
  parseCID,
  decodeContenthashWrapped,
  encodeContenthashWrapped,
  toPreviewLabel,
} from './ipfs/contenthash';

// Module identity — one pure string test, no chain library, so the action-side
// module discovery answers the same question as the hosts'.
export { isPublicationModuleName } from './protocol/module-name';
