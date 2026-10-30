import { describe, it, expect, vi } from 'vitest';
import {
  BASE_CHAIN_ID,
  clearEnsProposal,
  ENS_PROPOSAL_TTL_MS,
  ensProposalStorageKey,
  ensStepView,
  findPublicationName,
  hasEnsProposal,
  markEnsProposal,
  pollBackoffMs,
  RECORDS_MODULE_NAME,
  safeAppUrl,
  type EnsStepStorage,
} from '../../src/lib/ens-step';
import {
  buildRegisterSubdomainCall,
  computeSubnode,
  SOUL2SOUL_SUFFIX,
  type EnsRegistrationState,
} from '../../src/lib/ens-registration';
import {
  ENS_L1_CHAIN_ID,
  ENS_REGISTRY_ADDRESS,
  ZERO_ADDRESS,
  type EvmReadFn,
} from '../../src/lib/domain-validation';

const SAFE = '0x79dedb19353F7909CDc68504839EF88a7498aaf2';
const OTHER_OWNER = '0x000000000000000000000000000000000000dEaD';
const RECORDS = '0x1111111111111111111111111111111111111111';
const OTHER_MODULE = '0x2222222222222222222222222222222222222222';
const SENTINEL = '0x0000000000000000000000000000000000000001';
const NODE = '0x' + '1'.repeat(64);

interface ReadCall {
  chainId: number;
  contract: string;
  method: string;
  args: any[];
}

/** A fake chain whose Safe module list + records module are injectable. */
function makeChainRead(options: {
  modules?: string[];
  next?: string;
  /** Explicit pages, walked in order (for multi-page / maxPages tests). */
  pages?: Array<{ modules: string[]; next?: string }>;
  name?: string;
  /** Per-module `name` record, when a Safe has more than one records module. */
  names?: Record<string, string>;
  recordsModule?: string;
  recordsModules?: string[];
  nameThrowsOn?: string[];
  getRecordThrows?: boolean;
  getRecordThrowsOn?: string[];
  modulesThrows?: boolean;
  calls?: ReadCall[];
}): EvmReadFn {
  const calls = options.calls;
  let pageIndex = 0;
  return async (chainId, contractAddress, _abi, method, args) => {
    calls?.push({ chainId, contract: String(contractAddress), method, args });
    switch (method) {
      case 'getModulesPaginated': {
        if (options.modulesThrows) throw new Error('rpc down');
        if (options.pages) {
          const page = options.pages[Math.min(pageIndex++, options.pages.length - 1)];
          return [page.modules, page.next ?? SENTINEL];
        }
        return [options.modules ?? [], options.next ?? SENTINEL];
      }
      case 'NAME': {
        const module = String(contractAddress);
        if (options.nameThrowsOn?.includes(module)) throw new Error('no NAME');
        return (options.recordsModules ?? [options.recordsModule ?? RECORDS]).includes(module)
          ? RECORDS_MODULE_NAME
          : 'Other Module';
      }
      case 'getRecord':
        if (options.getRecordThrows || options.getRecordThrowsOn?.includes(String(contractAddress)))
          throw new Error('rpc down');
        return options.names?.[String(contractAddress)] ?? options.name ?? '';
      default:
        throw new Error(`unexpected read ${method}`);
    }
  };
}

