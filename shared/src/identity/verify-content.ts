// ============================================================================
// Verify — authorship verification + public log resolution
// ============================================================================

import { utils } from 'ethers';
import { jcs } from './jcs';
import { buildSigningView } from './signing-view';
import { type S2SContentItem, S2S_DOMAIN, S2S_TYPES, eoaOf } from '../protocol/types';

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
 * Returns true if all checks pass, false otherwise.
 */
export async function verifyAuthorship(
  item: S2SContentItem,
  decryptFn: (ciphertext: string) => Promise<string>,
): Promise<boolean> {
  try {
    // 1. Obtain the canonical body JSON
    const bodyJson = item.encryption
      ? await decryptFn(item.body)
      : item.body;

    // 2. Verify plaintextHash
    const computedHash = utils.keccak256(utils.toUtf8Bytes(bodyJson));
    if (computedHash !== item.public.plaintextHash) {
      return false;
    }

    // 3. Verify the same canonicalization was used
    const reCanonical = jcs(JSON.parse(bodyJson));
    const reHash = utils.keccak256(utils.toUtf8Bytes(reCanonical));
    if (reHash !== computedHash) {
      console.warn('verifyAuthorship: body JSON was not in canonical form (JCS)');
    }

    // 4. Recover the signer from the EIP-712 signature
    const digest = utils._TypedDataEncoder.hash(
      S2S_DOMAIN,
      S2S_TYPES,
      buildSigningView(item.public),
    );
    const recovered = utils.recoverAddress(digest, item.proof.signature);

    // 5. Check recovered address matches the author's EOA
    const expectedEoa = eoaOf(item.public.author);
    const recoveredAddress = recovered.toLowerCase();
    const expectedAddress = expectedEoa.toLowerCase();

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
// verifyPlaintextHash — fast check, no signature recovery
// ============================================================================

/**
 * Verify just the plaintext hash — no signature check.
 * Useful when you already trust the source and just want integrity.
 */
export function verifyPlaintextHash(
  item: S2SContentItem,
  plaintextJson: string,
): boolean {
  const computedHash = utils.keccak256(utils.toUtf8Bytes(plaintextJson));
  return computedHash === item.public.plaintextHash;
}

// ============================================================================
// verifyBodyHash — keccak256 of a plaintext body vs an expected hex digest
// ============================================================================

/**
 * True when keccak256(utf8(bodyJson)) equals `expectedHex` (case-insensitive).
 *
 * Used to check a page's `plaintextHash` against the body it claims to
 * describe. Never throws: malformed hex, non-body input or any internal error
 * yields false, because a caller cannot distinguish "unparseable" from
 * "not the same bytes" in any useful way.
 */
export function verifyBodyHash(bodyJson: string, expectedHex: string): boolean {
  try {
    if (typeof bodyJson !== 'string' || typeof expectedHex !== 'string') return false;
    const computed = utils.keccak256(utils.toUtf8Bytes(bodyJson));
    return computed.toLowerCase() === expectedHex.toLowerCase();
  } catch {
    return false;
  }
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
  author: string;      // did:ethr author
  timestamp: number;   // when this version was appended
  tombstone: boolean;  // true if this is a retraction
}

/**
 * Resolve the latest (non-tombstone) version of a document.
 *
 * @param _genesis - the document's persistent identity (its first objectId)
 * @returns the latest version record, or null if the document doesn't exist or is tombstoned
 *
 * NOTE: This is a type stub. The real implementation queries the append-log contract
 * (see §4 of the handoff). The contract provides ordered, gated appends and public reads.
 */
export function resolveLatest(
  _genesis: string,
  /* contract reader dependency would go here */
): Promise<VersionRecord | null> {
  // TODO: Implement when the append-log contract is deployed.
  // For now this is a placeholder that always returns null,
  // signalling "not yet implemented" rather than "not found."
  console.warn('resolveLatest: not yet implemented (append-log contract pending)');
  return Promise.resolve(null);
}

/**
 * Get the full version history for a document.
 */
export function getHistory(_genesis: string): Promise<VersionRecord[]> {
  console.warn('getHistory: not yet implemented (append-log contract pending)');
  return Promise.resolve([]);
}