import { encodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';

import { parseAbi, saltNonceFor } from '../src/adapters/tx-runner';

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

describe('parseAbi', () => {
  // The two shapes the seams carry, and the bug that finding them out cost:
  // `s2s author address` died on `Unexpected token 'u', "function th"…` because
  // the Safe reads hand a human-readable ABI to a helper that only did
  // JSON.parse.
  it('parses a human-readable ABI, one function per line', () => {
    const abi = parseAbi(['function threshold() view returns (uint256)', 'function getOwners() view returns (address[])'].join('\n'));
    expect(abi.map((entry) => ('name' in entry ? entry.name : undefined))).toEqual([
      'threshold',
      'getOwners',
    ]);
    // keccak('threshold()')[:4], so the human-readable line became a real
    // entry and not a JSON-shaped nothing.
    expect(encodeFunctionData({ abi, functionName: 'threshold', args: [] })).toBe('0x42cde4e8');
  });

  it('parses a compiled ABI as JSON, which is what the write path passes', () => {
    const abi = parseAbi(JSON.stringify([{ type: 'function', name: 'retract', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'uint256' }], outputs: [] }]));
    expect(abi.map((entry) => ('name' in entry ? entry.name : undefined))).toEqual(['retract']);
  });

  it('refuses a malformed ABI instead of re-parsing it as the other shape', () => {
    expect(() => parseAbi('function threshold(')).toThrow();
  });
});
