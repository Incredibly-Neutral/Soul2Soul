// ============================================================================
// Signing view — builds the flat object that matches S2S_TYPES
// The S2SPublicContent interface stores tags/attributes as arrays for readability,
// but EIP-712 commits them as bytes32 hashes. This helper builds the struct
// that actually gets signed, so signer and verifier agree on the shape.
// ============================================================================

import { keccakOfJson } from './jcs';
import type { S2SPublicContent } from '../types';

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