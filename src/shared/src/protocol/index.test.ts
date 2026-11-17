import { describe, it, expect, vi } from 'vitest';
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  type Abi,
  type Address,
  type Hex,
} from 'viem';

import {
  getProtocolControllerAndModules,
  getManifest,
  MANIFEST_MODULE_ADDRESS,
  type ViemProvider,
} from './index';

// The controller's module lookup runs through viem contract instances, so the
// fake is a transport: `eth_call` in, ABI-encoded `eth_call` out. What the test
// watches is which selectors are asked, in which order — the CREATE2 prediction
// must be one call to the factory, and the fallback must survive an absent one.

const CONTROLLER = '0x' + 'cc'.repeat(20);
const FACTORY = '0x' + 'ff'.repeat(20);
const AT = (n: number) => ('0x' + String(n).repeat(40)) as Address;

const RECORDS = AT(1);
const PUBLICATION = AT(2);
const OTHER = AT(9);

const ABI = [
  {
    inputs: [{ internalType: 'uint256', name: 'id', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'parentDomainController',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'start', type: 'address' },
      { internalType: 'uint256', name: 'pageSize', type: 'uint256' },
    ],
    name: 'getModulesPaginated',
    outputs: [
      { internalType: 'address[]', name: 'array', type: 'address[]' },
      { internalType: 'address', name: 'next', type: 'address' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'NAME',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'implementationCount',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'safe', type: 'address' }],
    name: 'moduleAddress',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'safe', type: 'address' },
      { internalType: 'uint256', name: 'version', type: 'uint256' },
    ],
    name: 'moduleAddressForVersion',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'string[]', name: 'keys', type: 'string[]' }],
    name: 'getRecords',
    outputs: [{ internalType: 'string[]', name: 'values', type: 'string[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'VERSION',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const satisfies Abi;

interface ChainOptions {
  modules: Address[];
  /** module → NAME(); absent means the module has no NAME() and reverts */
  names: Record<string, string>;
  /** `implementationCount()`; `'revert'` is a V2-generation factory */
  count?: bigint | 'revert';
  /** `moduleAddress(safe)` */
  latest?: Address;
  /** version (as a string) → predicted address */
  predictions?: Record<string, Address>;
  /** The `manifest` record's value; `undefined` means the key was never written */
  manifest?: string;
  /** `VERSION()`; the on-chain contract's own version, the manifest's major.minor */
  version?: string;
}

/**
 * The `manifest` document as the other worker writes it: one JSON value under
 * the record key `manifest`, camelCase, optional action CIDs absent when the
 * action was never written.
 */
const manifestDocument = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: '0.1.0',
    gateway: 'ipfs.mock',
    ensRegistry: 'ens-registry',
    ensRecords: 'ens-records',
    publicationFactory: FACTORY,
    recordsFactory: 'records-factory',
    pkp: 'pkp',
    litActions: { prep: 'prep', render: 'render', update: 'update' },
    ...overrides,
  });

/**
 * The controller's records, as `getManifest` reads them: one document under the
 * single key `manifest`. Only one field matters to a module lookup —
 * `publicationFactory`, the address the prediction is read from.
 */
const RECORD_VALUES = [manifestDocument()];

/**
 * An answer that is not an answer: the transport returns empty data, which
 * `readContract` fails to decode — the same revert a selector the factory does
 * not have produces. (Throwing from the transport instead costs viem a
 * second-long error path per call, which would dominate the suite.)
 */
const REVERT = Symbol('revert');

function makeClients(options: ChainOptions) {
  const calls: string[] = [];

  const answer = (to: string, functionName: string, args: readonly unknown[]): unknown => {
    if (functionName === 'ownerOf') return CONTROLLER;
    if (functionName === 'parentDomainController') return CONTROLLER;
    if (functionName === 'getModulesPaginated') {
      return [options.modules, '0x0000000000000000000000000000000000000001'];
    }
    if (functionName === 'NAME') {
      const name = options.names[to];
      return name === undefined ? REVERT : name;
    }
    if (functionName === 'implementationCount') {
      return options.count === 'revert' ? REVERT : (options.count ?? 0n);
    }
    if (functionName === 'moduleAddress') {
      return options.latest ?? REVERT;
    }
    if (functionName === 'moduleAddressForVersion') {
      return options.predictions?.[String(args[1])] ?? REVERT;
    }
    if (functionName === 'getRecords') return [options.manifest ?? RECORD_VALUES[0]];
    if (functionName === 'VERSION') return options.version ?? '0.1';
    throw new Error(`unexpected call ${functionName}`);
  };

  const request = async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
    // Nothing here predicts an undeployed address with code, so no module is
    // ever found by its bytecode.
    if (method === 'eth_getCode') return '0x';
    if (method !== 'eth_call') throw new Error(`unexpected method ${method}`);
    const [{ to, data }] = params as [{ to: string; data: Hex }];
    const decoded = decodeFunctionData({ abi: ABI, data });
    const functionName = decoded.functionName as string;
    calls.push(argsSignature(functionName, decoded.args as readonly unknown[]));

    const result = answer(to.toLowerCase(), functionName, (decoded.args ?? []) as readonly unknown[]);
    if (result === REVERT) return '0x';
    return encodeFunctionResult({ abi: ABI, functionName, result } as any);
  };

  const client = createPublicClient({ transport: custom({ request }) }) as any;
  return { client, calls };
}

function argsSignature(functionName: string, args: readonly unknown[]): string {
  return functionName === 'moduleAddressForVersion'
    ? `${functionName}:${String(args[1])}`
    : functionName;
}

