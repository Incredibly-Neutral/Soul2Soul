import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getProtocolControllerAndModules,
  getDomainOwnerAndModules,
  findModuleWithRole,
  findModuleByPublicationName,
  RECORDS_ROLE_ID,
  PUBLICATION_ROLE_ID,
} from './ens.factory';

// ============================================================================
// Role discovery is ERC-165 first, with a NAME() fallback for publication.
//
// What these tests hold down:
//
//   1. The canonical Safe — the Safe 4337 module plus the records and the
//      publication module — resolves both roles. Each probe is an eth_call and
//      every eth_call spends one of Lit's 50 requests per session, so the count
//      is part of the contract.
//   2. A module that answers the role id is found by the id and its NAME() is
//      never read.
//   3. A module whose supportsInterface reverts is found through the NAME()
//      fallback — which is the live case, since none of the three deployed
//      publication modules implements ERC-165.
//   4. A module that answers neither is not accepted, and the accepted-name set
//      is exactly the pre-ERC-165 one.
//   5. A supplied `publication_factory` predicts the publication module before
//      any probe, and its answer is taken only when the Safe already lists the
//      address. No prediction, a reverting factory, and a prediction the Safe
//      does not enable all end at the same NAME() scan as before.
//
// The 4337 skip survives as an optimisation: that module answers no S2S role.
// ============================================================================

// Canonical SAFE_4337_MODULE_ADDRESS.
const SAFE_4337 = '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226';
const SAFE_4337_LOWER = SAFE_4337.toLowerCase();

const RECORDS = '0x' + '11'.repeat(20);
const PUBLICATION = '0x' + '22'.repeat(20);
const STRANGER = '0x' + '33'.repeat(20); // answers neither an id nor a NAME
const REVERTER = '0x' + '44'.repeat(20); // supportsInterface reverts, NAME answers

// The CREATE2 factory: `publication_factory` on the protocol records.
const FACTORY = '0x' + '55'.repeat(20);
const DECOY = '0x' + '66'.repeat(20); // predicted, never enabled on the Safe

// The names the pre-ERC-165 discovery accepted. Asserted end to end below, so a
// later edit to the predicate that narrows the set fails here.
const ACCEPTED_PUBLICATION_NAMES = [
  'S2S Publication Module', // V1
  'S2S Publication Module V1',
  'S2S Publication Module V2',
  'S2S Publication Module V3', // what the live V3 answers
  'S2S Publication Module V4', // a version this build has never seen
];

// Names the old discovery rejected, and must still reject.
const REJECTED_PUBLICATION_NAMES = [
  'S2S Records Module',
  'S2S Publication Module V2 Factory',
  'S2S Publication Module V',
  'S2S Publication Module VX',
  's2s publication module',
  ' S2S Publication Module V3',
  'S2S Publication Module V3 ',
  'S2S Publication  Module',
];

type Answer = boolean | 'revert';

const state = vi.hoisted(() => ({
  MODULES: [] as string[],
  // answers[address.toLowerCase()][roleId] === true → the module claims that role.
  answers: {} as Record<string, Record<string, Answer>>,
  // names[address.toLowerCase()] → what the module answers for NAME(); the
  // string 'revert' makes the call fail.
  names: {} as Record<string, string | 'revert'>,
  probes: [] as { address: string; roleId: string }[],
  nameProbes: [] as string[],
  // The factory's answers. `moduleAddress` is what the next createModule would
  // deploy; `implementations` is the implementation history that
  // moduleAddressForVersion indexes, which is 1-BASED: version v is index v - 1,
  // its length is what implementationCount answers, and version 0 reverts
  // InvalidVersion exactly as the contract does. 'revert' makes a read fail,
  // which is what every factory deployed before the CREATE2 one does.
  factoryModuleAddress: null as string | 'revert' | null,
  factoryImplementations: 'revert' as string[] | 'revert',
  factoryProbes: [] as { address: string; method: string; args: unknown[] }[],
}));

const setAnswers = (address: string, answers: Record<string, Answer>) => {
  state.answers[address.toLowerCase()] = answers;
};

