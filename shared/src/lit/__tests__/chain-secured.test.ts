import { describe, it, expect } from 'vitest';
import { decodeFunctionData, keccak256, toBytes, toHex, getAddress } from 'viem';
import {
  ACCOUNT_CONFIG_ADDRESS,
  PROTOCOL_SAFE_ADDRESS,
  actionHash,
  adminHash,
  buildSafeBatch,
  encodeAddAction,
  encodeAddActionToGroup,
  encodeAddGroup,
  encodeAddPkpToGroup,
  encodeRegisterWalletDerivation,
  encodeRemoveAction,
  encodeRemoveActionFromGroup,
  encodeSetUsageApiKey,
  generateUsageKey,
  usageHash,
  writesFacetAbi,
} from '../chain-secured.js';

/**
 * Verified vectors (independent keccak256 check, 2026-10-05):
 *  - actionHash(cid) == keccak256(toBytes(cid)); the 5 pinned hashedCids below
 *    are the verified CIDs reused for the re-provision (matches the working-tree
 *    config.json / research table).
 *  - adminHash(PROTOCOL_SAFE_ADDRESS) == 0x11adab45e07d6dd847846fd13be95947bf24119ebfdae77f91d6598dbed69760.
 */
const PINNED_CIDS: Array<[string, string, string]> = [
  [
    'encrypt',
    'QmQNnefQsHQoUGyLaGJHMNhTaRtEYGfccejPsQXhJn7Rsh',
    '0xf2925f24662e3bd9ab6c3087a0ab7f8384eb96bacd46729a8eaeaba828ce97e1',
  ],
  [
    'prep',
    'QmNPXjE8X9fP1JeqMGNrhq6GDypghtdYBWJfXQdzd6sLQy',
    '0xff4c3b1127ba642fccef8f2f8921aa15120969b69b1ae7b5a8e7a6d4b75ea657',
  ],
  [
    'render',
    'QmPmZeTd7cYzkcadpYjYVJTgGDrz3dyFkKxPEAJYZajdsd',
    '0xac828e8cad1d224b209d7d2ea1380f0719e455f32d9cd76eba18b3163ef2e1f6',
  ],
  [
    'update',
    'QmR2jxUm2jKiiUegx1VwWbAeCXYPuTbtQWBBUetnzv1gBn',
    '0xc739a3937eddfedcb3b5a9fef918d6b52ac950374c53dc61f2be828aeb91bfa3',
  ],
  [
    'maintain-cache',
    'Qmf9emwnMV7KLZE8BjqjhFLKfkUWUPvH4Q8tD43FNcDmtF',
    '0x9d7bbe2a9f72e232e5cc97d811cd6d663b0d19e4375110552eba303c46f4e3f7',
  ],
] as const;

