import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  SOUL2SOUL_SUFFIX,
  buildRegisterSubdomainCall,
  computeSubnode,
  readEnsRegistration,
  type EnsRegistrationDeps,
} from '../../src/lib/ens-registration';
import {
  ENS_L1_CHAIN_ID,
  ENS_REGISTRY_ADDRESS,
  ZERO_ADDRESS,
  type EvmReadFn,
} from '../../src/lib/domain-validation';

// The real L1 registry is the default; the tests inject a distinct one where
// the "caller-supplied registry wins" behaviour is under test.
const REGISTRY = '0x9aB0B1629fc094B1142F9fe9456cdc34A130c4e5';
const CUSTOM_REGISTRY = '0x1111111111111111111111111111111111111111';
const NAMEWRAPPER = '0x00000000000000000000000000000000000000aa';
const ZERO = ZERO_ADDRESS;

const PARENT_NODE = ethers.namehash('soul2soul.eth');
const SAFE = '0x79dedb19353F7909CDc68504839EF88a7498aaf2';
const SAFE_LOWER = SAFE.toLowerCase();
const OTHER_OWNER = '0x000000000000000000000000000000000000dEaD';

interface ReadRecord {
  chainId: number;
  contract: string;
  method: string;
  args: any[];
}

interface MockState {
  /** registry.registeredSubdomains(label) */
  registered?: boolean;
  /** NameWrapper.ownerOf(node) return value */
  owner?: string;
  /** ownerOf reverts (the unwrapped/absent-subnode case) */
  ownerThrows?: boolean;
  /** registry.nameWrapper() return value */
  nameWrapper?: string;
  /** registry.parentNode() */
  parentNode?: string;
}

/**
 * Injected-chain stand-in: answers the three registry reads + the NameWrapper
 * ownerOf, records every call so the test can assert where the reads went.
 */
function makeDeps(
  state: MockState = {},
  record: ReadRecord[] = [],
): EnsRegistrationDeps & { record: ReadRecord[] } {
  const evmRead: EvmReadFn = async (chainId, contractAddress, _abi, method, args) => {
    record.push({ chainId, contract: String(contractAddress).toLowerCase(), method, args });
    switch (method) {
      case 'parentNode':
        return state.parentNode ?? PARENT_NODE;
      case 'nameWrapper':
        return state.nameWrapper ?? NAMEWRAPPER;
      case 'registeredSubdomains':
        return state.registered ?? false;
      case 'ownerOf':
        if (state.ownerThrows) throw new Error('ERC721: invalid token ID');
        return state.owner ?? ZERO;
      default:
        throw new Error(`unexpected call ${method}`);
    }
  };
  return { evmRead, record };
}

