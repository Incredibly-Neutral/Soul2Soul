import { keccak256, toBytes } from 'viem';
import { describe, expect, it } from 'vitest';

import { authorSafeSalt, AUTHOR_SAFE_SALT_PREFIX } from '../src/core/author-safe';
import { saltNonceFor } from '../src/adapters/tx-runner';

const EOA = '0x934E20411C9E8E92946BD8786D7c3E5bC4DB1387';

describe('author Safe identity', () => {
  it('salts with the plugin prefix and the EOA only (no chain)', () => {
    expect(AUTHOR_SAFE_SALT_PREFIX).toBe('s2s_');
    expect(authorSafeSalt(EOA)).toBe(`s2s_${EOA}`);
  });

  it('derives the salt-nonce exactly as 0xobsidian does (unmasked keccak)', () => {
    // 0xobsidian: saltNonce = BigInt(keccak256(toBytes(`s2s_${eoa}`)))
    // Any masking would change the CREATE2 input and thus the address.
    const salt = authorSafeSalt(EOA);
    expect(saltNonceFor(salt)).toBe(BigInt(keccak256(toBytes(salt))));
    expect(saltNonceFor(salt) < 2n ** 128n).toBe(false);
  });
});

describe('author Safe derivation is pinned to 0xobsidian', () => {
  it('pins the L2 singleton, factory, version and entry point', async () => {
    const m = await import('../src/core/author-safe');
    expect(m.SAFE_L2_SINGLETON).toBe('0x29fcB43b46531BcA003ddC8FCB67FFE91900C762');
    expect(m.SAFE_PROXY_FACTORY).toBe('0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67');
    expect(m.AUTHOR_SAFE_VERSION).toBe('1.4.1');
    // Pinned, not config-driven: the default `entryPoint` config value is 0.6,
    // but the 4337 module address is part of the Safe initializer.
    expect(m.AUTHOR_SAFE_ENTRY_POINT).toBe('0.7');
  });
});
