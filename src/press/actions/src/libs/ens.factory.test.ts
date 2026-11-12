import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getProtocolControllerAndModules,
  getDomainOwnerAndModules,
  findModuleWithRole,
  RECORDS_ROLE_ID,
  PUBLICATION_ROLE_ID,
} from './ens.factory';

// ============================================================================
// Role discovery is ERC-165: every S2S module answers
// `supportsInterface(roleId)`, so a module is found by what it implements and
// not by a NAME() string it could copy.
//
// What these tests hold down:
//
//   1. The canonical Safe — the Safe 4337 module plus the records and the
//      publication module — resolves both roles in three probes or fewer. Each
//      probe is an eth_call and every eth_call spends one of Lit's 50 requests
//      per session, so the count is part of the contract, not an incidental.
//   2. A module whose supportsInterface reverts (an address that is a module
//      but answers no ERC-165 at all) is skipped, not treated as ours.
//   3. A module that answers the wrong role id is not accepted: answering the
//      records id does not make a module the publication module.
//
// The 4337 skip survives as an optimisation: that module answers no S2S role,
// so the probe could only ever come back empty.
// ============================================================================

// Canonical SAFE_4337_MODULE_ADDRESS.
const SAFE_4337 = '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226';
const SAFE_4337_LOWER = SAFE_4337.toLowerCase();

const RECORDS = '0x' + '11'.repeat(20);
const PUBLICATION = '0x' + '22'.repeat(20);
const STRANGER = '0x' + '33'.repeat(20); // a module that answers neither role
const REVERTER = '0x' + '44'.repeat(20); // a module whose supportsInterface reverts

// answers[address.toLowerCase()][roleId] === true → the module claims that role.
// A missing entry, or the string 'revert', makes the eth_call fail.
type Answer = boolean | 'revert';

const state = vi.hoisted(() => ({
  MODULES: [] as string[],
  answers: {} as Record<string, Record<string, Answer>>,
  probes: [] as { address: string; roleId: string }[],
}));

const setAnswers = (address: string, answers: Record<string, Answer>) => {
  state.answers[address.toLowerCase()] = answers;
};

const probesFor = (roleId: string) =>
  state.probes.filter((probe) => probe.roleId === roleId).map((probe) => probe.address);

vi.mock('./evm', () => ({
  evmRead: vi.fn(
    async (_chain: string, contractAddress: string, _abi: any, method: string, args: any[]) => {
      switch (method) {
        case 'nameWrapper':
          return '0x' + 'aa'.repeat(20);
        case 'ownerOf':
          return '0x' + 'bb'.repeat(20);
        case 'parentDomainController':
          return '0x' + 'cc'.repeat(20);
        case 'getModulesPaginated':
          return [state.MODULES, '0x' + '00'.repeat(20)];
        case 'supportsInterface': {
          const roleId = args[0] as string;
          const address = contractAddress.toLowerCase();
          state.probes.push({ address, roleId });
          const answer = state.answers[address]?.[roleId];
          if (answer === undefined || answer === 'revert') {
            throw new Error('execution reverted: no supportsInterface');
          }
          return answer;
        }
        default:
          throw new Error('unexpected method ' + method);
      }
    },
  ),
}));

beforeEach(() => {
  // The bundle injects `ethers` at runtime; ens.factory needs utils.namehash.
  (globalThis as any).ethers = {
    utils: { namehash: () => '0x' + 'ab'.repeat(32) },
  };
  state.MODULES = [];
  state.answers = {};
  state.probes = [];
  setAnswers(RECORDS, { [RECORDS_ROLE_ID]: true });
  setAnswers(PUBLICATION, { [PUBLICATION_ROLE_ID]: true });
  setAnswers(SAFE_4337, {}); // would revert, but it must never be asked
  setAnswers(STRANGER, { [RECORDS_ROLE_ID]: false, [PUBLICATION_ROLE_ID]: false });
  setAnswers(REVERTER, { [RECORDS_ROLE_ID]: 'revert', [PUBLICATION_ROLE_ID]: 'revert' });
});

describe('role ids', () => {
  it('are distinct bytes4 constants, so one probe cannot answer for both roles', () => {
    expect(RECORDS_ROLE_ID).toMatch(/^0x[0-9a-f]{8}$/);
    expect(PUBLICATION_ROLE_ID).toMatch(/^0x[0-9a-f]{8}$/);
    expect(PUBLICATION_ROLE_ID).not.toBe(RECORDS_ROLE_ID);
    expect(PUBLICATION_ROLE_ID).not.toBe('0x01ffc9a7');
  });
});

