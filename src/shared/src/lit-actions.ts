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
  DidEthr,
  S2SContentBody,
} from './manuscript';
export type {
  ActionResult,
  DataAvailabilityEntry,
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

// Identity — JCS canonical JSON + body-hash verification. Both are dependency
// free enough for the Lit Action bundle (they only use ethers v5 utils).
export { jcs } from './manuscript/identity/jcs';
export { verifyBodyHash } from './manuscript/identity/verify-content';

// Contenthash helpers (zod-free, safe for Lit Actions — INV-7)
export {
  parseCID,
  decodeContenthashWrapped,
  encodeContenthashWrapped,
  toPreviewLabel,
} from './ipfs/contenthash';
