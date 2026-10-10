import { describe, it, expect } from 'vitest';
import { keccak256, toBytes, encodePacked, getAddress, decodeFunctionData, type Hex } from 'viem';
import { ethers } from 'ethers'; // v5 — cross-check adminHash vs the reference SDK
import {
  ACCOUNT_CONFIG_DIAMOND,
  adminHash,
  actionHash,
  generateUsageKey,
  encodeAddGroup,
  encodeAddAction,
  encodeAddActionToGroup,
  encodeRemoveActionFromGroup,
  encodeRemoveAction,
  encodeAddPkpToGroup,
  encodeRegisterWalletDerivation,
  encodeSetUsageApiKey,
  buildReProvisionBatch,
  buildSwapActionBatch,
  buildAddActionBatch,
  buildRemoveActionBatch,
  decodeBatch,
  printBatch,
  WRITES_FACET_ABI,
  type ActionDef,
} from './chain-secured';

// The s2s Safe (= PROTOCOL_SAFE_ADDRESS) — on-chain admin of the new account.
const SAFE = '0x24936f87442673B7c057BF3f5dCCB726baF20c6B';

// The 5 actions currently in protocol/scripts/lit/config.json (committed on
// origin/main) — cid → hashedCid pairs computed by LitService.registerAction.
const CONFIG_ACTIONS: { name: string; cid: string; hashedCid: string }[] = [
  {
    name: 'encrypt',
    cid: 'QmQNnefQsHQoUGyLaGJHMNhTaRtEYGfccejPsQXhJn7Rsh',
    hashedCid: '0xf2925f24662e3bd9ab6c3087a0ab7f8384eb96bacd46729a8eaeaba828ce97e1',
  },
  {
    name: 'prep',
    cid: 'QmcnFkP6QTMGuvzpQhZbCKMnMCwTuVN2X4j18SLR1hrXTZ',
    hashedCid: '0xf80a407fe37dd9d6c45a9bd07bf8f47cf2f8dd9f45b5845d8ce3fe1781669478',
  },
  {
    name: 'render',
    cid: 'QmSrMsfkQHq4i2USano2bFA4aoSwtZsNhv5VS1SBof6RM9',
    hashedCid: '0x39ce94dfb5a0f5191e309bb528d132969618adcab68b1e887d3cb74e7e6fe51d',
  },
  {
    name: 'update',
    cid: 'QmfYRYQdna5K6GF3ybSMDWGpPMCX5g7zUdcYsxR14Jkk2q',
    hashedCid: '0x905daba952f9225e74a7cc992248bff4253b8eb0bb73c0058755ef72eee929a1',
  },
  {
    name: 'maintain-cache',
    cid: 'QmcvCDWQTtZYoPeR2zpRskZ5FxnjW7nhkddv26MsPHp6W2',
    hashedCid: '0x94b1b7db339884f99f4533bd648640dcc2396658607900144fed20df9f1c1e38',
  },
];

const actions: ActionDef[] = CONFIG_ACTIONS.map((a) => ({
  name: a.name,
  cid: a.cid,
  hashedCid: BigInt(a.hashedCid),
}));

// ============================================================================
// adminHash — uint256(keccak256(abi.encodePacked(safeAddress)))
// ============================================================================

describe('adminHash', () => {
  it('equals keccak256(abi.encodePacked(address)) for the Safe', () => {
    const expected = BigInt(keccak256(encodePacked(['address'], [getAddress(SAFE)])));
    expect(adminHash(SAFE)).toBe(expected);
  });

  it('cross-checks against ethers v5 solidityKeccak256 (reference SDK formula)', () => {
    const ethersHash = BigInt(ethers.utils.solidityKeccak256(['address'], [SAFE]));
    expect(adminHash(SAFE)).toBe(ethersHash);
  });

  it('matches keccak256 of the raw 20 address bytes (abi.encodePacked(address))', () => {
    expect(adminHash(SAFE)).toBe(BigInt(keccak256(toBytes(getAddress(SAFE)))));
  });

  it('is a stable constant (idempotent, case-insensitive address)', () => {
    const lower = SAFE.toLowerCase();
    expect(adminHash(SAFE)).toBe(adminHash(lower));
    expect(adminHash(SAFE).toString()).toBe(
      '7996165050625362176193714807214452940111927034977823694967163750139743868768',
    );
  });
});