const setName = (address: string, name: string | 'revert') => {
  state.names[address.toLowerCase()] = name;
};

const probedAddresses = () => state.probes.map((probe) => probe.address);
const factoryMethods = () => state.factoryProbes.map((probe) => probe.method);
const publicationRoleProbes = () =>
  state.probes.filter((probe) => probe.roleId === PUBLICATION_ROLE_ID);

const setFactory = (answers: { moduleAddress?: string; implementations?: string[] }) => {
  state.factoryModuleAddress = answers.moduleAddress ?? null;
  state.factoryImplementations = answers.implementations ?? [];
};

// What every factory deployed before the CREATE2 one does: no such function.
const setRevertingFactory = () => {
  state.factoryModuleAddress = 'revert';
  state.factoryImplementations = 'revert';
};

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
        case 'NAME': {
          const address = contractAddress.toLowerCase();
          state.nameProbes.push(address);
          const name = state.names[address];
          if (name === undefined || name === 'revert') {
            throw new Error('execution reverted: no NAME');
          }
          return name;
        }
        case 'moduleAddress': {
          state.factoryProbes.push({ address: contractAddress, method, args });
          if (state.factoryModuleAddress === null || state.factoryModuleAddress === 'revert') {
            throw new Error('execution reverted: no moduleAddress');
          }
          return state.factoryModuleAddress;
        }
        case 'implementationCount': {
          state.factoryProbes.push({ address: contractAddress, method, args });
          if (state.factoryImplementations === 'revert') {
            throw new Error('execution reverted: no implementationCount');
          }
          return state.factoryImplementations.length;
        }
        case 'moduleAddressForVersion': {
          state.factoryProbes.push({ address: contractAddress, method, args });
          if (state.factoryImplementations === 'revert') {
            throw new Error('execution reverted: no moduleAddressForVersion');
          }
          const version = Number(args[1]);
          // 1-based over the history; 0 is not a version the view accepts.
          if (!Number.isInteger(version) || version < 1) {
            throw new Error('execution reverted: InvalidVersion');
          }
          const implementation = state.factoryImplementations[version - 1];
          if (!implementation) throw new Error('execution reverted: InvalidVersion');
          return implementation;
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
  state.names = {};
  state.probes = [];
  state.nameProbes = [];
  state.factoryModuleAddress = null;
  state.factoryImplementations = 'revert';
  state.factoryProbes = [];
  setAnswers(RECORDS, { [RECORDS_ROLE_ID]: true });
  setAnswers(PUBLICATION, { [PUBLICATION_ROLE_ID]: true });
  setName(PUBLICATION, 'S2S Publication Module V3');
  setAnswers(SAFE_4337, {}); // would revert, but it must never be asked
  setAnswers(STRANGER, { [RECORDS_ROLE_ID]: false, [PUBLICATION_ROLE_ID]: false });
  setName(STRANGER, 'S2S Records Module');
  // The live case: no supportsInterface at all, a NAME() that says what it is.
  setAnswers(REVERTER, { [RECORDS_ROLE_ID]: 'revert', [PUBLICATION_ROLE_ID]: 'revert' });
  setName(REVERTER, 'S2S Publication Module V2');
});

describe('role ids', () => {
  it('are distinct bytes4 constants, so one probe cannot answer for both roles', () => {
    expect(RECORDS_ROLE_ID).toMatch(/^0x[0-9a-f]{8}$/);
    expect(PUBLICATION_ROLE_ID).toMatch(/^0x[0-9a-f]{8}$/);
    expect(PUBLICATION_ROLE_ID).not.toBe(RECORDS_ROLE_ID);
    expect(PUBLICATION_ROLE_ID).not.toBe('0x01ffc9a7');
  });
});