describe('getDomainOwnerAndModules — resolves both roles by interface', () => {
  it('resolves records and publication on a Safe that carries the 4337 module in three probes or fewer', async () => {
    state.MODULES = [SAFE_4337, RECORDS, PUBLICATION];

    const result = await getDomainOwnerAndModules('example.eth');

    expect(result.configModule).toBe(RECORDS);
    expect(result.publicationModule).toBe(PUBLICATION);
    expect(state.probes.length).toBeLessThanOrEqual(3);
    // The 4337 module answers no S2S interface and is skipped outright.
    expect(state.probes.map((probe) => probe.address)).not.toContain(SAFE_4337_LOWER);
  });

  it('keeps the three-probe ceiling when the module list is the other way round', async () => {
    state.MODULES = [PUBLICATION, SAFE_4337, RECORDS];

    const result = await getDomainOwnerAndModules('example.eth');

    expect(result.configModule).toBe(RECORDS);
    expect(result.publicationModule).toBe(PUBLICATION);
    expect(state.probes.length).toBeLessThanOrEqual(3);
  });

  it('asks records first, so a records-only Safe costs one probe', async () => {
    state.MODULES = [SAFE_4337, RECORDS, STRANGER];

    const result = await getDomainOwnerAndModules('example.eth');

    expect(result.configModule).toBe(RECORDS);
    // STRANGER answers false to both ids; one probe each, never more.
    expect(probesFor(RECORDS_ROLE_ID).length).toBeLessThanOrEqual(2);
  });

  it('skips a module whose supportsInterface reverts', async () => {
    state.MODULES = [REVERTER, RECORDS, PUBLICATION];

    const result = await getDomainOwnerAndModules('example.eth');

    expect(result.configModule).toBe(RECORDS);
    expect(result.publicationModule).toBe(PUBLICATION);
    expect(result.configModule).not.toBe(REVERTER);
    expect(result.publicationModule).not.toBe(REVERTER);
  });

  it('does not accept a module that answers the records id as the publication module', async () => {
    // STRANGER claims nothing; give it a wrong-id answer instead.
    setAnswers(STRANGER, { [RECORDS_ROLE_ID]: true });

    state.MODULES = [RECORDS, PUBLICATION, STRANGER];

    const result = await getDomainOwnerAndModules('example.eth');

    expect(result.configModule).toBe(RECORDS);
    expect(result.publicationModule).toBe(PUBLICATION);
  });

  it('returns null for a role no module answers', async () => {
    setAnswers(PUBLICATION, {}); // answers neither id

    state.MODULES = [SAFE_4337, RECORDS, PUBLICATION, STRANGER];

    const result = await getDomainOwnerAndModules('example.eth');

    expect(result.configModule).toBe(RECORDS);
    expect(result.publicationModule).toBeNull();
  });

  it('never probes the 4337 module, lowercased address included', async () => {
    state.MODULES = [SAFE_4337_LOWER, RECORDS];

    const result = await getDomainOwnerAndModules('example.eth');

    expect(result.configModule).toBe(RECORDS);
    expect(state.probes.map((probe) => probe.address)).not.toContain(SAFE_4337_LOWER);
  });

  it('finds nothing and probes nothing when the 4337 module is the only module', async () => {
    state.MODULES = [SAFE_4337];

    const result = await getDomainOwnerAndModules('example.eth');

    expect(result.configModule).toBeNull();
    expect(result.publicationModule).toBeNull();
    expect(state.probes).toEqual([]);
  });
});

describe('getProtocolControllerAndModules — the records module only', () => {
  it('resolves the records module and never asks for the publication role', async () => {
    state.MODULES = [SAFE_4337, RECORDS, PUBLICATION];

    const result = await getProtocolControllerAndModules();

    expect(result.configModule).toBe(RECORDS);
    expect(state.probes.length).toBeLessThanOrEqual(2);
    expect(probesFor(PUBLICATION_ROLE_ID)).toEqual([]);
  });

  it('skips modules answering false or reverting', async () => {
    state.MODULES = [SAFE_4337, STRANGER, REVERTER, RECORDS];

    const result = await getProtocolControllerAndModules();

    expect(result.configModule).toBe(RECORDS);
  });

  it('returns a null config module when no module answers the records id', async () => {
    state.MODULES = [SAFE_4337, PUBLICATION];

    const result = await getProtocolControllerAndModules();

    expect(result.configModule).toBeNull();
  });
});

describe('findModuleWithRole', () => {
  it('returns the first module that answers and null when none does', async () => {
    await expect(findModuleWithRole([STRANGER, REVERTER, RECORDS], RECORDS_ROLE_ID)).resolves.toBe(
      RECORDS,
    );
    await expect(findModuleWithRole([STRANGER, REVERTER], PUBLICATION_ROLE_ID)).resolves.toBeNull();
    await expect(findModuleWithRole([], RECORDS_ROLE_ID)).resolves.toBeNull();
  });
});
