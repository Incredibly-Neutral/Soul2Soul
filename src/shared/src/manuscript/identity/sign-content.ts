// ============================================================================
// buildSignedContentItem — produce a signed S2SContentItem from raw inputs
// ============================================================================

import { ethersUtils } from './ethers-ambient';
import { jcs, keccakOfJson, keccakOfString } from './jcs';
import { signingEnvelope } from './signing-view';
import {
  type AnyS2SContentItem,
  type S2SContentItem,
  type S2SContentItemV2,
  type S2SPublicContent,
  type S2SPublicContentV2,
  type S2SProof,
  type S2SContentBody,
  type Address,
  S2S_DOMAIN,
} from '../types';

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
 * NOTE on EIP-712 shape: the struct commits tagsHash/attributesHash (bytes32)
 * rather than the raw arrays. This function computes those hashes from
 * the tags/attributes fields on the public metadata before signing.
 *
 * Two envelope versions: a `specVersion` of '2' takes creationDate + modifiedDate
 * and signs the S2SContentV2 struct; anything else takes createdAt and signs
 * S2SContent exactly as before. The input types pin the literal, so a v1
 * specVersion carrying the two dates does not compile.
 *
 * @param author - the author Safe's address. Used exactly as given when supplied:
 *                 the objectId is the digest of these bytes, so normalising one
 *                 here would change what the author signed. Omitted, it is
 *                 signer.getAddress(). The proof.signer always records the actual
 *                 signing key (EOA).
 */
export type PublicInputV1 = Omit<S2SPublicContent, 'author' | 'plaintextHash' | 'specVersion'> & {
  specVersion: '1';
};
export type PublicInputV2 = Omit<
  S2SPublicContentV2,
  'author' | 'plaintextHash' | 'specVersion'
> & { specVersion: '2' };

export async function buildSignedContentItem(
  pub: PublicInputV2,
  body: S2SContentBody,
  signer: TypedDataSigner,
  encryptFn: (plaintext: string) => Promise<string> | string,
  author?: string,
): Promise<S2SContentItemV2>;
export async function buildSignedContentItem(
  pub: PublicInputV1,
  body: S2SContentBody,
  signer: TypedDataSigner,
  encryptFn: (plaintext: string) => Promise<string> | string,
  author?: string,
): Promise<S2SContentItem>;
export async function buildSignedContentItem(
  pub: PublicInputV1 | PublicInputV2,
  body: S2SContentBody,
  signer: TypedDataSigner,
  encryptFn: (plaintext: string) => Promise<string> | string,
  author?: string,
): Promise<AnyS2SContentItem> {
  const utils = ethersUtils();
  // 1. Canonicalize the body and compute plaintextHash
  const bodyJson = jcs(body);
  const plaintextHash = keccakOfString(bodyJson);

  // 2. Assemble the public metadata for the envelope version in play.
  //    v1 keeps createdAt and the exact field set it always had.
  // The signed field is a bare address; a caller's string is taken as given.
  const authorAddr = (author ?? signer.getAddress()) as Address;
  const shared = {
    specVersion: pub.specVersion,
    author: authorAddr,
    postType: pub.postType,
    mediaType: pub.mediaType,
    parent: pub.parent,
    position: pub.position,
    publication: pub.publication,
    locale: pub.locale,
    base: pub.base,
    tags: pub.tags,
    attributes: pub.attributes,
    plaintextHash,
  };
  const publicPart: S2SPublicContent | S2SPublicContentV2 =
    pub.specVersion === '2'
      ? { ...shared, creationDate: pub.creationDate, modifiedDate: pub.modifiedDate }
      : { ...shared, createdAt: pub.createdAt };
  const { types, view: signingView } = signingEnvelope(publicPart);

  // 3. Compute objectId = EIP-712 digest of signingView
  const objectId = utils._TypedDataEncoder.hash(
    S2S_DOMAIN,
    types,
    signingView,
  );

  // 4. Sign the typed data
  const signature = await signer.signTypedData(
    S2S_DOMAIN as unknown as Record<string, unknown>,
    types,
    signingView,
  );

  const proof: S2SProof = {
    type: 'eip712',
    signer: `0x${signer.getAddress().replace('0x', '')}` as `0x${string}`,
    signature: signature as `0x${string}`,
  };

  // 5. Encrypt (or pass through) — result goes into .body
  const bodyContent = await encryptFn(bodyJson);

  // 6. Already built publicPart above with the original arrays (not hashes)
  //    The EIP-712 signature commits the hash values;
  //    a verifier re-computes them from the arrays and checks the signature.

  return { public: publicPart, objectId, proof, encryption: encryptFn !== noOpEncrypt, body: bodyContent } as AnyS2SContentItem;
}

/** Pass-through encrypt function — for non-encrypted content */
export function noOpEncrypt(plaintext: string): string {
  return plaintext;
}

// ============================================================================
// EIP-712 digest helper (deterministic, no signing)
// ============================================================================

export function computeObjectId(publicPart: S2SPublicContent | S2SPublicContentV2): string {
  const utils = ethersUtils();
  const { types, view } = signingEnvelope(publicPart);
  return utils._TypedDataEncoder.hash(
    S2S_DOMAIN,
    types,
    view,
  );
}

export { keccakOfJson } from './jcs';