describe('findPublicationName', () => {
  it('reads name from the records module on Base, walking the Safe module list', async () => {
    const calls: ReadCall[] = [];
    const evmRead = makeChainRead({
      modules: [OTHER_MODULE, RECORDS],
      name: 'polyphony.soul2soul.eth',
      calls,
    });

    await expect(findPublicationName(evmRead, SAFE)).resolves.toBe('polyphony.soul2soul.eth');

    const page = calls.find((c) => c.method === 'getModulesPaginated');
    expect(page?.chainId).toBe(BASE_CHAIN_ID);
    expect(page?.contract).toBe(SAFE);
    expect(page?.args).toEqual([SENTINEL, 20]);
    const record = calls.find((c) => c.method === 'getRecord');
    expect(record?.chainId).toBe(BASE_CHAIN_ID);
    expect(record?.contract).toBe(RECORDS);
    expect(record?.args).toEqual(['name']);
  });

  it('returns "" when no module identifies itself as the records module', async () => {
    const evmRead = makeChainRead({ modules: [OTHER_MODULE], recordsModule: '0xnot-here' });
    await expect(findPublicationName(evmRead, SAFE)).resolves.toBe('');
  });

  it('skips a module whose NAME() reverts and still finds the records module', async () => {
    const evmRead = makeChainRead({
      modules: [OTHER_MODULE, RECORDS],
      nameThrowsOn: [OTHER_MODULE],
      name: 'polyphony.soul2soul.eth',
    });
    await expect(findPublicationName(evmRead, SAFE)).resolves.toBe('polyphony.soul2soul.eth');
  });

  it('returns "" for a publication with no name record', async () => {
    const evmRead = makeChainRead({ modules: [RECORDS], name: '' });
    await expect(findPublicationName(evmRead, SAFE)).resolves.toBe('');
  });

  it('returns "" and never throws when the module list read fails (429/transport)', async () => {
    const evmRead = makeChainRead({ modulesThrows: true });
    await expect(findPublicationName(evmRead, SAFE)).resolves.toBe('');
  });

  it('returns "" when the records module name read fails', async () => {
    const evmRead = makeChainRead({ modules: [RECORDS], getRecordThrows: true });
    await expect(findPublicationName(evmRead, SAFE)).resolves.toBe('');
  });

  it('walks a real second page', async () => {
    const NEXT = '0x' + '9'.repeat(40);
    const calls: ReadCall[] = [];
    const evmRead = makeChainRead({
      pages: [
        { modules: [OTHER_MODULE], next: NEXT },
        { modules: [RECORDS], next: SENTINEL },
      ],
      name: 'polyphony.soul2soul.eth',
      calls,
    });
    await expect(findPublicationName(evmRead, SAFE)).resolves.toBe('polyphony.soul2soul.eth');
    const pages = calls.filter((c) => c.method === 'getModulesPaginated');
    expect(pages.map((c) => c.args[0])).toEqual([SENTINEL, NEXT]);
  });

  it('stops at maxPages even when every page advertises another', async () => {
    const calls: ReadCall[] = [];
    const evmRead = makeChainRead({
      pages: [
        { modules: [], next: '0x' + '9'.repeat(40) },
        { modules: [], next: '0x' + '8'.repeat(40) },
        { modules: [], next: '0x' + '7'.repeat(40) },
        { modules: [], next: '0x' + '6'.repeat(40) },
      ],
      calls,
    });
    await findPublicationName(evmRead, SAFE, { maxPages: 3 });
    expect(calls.filter((c) => c.method === 'getModulesPaginated')).toHaveLength(3);
  });

  it('does not loop forever when a page returns the previous cursor again', async () => {
    const NEXT = '0x' + '9'.repeat(40);
    const calls: ReadCall[] = [];
    const evmRead = makeChainRead({
      pages: [
        { modules: [], next: NEXT },
        { modules: [], next: NEXT },
      ],
      calls,
    });
    await findPublicationName(evmRead, SAFE);
    expect(calls.filter((c) => c.method === 'getModulesPaginated')).toHaveLength(2);
  });

  it('returns "" without any read for an empty Safe address', async () => {
    const calls: ReadCall[] = [];
    const evmRead = makeChainRead({ modules: [RECORDS], calls });
    await expect(findPublicationName(evmRead, '')).resolves.toBe('');
    expect(calls).toHaveLength(0);
  });

  it('accepts only the expected publication name when two records modules disagree', async () => {
    const SECOND_RECORDS = '0x3333333333333333333333333333333333333333';
    const calls: ReadCall[] = [];
    const evmRead = makeChainRead({
      modules: [RECORDS, SECOND_RECORDS],
      recordsModules: [RECORDS, SECOND_RECORDS],
      names: { [RECORDS]: 'stale.soul2soul.eth', [SECOND_RECORDS]: 'polyphony.soul2soul.eth' },
      calls,
    });

    await expect(
      findPublicationName(evmRead, SAFE, { expectedName: 'polyphony.soul2soul.eth' }),
    ).resolves.toBe('polyphony.soul2soul.eth');
    // Without the hint, the first records module wins (legacy behaviour).
    await expect(findPublicationName(evmRead, SAFE)).resolves.toBe('stale.soul2soul.eth');
  });

  it('returns "" rather than a different module name when the expected name is absent', async () => {
    const evmRead = makeChainRead({ modules: [RECORDS], name: 'stale.soul2soul.eth' });
    await expect(
      findPublicationName(evmRead, SAFE, { expectedName: 'polyphony.soul2soul.eth' }),
    ).resolves.toBe('');
  });

  it('distinguishes a missing NAME() from a transport failure when asked', async () => {
    const base = makeChainRead({
      modules: [OTHER_MODULE, RECORDS],
      name: 'polyphony.soul2soul.eth',
    });
    const evmRead: EvmReadFn = async (...args) => {
      if (args[3] === 'NAME' && String(args[1]) === OTHER_MODULE) {
        const err = new Error('execution reverted') as Error & { code: string };
        err.code = 'CALL_EXCEPTION';
        throw err;
      }
      return base(...args);
    };
    await expect(findPublicationName(evmRead, SAFE, { throwOnError: true })).resolves.toBe(
      'polyphony.soul2soul.eth',
    );
  });

  it('propagates a non-revert NAME() failure when asked', async () => {
    const base = makeChainRead({ modules: [RECORDS] });
    const evmRead: EvmReadFn = async (...args) => {
      if (args[3] === 'NAME') {
        const err = new Error('429 Too Many Requests') as Error & { code: string };
        err.code = 'SERVER_ERROR';
        throw err;
      }
      return base(...args);
    };
    await expect(
      findPublicationName(evmRead, SAFE, {
        expectedName: 'polyphony.soul2soul.eth',
        throwOnError: true,
      }),
    ).rejects.toThrow('429');
  });

  it('can propagate read failures so the host does not cache a failed read', async () => {
    await expect(
      findPublicationName(makeChainRead({ modulesThrows: true }), SAFE, { throwOnError: true }),
    ).rejects.toThrow('rpc down');
    await expect(
      findPublicationName(makeChainRead({ modules: [RECORDS], getRecordThrows: true }), SAFE, {
        expectedName: 'polyphony.soul2soul.eth',
        throwOnError: true,
      }),
    ).rejects.toThrow('rpc down');
  });
});