describe('actionHash', () => {
  it('equals keccak256 of the raw CID string bytes', () => {
    const cid = 'QmQNnefQsHQoUGyLaGJHMNhTaRtEYGfccejPsQXhJn7Rsh';
    expect(actionHash(cid)).toBe(keccak256(toBytes(cid)));
    expect(actionHash(cid)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('reproduces every pinned hashedCid in config.json', () => {
    for (const [, cid, expected] of PINNED_CIDS) {
      expect(actionHash(cid), `actionHash for ${cid}`).toBe(expected);
    }
  });
});

describe('adminHash', () => {
  it('equals keccak256 of the 20 raw address bytes', () => {
    expect(adminHash(PROTOCOL_SAFE_ADDRESS)).toBe(
      keccak256(toBytes(getAddress(PROTOCOL_SAFE_ADDRESS))),
    );
  });

  it('matches the verified vector for PROTOCOL_SAFE_ADDRESS', () => {
    expect(adminHash(PROTOCOL_SAFE_ADDRESS)).toBe(
      '0x11adab45e07d6dd847846fd13be95947bf24119ebfdae77f91d6598dbed69760',
    );
  });

  it('is a 32-byte uint256 hex', () => {
    expect(adminHash(PROTOCOL_SAFE_ADDRESS)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('generateUsageKey / usageHash', () => {
  it('produces the documented lk_ + 64-lowercase-hex format', () => {
    const { usageKey } = generateUsageKey();
    expect(usageKey.startsWith('lk_')).toBe(true);
    const hex = usageKey.slice(3);
    expect(hex).toHaveLength(64);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('usageHash equals keccak256 of the UTF-8 key bytes', () => {
    const { usageKey, usageHash: h } = generateUsageKey();
    expect(h).toBe(keccak256(toBytes(usageKey)));
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('mints distinct keys each call (32 CSPRNG bytes)', () => {
    const a = generateUsageKey().usageKey;
    const b = generateUsageKey().usageKey;
    expect(a).not.toBe(b);
  });

  it('round-trips usageHash(usageKey)', () => {
    const { usageKey, usageHash: h } = generateUsageKey();
    expect(usageHash(usageKey)).toBe(h);
  });
});

describe('setUsageApiKey encoding', () => {
  const adminHashVal = adminHash(PROTOCOL_SAFE_ADDRESS);
  const usageHashVal = usageHash('lk_abc');
  const groupId = 1n;

  it('encodes the exact WritesFacet arg order for a re-provision usage key', () => {
    const { data } = encodeSetUsageApiKey({
      apiKeyHash: adminHashVal,
      usageApiKeyHash: usageHashVal,
      expiration: 0,
      balance: 0,
      name: 's2s usage key',
      description: 's2s group execution key (chain-secured)',
      createGroups: false,
      deleteGroups: false,
      createPKPs: false,
      manageIPFSIdsInGroups: [toHex(groupId)],
      addPkpToGroups: [],
      removePkpFromGroups: [],
      executeInGroups: [toHex(groupId)],
    });
    expect(data.startsWith('0x')).toBe(true);

    const decoded = decodeFunctionData({ abi: writesFacetAbi, data });
    expect(decoded.functionName).toBe('setUsageApiKey');
    expect(decoded.args![0]).toBe(BigInt(adminHashVal));
    expect(decoded.args![1]).toBe(BigInt(usageHashVal));
    expect(decoded.args![2]).toBe(0n); // expiration
    expect(decoded.args![3]).toBe(0n); // balance
    expect(decoded.args![4]).toBe('s2s usage key');
    expect(decoded.args![5]).toBe('s2s group execution key (chain-secured)');
    expect(decoded.args![6]).toBe(false); // createGroups
    expect(decoded.args![7]).toBe(false); // deleteGroups
    expect(decoded.args![8]).toBe(false); // createPKPs
    expect(decoded.args![9]).toEqual([groupId]); // manageIPFSIdsInGroups
    expect(decoded.args![10]).toEqual([]); // addPkpToGroups
    expect(decoded.args![11]).toEqual([]); // removePkpFromGroups
    expect(decoded.args![12]).toEqual([groupId]); // executeInGroups
  });

  it('defaults the permission flags and arrays when omitted', () => {
    const { data } = encodeSetUsageApiKey({
      apiKeyHash: adminHashVal,
      usageApiKeyHash: usageHashVal,
      name: 'minimal',
      description: '',
    });
    const decoded = decodeFunctionData({ abi: writesFacetAbi, data });
    expect(decoded.functionName).toBe('setUsageApiKey');
    expect(decoded.args![6]).toBe(false);
    expect(decoded.args![7]).toBe(false);
    expect(decoded.args![8]).toBe(false);
    expect(decoded.args![9]).toEqual([]);
    expect(decoded.args![10]).toEqual([]);
    expect(decoded.args![11]).toEqual([]);
    expect(decoded.args![12]).toEqual([]);
  });
});

describe('buildSafeBatch', () => {
  const adminHashVal = adminHash(PROTOCOL_SAFE_ADDRESS);
  const cid = 'QmQNnefQsHQoUGyLaGJHMNhTaRtEYGfccejPsQXhJn7Rsh';
  const hashed = actionHash(cid);

  it('returns { to, value, data } entries targeting the AccountConfig diamond', () => {
    const writes = [
      encodeAddGroup({
        apiKeyHash: adminHashVal,
        name: 's2s',
        description: '',
        cidHashes: [hashed],
        pkpIds: [PROTOCOL_SAFE_ADDRESS],
      }),
      encodeAddAction({
        apiKeyHash: adminHashVal,
        name: 'prep',
        description: 'prep',
        actionHash: hashed,
      }),
      encodeAddActionToGroup({
        apiKeyHash: adminHashVal,
        groupId: 1,
        action: hashed,
      }),
      encodeAddPkpToGroup({
        apiKeyHash: adminHashVal,
        groupId: 1,
        pkpId: PROTOCOL_SAFE_ADDRESS,
      }),
      encodeRegisterWalletDerivation({
        apiKeyHash: adminHashVal,
        pkpId: PROTOCOL_SAFE_ADDRESS,
        derivationPath: '0x0000000000000000000000000000000000000000000000000000000000000001',
        name: 's2s pkp',
        description: '',
      }),
    ];

    const batch = buildSafeBatch(writes);
    expect(batch).toHaveLength(writes.length);

    for (let i = 0; i < batch.length; i++) {
      expect(batch[i]).toMatchObject({
        to: ACCOUNT_CONFIG_ADDRESS,
        value: '0',
        operation: 0, // OperationType.Call
      });
      expect(typeof batch[i].data).toBe('string');
      expect(batch[i].data).toMatch(/^0x/);
      expect(batch[i].data).toBe(writes[i].data);
    }
  });

  it('decodes each batch entry back to the originating function', () => {
    const writes = [
      encodeAddGroup({
        apiKeyHash: adminHashVal,
        name: 's2s',
        description: '',
        cidHashes: [hashed],
        pkpIds: [PROTOCOL_SAFE_ADDRESS],
      }),
      encodeAddActionToGroup({ apiKeyHash: adminHashVal, groupId: 1, action: hashed }),
      encodeRemoveActionFromGroup({
        apiKeyHash: adminHashVal,
        groupId: 1,
        action: hashed,
      }),
      encodeRemoveAction({ apiKeyHash: adminHashVal, actionHash: hashed }),
      encodeSetUsageApiKey({
        apiKeyHash: adminHashVal,
        usageApiKeyHash: usageHash('lk_abc'),
        name: 'key',
        description: '',
      }),
    ];
    const batch = buildSafeBatch(writes);
    for (let i = 0; i < batch.length; i++) {
      const decoded = decodeFunctionData({ abi: writesFacetAbi, data: batch[i].data });
      expect(decoded.functionName).toBe(writes[i].functionName);
    }
  });

  it('addGroup first arg is the admin hash and binds cidHashes + pkpIds', () => {
    const { data } = encodeAddGroup({
      apiKeyHash: adminHashVal,
      name: 's2s',
      description: '',
      cidHashes: [hashed],
      pkpIds: [PROTOCOL_SAFE_ADDRESS],
    });
    const decoded = decodeFunctionData({ abi: writesFacetAbi, data });
    expect(decoded.functionName).toBe('addGroup');
    expect(decoded.args![0]).toBe(BigInt(adminHashVal));
    expect(decoded.args![1]).toBe('s2s');
    expect(decoded.args![3]).toEqual([BigInt(hashed)]);
    expect(decoded.args![4]).toEqual([getAddress(PROTOCOL_SAFE_ADDRESS)]);
  });
});
