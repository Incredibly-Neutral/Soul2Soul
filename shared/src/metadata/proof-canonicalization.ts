// ============================================================================
// Proof canonicalisation — single source of truth for the bytes that get
// signed by the renderer (render/metadata.ts) and re-derived by the update
// gate (update/verify.ts). Keeping both on this helper is what stops the two
// from drifting: a mismatch here silently invalidates every published page.
//
// Legacy (pre specVersion "1") canonicalisation was:
//
//   JSON.stringify(obj, Object.keys(obj).sort())
//
// In JS the replacer-array form of JSON.stringify is a *recursive key
// whitelist*, applied at every nesting level. So every nested key whose name
// does not also appear at the top level — sha256, contentUrl, did values,
// dates, did:pkh values … — was silently dropped from the signed bytes. The
// signature therefore covered the shape of the document, not its content.
// `canonicalizeProofPayloadLegacy` reproduces those exact bytes so pages
// published under the old scheme still verify.
// ============================================================================

import { jcs } from '../identity/jcs';

/** Marker stored on the proof so verifiers know which canonicalisation was used. */
export const PROOF_CANONICALIZATION_JCS = 'JCS-RFC8785';

export type ProofCanonicalization = typeof PROOF_CANONICALIZATION_JCS | 'LEGACY';

/**
 * The pre-JCS canonicaliser, kept byte-identical to the code that shipped it.
 *
 * NOTE: called with `any` deliberately — the legacy code passed untyped schema
 * objects through JSON.stringify, and the replacer-array form must not be
 * "fixed" here. This function is frozen history; do not optimise it.
 */
export function canonicalizeLegacy(value: object): string {
  return JSON.stringify(value, Object.keys(value).sort());
}

/**
 * Canonical signing payload: RFC 8785 (JCS) of the schema-without-proof,
 * concatenated with JCS of the proof options (everything except proofValue).
 *
 * Concatenation (rather than a single object) mirrors the original W3C Data
 * Integrity implementation and keeps the payload length unambiguous: JCS
 * output is always a single JSON value, so the boundary is well defined.
 */
export function canonicalizeProofPayload(
  schemaWithoutProof: object,
  proofOptions: object,
): string {
  return jcs(schemaWithoutProof) + jcs(proofOptions);
}

/** The legacy (recursive-key-whitelist) signing payload. Frozen — see above. */
export function canonicalizeProofPayloadLegacy(
  schemaWithoutProof: object,
  proofOptions: object,
): string {
  return canonicalizeLegacy(schemaWithoutProof) + canonicalizeLegacy(proofOptions);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * Which canonicalisation a page was signed with.
 *
 * The marker lives in exactly one place: the proof options object
 * (`proof.canonicalization`, with `proofValue` removed). Read from the proof
 * options only — a second lookup path (e.g. accepting a whole schema) just
 * invites the signer and the verifier to disagree about where the marker is.
 * Anything without the exact marker is LEGACY: old pages must never be read as
 * JCS.
 */
export function proofCanonicalizationOf(proofOptions: object): ProofCanonicalization {
  const record = asRecord(proofOptions);
  return record?.canonicalization === PROOF_CANONICALIZATION_JCS
    ? PROOF_CANONICALIZATION_JCS
    : 'LEGACY';
}