function registrationState(overrides: Partial<EnsRegistrationState> = {}): EnsRegistrationState {
  const label = overrides.label ?? 'polyphony';
  const parentNode = '0x' + '2'.repeat(64);
  return {
    label,
    name: `${label}.${SOUL2SOUL_SUFFIX}`,
    registry: ENS_REGISTRY_ADDRESS,
    nameWrapper: '0x00000000000000000000000000000000000000aa',
    parentWrapped: true,
    node: computeSubnode(parentNode, label),
    owner: ZERO_ADDRESS,
    registered: false,
    ownedBySafe: false,
    needsRegistration: true,
    desynced: false,
    ...overrides,
  };
}

const L1_SAFE = { chainId: ENS_L1_CHAIN_ID, safeAddress: SAFE };
const BASE_SAFE = { chainId: 8453, safeAddress: SAFE };

describe('ensStepView', () => {
  it('is hidden when the registration was not read (null state)', () => {
    expect(ensStepView(null, L1_SAFE).kind).toBe('hidden');
    expect(ensStepView(null, BASE_SAFE).kind).toBe('hidden');
    expect(ensStepView(null, L1_SAFE).canPropose).toBe(false);
  });

  it('needs registration on chain 1 and can propose the exact call', () => {
    const view = ensStepView(registrationState(), L1_SAFE);
    expect(view.kind).toBe('needs-registration');
    expect(view.chain).toBe('l1');
    expect(view.canPropose).toBe(true);
    const expected = buildRegisterSubdomainCall(ENS_REGISTRY_ADDRESS, 'polyphony', SAFE);
    expect(view.call).toEqual({ to: expected.to, data: expected.data });
    expect(view.name).toBe(`polyphony.${SOUL2SOUL_SUFFIX}`);
  });

  it('needs registration on Base but cannot propose from that chain', () => {
    const view = ensStepView(registrationState(), BASE_SAFE);
    expect(view.kind).toBe('needs-registration');
    expect(view.chain).toBe('other');
    expect(view.canPropose).toBe(false);
    // The copy fallback still gets the call.
    expect(view.call?.to).toBe(ENS_REGISTRY_ADDRESS);
    expect(view.call?.data).toMatch(/^0x[0-9a-f]+$/i);
  });

  it('is waiting once a proposal is recorded (both chains)', () => {
    const l1 = ensStepView(registrationState(), L1_SAFE, { proposed: true });
    expect(l1.kind).toBe('waiting');
    expect(l1.canPropose).toBe(false);
    expect(l1.call).toBeDefined();

    const base = ensStepView(registrationState(), BASE_SAFE, { proposed: true });
    expect(base.kind).toBe('waiting');
    expect(base.canPropose).toBe(false);
  });

  it('is done when the subnode is owned by this Safe', () => {
    const view = ensStepView(
      registrationState({
        registered: true,
        owner: SAFE.toLowerCase(),
        ownedBySafe: true,
        needsRegistration: false,
      }),
      BASE_SAFE,
    );
    expect(view.kind).toBe('done');
    expect(view.canPropose).toBe(false);
    expect(view.call).toBeUndefined();
  });

  it('is an error when a third party owns the subnode (never proposable)', () => {
    const view = ensStepView(
      registrationState({
        registered: true,
        owner: OTHER_OWNER.toLowerCase(),
        needsRegistration: false,
      }),
      L1_SAFE,
    );
    expect(view.kind).toBe('error');
    expect(view.canPropose).toBe(false);
    expect(view.call).toBeUndefined();
    expect(view.reason).toContain(OTHER_OWNER.toLowerCase());
  });

  it('is an error for the desynced half-written registry state', () => {
    const view = ensStepView(
      registrationState({ registered: true, desynced: true, needsRegistration: false }),
      L1_SAFE,
    );
    expect(view.kind).toBe('error');
    expect(view.canPropose).toBe(false);
    expect(view.reason).toContain('no owner');
  });
});