describe('readEnsRegistration', () => {
  it('reports a subnode already registered to the publication Safe', async () => {
    const deps = makeDeps({ registered: true, owner: SAFE });
    const state = await readEnsRegistration(deps, { label: 'polyphony', safeAddress: SAFE });

    expect(state.label).toBe('polyphony');
    expect(state.name).toBe('polyphony.soul2soul.eth');
    expect(state.name.endsWith(`.${SOUL2SOUL_SUFFIX}`)).toBe(true);
    expect(state.registry).toBe(REGISTRY);
    expect(state.registry).toBe(ENS_REGISTRY_ADDRESS);
    // The subnode is exactly namehash('polyphony.soul2soul.eth').
    expect(state.node).toBe(ethers.namehash('polyphony.soul2soul.eth'));
    expect(state.node).toMatch(/^0x[0-9a-f]{64}$/);
    expect(state.nameWrapper).toBe(NAMEWRAPPER);
    expect(state.owner).toBe(SAFE_LOWER);
    expect(state.registered).toBe(true);
    expect(state.ownedBySafe).toBe(true);
    expect(state.needsRegistration).toBe(false);
    expect(state.desynced).toBe(false);
  });

  it('compares the owner with the Safe case-insensitively', async () => {
    const deps = makeDeps({ registered: true, owner: SAFE_LOWER });
    const state = await readEnsRegistration(deps, { label: 'polyphony', safeAddress: SAFE });
    expect(state.ownedBySafe).toBe(true);
  });

  it('reports a subnode registered to someone else', async () => {
    const deps = makeDeps({ registered: true, owner: OTHER_OWNER });
    const state = await readEnsRegistration(deps, { label: 'polyphony', safeAddress: SAFE });

    expect(state.registered).toBe(true);
    expect(state.owner).toBe(OTHER_OWNER.toLowerCase());
    expect(state.ownedBySafe).toBe(false);
    expect(state.needsRegistration).toBe(false);
    expect(state.desynced).toBe(false);
  });

  it('reports an unregistered subnode as needing registration', async () => {
    const deps = makeDeps({ registered: false, owner: ZERO });
    const state = await readEnsRegistration(deps, { label: 'polyphony', safeAddress: SAFE });

    expect(state.registered).toBe(false);
    expect(state.owner).toBe(ZERO);
    expect(state.ownedBySafe).toBe(false);
    expect(state.needsRegistration).toBe(true);
    expect(state.desynced).toBe(false);
    // Both zero reads were actually made, against the registry and the wrapper.
    const methods = deps.record.map((r) => r.method);
    expect(methods).toContain('registeredSubdomains');
    expect(methods).toContain('ownerOf');
  });

  it('flags a desynced registry: registeredSubdomains true but no subnode owner', async () => {
    const deps = makeDeps({ registered: true, owner: ZERO });
    const state = await readEnsRegistration(deps, { label: 'polyphony', safeAddress: SAFE });

    expect(state.registered).toBe(true);
    expect(state.owner).toBe(ZERO);
    expect(state.needsRegistration).toBe(false);
    expect(state.desynced).toBe(true);
  });

  it('treats a reverting ownerOf as "no owner" instead of failing the read', async () => {
    const unregistered = await readEnsRegistration(
      makeDeps({ registered: false, ownerThrows: true }),
      { label: 'polyphony', safeAddress: SAFE },
    );
    expect(unregistered.owner).toBe(ZERO);
    expect(unregistered.needsRegistration).toBe(true);
    expect(unregistered.desynced).toBe(false);

    const desynced = await readEnsRegistration(makeDeps({ registered: true, ownerThrows: true }), {
      label: 'polyphony',
      safeAddress: SAFE,
    });
    expect(desynced.owner).toBe(ZERO);
    expect(desynced.desynced).toBe(true);
  });

  it('prefers a caller-supplied registry over the default', async () => {
    const deps = makeDeps({ registered: false });
    const state = await readEnsRegistration(deps, {
      registry: CUSTOM_REGISTRY,
      label: 'polyphony',
      safeAddress: SAFE,
    });

    expect(state.registry).toBe(CUSTOM_REGISTRY);
    const registryReads = deps.record.filter((r) => r.method !== 'ownerOf');
    expect(registryReads.length).toBeGreaterThan(0);
    for (const read of registryReads) {
      expect(read.contract).toBe(CUSTOM_REGISTRY);
    }
  });

  it('reads the L1 registry and NameWrapper on chain 1 only', async () => {
    const deps = makeDeps({ registered: true, owner: SAFE });
    await readEnsRegistration(deps, { label: 'polyphony', safeAddress: SAFE });

    expect(deps.record.length).toBe(4);
    for (const read of deps.record) {
      expect(read.chainId).toBe(ENS_L1_CHAIN_ID);
    }
    const ownerCall = deps.record.find((r) => r.method === 'ownerOf')!;
    expect(ownerCall.contract).toBe(NAMEWRAPPER);
    expect(ownerCall.args).toEqual([ethers.namehash('polyphony.soul2soul.eth')]);
    const registeredCall = deps.record.find((r) => r.method === 'registeredSubdomains')!;
    expect(registeredCall.args).toEqual(['polyphony']);
  });

  it('computes the subnode from the registry parentNode, not a constant', async () => {
    const otherParent = ethers.namehash('example.eth');
    const deps = makeDeps({ parentNode: otherParent, registered: true, owner: SAFE });
    const state = await readEnsRegistration(deps, { label: 'polyphony', safeAddress: SAFE });

    expect(state.node).toBe(ethers.namehash('polyphony.example.eth'));
    expect(state.node).toBe(computeSubnode(otherParent, 'polyphony'));
  });
});

describe('computeSubnode', () => {
  it('matches ethers.namehash for a subnode of the parent', () => {
    expect(computeSubnode(ethers.namehash('soul2soul.eth'), 'polyphony')).toBe(
      ethers.namehash('polyphony.soul2soul.eth'),
    );
  });
});

describe('buildRegisterSubdomainCall', () => {
  const REGISTER_ABI = ['function registerSubdomain(string label, address owner)'];

  it('targets the registry with a zero value', () => {
    const call = buildRegisterSubdomainCall(REGISTRY, 'polyphony', SAFE);
    expect(call.to).toBe(REGISTRY);
    expect(call.value).toBe('0');
    expect(call.data.startsWith('0x')).toBe(true);
  });

  it('uses the registerSubdomain(string,address) selector', () => {
    const call = buildRegisterSubdomainCall(REGISTRY, 'polyphony', SAFE);
    const selector = ethers.dataSlice(ethers.id('registerSubdomain(string,address)'), 0, 4);
    expect(ethers.dataSlice(call.data, 0, 4)).toBe(selector);
  });

  it('round-trips to (label, owner)', () => {
    const call = buildRegisterSubdomainCall(REGISTRY, 'polyphony', SAFE);
    const iface = new ethers.Interface(REGISTER_ABI);
    const [label, owner] = iface.decodeFunctionData('registerSubdomain', call.data);
    expect(label).toBe('polyphony');
    expect(ethers.getAddress(String(owner))).toBe(ethers.getAddress(SAFE));
  });
});
