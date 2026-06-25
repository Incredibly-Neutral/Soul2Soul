// ============================================================================
// buildSignedContentItem — produce a signed S2SContentItem from raw inputs
// ============================================================================

import { utils } from 'ethers';
import { jcs, keccakOfJson } from './jcs';
import { buildSigningView } from './signing-view';
import {
  type S2SContentItem,
  type S2SPublicContent,
  type S2SProof,
  type S2SContentBody,
  type DidEthr,
  S2S_DOMAIN,
  S2S_TYPES,
  toDidEthr,
} from '../protocol/types';

/**
 * Signer abstraction — any object that can produce an EIP-712 typed data signature.
 * Works with viem WalletClient, ethers Wallet, or a raw signing function.
 */
export interface TypedDataSigner {
  signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, { name: string; type: string }[]>,
    value: Record<string, unknown>,
  ): Promise<string>;
  getAddress(): string;
}

/**
 * Build a fully signed S2SContentItem.
 *
 * The order is load-bearing: hash → digest(=objectId) → sign → encrypt
 * The objectId exists at sign time; the CID does not.
 *
 * NOTE on EIP-712 shape: S2S_TYPES uses tagsHash/attributesHash (bytes32)
 * rather than the raw arrays. This function computes those hashes from
 * the tags/attributes fields on the public metadata before signing.
 */
export async function buildSignedContentItem(
  pub: Omit<S2SPublicContent, 'author' | 'plaintextHash'>,
  body: S2SContentBody,
  signer: TypedDataSigner,
  encryptFn: (plaintext: string) => Promise<string> | string,
): Promise<S2SContentItem> {
  // 1. Canonicalize the body and compute plaintextHash
  const bodyJson = jcs(body);
  const plaintextHash = utils.keccak256(utils.toUtf8Bytes(bodyJson));

  // 2. Compute tagsHash and attributesHash for EIP-712 (bytes32 fields)
  // 3. Build the signing view — matches S2S_TYPES exactly
  const author = toDidEthr(signer.getAddress());
  const publicPart: S2SPublicContent = {
    specVersion: pub.specVersion,
    author,
    postType: pub.postType,
    mediaType: pub.mediaType,
    parent: pub.parent,
    position: pub.position,
    publication: pub.publication,
    locale: pub.locale,
    createdAt: pub.createdAt,
    base: pub.base,
    tags: pub.tags,
    attributes: pub.attributes,
    plaintextHash,
  };
  const signingView = buildSigningView(publicPart);

  // 4. Compute objectId = EIP-712 digest of signingView
  const objectId = utils._TypedDataEncoder.hash(
    S2S_DOMAIN,
    S2S_TYPES,
    signingView,
  );

  // 5. Sign the typed data
  const signature = await signer.signTypedData(
    S2S_DOMAIN as unknown as Record<string, unknown>,
    S2S_TYPES,
    signingView,
  );

  const proof: S2SProof = {
    type: 'eip712',
    signer: `0x${signer.getAddress().replace('0x', '')}` as `0x${string}`,
    signature: signature as `0x${string}`,
  };

  // 6. Encrypt (or pass through) — result goes into .body
  const bodyContent = await encryptFn(bodyJson);

  // 7. Already built publicPart above with the original arrays (not hashes)
  //    The EIP-712 signature commits the hash values;
  //    a verifier re-computes them from the arrays and checks the signature.

  return { public: publicPart, objectId, proof, encryption: encryptFn !== noOpEncrypt, body: bodyContent };
}

/** Pass-through encrypt function — for non-encrypted content */
export function noOpEncrypt(plaintext: string): string {
  return plaintext;
}

// ============================================================================
// EIP-712 digest helper (deterministic, no signing)
// ============================================================================

export function computeObjectId(publicPart: S2SPublicContent): string {
  const signingView = buildSigningView(publicPart);
  return utils._TypedDataEncoder.hash(
    S2S_DOMAIN,
    S2S_TYPES,
    signingView,
  );
}

export { keccakOfJson } from './jcs';