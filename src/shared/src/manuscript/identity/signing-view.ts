// ============================================================================
// Signing view — builds the flat object that matches S2S_TYPES
// The S2SPublicContent interface stores tags/attributes as arrays for readability,
// but EIP-712 commits them as bytes32 hashes. This helper builds the struct
// that actually gets signed, so signer and verifier agree on the shape.
// ============================================================================

import { keccakOfJson } from './jcs';
import { S2S_TYPES, S2S_TYPES_V2 } from '../types';
import type { S2SPublicContent, S2SPublicContentV2 } from '../types';

export function buildSigningView(pub: S2SPublicContent): Record<string, unknown> {
  const tagsHash = keccakOfJson(pub.tags);
  const attributesHash = pub.attributes
    ? keccakOfJson(pub.attributes)
    : '0x0000000000000000000000000000000000000000000000000000000000000000';

  return {
    specVersion: pub.specVersion,
    author: pub.author,
    plaintextHash: pub.plaintextHash,
    postType: pub.postType,
    mediaType: pub.mediaType,
    parent: pub.parent,
    position: pub.position,
    publication: pub.publication,
    locale: pub.locale,
    createdAt: pub.createdAt,
    base: pub.base ?? '',
    tagsHash,
    attributesHash,
  };
}

/** Same shape as buildSigningView, with the two dates where createdAt sat. */
export function buildSigningViewV2(pub: S2SPublicContentV2): Record<string, unknown> {
  const tagsHash = keccakOfJson(pub.tags);
  const attributesHash = pub.attributes
    ? keccakOfJson(pub.attributes)
    : '0x0000000000000000000000000000000000000000000000000000000000000000';

  return {
    specVersion: pub.specVersion,
    author: pub.author,
    plaintextHash: pub.plaintextHash,
    postType: pub.postType,
    mediaType: pub.mediaType,
    parent: pub.parent,
    position: pub.position,
    publication: pub.publication,
    locale: pub.locale,
    creationDate: pub.creationDate,
    modifiedDate: pub.modifiedDate,
    base: pub.base ?? '',
    tagsHash,
    attributesHash,
  };
}

/**
 * Pick the EIP-712 struct and the signing view for an envelope.
 * `specVersion === '2'` selects the S2SContentV2 struct; anything else stays v1,
 * so items already signed under v1 keep their type hash and digest.
 */
export function signingEnvelope(
  pub: S2SPublicContent | S2SPublicContentV2,
): { types: Record<string, { name: string; type: string }[]>; view: Record<string, unknown> } {
  if (pub.specVersion === '2') {
    return { types: S2S_TYPES_V2, view: buildSigningViewV2(pub as S2SPublicContentV2) };
  }
  return { types: S2S_TYPES, view: buildSigningView(pub as S2SPublicContent) };
}