// ============================================================================
// actionHash — uint256(keccak256(raw CID string bytes))
// ============================================================================

describe('actionHash', () => {
  it('equals keccak256(toBytes(cid)) for a known CID', () => {
    expect(actionHash(CONFIG_ACTIONS[0].cid)).toBe(
      BigInt(keccak256(toBytes(CONFIG_ACTIONS[0].cid))),
    );
  });

  it('reproduces every hashedCid currently committed in config.json', () => {
    for (const a of CONFIG_ACTIONS) {
      expect(actionHash(a.cid), `actionHash mismatch for ${a.name}`).toBe(BigInt(a.hashedCid));
    }
  });

  it('differs between distinct CIDs', () => {
    expect(actionHash(CONFIG_ACTIONS[0].cid)).not.toBe(actionHash(CONFIG_ACTIONS[1].cid));
  });
});

// ============================================================================
// generateUsageKey — lk_ + hex(32 random bytes); only hash goes on-chain
// ============================================================================

describe('generateUsageKey', () => {
  it('produces an lk_ key of exactly 67 chars (lk_ + 64 hex)', () => {
    const { key } = generateUsageKey();
    expect(key.startsWith('lk_')).toBe(true);
    expect(key.length).toBe(67);
    expect(key.slice(3)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('usageHash = uint256(keccak256(utf8(key)))', () => {
    const { key, usageHash } = generateUsageKey();
    expect(usageHash).toBe(BigInt(keccak256(toBytes(key))));
  });

  it('generates a fresh key every call (no reuse)', () => {
    const a = generateUsageKey();
    const b = generateUsageKey();
    expect(a.key).not.toBe(b.key);
    expect(a.usageHash).not.toBe(b.usageHash);
  });
});

// ============================================================================
// ABI encoders — viem encode → decode round-trips
// ============================================================================

describe('WritesFacet encoders (viem round-trip)', () => {
  const h = adminHash(SAFE);
  const cidHash = actionHash(CONFIG_ACTIONS[0].cid);
  const pkp = '0xddc48e51e9917f15528aabf44796bd3cdf69b414';

  it('addGroup round-trips and keeps the exact arg order', () => {
    const data = encodeAddGroup({
      accountApiKeyHash: h,
      name: 's2s',
      description: '',
      cidHashes: [cidHash],
      pkpIds: [pkp],
    });
    const { functionName, args } = decodeFunctionDataLike(data);
    expect(functionName).toBe('addGroup');
    expect(args[0]).toBe(h);
    expect(args[1]).toBe('s2s');
    expect(args[3]).toEqual([cidHash]);
    expect(args[4]).toEqual([getAddress(pkp)]);
  });

  it('addAction round-trips', () => {
    const { functionName, args } = decodeFunctionDataLike(
      encodeAddAction({
        accountApiKeyHash: h,
        name: 'encrypt',
        description: 'encrypt',
        actionHash: cidHash,
      }),
    );
    expect(functionName).toBe('addAction');
    expect(args).toEqual([h, 'encrypt', 'encrypt', cidHash]);
  });

  it('addActionToGroup round-trips', () => {
    const { functionName, args } = decodeFunctionDataLike(
      encodeAddActionToGroup({ accountApiKeyHash: h, groupId: 1n, action: cidHash }),
    );
    expect(functionName).toBe('addActionToGroup');
    expect(args).toEqual([h, 1n, cidHash]);
  });

  it('removeActionFromGroup round-trips', () => {
    const { functionName, args } = decodeFunctionDataLike(
      encodeRemoveActionFromGroup({ accountApiKeyHash: h, groupId: 1n, action: cidHash }),
    );
    expect(functionName).toBe('removeActionFromGroup');
    expect(args).toEqual([h, 1n, cidHash]);
  });

  it('removeAction round-trips', () => {
    const { functionName, args } = decodeFunctionDataLike(
      encodeRemoveAction({ accountApiKeyHash: h, actionHash: cidHash }),
    );
    expect(functionName).toBe('removeAction');
    expect(args).toEqual([h, cidHash]);
  });

  it('addPkpToGroup round-trips', () => {
    const { functionName, args } = decodeFunctionDataLike(
      encodeAddPkpToGroup({ accountApiKeyHash: h, groupId: 1n, pkpId: pkp }),
    );
    expect(functionName).toBe('addPkpToGroup');
    expect(args).toEqual([h, 1n, getAddress(pkp)]);
  });

  it('registerWalletDerivation round-trips (0x hex derivation path preserved)', () => {
    const derivationPathHex = '0xabc123' as Hex;
    const { functionName, args } = decodeFunctionDataLike(
      encodeRegisterWalletDerivation({
        accountApiKeyHash: h,
        pkpId: pkp,
        derivationPath: derivationPathHex,
        name: 's2s pkp',
        description: 's2s protocol pkp (chain-secured)',
      }),
    );
    expect(functionName).toBe('registerWalletDerivation');
    expect(args[0]).toBe(h);
    expect(args[1]).toBe(getAddress(pkp));
    expect(args[2]).toBe(BigInt(derivationPathHex)); // verbatim value preserved
    expect(args[3]).toBe('s2s pkp');
  });

  it('setUsageApiKey round-trips the full 13-arg encoding', () => {
    const usage = generateUsageKey();
    const groupId = 1n;
    const { functionName, args } = decodeFunctionDataLike(
      encodeSetUsageApiKey({
        accountApiKeyHash: h,
        usageApiKeyHash: usage.usageHash,
        expiration: 0n,
        balance: 0n,
        name: 's2s usage key',
        description: 's2s protocol usage key (chain-secured)',
        createGroups: false,
        deleteGroups: false,
        createPKPs: false,
        manageIPFSIdsInGroups: [groupId],
        addPkpToGroups: [],
        removePkpFromGroups: [],
        executeInGroups: [groupId],
      }),
    );
    expect(functionName).toBe('setUsageApiKey');
    expect(args[0]).toBe(h);
    expect(args[1]).toBe(usage.usageHash);
    expect(args[2]).toBe(0n);
    expect(args[3]).toBe(0n);
    expect(args[4]).toBe('s2s usage key');
    expect(args[6]).toBe(false); // createGroups
    expect(args[7]).toBe(false); // deleteGroups
    expect(args[8]).toBe(false); // createPKPs
    expect(args[9]).toEqual([groupId]); // manageIPFSIdsInGroups
    expect(args[10]).toEqual([]); // addPkpToGroups
    expect(args[11]).toEqual([]); // removePkpFromGroups
    expect(args[12]).toEqual([groupId]); // executeInGroups
  });
});

// ============================================================================
// Batch builders — re-provision + recurring swap/add/remove
// ============================================================================

describe('buildReProvisionBatch', () => {
  const h = adminHash(SAFE);
  const usage = generateUsageKey();
  const pkp = '0xddc48e51e9917f15528aabf44796bd3cdf69b414';

  it('emits addGroup → registerWalletDerivation → 5×addAction → 5×addActionToGroup → addPkpToGroup → setUsageApiKey', () => {
    const batch = buildReProvisionBatch({
      accountApiKeyHash: h,
      groupName: 's2s',
      groupDescription: '',
      actionDefs: actions,
      pkpAddress: pkp,
      derivationPath: '0x1234',
      usageKey: usage,
      groupId: 1n,
    });

    // 1 + 1 + 5 + 5 + 1 + 1 = 14 transactions
    expect(batch).toHaveLength(14);

    const decoded = decodeBatch(batch).map((d) => d.functionName);
    expect(decoded[0]).toBe('addGroup');
    expect(decoded[1]).toBe('registerWalletDerivation');
    expect(decoded.slice(2, 7)).toEqual(Array(5).fill('addAction'));
    expect(decoded.slice(7, 12)).toEqual(Array(5).fill('addActionToGroup'));
    expect(decoded[12]).toBe('addPkpToGroup');
    expect(decoded[13]).toBe('setUsageApiKey');

    // every tx targets the diamond with no value transfer
    for (const t of batch) {
      expect(t.to).toBe(ACCOUNT_CONFIG_DIAMOND);
      expect(t.value).toBe('0');
      expect(t.operation).toBe(0);
    }

    // addGroup cidHashes = the 5 hashed CIDs; pkpIds = [new pkp]
    const addGroup = decodeFunctionDataLike(batch[0].data);
    expect(addGroup.args[3]).toEqual(actions.map((a) => a.hashedCid));
    expect(addGroup.args[4]).toEqual([getAddress(pkp)]);

    // setUsageApiKey scoped to group 1
    const setKey = decodeFunctionDataLike(batch[13].data);
    expect(setKey.args[9]).toEqual([1n]);
    expect(setKey.args[12]).toEqual([1n]);
  });

  it('prints a well-formed human-readable batch without throwing', () => {
    const batch = buildReProvisionBatch({
      accountApiKeyHash: h,
      groupName: 's2s',
      groupDescription: '',
      actionDefs: actions,
      pkpAddress: pkp,
      derivationPath: '0x1234',
      usageKey: usage,
      groupId: 1n,
    });
    expect(() => {
      printBatch(batch);
    }).not.toThrow();
  });
});

describe('recurring batch builders', () => {
  const h = adminHash(SAFE);
  const newAction: ActionDef = {
    name: 'render',
    cid: 'QmNewRenderCid',
    hashedCid: actionHash('QmNewRenderCid'),
  };
  const renderAction = actions.find((a) => a.name === 'render');
  if (!renderAction) {
    throw new Error('test fixture missing render action');
  }
  const oldHashedCid = renderAction.hashedCid;

  it('buildSwapActionBatch = removeActionFromGroup + addAction + addActionToGroup', () => {
    const batch = buildSwapActionBatch({
      accountApiKeyHash: h,
      groupId: 14n,
      oldHashedCid,
      action: newAction,
    });
    const names = decodeBatch(batch).map((d) => d.functionName);
    expect(names).toEqual(['removeActionFromGroup', 'addAction', 'addActionToGroup']);
    // remove targets the OLD hash, add/addToGroup the NEW hash
    const decodedBatch = decodeBatch(batch);
    expect(decodedBatch[0].args[2] as bigint).toBe(oldHashedCid);
    expect(decodedBatch[1].args[3] as bigint).toBe(newAction.hashedCid);
    expect(decodedBatch[2].args[2] as bigint).toBe(newAction.hashedCid);
  });

  it('buildAddActionBatch = addAction + addActionToGroup', () => {
    const names = decodeBatch(
      buildAddActionBatch({ accountApiKeyHash: h, groupId: 14n, action: newAction }),
    ).map((d) => d.functionName);
    expect(names).toEqual(['addAction', 'addActionToGroup']);
  });

  it('buildRemoveActionBatch = removeActionFromGroup + removeAction', () => {
    const names = decodeBatch(
      buildRemoveActionBatch({ accountApiKeyHash: h, groupId: 14n, hashedCid: oldHashedCid }),
    ).map((d) => d.functionName);
    expect(names).toEqual(['removeActionFromGroup', 'removeAction']);
  });
});

// viem decodeFunctionData helper (kept local so the ABI constant stays private)
function decodeFunctionDataLike(data: Hex): { functionName: string; args: readonly unknown[] } {
  const decoded = decodeFunctionData({ abi: WRITES_FACET_ABI, data });
  return { functionName: decoded.functionName, args: decoded.args };
}