describe('safeAppUrl', () => {
  it('opens the same Safe + app on mainnet with an encoded appUrl', () => {
    const url = safeAppUrl({
      chainId: ENS_L1_CHAIN_ID,
      safeAddress: SAFE,
      appUrl: 'https://app.example.test/records?a=1&b=two words',
    });
    expect(url).toBe(
      `https://app.safe.global/apps/open?safe=eth:${SAFE}&appUrl=https%3A%2F%2Fapp.example.test%2Frecords%3Fa%3D1%26b%3Dtwo%20words`,
    );
  });

  it('uses the chain shortname (and a numeric fallback for unknown chains)', () => {
    expect(safeAppUrl({ chainId: 8453, safeAddress: SAFE, appUrl: 'https://x.test/' })).toContain(
      `safe=base:${SAFE}`,
    );
    expect(safeAppUrl({ chainId: 424242, safeAddress: SAFE, appUrl: 'https://x.test/' })).toContain(
      `safe=424242:${SAFE}`,
    );
  });

  it('returns "" instead of a broken link when the address or app URL is unusable', () => {
    expect(safeAppUrl({ chainId: 1, safeAddress: '', appUrl: 'https://x.test/' })).toBe('');
    expect(
      safeAppUrl({ chainId: 1, safeAddress: 'not-an-address', appUrl: 'https://x.test/' }),
    ).toBe('');
    expect(safeAppUrl({ chainId: 1, safeAddress: SAFE, appUrl: '' })).toBe('');
  });
});

