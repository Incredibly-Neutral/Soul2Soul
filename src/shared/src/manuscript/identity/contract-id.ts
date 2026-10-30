/**
 * Convert a string reference to a bytes32-compatible hex string.
 *
 * - If the input is already a 0x-prefixed 64-hex-char hash (32 bytes), pass it through unchanged.
 * - Otherwise, keccak256-hash the input and return the 0x-prefixed result.
 *
 * Used to normalise document identifiers (objectIds, raw CIDs) into the
 * bytes32 representation expected by S2SPublicationModuleV2.
 */
declare const ethers: any;

const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;

export function toBytes32Id(ref: string): string {
  const trimmed = ref.trim();
  if (HEX32_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(trimmed));
}