describe('getDomainOwnerAndModules — resolves both roles', () => {
  it('resolves records and publication on a Safe that carries the 4337 module in three probes or fewer', async () => {
    state.MODULES = [SAFE_4337, RECORDS, PUBLICATION];

    const result = await getDomainOwnerAndModules('example.eth');

    expect(result.configModule).toBe(RECORDS);
    expect(result.publicationModule).toBe(PUBLICATION);
    expect(state.probes.length).toBeLessThanOrEqual(3);
    // The id was answered, so no NAME() is read anywhere.
    expect(state.nameProbes).toEqual([]);
    expect(probedAddresses()).not.toContain(SAFE_4337_LOWER);
  });

  it('keeps the three-probe ceiling when the module list is the other way round', async () => {
    state.MODULES = [PUBLICATION, SAFE_4337, RECORDS];

    const result = await getDomainOwnerAndModules('example.eth');

    expect(result.configModule).toBe(RECORDS);
    expect(result.publicationModule).toBe(PUBLICATION);
    expect(state.probes.length).toBeLessThanOrEqual(3);
    expect(state.nameProbes).toEqual([]);
  });

  it('finds a publication module whose supportsInterface reverts, through its NAME()', async () => {
    state.MODULES = [SAFE_4337, RECORDS, REVERTER];

    const result = await getDomainOwnerAndModules('example.eth');

    expect(result.configModule).toBe(RECORDS);
    expect(result.publicationModule).toBe(REVERTER);
    // The id probe came back empty, then NAME() decided it — four calls for
    // this Safe, which is the count the header states for the live case.
    expect(state.nameProbes).toEqual([REVERTER.toLowerCase()]);
    expect(state.probes.length + state.nameProbes.length).toBeLessThanOrEqual(4);
  });

  it('does not read NAME() for records, which answers its id', async () => {
    setName(RECORDS, 'S2S Records Module');
    state.MODULES = [SAFE_4337, RECORDS, PUBLICATION];

    await getDomainOwnerAndModules('example.eth');

    expect(state.nameProbes).not.toContain(RECORDS.toLowerCase());
  });

  it('does not accept a module that answers neither an id nor a NAME', async () => {
    setName(STRANGER, 'S2S Records Module');
    setAnswers(STRANGER, { [RECORDS_ROLE_ID]: false, [PUBLICATION_ROLE_ID]: false });

    state.MODULES = [RECORDS, STRANGER];

    const result = await getDomainOwnerAndModules('example.eth');

    expect(result.configModule).toBe(RECORDS);
    expect(result.publicationModule).toBeNull();
  });

  it('does not accept a module that answers the records id as the publication module', async () => {
    setAnswers(STRANGER, { [RECORDS_ROLE_ID]: true });

    state.MODULES = [RECORDS, PUBLICATION, STRANGER];

    const result = await getDomainOwnerAndModules('example.eth');

    expect(result.configModule).toBe(RECORDS);
    expect(result.publicationModule).toBe(PUBLICATION);
  });

  it('returns null for a role no module answers', async () => {
    setAnswers(PUBLICATION, {}); // answers neither id
    setName(PUBLICATION, 'S2S Records Module'); // and is not a publication by name

    state.MODULES = [SAFE_4337, RECORDS, PUBLICATION, STRANGER];

    const result = await getDomainOwnerAndModules('example.eth');

    expect(result.configModule).toBe(RECORDS);
    expect(result.publicationModule).toBeNull();
  });

  it('never probes the 4337 module, lowercased address included', async () => {
    state.MODULES = [SAFE_4337_LOWER, RECORDS];

    const result = await getDomainOwnerAndModules('example.eth');

    expect(result.configModule).toBe(RECORDS);
    expect(probedAddresses()).not.toContain(SAFE_4337_LOWER);
    expect(state.nameProbes).not.toContain(SAFE_4337_LOWER);
  });

  it('finds nothing and calls nothing when the 4337 module is the only module', async () => {
    state.MODULES = [SAFE_4337];

    const result = await getDomainOwnerAndModules('example.eth');

    expect(result.configModule).toBeNull();
    expect(result.publicationModule).toBeNull();
    expect(state.probes).toEqual([]);
    expect(state.nameProbes).toEqual([]);
  });
});

