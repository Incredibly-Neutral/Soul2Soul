// ============================================================================
// Verify — authorship verification + public log resolution
// ============================================================================

import { ethersUtils } from './ethers-ambient';
import { authorAddress } from './author-address';
import { jcs, keccakOfJson, keccakOfString } from './jcs';
import { signingEnvelope } from './signing-view';
import { type AnyS2SContentItem, S2S_DOMAIN, bodyForKey } from '../types';

// ============================================================================
// verifyAuthorship — called by decryptors before rendering
// Verifies: plaintext hash matches body content, and signature recovers to the author
// ============================================================================

/**
 * Verify that an S2SContentItem's author signature is valid.
 *
 * Requires decryption access (the renderer / author / publication owners).
 * Steps:
 *   1. Decrypt (or read plaintext) the body
 *   2. Check plaintextHash matches the decrypted content
 *   3. Recover the signer from the EIP-712 signature
 *   4. Check the recovered address matches the author's EOA
 *
 * Reads the protocol's body (`bodyForKey` default). An item that has no body
 * under the protocol key cannot be checked and verifies false.
 *
 * Returns true if all checks pass, false otherwise.
 */
export async function verifyAuthorship(
  item: AnyS2SContentItem,
  decryptFn: (ciphertext: string) => Promise<string>,
): Promise<boolean> {
  try {
    // ethers v5 from the ambient global — see ethers-ambient.ts (a static
    // import compiles to __require('ethers') and kills every action bundle).
    // Only the signature half needs ethers; the hashes below are viem.
    const utils = ethersUtils();

    // 1. Obtain the canonical body JSON. The plaintextHash commits the
    //    protocol's body, so that is the one verified here.
    const stored = bodyForKey(item);
    if (stored === undefined) {
      return false;
    }
    const bodyJson = item.encryption ? await decryptFn(stored) : stored;

    // 2. Verify plaintextHash
    const computedHash = keccakOfString(bodyJson);
    if (computedHash !== item.public.plaintextHash) {
      return false;
    }

    // 3. Verify the same canonicalization was used
    const reCanonical = jcs(JSON.parse(bodyJson));
    const reHash = keccakOfString(reCanonical);
    if (reHash !== computedHash) {
      console.warn('verifyAuthorship: body JSON was not in canonical form (JCS)');
    }

    // 4. Recover the signer from the EIP-712 signature. The struct and view are
    //    chosen by specVersion: v1 items keep the S2SContent type hash.
    const { types, view } = signingEnvelope(item.public);
    const digest = utils._TypedDataEncoder.hash(
      S2S_DOMAIN,
      types,
      view,
    );
    const recovered = utils.recoverAddress(digest, item.proof.signature);

    // 5. Check recovered address matches the author Safe (or the pre-change form
    //    an older item was pinned with)
    const expectedAddress = authorAddress(item.public.author);
    const recoveredAddress = recovered.toLowerCase();

    if (recoveredAddress !== expectedAddress) {
      return false;
    }

    // 6. Check proof.signer matches too (belt-and-suspenders)
    if (recoveredAddress !== item.proof.signer.toLowerCase()) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// verifyBodyHash — keccak256 of a plaintext body vs an expected hex digest
// ============================================================================

/**
 * True when keccak256(utf8(bodyJson)) equals `expectedHex` (case-insensitive).
 *
 * `bodyJson` MUST be the exact body string that was stored and hashed — the
 * `jcs(body)` output an item was built from: sign-content.ts sets
 * `bodyContent = jcs(body)` and then keccak256s precisely those bytes. Do not
 * re-serialise a parsed object into this function; `JSON.stringify` of a parsed
 * object is not canonical and will not reproduce the digest.
 *
 * This deliberately does NOT canonicalise its input: the contract is "hash
 * these bytes", and a caller that has the stored string must be able to check
 * it without guessing which canonical form the writer used.
 *
 * Never throws: malformed hex, non-body input or any internal error yields
 * false, because a caller cannot distinguish "unparseable" from "not the same
 * bytes" in any useful way.
 */
export function verifyBodyHash(bodyJson: string, expectedHex: string): boolean {
  try {
    const computed = keccakOfString(bodyJson);
    return computed.toLowerCase() === expectedHex.toLowerCase();
  } catch {
    return false;
  }
}

// ============================================================================
// verifyPlaintextHash — fast check, no signature recovery
// ============================================================================

/**
 * Verify just the plaintext hash — no signature check.
 * Useful when you already trust the source and just want integrity.
 */
export function verifyPlaintextHash(
  item: AnyS2SContentItem,
  plaintextJson: string,
): boolean {
  const computedHash = keccakOfString(plaintextJson);
  return computedHash === item.public.plaintextHash;
}
// ============================================================================

/**
 * Result of resolving the latest version of a document from the append log.
 * This is a type definition — the actual implementation depends on the
 * contract ABI. This function signature is the interface contract.
 */
export interface VersionRecord {
  genesis: string;     // the document's persistent identity (first objectId)
  objectId: string;    // this version's objectId (= EIP-712 digest)
  cid: string;         // the IPFS CID of this version's content
  author: string;      // the author Safe's address
  timestamp: number;   // when this version was appended
  tombstone: boolean;  // true if this is a retraction
}

/**
 * Resolve the latest (non-tombstone) version of a document.
 *
 * @param genesis - the document's persistent identity (its first objectId)
 * @returns the latest version record, or null if the document doesn't exist or is tombstoned
 *
 * NOTE: This is a type stub. The real implementation queries the append-log contract
 * (see §4 of the handoff). The contract provides ordered, gated appends and public reads.
 */
export async function resolveLatest(
  genesis: string,
  /* contract reader dependency would go here */
): Promise<VersionRecord | null> {
  // TODO: Implement when the append-log contract is deployed.
  // For now this is a placeholder that always returns null,
  // signalling "not yet implemented" rather than "not found."
  console.warn('resolveLatest: not yet implemented (append-log contract pending)');
  return null;
}

/**
 * Get the full version history for a document.
 */
export async function getHistory(
  genesis: string,
): Promise<VersionRecord[]> {
  console.warn('getHistory: not yet implemented (append-log contract pending)');
  return [];
}