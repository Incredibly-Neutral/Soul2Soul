declare module '@ensdomains/eth-ens-namehash' {
  /**
   * Compute the namehash of the given ENS name.
   * The namehash algorithm is specified in EIP-137.
   * @param name - The ENS name to hash
   * @returns The namehash as a hex string (with 0x prefix)
   */
  export function namehash(name: string): string;

  /**
   * Compute the label hash for a single component of an ENS name.
   * @param label - The ENS label to hash
   * @returns The label hash as a hex string (with 0x prefix)
   */
  export function labelhash(label: string): string;

  /**
   * Normalize an ENS name according to the ENS specification.
   * @param name - The ENS name to normalize
   * @returns The normalized name
   */
  export function normalize(name: string): string;
}