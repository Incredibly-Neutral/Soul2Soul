import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TxRunner } from './tx-runner';
import { newPublicationSafe, verifyModulesEnabled, setRecordsWithRetry, buildNewPublicationDeps } from './new';
import type { S2SPublication } from './types';

// =============================================================================
// Global fetch mock — builders talk to GitHub API + raw.githubusercontent.com.
// Stubbed here so tests don't need network.
// =============================================================================

function makeFetchMock() {
  return vi.fn((url: string) => {
    // GitHub API: /repos/*/contents/* → empty array (no files to process)
    if (url.includes('api.github.com/repos')) {
      if (url.includes('/commits/')) {
        return Promise.resolve(
          new Response(JSON.stringify({ sha: 'mock-commit-sha' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      // Contents API
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    // raw.githubusercontent.com → minimal valid JSON for mapping.json
    if (url.includes('raw.githubusercontent.com')) {
      if (url.includes('mapping.json')) {
        return Promise.resolve(
          new Response(JSON.stringify({ templateConfig: [], ripples: [] }), {
            status: 200,
          }),
        );
      }
      // Any other raw file (templates, etc.)
      return Promise.resolve(new Response('', { status: 200 }));
    }
    // Filebase upload (was Pinata — eth.link recommends Filebase)
    if (url.includes('rpc.filebase.io')) {
      return Promise.resolve(
        new Response(JSON.stringify({ Hash: 'mock-filebase-hash' }), {
          status: 200,
        }),
      );
    }
    // Kubo IPFS node — return success for any POST
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
}

// =============================================================================
// Test fixtures
// =============================================================================

const RECORDS_MODULE_ADDR = '0xe3747b7b346c04376151d2b7d4fa765cda1a12c7';
const PUBLICATION_MODULE_ADDR = '0xd4a8c9b7e1234567890abcdef1234567890abcd';
const PUBLICATION_ADDR_L1 = '0x1111111111111111111111111111111111111111';
const PUBLICATION_ADDR_L2 = '0x2222222222222222222222222222222222222222';
const SIGNER_ADDR = '0x3333333333333333333333333333333333333333';
const FEED_ADDR = '0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed';

function makePublication(overrides: Partial<S2SPublication> = {}): S2SPublication {
  return {
    name: 'testpub.soul2soul.eth',
    owners: [],
    authors: ['0xauthor1'],
    devRepository: 'github.com/user/repo',
    branch: 'main',
    ...overrides,
  };
}

/**
 * Mock TxRunner for L1 — only handles ENS registration + owner ops.
 */
function makeL1Runner(): TxRunner {
  return {
    updateSigner: vi.fn().mockResolvedValue(SIGNER_ADDR),
    connectToFreshSafe: vi.fn().mockResolvedValue(PUBLICATION_ADDR_L1),
    connectToExistingSafe: vi.fn().mockResolvedValue(undefined),
    // genericRead returns true for isOwner/isModuleEnabled;
    // for getOwners we'll override per-test where needed.
    genericRead: vi.fn().mockResolvedValue(true),
    // L1 only does ENS registration
    genericTx: vi.fn().mockResolvedValue('0xens_tx'),
    batchGenericTx: vi.fn().mockResolvedValue(['0xhash1', '0xhash2']),
  };
}

/**
 * Mock TxRunner for L2 — handles the full module creation + records pipeline.
 * Uses mockResolvedValueOnce for sequenced returns.
 */
function makeL2Runner(): TxRunner {
  return {
    updateSigner: vi.fn().mockResolvedValue(SIGNER_ADDR),
    connectToFreshSafe: vi.fn().mockResolvedValue(PUBLICATION_ADDR_L2),
    connectToExistingSafe: vi.fn().mockResolvedValue(undefined),
    genericRead: vi.fn().mockResolvedValue(true),
    genericTx: vi
      .fn()
      // 1st: records createModule
      .mockResolvedValueOnce(RECORDS_MODULE_ADDR)
      // 2nd: publication createModule
      .mockResolvedValueOnce(PUBLICATION_MODULE_ADDR)
      // remaining (setRecords etc.): just a hash
      .mockResolvedValue('0xsetRecords_ok'),
    batchGenericTx: vi.fn().mockResolvedValue(['0xhash1', '0xhash2']),
  };
}

function makeMockIPFS(): any {
  return {
    gateway: 'ipfs.mock',
    fetchFromKubo: vi.fn().mockResolvedValue({}),
    dagGet: vi.fn().mockResolvedValue({ Links: [] }),
    addToKubo: vi.fn().mockResolvedValue('mock-kubo-cid'),
    dagPut: vi.fn().mockResolvedValue('mock-dag-cid'),
    uploadToPinata: vi.fn().mockResolvedValue('mock-filebase-cid'),
    pinCidRemote: vi.fn().mockResolvedValue(true),
    prepareTempMfs: vi.fn().mockResolvedValue('/tmp/mock'),
    kuboPost: vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({}),
      text: () => '',
    }),
    mfsCp: vi.fn().mockResolvedValue(true),
    mfsFlush: vi.fn().mockResolvedValue({ ok: true, cid: 'mock-flush-cid' }),
    mfsStat: vi.fn().mockResolvedValue('mock-stat-cid'),
    mfsList: vi.fn().mockResolvedValue([]),
  };
}

/**
 * Build deps with separate L1/L2 runners.
 * Pass `owners` to set up mock getOwners/isOwner responses for the owners path.
 */
function makeDeps(
  opts: {
    owners?: string[];
    overrides?: Record<string, unknown>;
  } = {},
) {
  const { owners, overrides = {} } = opts;
  const l1 = makeL1Runner();
  const l2 = makeL2Runner();

  // If owners are present, wire genericRead to support getOwners + isOwner
  if (owners && owners.length > 0) {
    (l1.genericRead as any).mockImplementation(
      (_addr: string, _abi: string, method: string, args: any[]) => {
        if (method === 'getOwners') return [SIGNER_ADDR, ...owners];
        if (method === 'isOwner') return true;
        return true;
      },
    );
    (l2.genericRead as any).mockImplementation(
      (_addr: string, _abi: string, method: string, args: any[]) => {
        if (method === 'getOwners') return [SIGNER_ADDR, ...owners];
        if (method === 'isOwner') return true;
        return true;
      },
    );
  }

  return {
    l1,
    l2,
    privateKey: '0xdeadbeef',
    protocolInfo: {
      gateway: 'ipfs.mock',
      ensRegistry: '0xensRegistry0000000000000000000000000001',
      ensRecords: '0xmockEnsRecords',
      publicationFactory: '0xpubFactory0000000000000000000000000001',
      recordsFactory: '0xrecordsFactory000000000000000000000001',
      pkp: '0xmockPkp',
      litActions: { prep: 'mock-prep', render: 'mock-render', update: 'mock-update' },
    },
    recordsModuleFactoryAbi: [{ type: 'constructor' }],
    publicationModuleFactoryAbi: [{ type: 'constructor' }],
    recordsModuleAbi: [{ type: 'function', name: 'setRecords' }],
    ipfs: makeMockIPFS(),
    githubToken: 'mock-github-token',
    ensRecordsAddress: '0xmockEnsRecords',
    createFeed: vi.fn().mockResolvedValue(FEED_ADDR),
    ...overrides,
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Run the full newPublicationSafe with default mocks.
 * Advances fake timers to skip verifyModulesEnabled delays.
 */
async function runNew(publication?: S2SPublication, opts?: Parameters<typeof makeDeps>[0]) {
  const pub = publication ?? makePublication();
  const deps = makeDeps(opts);
  const promise = newPublicationSafe(deps, pub);
  await vi.runAllTimersAsync();
  await promise;
  return { deps, pub };
}

// =============================================================================
// Tests
// =============================================================================

describe('newPublicationSafe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', makeFetchMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // 1. Regression: recordsModule destructure bug
  // ---------------------------------------------------------------------------
  it('passes the FULL recordsModule address to enableModule (regression for destructure bug)', async () => {
    const { deps } = await runNew();

    const [[batchCalls]] = (deps.l2.batchGenericTx as any).mock.calls;
    expect(batchCalls).toHaveLength(2);
    expect(batchCalls[0].args).toEqual([RECORDS_MODULE_ADDR]);
    expect(batchCalls[1].args).toEqual([PUBLICATION_MODULE_ADDR]);

    // Sanity: the address should NOT be "0" or a single char
    expect(batchCalls[0].args[0]).toBe(RECORDS_MODULE_ADDR);
    expect(batchCalls[0].args[0].length).toBe(42); // "0x" + 40 hex chars
  });

  // ---------------------------------------------------------------------------
  // 2. Ordering
  // ---------------------------------------------------------------------------
  it('runs ENS registration + records createModule before publication createModule, with connectToExistingSafe between them', async () => {
    const { deps } = await runNew();

    const connectL1Order = (deps.l1.connectToExistingSafe as any).mock.invocationCallOrder[0];
    const connectL2Order = (deps.l2.connectToExistingSafe as any).mock.invocationCallOrder[0];

    // publication createModule is the 2nd genericTx on L2
    const l2Orders = (deps.l2.genericTx as any).mock.invocationCallOrder;
    const pubModuleCreateOrder = l2Orders[1]; // 0=records, 1=publication

    expect(connectL1Order).toBeLessThan(pubModuleCreateOrder);
    expect(connectL2Order).toBeLessThan(pubModuleCreateOrder);

    // ENS registration fired on L1
    const l1Calls = (deps.l1.genericTx as any).mock.calls;
    expect(l1Calls).toHaveLength(1);
    expect(l1Calls[0][2]).toBe('registerSubdomain');
  });

  // ---------------------------------------------------------------------------
  // 3. Data flow
  // ---------------------------------------------------------------------------
  it('calls setRecords with the records module address and enables both modules', async () => {
    const { deps } = await runNew();

    // setRecordsWithRetry calls genericTx on L2 with recordsModule address
    const l2Calls = (deps.l2.genericTx as any).mock.calls;
    const setRecordsCall = l2Calls.find(
      ([_addr, _abi, method]: [string, string, string]) => method === 'setRecords',
    );
    expect(setRecordsCall).toBeDefined();
    expect(setRecordsCall![0]).toBe(RECORDS_MODULE_ADDR);

    // enableModule batch has exactly 2 entries with correct module addresses
    const [[batchCalls]] = (deps.l2.batchGenericTx as any).mock.calls;
    expect(batchCalls).toHaveLength(2);
    expect(batchCalls[0]).toMatchObject({
      method: 'enableModule',
      args: [RECORDS_MODULE_ADDR],
    });
    expect(batchCalls[1]).toMatchObject({
      method: 'enableModule',
      args: [PUBLICATION_MODULE_ADDR],
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Owners branch
  // ---------------------------------------------------------------------------
  it('skips addOwner/removeOwner when owners array is empty', async () => {
    const { deps } = await runNew(makePublication({ owners: [] }));

    const allL1Calls = (deps.l1.batchGenericTx as any).mock.calls.flat(2) as any[];
    const allL2Calls = (deps.l2.batchGenericTx as any).mock.calls.flat(2) as any[];

    const hasAddOwner = [...allL1Calls, ...allL2Calls].some(
      (c: any) => c?.method === 'addOwnerWithThreshold',
    );
    expect(hasAddOwner).toBe(false);
  });

  it('builds addOwnerWithThreshold batch with [owner, 1] per owner on both chains', async () => {
    const owners = [
      '0xownerA0000000000000000000000000000000001',
      '0xownerB0000000000000000000000000000000002',
    ];
    const { deps } = await runNew(makePublication({ owners }), { owners });

    // Find the batchGenericTx call that contains addOwnerWithThreshold calls
    const findAddOwnerBatch = (mock: any) =>
      mock.mock.calls.find(([batch]: any[]) =>
        batch.some((c: any) => c.method === 'addOwnerWithThreshold'),
      );

    const l1Batch = findAddOwnerBatch(deps.l1.batchGenericTx);
    const l2Batch = findAddOwnerBatch(deps.l2.batchGenericTx);

    expect(l1Batch).toBeDefined();
    expect(l2Batch).toBeDefined();

    // Each batch should have one addOwnerWithThreshold per owner
    expect(l1Batch![0]).toHaveLength(2);
    expect(l1Batch![0][0].args).toEqual([owners[0], 1]);
    expect(l1Batch![0][1].args).toEqual([owners[1], 1]);
  });

  // ---------------------------------------------------------------------------
  // 5. Retry logic
  // ---------------------------------------------------------------------------
  it('setRecordsWithRetry retries up to 3 times then rethrows', async () => {
    const runner = makeL2Runner();
    (runner.genericTx as any).mockReset();
    (runner.genericTx as any)
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockRejectedValueOnce(new Error('fail 3'));

    const pub = makePublication();
    pub.configCid = 'test-cid';
    pub.feed = FEED_ADDR;

    // Use try/catch to avoid unhandled rejection noise in fake-timer tests
    let caught: Error | undefined;
    const promise = setRecordsWithRetry(runner, RECORDS_MODULE_ADDR, [], pub).catch((e) => {
      caught = e as Error;
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(caught).toBeDefined();
    expect(caught!.message).toBe('fail 3');
    expect(runner.genericTx).toHaveBeenCalledTimes(3);
  });

  it('verifyModulesEnabled polls until isModuleEnabled returns true', async () => {
    const runner = makeL2Runner();
    (runner.genericRead as any).mockReset();
    (runner.genericRead as any)
      // first module: false, false, true
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      // second module: false, true
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const promise = verifyModulesEnabled(
      runner,
      'test.soul2soul.eth',
      PUBLICATION_ADDR_L2,
      RECORDS_MODULE_ADDR,
      PUBLICATION_MODULE_ADDR,
    );
    await vi.runAllTimersAsync();
    await promise;

    const isEnabledCalls = (runner.genericRead as any).mock.calls.filter(
      ([_addr, _abi, method]: [string, string, string]) => method === 'isModuleEnabled',
    );
    // 3 calls for first module + 2 for second = 5
    expect(isEnabledCalls.length).toBe(5);
  });

  it('setRecordsWithRetry succeeds on first try', async () => {
    const runner = makeL2Runner();
    (runner.genericTx as any).mockReset().mockResolvedValue('0xok');

    const pub = makePublication();
    pub.configCid = 'test-cid';
    pub.feed = FEED_ADDR;

    const promise = setRecordsWithRetry(runner, RECORDS_MODULE_ADDR, [], pub);
    await vi.runAllTimersAsync();
    await promise;

    expect(runner.genericTx).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // 6. Adapter shape contract — ensures TxCall objects match what
  //    PermissionlessSafeService actually receives through the adapter.
  // ---------------------------------------------------------------------------
  it('enableModule TxCall has deploy:false and addOwner TxCall omits deploy', async () => {
    const owners = ['0xownerA0000000000000000000000000000000001'];
    const { deps } = await runNew(makePublication({ owners }), { owners });

    // Extract all TxCall objects passed to L2.batchGenericTx
    const allL2Batches = (deps.l2.batchGenericTx as any).mock.calls.map(([batch]: any[]) => batch);
    const allCalls: any[] = allL2Batches.flat();

    // enableModule calls must have deploy: false explicitly
    const enableCalls = allCalls.filter((c: any) => c.method === 'enableModule');
    expect(enableCalls).toHaveLength(2);
    for (const call of enableCalls) {
      expect(call).toHaveProperty('deploy', false);
      expect(call.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(typeof call.abi).toBe('string');
    }

    // addOwnerWithThreshold calls must NOT have deploy at all
    const addOwnerCalls = allCalls.filter((c: any) => c.method === 'addOwnerWithThreshold');
    expect(addOwnerCalls.length).toBeGreaterThan(0);
    for (const call of addOwnerCalls) {
      // deploy must be absent, not false — matches the original production
      // code which never includes a deploy key in addOwner calls.
      expect(call).not.toHaveProperty('deploy');
      expect(call.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(typeof call.abi).toBe('string');
      expect(call.args).toHaveLength(2);
    }
  });

  it('genericTx calls pass 0x-prefixed addresses and stringified ABIs', async () => {
    const { deps } = await runNew();

    // L1 genericTx: registerSubdomain
    const l1Calls = (deps.l1.genericTx as any).mock.calls;
    expect(l1Calls).toHaveLength(1);
    const [ensAddr, ensAbi, ensMethod, ensArgs, ensDeploy] = l1Calls[0];
    expect(ensAddr).toMatch(/^0x/);
    expect(typeof ensAbi).toBe('string');
    expect(JSON.parse(ensAbi)).toBeTruthy(); // valid JSON
    expect(ensMethod).toBe('registerSubdomain');
    expect(ensDeploy).toBe(false);

    // L2 genericTx #1: createModule (records factory)
    const l2Calls = (deps.l2.genericTx as any).mock.calls;
    const createRecords = l2Calls[0];
    expect(createRecords[0]).toMatch(/^0x/); // factory address
    expect(typeof createRecords[1]).toBe('string'); // stringified ABI
    expect(createRecords[2]).toBe('createModule');
    expect(createRecords[4]).toBe(true); // deploy

    // L2 genericTx #2: createModule (publication factory)
    const createPub = l2Calls[1];
    expect(createPub[0]).toMatch(/^0x/);
    expect(createPub[2]).toBe('createModule');
    expect(createPub[4]).toBe(true); // deploy

    // L2 genericTx should include setRecords call
    const setRecordsCall = l2Calls.find(([_a, _b, method]: any[]) => method === 'setRecords');
    expect(setRecordsCall).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 7. Composition: buildAssets runs before buildConfig
  // ---------------------------------------------------------------------------
  it('runs buildAssets before buildConfig (assetsCid flows into config)', async () => {
    const { deps, pub } = await runNew();

    // publication.configCid was set by the builder flow (not undefined)
    expect(pub.configCid).toBeTruthy();

    // The IPFS mfsFlush (called by AssetsBuilder at the end of buildAssets)
    // should have been invoked before addToKubo (called by ConfigBuilder
    // for the final config.json upload).
    const ipfs = deps.ipfs as any;
    const mfsFlushOrder = ipfs.mfsFlush.mock.invocationCallOrder[0];
    const addToKuboCalls = ipfs.addToKubo.mock.invocationCallOrder;
    // The last addToKubo call is for config.json (the kubo config CID write)
    const configAddOrder = addToKuboCalls[addToKuboCalls.length - 1];
    expect(mfsFlushOrder).toBeLessThan(configAddOrder);

    // buildConfig's addToKubo(JSON.stringify(...), 'config.json') was called
    const configUploadCalls = ipfs.addToKubo.mock.calls.filter(
      ([_content, name]: [string, string]) => name === 'config.json',
    );
    expect(configUploadCalls).toHaveLength(1);
  });
});

// =============================================================================
// buildNewPublicationDeps — deps assembly
// =============================================================================

describe('buildNewPublicationDeps', () => {
  it('wires injected pieces through and defaults ensRecordsAddress from protocolInfo', () => {
    const l1 = {} as TxRunner;
    const l2 = {} as TxRunner;
    const ipfs = {} as any;
    const protocolInfo = { ensRegistry: '0xr', recordsFactory: '0xf', publicationFactory: '0xp', ensRecords: '0xer' } as any;

    const deps = buildNewPublicationDeps({
      runners: { l1, l2 },
      privateKey: 'pk',
      protocolInfo,
      recordsModuleFactoryAbi: ['recordsFactoryAbi'],
      publicationModuleFactoryAbi: ['pubFactoryAbi'],
      recordsModuleAbi: ['recordsAbi'],
      ipfs,
      githubToken: 'gh',
      createFeed: async () => '0xfeed',
    });

    expect(deps.l1).toBe(l1);
    expect(deps.l2).toBe(l2);
    expect(deps.privateKey).toBe('pk');
    expect(deps.protocolInfo).toBe(protocolInfo);
    expect(deps.recordsModuleFactoryAbi).toEqual(['recordsFactoryAbi']);
    expect(deps.publicationModuleFactoryAbi).toEqual(['pubFactoryAbi']);
    expect(deps.recordsModuleAbi).toEqual(['recordsAbi']);
    expect(deps.ipfs).toBe(ipfs);
    expect(deps.githubToken).toBe('gh');
    expect(deps.ensRecordsAddress).toBe('0xer');
  });

  it('falls back to an empty ensRecordsAddress when protocolInfo.ensRecords is missing', () => {
    const deps = buildNewPublicationDeps({
      runners: { l1: {} as TxRunner, l2: {} as TxRunner },
      privateKey: 'pk',
      protocolInfo: {} as any,
      recordsModuleFactoryAbi: [],
      publicationModuleFactoryAbi: [],
      recordsModuleAbi: [],
      ipfs: {} as any,
      githubToken: '',
      createFeed: async () => '0xfeed',
    });
    expect(deps.ensRecordsAddress).toBe('');
  });
});