describe('getDomainOwnerAndModules — the CREATE2 prediction', () => {
  it('takes a predicted address the Safe lists, with no publication probe and no NAME() read', async () => {
    // Answer no role id and reject the NAME, so only the prediction can find it.
    setAnswers(PUBLICATION, {});
    setName(PUBLICATION, 'S2S Records Module');
    state.MODULES = [SAFE_4337, RECORDS, PUBLICATION];
    setFactory({ moduleAddress: PUBLICATION, implementations: [PUBLICATION] });

    const result = await getDomainOwnerAndModules('example.eth', undefined, FACTORY);

    expect(result.configModule).toBe(RECORDS);
    expect(result.publicationModule).toBe(PUBLICATION);
    expect(factoryMethods()).toEqual(['moduleAddress']);
    expect(publicationRoleProbes()).toEqual([]);
    expect(state.nameProbes).toEqual([]);
    // One factory call instead of the publication probe or the NAME() read.
    expect(state.probes.length + state.factoryProbes.length).toBeLessThanOrEqual(3);
    expect(state.factoryProbes[0].address).toBe(FACTORY);
  });

  it('resolves a publication created under the previous implementation (count 2, version 1)', async () => {
    // The case the prediction exists for: the factory's current generation is
    // not on the list, the previous one is.
    const older = '0x' + '77'.repeat(20);
    setAnswers(older, {});
    setName(older, 'S2S Publication Module V2');
    state.MODULES = [SAFE_4337, RECORDS, older];
    setFactory({ moduleAddress: DECOY, implementations: [older, DECOY] });

    const result = await getDomainOwnerAndModules('example.eth', undefined, FACTORY);

    expect(result.publicationModule).toBe(older);
    expect(factoryMethods()).toEqual([
      'moduleAddress',
      'implementationCount',
      'moduleAddressForVersion',
    ]);
    // Version 1 is the previous implementation; the walk never asks version 0.
    expect(state.factoryProbes[2].args).toEqual([expect.any(String), 1]);
    expect(state.nameProbes).toEqual([]);
    expect(state.probes.length + state.factoryProbes.length).toBeLessThanOrEqual(5);
  });

  it('walks older versions newest first and stops above version 1', async () => {
    const older = '0x' + '77'.repeat(20); // created under version 1
    const mid = '0x' + '88'.repeat(20); // never enabled on this Safe
    setAnswers(older, {});
    setName(older, 'S2S Publication Module V2');
    state.MODULES = [SAFE_4337, RECORDS, older];
    setFactory({ moduleAddress: DECOY, implementations: [older, mid, DECOY] });

    const result = await getDomainOwnerAndModules('example.eth', undefined, FACTORY);

    expect(result.publicationModule).toBe(older);
    expect(factoryMethods()).toEqual([
      'moduleAddress',
      'implementationCount',
      'moduleAddressForVersion',
      'moduleAddressForVersion',
    ]);
    // Newest first: version 2 before version 1, and 0 is never asked.
    expect(state.factoryProbes[2].args).toEqual([expect.any(String), 2]);
    expect(state.factoryProbes[3].args).toEqual([expect.any(String), 1]);
    expect(state.nameProbes).toEqual([]);
  });

  it('reads no version at all when only one implementation was ever set', async () => {
    state.MODULES = [SAFE_4337, RECORDS, REVERTER];
    setFactory({ moduleAddress: DECOY, implementations: [DECOY] });

    const result = await getDomainOwnerAndModules('example.eth', undefined, FACTORY);

    expect(result.publicationModule).toBe(REVERTER);
    expect(factoryMethods()).toEqual(['moduleAddress', 'implementationCount']);
    expect(state.nameProbes).toEqual([REVERTER.toLowerCase()]);
  });

  it('falls back to the NAME() scan when no predicted address is on the list', async () => {
    state.MODULES = [SAFE_4337, RECORDS, REVERTER];
    setFactory({ moduleAddress: DECOY, implementations: [DECOY] });

    const result = await getDomainOwnerAndModules('example.eth', undefined, FACTORY);

    expect(result.publicationModule).toBe(REVERTER);
    expect(factoryMethods()).toEqual(['moduleAddress', 'implementationCount']);
    expect(state.nameProbes).toEqual([REVERTER.toLowerCase()]);
  });

  it('falls through to the probes when the factory read reverts, and stops reading', async () => {
    state.MODULES = [SAFE_4337, RECORDS, REVERTER];
    setRevertingFactory();

    const result = await getDomainOwnerAndModules('example.eth', undefined, FACTORY);

    expect(result.publicationModule).toBe(REVERTER);
    // One failed read, then exactly the path that existed before prediction.
    expect(factoryMethods()).toEqual(['moduleAddress']);
    expect(state.nameProbes).toEqual([REVERTER.toLowerCase()]);
    expect(state.probes.length + state.nameProbes.length).toBeLessThanOrEqual(4);
  });

  it('does not accept a predicted address the Safe does not enable', async () => {
    state.MODULES = [SAFE_4337, RECORDS, REVERTER];
    setFactory({ moduleAddress: DECOY, implementations: [DECOY] });

    const result = await getDomainOwnerAndModules('example.eth', undefined, FACTORY);

    expect(result.publicationModule).not.toBe(DECOY);
    expect(result.publicationModule).toBe(REVERTER);
  });

  it('reads nothing from the factory when no factory is passed', async () => {
    state.MODULES = [SAFE_4337, RECORDS, PUBLICATION];
    setFactory({ moduleAddress: PUBLICATION, implementations: [PUBLICATION] });

    const result = await getDomainOwnerAndModules('example.eth');

    expect(result.publicationModule).toBe(PUBLICATION);
    expect(state.factoryProbes).toEqual([]);
  });

  it('ignores a prediction that is only the records module', async () => {
    state.MODULES = [SAFE_4337, RECORDS, REVERTER];
    setFactory({ moduleAddress: RECORDS, implementations: [RECORDS] });

    const result = await getDomainOwnerAndModules('example.eth', undefined, FACTORY);

    expect(result.configModule).toBe(RECORDS);
    expect(result.publicationModule).toBe(REVERTER);
  });
});