describe('one-proposal-per-Safe-and-label marker', () => {
  function fakeStorage(): EnsStepStorage {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    };
  }

  it('is keyed by lowercased Safe, registry and label, and persists once marked', () => {
    const storage = fakeStorage();
    expect(hasEnsProposal(storage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS)).toBe(false);
    markEnsProposal(storage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS);
    expect(
      hasEnsProposal(
        storage,
        SAFE.toUpperCase().replace('0X', '0x'),
        'POLYPHONY',
        ENS_REGISTRY_ADDRESS,
      ),
    ).toBe(true);
    expect(ensProposalStorageKey(SAFE, 'polyphony', ENS_REGISTRY_ADDRESS)).toBe(
      `s2s.ens-step.proposed.v2:${SAFE.toLowerCase()}:${ENS_REGISTRY_ADDRESS.toLowerCase()}:polyphony`,
    );
    // A renamed publication, or a different deployment's registry, is a
    // different scope and must not inherit the marker.
    expect(hasEnsProposal(storage, SAFE, 'other-name', ENS_REGISTRY_ADDRESS)).toBe(false);
    expect(hasEnsProposal(storage, SAFE, 'polyphony', OTHER_OWNER)).toBe(false);
  });

  it('expires after the TTL and clear() re-arms the card', () => {
    const storage = fakeStorage();
    const now = 1_700_000_000_000;
    markEnsProposal(storage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS, now);
    expect(hasEnsProposal(storage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS, now + 1)).toBe(true);
    expect(
      hasEnsProposal(
        storage,
        SAFE,
        'polyphony',
        ENS_REGISTRY_ADDRESS,
        now + ENS_PROPOSAL_TTL_MS + 1,
      ),
    ).toBe(false);
    expect(storage.getItem(ensProposalStorageKey(SAFE, 'polyphony', ENS_REGISTRY_ADDRESS))).toBe(
      null,
    );

    markEnsProposal(storage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS, now);
    clearEnsProposal(storage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS);
    expect(hasEnsProposal(storage, SAFE, 'polyphony', ENS_REGISTRY_ADDRESS, now)).toBe(false);
  });

  it('treats a throwing storage as "not proposed" instead of breaking the card', () => {
    const storage: EnsStepStorage = {
      getItem: vi.fn(() => {
        throw new Error('denied');
      }),
      setItem: vi.fn(() => {
        throw new Error('denied');
      }),
      removeItem: vi.fn(() => {
        throw new Error('denied');
      }),
    };
    expect(hasEnsProposal(storage, SAFE, 'polyphony')).toBe(false);
    expect(() => markEnsProposal(storage, SAFE, 'polyphony')).not.toThrow();
    expect(() => clearEnsProposal(storage, SAFE, 'polyphony')).not.toThrow();
  });
});

describe('pollBackoffMs', () => {
  it('doubles on consecutive failures and caps at one minute', () => {
    expect(pollBackoffMs(5_000, 0)).toBe(5_000);
    expect(pollBackoffMs(5_000, 1)).toBe(10_000);
    expect(pollBackoffMs(5_000, 2)).toBe(20_000);
    expect(pollBackoffMs(5_000, 3)).toBe(40_000);
    expect(pollBackoffMs(5_000, 4)).toBe(60_000);
    expect(pollBackoffMs(5_000, 100)).toBe(60_000);
  });
});