const countCalls = (calls: string[], name: string) =>
  calls.filter((call) => call === name || call.startsWith(`${name}:`)).length;

describe('getProtocolControllerAndModules', () => {
  it('resolves the modules by NAME(), with no factory read at all', async () => {
    const { client, calls } = makeClients({
      modules: [RECORDS, PUBLICATION, OTHER],
      names: {
        [RECORDS]: 'S2S Records Module',
        [PUBLICATION]: 'S2S Publication Module V2',
        [OTHER]: 'Not A Module',
      },
    });

    const resolved = await getProtocolControllerAndModules(false, client, client);

    expect(resolved.multisig.toLowerCase()).toBe(CONTROLLER);
    expect(resolved.configModule).toBe(RECORDS);
    expect(resolved.publicationModule).toBe(PUBLICATION);
    // Scan-only: the factory is a record this function has not read yet.
    expect(calls).not.toContain('moduleAddress');
    expect(calls).not.toContain('implementationCount');
  });

  it('returns the enabled-module list it read, for the caller’s prediction', async () => {
    const { client, calls } = makeClients({ modules: [RECORDS, PUBLICATION], names: {} });

    const resolved = await getProtocolControllerAndModules(false, client, client);

    expect(resolved.modules).toEqual([RECORDS, PUBLICATION]);
    // One list, not two: the caller reuses what this read.
    expect(countCalls(calls, 'getModulesPaginated')).toBe(1);
  });
});

// ============================================================================
// getManifest — one call on the manifest module, no publication in the read
// ============================================================================

describe('getManifest', () => {
  /** A provider whose only job is to answer the manifest module's calls. */
  const makeReader = (current: string, { version = '0.1.0', revert = false } = {}) => {
    const readContract = vi.fn(async (args: any) => {
      if (revert) throw new Error('execution reverted: NoManifest()');
      if (args.aborted) throw new Error('aborted');
      if (args.args && args.args.length) return current;
      return [version, current] as const;
    });

    return { provider: { readContract } as unknown as ViemProvider, readContract };
  };

  it('reads the current document with one call on the module constant', async () => {
    const { provider, readContract } = makeReader(manifestDocument());

    const info = await getManifest(provider, provider);

    expect(info).toEqual({
      version: '0.1.0',
      gateway: 'ipfs.mock',
      ensRegistry: 'ens-registry',
      ensRecords: 'ens-records',
      publicationFactory: FACTORY,
      recordsFactory: 'records-factory',
      moduleFactory: FACTORY,
      pkp: 'pkp',
      litActions: { prep: 'prep', render: 'render', update: 'update' },
    });
    expect(readContract).toHaveBeenCalledTimes(1);
    expect(readContract.mock.calls[0][0].address).toBe(MANIFEST_MODULE_ADDRESS);
    expect(readContract.mock.calls[0][0].args).toEqual([]);
  });

  it('names no publication: the bootstrap read cannot depend on one', async () => {
    const { provider } = makeReader(manifestDocument());
    expect((await getManifest(provider, provider)).publicationModule).toBeUndefined();
  });

  it('reads a named version, and reports the document\'s own version', async () => {
    const { provider, readContract } = makeReader(
      manifestDocument({ version: '0.1.4' }),
    );

    const info = await getManifest(provider, provider, '0.1.4');

    expect(info.version).toBe('0.1.4');
    expect(readContract.mock.calls[0][0].args).toEqual(['0.1.4']);
  });

  it('omits action CIDs the document omits, rather than answering undefined strings', async () => {
    const { provider } = makeReader(
      manifestDocument({
        litActions: { prep: 'p', render: 'r', update: 'u', encrypt: 'e' },
      }),
    );

    const info = await getManifest(provider, provider);

    expect(info.litActions.encrypt).toBe('e');
    expect(info.litActions.decrypt).toBeUndefined();
    expect('decrypt' in info.litActions).toBe(true);
  });

  it('rejects a versioned read whose document names another version', async () => {
    const { provider } = makeReader(manifestDocument({ version: '0.1.0' }));

    await expect(getManifest(provider, provider, '0.1.4')).rejects.toThrow(
      /0\.1\.4 carries document version 0\.1\.0/,
    );
  });

  it('rejects an index and a document that disagree', async () => {
    const { provider } = makeReader(manifestDocument({ version: '0.1.0' }), {
      version: '0.1.1',
    });

    await expect(getManifest(provider, provider)).rejects.toThrow(
      /0\.1\.1 carries document version 0\.1\.0/,
    );
  });

  it('throws naming the module when the module answers no manifest', async () => {
    const { provider } = makeReader('', { revert: true });

    await expect(getManifest(provider, provider)).rejects.toThrow(
      new RegExp(`cannot read the current version on ${MANIFEST_MODULE_ADDRESS}`),
    );
  });

  it('throws naming the version asked for when that version is not published', async () => {
    const { provider } = makeReader('', { revert: true });

    await expect(getManifest(provider, provider, '0.1.4')).rejects.toThrow(
      /cannot read version 0\.1\.4/,
    );
  });

  it('throws on a document that is not JSON, with no fallback', async () => {
    const { provider } = makeReader('data_gateway=ipfs.mock');

    await expect(getManifest(provider, provider)).rejects.toThrow(/0\.1\.0 is not valid JSON/);
  });

  it('throws on a document with a missing field, naming the version', async () => {
    const { provider } = makeReader(manifestDocument({ gateway: undefined }));

    await expect(getManifest(provider, provider)).rejects.toThrow(
      /0\.1\.0 does not have the document's shape/,
    );
  });
});