describe('getProtocolControllerAndModules — the records module only', () => {
  it('resolves the records module, with no publication probe and no NAME() read', async () => {
    state.MODULES = [SAFE_4337, RECORDS, PUBLICATION];

    const result = await getProtocolControllerAndModules();

    expect(result.configModule).toBe(RECORDS);
    expect(state.probes.length).toBeLessThanOrEqual(2);
    expect(state.nameProbes).toEqual([]);
  });

  it('skips modules answering false or reverting, with no NAME() fallback for records', async () => {
    state.MODULES = [SAFE_4337, STRANGER, REVERTER, RECORDS];

    const result = await getProtocolControllerAndModules();

    expect(result.configModule).toBe(RECORDS);
    expect(state.nameProbes).toEqual([]);
  });

  it('returns a null config module when no module answers the records id', async () => {
    state.MODULES = [SAFE_4337, PUBLICATION];

    const result = await getProtocolControllerAndModules();

    expect(result.configModule).toBeNull();
    expect(state.nameProbes).toEqual([]);
  });
});

describe('the publication NAME() fallback', () => {
  it('accepts exactly the names the pre-ERC-165 discovery accepted', async () => {
    for (const name of ACCEPTED_PUBLICATION_NAMES) {
      state.probes = [];
      state.nameProbes = [];
      setName(REVERTER, name);

      await expect(
        findModuleByPublicationName([REVERTER], undefined),
        `expected ${JSON.stringify(name)} to be accepted`,
      ).resolves.toBe(REVERTER);
    }

    for (const name of REJECTED_PUBLICATION_NAMES) {
      state.probes = [];
      state.nameProbes = [];
      setName(REVERTER, name);

      await expect(
        findModuleByPublicationName([REVERTER], undefined),
        `expected ${JSON.stringify(name)} to be rejected`,
      ).resolves.toBeNull();
    }
  });

  it('is not consulted while a module answers the publication id', async () => {
    state.MODULES = [RECORDS, PUBLICATION, REVERTER];

    const result = await getDomainOwnerAndModules('example.eth');

    expect(result.publicationModule).toBe(PUBLICATION);
    expect(state.nameProbes).toEqual([]);
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
