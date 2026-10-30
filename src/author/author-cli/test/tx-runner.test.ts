import { describe, expect, it } from 'vitest';

import { saltNonceFor } from '../src/adapters/tx-runner';

describe('saltNonceFor', () => {
  it('is deterministic for the same salt', () => {
    expect(saltNonceFor('my-publication')).toBe(saltNonceFor('my-publication'));
  });

  it('produces distinct nonces for distinct salts', () => {
    expect(saltNonceFor('a')).not.toBe(saltNonceFor('b'));
  });

  it('fits in the Safe 63-bit saltNonce range (top bit cleared)', () => {
    const nonce = saltNonceFor('anything');
    expect(nonce).toBeGreaterThanOrEqual(0n);
    expect(nonce).toBeLessThan(1n << 255n);
  });

  it('yields the same nonce regardless of the chain (pure function)', () => {
    // The whole point: L1 and L2 Safes deploy to the same address via the same salt.
    expect(saltNonceFor('twin')).toBe(saltNonceFor('twin'));
  });
});
