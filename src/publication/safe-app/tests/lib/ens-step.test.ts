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
  NoRecordsModuleError,
  pollBackoffMs,
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
import { S2S_MODULE_KIND_RECORDS } from '@s2s/soul2soul-shared/safe-app';

const SAFE = '0x79dedb19353F7909CDc68504839EF88a7498aaf2';
const OTHER_OWNER = '0x000000000000000000000000000000000000dEaD';
const RECORDS = '0x1111111111111111111111111111111111111111';
const FACTORY = '0x3333333333333333333333333333333333333333';
const NODE = '0x' + '1'.repeat(64);

interface ReadCall {
  chainId: number;
  contract: string;
  method: string;
  args: any[];
}

/**
 * A fake chain: the factory answers `moduleAddress(safe, records kind)`, and the
 * module it names answers `getRecord('name')`. Any other read is a bug, so it
 * throws instead of inventing an answer.
 */
function makeChainRead(options: {
  /** What the factory answers; ZERO_ADDRESS by default (no module). */
  module?: string;
  name?: string;
  moduleThrows?: boolean;
  getRecordThrows?: boolean;
  calls?: ReadCall[];
}): EvmReadFn {
  const calls = options.calls;
  return async (chainId, contractAddress, _abi, method, args) => {
    calls?.push({ chainId, contract: String(contractAddress), method, args });
    switch (method) {
      case 'moduleAddress':
        if (options.moduleThrows) throw new Error('rpc down');
        return options.module ?? ZERO_ADDRESS;
      case 'getRecord':
        if (options.getRecordThrows) throw new Error('rpc down');
        return options.name ?? '';
      default:
        throw new Error(`unexpected read ${method}`);
    }
  };
}

const RECORDS_MODULE = { moduleFactory: FACTORY, module: RECORDS };

describe('findPublicationName', () => {
  it('asks the factory for the records module, then reads its name record on Base', async () => {
    const calls: ReadCall[] = [];
    const evmRead = makeChainRead({ ...RECORDS_MODULE, name: 'polyphony.soul2soul.eth', calls });

    await expect(findPublicationName(evmRead, SAFE, { moduleFactory: FACTORY })).resolves.toBe(
      'polyphony.soul2soul.eth',
    );

    const ask = calls.find((c) => c.method === 'moduleAddress');
    expect(ask?.chainId).toBe(BASE_CHAIN_ID);
    expect(ask?.contract).toBe(FACTORY);
    expect(ask?.args).toEqual([SAFE, S2S_MODULE_KIND_RECORDS]);
    const record = calls.find((c) => c.method === 'getRecord');
    expect(record?.chainId).toBe(BASE_CHAIN_ID);
    expect(record?.contract).toBe(RECORDS);
    expect(record?.args).toEqual(['name']);
  });

  it('never reads the Safe module list or probes NAME()', async () => {
    const calls: ReadCall[] = [];
    await findPublicationName(makeChainRead({ ...RECORDS_MODULE, calls }), SAFE, {
      moduleFactory: FACTORY,
    });
    expect(calls.map((c) => c.method)).toEqual(['moduleAddress', 'getRecord']);
  });

  it('refuses with NoRecordsModuleError when the factory names no module', async () => {
    const calls: ReadCall[] = [];
    const evmRead = makeChainRead({ module: ZERO_ADDRESS, calls });

    await expect(
      findPublicationName(evmRead, SAFE, { moduleFactory: FACTORY }),
    ).rejects.toBeInstanceOf(NoRecordsModuleError);
    // A refusal is not a search: nothing else is read.
    expect(calls.map((c) => c.method)).toEqual(['moduleAddress']);
  });

  it('refuses before any read when the protocol record names no factory', async () => {
    const calls: ReadCall[] = [];
    await expect(
      findPublicationName(makeChainRead({ ...RECORDS_MODULE, calls }), SAFE, { moduleFactory: '' }),
    ).rejects.toBeInstanceOf(NoRecordsModuleError);
    expect(calls).toHaveLength(0);
  });

  it('returns "" for a publication whose name record is not written yet', async () => {
    const evmRead = makeChainRead({ ...RECORDS_MODULE, name: '' });
    await expect(findPublicationName(evmRead, SAFE, { moduleFactory: FACTORY })).resolves.toBe('');
  });

  it('returns "" when the name read fails, and propagates it when asked', async () => {
    const evmRead = makeChainRead({ ...RECORDS_MODULE, getRecordThrows: true });
    await expect(findPublicationName(evmRead, SAFE, { moduleFactory: FACTORY })).resolves.toBe('');
    await expect(
      findPublicationName(evmRead, SAFE, { moduleFactory: FACTORY, throwOnError: true }),
    ).rejects.toThrow('rpc down');
  });

  it('returns "" without any read for an empty Safe address', async () => {
    const calls: ReadCall[] = [];
    const evmRead = makeChainRead({ ...RECORDS_MODULE, calls });
    await expect(findPublicationName(evmRead, '', { moduleFactory: FACTORY })).resolves.toBe('');
    expect(calls).toHaveLength(0);
  });

  it('returns "" rather than a different name when the expected name is absent', async () => {
    const evmRead = makeChainRead({ ...RECORDS_MODULE, name: 'stale.soul2soul.eth' });
    await expect(
      findPublicationName(evmRead, SAFE, {
        moduleFactory: FACTORY,
        expectedName: 'polyphony.soul2soul.eth',
      }),
    ).resolves.toBe('');
  });

  it('propagates a transport failure of the factory read so the host does not cache it', async () => {
    const evmRead = makeChainRead({ moduleThrows: true });
    // A 429 is not a refusal: without throwOnError it reads as "no name yet",
    // with it the host retries instead of hiding the card for the page load.
    await expect(findPublicationName(evmRead, SAFE, { moduleFactory: FACTORY })).resolves.toBe('');
    await expect(
      findPublicationName(evmRead, SAFE, { moduleFactory: FACTORY, throwOnError: true }),
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

  it('reports a missing records module instead of a registration to make', () => {
    const view = ensStepView(null, BASE_SAFE, { moduleMissing: 'no records module' });
    expect(view.kind).toBe('error');
    expect(view.canPropose).toBe(false);
    expect(view.call).toBeUndefined();
    // The server's own words, not a guessed name.
    expect(view.reason).toBe('no records module');
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
