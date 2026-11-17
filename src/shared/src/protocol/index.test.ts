import { describe, it, expect } from 'vitest';
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  type Abi,
  type Address,
  type Hex,
} from 'viem';

import { getProtocolControllerAndModules, getManifest } from './index';

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
// getManifest — the shipped path: the record decides the prediction
// ============================================================================

describe('getManifest', () => {
  it('resolves the controller’s publication module by prediction, once the record is read', async () => {
    const { client, calls } = makeClients({
      modules: [RECORDS, PUBLICATION],
      names: { [RECORDS]: 'S2S Records Module', [PUBLICATION]: 'S2S Publication Module V3' },
      count: 1n,
      latest: PUBLICATION,
    });

    const info = await getManifest(client, client);

    expect(info.publicationModule).toBe(PUBLICATION);
    expect(info.publicationFactory.toLowerCase()).toBe(FACTORY);
    // The kind model's factory is the same record: one factory, every kind.
    expect(info.moduleFactory.toLowerCase()).toBe(FACTORY);
    // The factory is read from the record, so the prediction cannot come first.
    expect(calls.lastIndexOf('getRecords')).toBeLessThan(calls.indexOf('moduleAddress'));
    // One module list, one records read: the prediction reuses both.
    expect(countCalls(calls, 'getModulesPaginated')).toBe(1);
    expect(countCalls(calls, 'getRecords')).toBe(1);
  });

  it('prefers the prediction over the module the NAME() scan would pick', async () => {
    // Two publication-named modules: the scan keeps the last one it reads,
    // which is not the prediction. Prediction first is only true if A wins.
    const A = AT(3);
    const B = AT(4);
    const { client } = makeClients({
      modules: [RECORDS, A, B],
      names: {
        [RECORDS]: 'S2S Records Module',
        [A]: 'S2S Publication Module V3',
        [B]: 'S2S Publication Module V3',
      },
      count: 1n,
      latest: A,
    });

    const info = await getManifest(client, client);

    expect(info.publicationModule).toBe(A);
  });

  it('falls back to the NAME() scan on a factory that cannot answer', async () => {
    const { client } = makeClients({
      modules: [RECORDS, PUBLICATION],
      names: { [RECORDS]: 'S2S Records Module', [PUBLICATION]: 'S2S Publication Module V2' },
      count: 'revert',
    });

    const info = await getManifest(client, client);

    expect(info.publicationModule).toBe(PUBLICATION);
  });

  it('keeps the scan answer when the prediction names an address the Safe does not enable', async () => {
    const { client } = makeClients({
      modules: [RECORDS, PUBLICATION],
      names: { [RECORDS]: 'S2S Records Module', [PUBLICATION]: 'S2S Publication Module V2' },
      count: 1n,
      latest: AT(7),
    });

    expect((await getManifest(client, client)).publicationModule).toBe(PUBLICATION);
  });

  it('leaves publicationModule undefined when nothing resolves, rather than guessing', async () => {
    const { client } = makeClients({
      modules: [RECORDS],
      names: { [RECORDS]: 'S2S Records Module' },
      count: 'revert',
    });

    expect((await getManifest(client, client)).publicationModule).toBeUndefined();
  });

  it('reads the whole manifest from one document under one key', async () => {
    const { client, calls } = makeClients({
      modules: [RECORDS, PUBLICATION],
      names: { [RECORDS]: 'S2S Records Module', [PUBLICATION]: 'S2S Publication Module V3' },
    });

    const info = await getManifest(client, client);

    expect(info).toEqual({
      version: '0.1.0',
      gateway: 'ipfs.mock',
      ensRegistry: 'ens-registry',
      ensRecords: 'ens-records',
      publicationFactory: FACTORY,
      recordsFactory: 'records-factory',
      moduleFactory: FACTORY,
      publicationModule: PUBLICATION,
      pkp: 'pkp',
      litActions: { prep: 'prep', render: 'render', update: 'update' },
    });
    // One records read for the document, one VERSION() answering compatibility.
    expect(countCalls(calls, 'getRecords')).toBe(1);
    expect(countCalls(calls, 'VERSION')).toBe(1);
  });

  it('carries a newer document on an unchanged VERSION(), differing only past the minor', async () => {
    const { client } = makeClients({
      modules: [RECORDS],
      names: { [RECORDS]: 'S2S Records Module' },
      manifest: manifestDocument({ version: '0.1.4' }),
      version: '0.1',
    });

    expect((await getManifest(client, client)).version).toBe('0.1.4');
  });

  it('rejects a document whose major differs from VERSION(), naming both', async () => {
    const { client } = makeClients({
      modules: [RECORDS],
      names: { [RECORDS]: 'S2S Records Module' },
      manifest: manifestDocument({ version: '1.0.0' }),
      version: '0.1',
    });

    await expect(getManifest(client, client)).rejects.toThrow(/1\.0\.0.*VERSION\(\) 0\.1/);
  });

  it('rejects a document whose minor differs from VERSION(), on the same major', async () => {
    const { client } = makeClients({
      modules: [RECORDS],
      names: { [RECORDS]: 'S2S Records Module' },
      manifest: manifestDocument({ version: '0.2.0' }),
      version: '0.1',
    });

    await expect(getManifest(client, client)).rejects.toThrow(/0\.2\.0.*VERSION\(\) 0\.1/);
  });

  it('throws naming the manifest key when the record was never written', async () => {
    const { client } = makeClients({
      modules: [RECORDS],
      names: { [RECORDS]: 'S2S Records Module' },
      manifest: '',
    });

    await expect(getManifest(client, client)).rejects.toThrow(/'manifest'/);
  });

  it('throws naming the manifest key when the record is not JSON, with no fallback', async () => {
    const { client, calls } = makeClients({
      modules: [RECORDS, PUBLICATION],
      names: { [RECORDS]: 'S2S Records Module', [PUBLICATION]: 'S2S Publication Module V3' },
      manifest: 'data_gateway=ipfs.mock',
    });

    await expect(getManifest(client, client)).rejects.toThrow(/'manifest'/);
    // The flat keys are gone: nothing is read past the document.
    expect(countCalls(calls, 'getRecords')).toBe(1);
    expect(calls).not.toContain('moduleAddress');
  });
});
