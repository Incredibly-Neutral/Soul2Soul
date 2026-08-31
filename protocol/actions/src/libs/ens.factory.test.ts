import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getProtocolControllerAndModules, getDomainOwnerAndModules } from './ens.factory';

// ============================================================================
// Known non-S2S module NAME() probe skip.
//
// Regression context (see brain/reviews/trace-rpc-0xa3f4df7e-2026-08-31.md for
// the read-only RPC trace): every protocol action issues NAME() eth_call probes
// (selector 0xa3f4df7e) against EVERY module returned by getModulesPaginated on
// the publication Safe, to discover which are the S2S Records / Publication
// modules. One enabled module is the canonical Safe 4337 Module at
// 0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226 (SAFE_4337_MODULE_ADDRESS, Safe
// 1.4.1 + EntryPoint 0.7 on Base 8453). It never implements NAME(), so every
// probe reverts and the evmRead failover logs it once per RPC URL (drpc +
// alchemy = 2 extra lines), burning 2 RPC requests against Lit's hard
// 50-requests-per-session cap. We KNOW this address can never be an S2S module,
// so we must never issue a NAME() evmRead for it — while still probing every
// other module exactly as before.
//
// We mock ./evm's evmRead and record every NAME()-targeted contract address so
// we can assert the 4337 module is never probed and every other module is.
// ============================================================================

// Canonical SAFE_4337_MODULE_ADDRESS (the constant under test).
const SAFE_4337 = '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226';
const SAFE_4337_LOWER = SAFE_4337.toLowerCase();

const RECORDS = '0x' + '11'.repeat(20);
const PUBLICATION = '0x' + '22'.repeat(20);
const NO_NAME = '0x' + '33'.repeat(20); // a genuine module lacking NAME() — must STILL be probed

// vi.hoisted so the mocked module factory and tests share the same mutable
// state (module list to return + NAME-probe target log).
const state = vi.hoisted(() => ({
  MODULES: [] as string[],
  nameProbes: [] as string[],
  recordsAddr: '0x' + '11'.repeat(20),
}));

vi.mock('./evm', () => ({
  evmRead: vi.fn(async (_chain: string, contractAddress: string, _abi: any, method: string) => {
    switch (method) {
      case 'nameWrapper':
        return '0x' + 'aa'.repeat(20);
      case 'ownerOf':
        return '0x' + 'bb'.repeat(20);
      case 'parentDomainController':
        return '0x' + 'cc'.repeat(20);
      case 'getModulesPaginated':
        return [state.MODULES, '0x' + '00'.repeat(20)];
      case 'NAME':
        // Record every module we issue a NAME() probe against (canonical lower).
        state.nameProbes.push(contractAddress.toLowerCase());
        if (contractAddress.toLowerCase() === state.recordsAddr) {
          return 'S2S Records Module';
        }
        if (contractAddress === PUBLICATION) {
          return 'S2S Publication Module V2';
        }
        throw new Error('no NAME function');
      default:
        throw new Error('unexpected method ' + method);
    }
  }),
}));

beforeEach(() => {
  // The bundle injects `ethers` at runtime; ens.factory needs utils.namehash.
  (globalThis as any).ethers = {
    utils: { namehash: () => '0x' + 'ab'.repeat(32) },
  };
  state.MODULES = [];
  state.nameProbes = [];
});

describe('getProtocolControllerAndModules — skips NAME() probe for the Safe 4337 module', () => {
  it('never probes the 4337 module while still probing other modules', async () => {
    state.MODULES = [SAFE_4337, RECORDS];

    const result = await getProtocolControllerAndModules();

    // It still finds the S2S Records module.
    expect(result.configModule).toBe(RECORDS);
    // Only RECORDS was NAME()-probed — the 4337 module was never probed.
    expect(state.nameProbes).toEqual([RECORDS.toLowerCase()]);
    expect(state.nameProbes).not.toContain(SAFE_4337_LOWER);
  });

  it('skips a lowercased 4337 address too (canonical comparison)', async () => {
    state.MODULES = [SAFE_4337_LOWER, RECORDS];

    const result = await getProtocolControllerAndModules();

    expect(result.configModule).toBe(RECORDS);
    expect(state.nameProbes).toEqual([RECORDS.toLowerCase()]);
    expect(state.nameProbes).not.toContain(SAFE_4337_LOWER);
  });
});

describe('getDomainOwnerAndModules — skips NAME() probe for the Safe 4337 module', () => {
  it('never probes the 4337 module while still probing records, publication and no-NAME modules', async () => {
    state.MODULES = [RECORDS, SAFE_4337, PUBLICATION, NO_NAME];

    const result = await getDomainOwnerAndModules('example.eth');

    // Still finds both S2S modules.
    expect(result.configModule).toBe(RECORDS);
    expect(result.publicationModule).toBe(PUBLICATION);
    // Exactly ONE NAME() probe per non-4337 module (records, publication,
    // no-NAME) — the 4337 module in the middle was never probed.
    expect(state.nameProbes).toEqual([RECORDS, PUBLICATION, NO_NAME].map((a) => a.toLowerCase()));
    expect(state.nameProbes).not.toContain(SAFE_4337_LOWER);
  });

  it('skips the 4337 module when it is the only module (empty name probe set)', async () => {
    // getModulesPaginated would never return a page containing ONLY the 4337
    // module alongside nothing relevant, but guard the degenerate case anyway:
    // the 4337 module must not be probed, and no records/publication is found.
    state.MODULES = [SAFE_4337];

    const result = await getDomainOwnerAndModules('example.eth');

    expect(result.configModule).toBeNull();
    expect(result.publicationModule).toBeNull();
    expect(state.nameProbes).toEqual([]);
  });
});
