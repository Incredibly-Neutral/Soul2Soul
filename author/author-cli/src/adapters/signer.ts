// ============================================================================
// Signer adapter — wraps a viem PrivateKeyAccount as shared's TypedDataSigner.
//
// `buildSignedContentItem` (shared) calls `signTypedData(domain, types, value)`
// where `types` is S2S_TYPES (root type `S2SContent`). viem needs an explicit
// `primaryType`, which we derive dynamically as the type key no other type
// references.
// ============================================================================

import type { PrivateKeyAccount } from 'viem/accounts';

import type { TypedDataSigner } from '@s2s/soul2soul-shared';

export class ViemTypedDataSigner implements TypedDataSigner {
  private readonly account: PrivateKeyAccount;

  constructor(account: PrivateKeyAccount) {
    this.account = account;
  }

  getAddress(): string {
    return this.account.address;
  }

  /** Personal-message signature used by the render pipeline ('lit actions auth', INV-1). */
  async signMessage(message: string): Promise<string> {
    return this.account.signMessage({ message });
  }

  async signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, { name: string; type: string }[]>,
    value: Record<string, unknown>,
  ): Promise<string> {
    const primaryType = findPrimaryType(types);
    return this.account.signTypedData({
      domain,
      types,
      primaryType,
      message: value,
    });
  }
}

/** Derive the EIP-712 primary type: the type key not referenced by any other. */
function findPrimaryType(types: Record<string, { name: string; type: string }[]>): string {
  const referenced = new Set<string>();
  for (const fields of Object.values(types)) {
    for (const field of fields) {
      referenced.add(field.type);
    }
  }
  for (const key of Object.keys(types)) {
    if (!referenced.has(key)) return key;
  }
  throw new Error('could not determine the primary EIP-712 type from the provided types');
}
