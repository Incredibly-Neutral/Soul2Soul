import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toBytes32Id } from '@s2s/soul2soul-shared';
import { SafeIntegration } from '../../src/lib/safe-integration';

// ---------------------------------------------------------------------------
// Mock strategy (SPEC-safe-app test seams):
//  - SafeAppsSDK is mocked so every mutation goes through safeSdk.txs.send
//    and NEVER executes a direct on-chain send.
//  - window.ethers is stubbed (JsonRpcProvider / Contract / BrowserProvider)
//    so module discovery by NAME() and the read paths run without any RPC.
//  - The mocked ethers.Contract returns a per-address stub; any method the
//    source calls that is NOT on the stub is recorded in `directCalls` — so
//    "never a direct send" can be asserted by checking the mutation method was
//    never invoked on the contract instance.
// ---------------------------------------------------------------------------

const R_ADDR = '0x0000000000000000000000000000000000000R00';
const P_ADDR = '0x0000000000000000000000000000000000000P00';
const O_ADDR = '0x0000000000000000000000000000000000000O00';

const SAFE_DATA = {
  safeAddress: '0xSafeAddress',
  chainId: 8453,
  network: 'base',
  modules: [O_ADDR, R_ADDR, P_ADDR],
  owners: ['0xOwner1', '0xOwner2'],
  threshold: 2,
};

const sdk = vi.hoisted(() => {
  const opts: unknown[] = [];
  const getInfo = vi.fn();
  const txsSend = vi.fn();
  const SDK = class {
    constructor(o?: unknown) {
      opts.push(o);
    }
    safe = { getInfo };
    txs = { send: txsSend };
  };
  return { opts, getInfo, txsSend, SDK };
});

vi.mock('@safe-global/safe-apps-sdk', () => ({ default: sdk.SDK }));

const eth = vi.hoisted(() => {
  const contractStubs: Record<string, any> = {};
  const directCalls: Record<string, Record<string, unknown[][]>> = {};
  const rpcUrls: string[] = [];
  const contractCtorArgs: unknown[][] = [];
  const browserProviderCalls: unknown[] = [];
  const getLogsCalls: unknown[] = [];
  const getCodeCalls: unknown[] = [];
  let getLogsResult: unknown = [];
  let codeResults: Record<string, string> = {};

  function JsonRpcProvider(this: any, url: string) {
    rpcUrls.push(url);
    this.url = url;
    this.getLogs = async (args: unknown) => {
      getLogsCalls.push(args);
      return getLogsResult;
    };
    this.getCode = async (address: string) => {
      getCodeCalls.push(address);
      return codeResults[address.toLowerCase()] ?? '0x';
    };
  }
  function BrowserProvider(this: any, ethObj: unknown) {
    browserProviderCalls.push(ethObj);
    this.ethObj = ethObj;
    this.getSigner = async () => ({
      getAddress: async () => '0xSignerAddress',
      signMessage: async (m: string) => `signed:${m}`,
    });
  }
  function Contract(this: any, address: string, abi: unknown, provider: unknown) {
    contractCtorArgs.push([address, abi, provider]);
    const stub = contractStubs[address] ?? {};
    // Faithful to ethers v6: a wrapper knows the address it was constructed
    // with (`target`). The source takes tx `to:` from here, so the mock must
    // carry it too.
    if (!('target' in stub)) stub.target = address;
    const record: Record<string, unknown[][]> = (directCalls[address] ??= {});
    return new Proxy(stub, {
      get(t, prop) {
        if (typeof prop === 'symbol') return (t as any)[prop];
        if (prop === 'then') return undefined; // never treat the stub as thenable
        if (prop in t) return (t as any)[prop];
        return (...args: unknown[]) => {
          (record[prop] ??= []).push(args);
          return undefined;
        };
      },
    });
  }
  return {
    contractStubs, directCalls, rpcUrls, contractCtorArgs, browserProviderCalls, getLogsCalls,
    getCodeCalls, JsonRpcProvider, BrowserProvider, Contract,
    // Accessors so tests can set the result the getLogs mock will return.
    get getLogsResult() { return getLogsResult; },
    set getLogsResult(v: unknown) { getLogsResult = v; },
    // Accessors for the eth_getCode mock (address → hex code).
    get codeResults() { return codeResults; },
    set codeResults(v: Record<string, string>) { codeResults = v; },
  };
});

function makeInterface() {
  return { encodeFunctionData: vi.fn((fn: string) => `0x${fn}`) };
}

function makeRecordsStub() {
  return {
    NAME: vi.fn(async () => 'S2S Records Module'),
    interface: makeInterface(),
    getAllRecords: vi.fn(),
    getRecord: vi.fn(),
  };
}

function makePubStub() {
  return {
    NAME: vi.fn(async () => 'S2S Publication Module V2'),
    interface: makeInterface(),
    hasDeal: vi.fn(),
    getDeals: vi.fn(),
    getOffers: vi.fn(),
    getWhitelistedAuthors: vi.fn(),
    getWhitelistedDevs: vi.fn(),
    canPublish: vi.fn(),
  };
}

let records: ReturnType<typeof makeRecordsStub>;
let pub: ReturnType<typeof makePubStub>;
let other: { NAME: ReturnType<typeof vi.fn> };

beforeEach(() => {
  // Deterministic DRPC URLs regardless of the local root .env.
  vi.stubEnv('VITE_DRPC_API_KEY', 'testkey');
  records = makeRecordsStub();
  pub = makePubStub();
  other = { NAME: vi.fn(async () => { throw new Error('no NAME()'); }) };

  eth.contractStubs[R_ADDR] = records;
  eth.contractStubs[P_ADDR] = pub;
  eth.contractStubs[O_ADDR] = other;
  eth.rpcUrls.length = 0;
  eth.contractCtorArgs.length = 0;
  eth.browserProviderCalls.length = 0;
  eth.getLogsCalls.length = 0;
  eth.getLogsResult = [];
  eth.getCodeCalls.length = 0;
  eth.codeResults = {};
  for (const k of Object.keys(eth.directCalls)) delete eth.directCalls[k];

  (globalThis as any).window = { ethers: eth, ethereum: '0xETHEREUM' };

  sdk.opts.length = 0;
  sdk.getInfo.mockReset();
  sdk.txsSend.mockReset();
  sdk.getInfo.mockResolvedValue({ ...SAFE_DATA });
});

/** Construct + initialize a SafeIntegration, asserting the discovery result. */
async function initInstance(): Promise<SafeIntegration> {
  const si = new SafeIntegration();
  const info = await si.initialize();
  expect(info.safeAddress).toBe(SAFE_DATA.safeAddress);
  expect(info.chainId).toBe(SAFE_DATA.chainId);
  return si;
}

describe('initialize — module discovery by NAME()', () => {
  it('discovers the Records and Publication modules by NAME() and fills safeInfo', async () => {
    const si = await initInstance();
    expect(records.NAME).toHaveBeenCalled();
    expect(pub.NAME).toHaveBeenCalled();

    const info = si.getSafeInfo();
    expect(info.s2sRecords).toBe(R_ADDR);
    expect(info.s2sPublication).toBe(P_ADDR);
    expect(info.modules).toEqual(SAFE_DATA.modules);
    expect(info.owners).toEqual(SAFE_DATA.owners);
    expect(info.threshold).toBe(2);
    expect(info.network).toBe('base');

    expect(si.isConnected()).toBe(true);
    expect(si.hasRecordsModule()).toBe(true);
    expect(si.hasPublicationModule()).toBe(true);
  });

  it('creates a JsonRpcProvider for the Safe chain via getRpcUrl', async () => {
    await initInstance();
    expect(eth.rpcUrls).toEqual(['https://lb.drpc.live/base/testkey']);
  });

  it('skips modules that throw on NAME() (no NAME function)', async () => {
    const si = await initInstance();
    expect(other.NAME).toHaveBeenCalled();
    // O_ADDR was never assigned as a known module.
    expect(si.getSafeInfo().s2sRecords).toBe(R_ADDR);
    expect(si.getSafeInfo().s2sPublication).toBe(P_ADDR);
  });

  it('returns safeInfo with empty module addresses when initialize fails early', async () => {
    sdk.getInfo.mockRejectedValue(new Error('no wallet'));
    const si = new SafeIntegration();
    const info = await si.initialize();
    expect(info.s2sRecords).toBe('');
    expect(info.s2sPublication).toBe('');
    expect(si.hasRecordsModule()).toBe(false);
    expect(si.hasPublicationModule()).toBe(false);
  });

  // --- step-3 race (`to: ''` → invalid address) ---------------------------

  it('a second initialize() whose NAME() probes revert keeps the known addresses (the step-3 repro)', async () => {
    const si = await initInstance();

    // The live repro: an overlapping fetchFreshData() calls initialize() again
    // while the RPC is unhappy, so every NAME() probe reverts. The Safe still
    // LISTS both modules — it just could not tell us their names this time.
    records.NAME.mockRejectedValue(new Error('revert'));
    pub.NAME.mockRejectedValue(new Error('revert'));

    const info = await si.initialize();

    expect(info.s2sRecords).toBe(R_ADDR);
    expect(info.s2sPublication).toBe(P_ADDR);
    expect(si.hasRecordsModule()).toBe(true);

    // The tx that used to be proposed with `to: ''` now targets the module.
    await si.setRecord('config', 'bafyCid');
    expect(sdk.txsSend).toHaveBeenLastCalledWith({
      txs: [{ to: R_ADDR, value: '0', data: '0xsetRecord' }],
    });
  });

  it('publishes its result atomically: no reader ever sees a known module with an empty address', async () => {
    const si = await initInstance(); // records + publication known and published

    let releaseRecords!: () => void;
    let releasePub!: () => void;
    const recordsGate = new Promise<void>((r) => (releaseRecords = r));
    const pubGate = new Promise<void>((r) => (releasePub = r));
    records.NAME.mockImplementation(async () => {
      await recordsGate;
      return 'S2S Records Module';
    });
    pub.NAME.mockImplementation(async () => {
      await pubGate;
      return 'S2S Publication Module V2';
    });

    // Count only this pair of calls (initInstance above already probed NAME()).
    records.NAME.mockClear();
    pub.NAME.mockClear();

    // Two overlapping initializations, exactly like the two fetchFreshData()
    // calls in the live crash.
    const first = si.initialize();
    const second = si.initialize();

    // Invariant a reader (setRecord, the UI) relies on: a module we claim to
    // have always has its address published. "Known module, '' address" is what
    // produced the tx to `to: ''`.
    const assertWhole = () => {
      if (si.hasRecordsModule()) expect(si.getSafeInfo().s2sRecords).toBe(R_ADDR);
      if (si.hasPublicationModule()) expect(si.getSafeInfo().s2sPublication).toBe(P_ADDR);
    };

    // Both calls are parked on the records NAME() probe. Nothing may have been
    // published yet — in particular safeInfo must NOT have been blanked.
    await vi.waitFor(() => expect(records.NAME).toHaveBeenCalledTimes(2));
    assertWhole();

    // Records rediscovered, publication still probing: still no asymmetry.
    releaseRecords();
    await vi.waitFor(() => expect(pub.NAME).toHaveBeenCalledTimes(2));
    assertWhole();

    releasePub();
    const infos = await Promise.all([first, second]);
    for (const info of infos) {
      expect(info.s2sRecords).toBe(R_ADDR);
      expect(info.s2sPublication).toBe(P_ADDR);
    }
    assertWhole();
  });

  it('keeps a module adopted while initialize() is suspended on a NAME() probe (no lost update)', async () => {
    // N3: the publish used to write back the wrapper captured at entry, so an
    // adoptModules() landing mid-pass was discarded — hasRecordsModule() false
    // for the rest of the page, Config tab gone, config session dropped.
    const ADOPTED = '0xAdoptedMidPass';
    const GATE = '0xGateModule';
    eth.contractStubs[ADOPTED] = makeRecordsStub();
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));
    const gateName = vi.fn(async () => {
      await gate;
      return 'Some Other Module';
    });
    eth.contractStubs[GATE] = { NAME: gateName };

    const si = new SafeIntegration();
    // The Safe lists only an unrelated module, so this pass discovers nothing.
    sdk.getInfo.mockResolvedValue({ ...SAFE_DATA, modules: [GATE] });

    const pending = si.initialize();
    await vi.waitFor(() => expect(gateName).toHaveBeenCalled());

    // The init flow learns the freshly-deployed module and adopts it now.
    await si.adoptModules(ADOPTED);
    expect(si.hasRecordsModule()).toBe(true);

    releaseGate();
    const info = await pending;

    // The adopted wrapper survived the publish, and the derived address too.
    expect(si.hasRecordsModule()).toBe(true);
    expect(info.s2sRecords).toBe(ADOPTED);
    await si.setRecord('config', 'bafyCid');
    expect(sdk.txsSend).toHaveBeenLastCalledWith({
      txs: [{ to: ADOPTED, value: '0', data: '0xsetRecord' }],
    });
  });

  it('clears a module the Safe no longer lists, so hasRecordsModule() stops lying after a reset', async () => {
    const si = await initInstance();
    expect(si.hasRecordsModule()).toBe(true);
    expect(si.hasPublicationModule()).toBe(true);

    // Reset: both modules are gone from the Safe's module list.
    sdk.getInfo.mockResolvedValue({ ...SAFE_DATA, modules: [O_ADDR] });
    const info = await si.initialize();

    expect(info.s2sRecords).toBe('');
    expect(info.s2sPublication).toBe('');
    expect(si.hasRecordsModule()).toBe(false);
    expect(si.hasPublicationModule()).toBe(false);
    await expect(si.getAllRecords()).rejects.toThrow('Records module not initialized');
  });

  it('keeps a module adopted mid-init that the Safe does not list yet (deployed, enable tx pending)', async () => {
    const ADOPTED = '0xAdoptedRecordsModule';
    eth.contractStubs[ADOPTED] = makeRecordsStub();

    const si = new SafeIntegration();
    // Fresh Safe: no modules installed yet.
    sdk.getInfo.mockResolvedValue({ ...SAFE_DATA, modules: [] });
    await si.initialize();
    expect(si.hasRecordsModule()).toBe(false);

    // The init flow deploys the contracts and adopts them (factory logs) BEFORE
    // the enableModule proposal executes; a concurrent initialize() must not
    // wipe that recovery handle.
    await si.adoptModules(ADOPTED);
    expect(si.hasRecordsModule()).toBe(true);

    const info = await si.initialize();
    expect(info.s2sRecords).toBe(ADOPTED);
    expect(si.hasRecordsModule()).toBe(true);
  });
});

describe('setRecord — proposes via safeSdk.txs.send, never a direct send', () => {
  it('encodes setRecord and sends the proposal to the records module address', async () => {
    const si = await initInstance();
    const safeUrl = await si.setRecord('key1', 'value1');

    expect(records.interface.encodeFunctionData).toHaveBeenCalledWith('setRecord', ['key1', 'value1']);
    expect(sdk.txsSend).toHaveBeenCalledWith({
      txs: [{ to: R_ADDR, value: '0', data: '0xsetRecord' }],
    });
    expect(safeUrl).toBe(
      `https://app.safe.global/transactions/queue?safe=8453:0xSafeAddress`,
    );

    // NEVER a direct send: the contract's own setRecord method was not invoked.
    expect(eth.directCalls[R_ADDR]?.['setRecord']).toBeUndefined();
    expect(eth.directCalls[R_ADDR]?.['send']).toBeUndefined();
  });

  it('throws when not initialized (no records module)', async () => {
    const si = new SafeIntegration();
    await expect(si.setRecord('k', 'v')).rejects.toThrow('Safe SDK not initialized');
  });

  it('REFUSES to propose a tx with no records module: clear error, sdk.txs.send never called', async () => {
    // The step-3 crash was `to: ''` reaching the Safe SDK. A known-but-addressless
    // module must not silently degrade into that: no send at all, clear error.
    const si = await initInstance();
    si.recordsModule = null;
    sdk.txsSend.mockClear();

    await expect(si.setRecord('config', 'bafyX')).rejects.toThrow(
      'records module not found on this Safe',
    );
    await expect(si.deleteRecord('config')).rejects.toThrow(
      'records module not found on this Safe',
    );
    expect(sdk.txsSend).not.toHaveBeenCalled();
  });

  it('takes `to:` from the contract target, never from a possibly-stale safeInfo address', async () => {
    const si = await initInstance();
    // Simulate the old racy shape: safeInfo says '' while the wrapper is known.
    // (initialize() can no longer produce this, but the payload must not depend
    // on it either.)
    si.getSafeInfo().s2sRecords = '';
    si.getSafeInfo().s2sPublication = '';

    await si.setRecord('config', 'bafyX');
    await si.whitelistAuthor('0xAuthor');

    expect(sdk.txsSend).toHaveBeenNthCalledWith(1, {
      txs: [{ to: R_ADDR, value: '0', data: '0xsetRecord' }],
    });
    expect(sdk.txsSend).toHaveBeenNthCalledWith(2, {
      txs: [{ to: P_ADDR, value: '0', data: '0xwhitelistAuthor' }],
    });
  });
});

describe('deleteRecord', () => {
  it('encodes deleteRecord and proposes it via the SDK', async () => {
    const si = await initInstance();
    await si.deleteRecord('key9');

    expect(records.interface.encodeFunctionData).toHaveBeenCalledWith('deleteRecord', ['key9']);
    expect(sdk.txsSend).toHaveBeenCalledWith({
      txs: [{ to: R_ADDR, value: '0', data: '0xdeleteRecord' }],
    });
    expect(eth.directCalls[R_ADDR]?.['deleteRecord']).toBeUndefined();
  });
});

describe('proposeBatch — generic batch proposal (module-install init flow, AD-3)', () => {
  it('sends the exact tx array via sdk.txs.send and returns the Safe queue URL', async () => {
    const si = await initInstance();
    const batch = [
      { to: R_ADDR, value: '0', data: '0xcreateModule' },
      { to: R_ADDR, value: '0', data: '0xenableModule' },
    ];

    const safeUrl = await si.proposeBatch(batch);

    expect(sdk.txsSend).toHaveBeenCalledWith({ txs: batch });
    expect(safeUrl).toBe(
      `https://app.safe.global/transactions/queue?safe=8453:0xSafeAddress`,
    );

    // NEVER a direct send: nothing was invoked on any contract instance.
    for (const k of Object.keys(eth.directCalls)) {
      expect(eth.directCalls[k]).toEqual({});
    }
  });

  it('throws when the Safe SDK is missing', async () => {
    const si = new SafeIntegration();
    await expect(si.proposeBatch([{ to: R_ADDR, value: '0', data: '0x00' }]))
      .rejects.toThrow('Safe SDK not initialized');
    expect(sdk.txsSend).not.toHaveBeenCalled();
  });
});

describe('getProvider — JSON-RPC provider for the Safe chain', () => {
  it('returns a JsonRpcProvider built via getRpcUrl for the Safe chainId', async () => {
    const si = await initInstance();
    const provider = si.getProvider();
    expect(provider.url).toBe('https://lb.drpc.live/base/testkey');
  });
});

describe('fetchFactoryModuleCreatedLogs — factory ModuleCreated log reads', () => {
  it('calls provider.getLogs with address + padded safe topic and returns the logs', async () => {
    const si = await initInstance();
    const factory = '0xFactory'; 
    const safeAddress = '0xAbCdef1234567890AbCdef1234567890AbCdef12'; // 40 hex chars
    const topic0 = '0x' + '0'.repeat(64);
    const paddedSafe = '0x' + '0'.repeat(24) + 'abcdef1234567890abcdef1234567890abcdef12';
    const log = { topics: [topic0, paddedSafe], data: '0x' };
    eth.getLogsResult = [log];

    const result = await si.fetchFactoryModuleCreatedLogs(factory, safeAddress, topic0, 12345);

    expect(eth.getLogsCalls).toEqual([{
      address: factory,
      topics: [topic0, paddedSafe],
      fromBlock: 12345,
      toBlock: 'latest',
    }]);
    expect(result).toEqual([log]);
  });
});

describe('contractCodeSize — factory code check (wrong-chain guard)', () => {
  it('returns 0 when the account has no code (the wrong-chain case)', async () => {
    eth.codeResults = { [R_ADDR.toLowerCase()]: '0x' };
    const si = await initInstance();

    await expect(si.contractCodeSize(R_ADDR)).resolves.toBe(0);
  });

  it('returns the byte length of the deployed code', async () => {
    // 100 bytes of code -> 200 hex chars after the 0x prefix.
    eth.codeResults = { [P_ADDR.toLowerCase()]: '0x' + '60'.repeat(100) };
    const si = await initInstance();

    await expect(si.contractCodeSize(P_ADDR)).resolves.toBe(100);
  });

  it('reads through the provider for the Safe chain and logs nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    eth.codeResults = { [R_ADDR.toLowerCase()]: '0x6080' };
    const si = await initInstance();
    log.mockClear();

    await expect(si.contractCodeSize(R_ADDR)).resolves.toBe(2);

    expect(eth.getCodeCalls).toEqual([R_ADDR]);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe('readIsModuleEnabled — standard Safe module check', () => {
  it('reads isModuleEnabled through the contract on the Safe address with the minimal ABI', async () => {
    const isModuleEnabled = vi.fn(async () => true);
    eth.contractStubs[SAFE_DATA.safeAddress] = { isModuleEnabled };
    const si = await initInstance();

    await expect(si.readIsModuleEnabled('0xModule')).resolves.toBe(true);
    expect(isModuleEnabled).toHaveBeenCalledWith('0xModule');

    // The contract is built on the Safe address with the minimal ABI.
    const ctor = eth.contractCtorArgs.find(([addr]) => addr === SAFE_DATA.safeAddress);
    expect(ctor?.[1]).toEqual(['function isModuleEnabled(address) view returns (bool)']);
  });
});

describe('publication mutations — makeOffer / acceptOffer / retract / whitelists', () => {
  it('makeOffer encodes the bytes32 genesis + cid and proposes to the publication module', async () => {
    const si = await initInstance();
    const genesis = `0x${'a'.repeat(64)}`;
    await si.makeOffer(genesis, 'bafyCid');

    expect(pub.interface.encodeFunctionData).toHaveBeenCalledWith('makeOffer', [toBytes32Id(genesis), 'bafyCid']);
    expect(sdk.txsSend).toHaveBeenCalledWith({
      txs: [{ to: P_ADDR, value: '0', data: '0xmakeOffer' }],
    });
    expect(eth.directCalls[P_ADDR]?.['makeOffer']).toBeUndefined();
  });

  it('acceptOffer and retract encode the bytes32 genesis', async () => {
    const si = await initInstance();
    const genesis = `0x${'b'.repeat(64)}`;
    await si.acceptOffer(genesis);
    await si.retract(genesis);

    expect(pub.interface.encodeFunctionData).toHaveBeenCalledWith('acceptOffer', [toBytes32Id(genesis)]);
    expect(pub.interface.encodeFunctionData).toHaveBeenCalledWith('retract', [toBytes32Id(genesis)]);
    expect(sdk.txsSend).toHaveBeenCalledTimes(2);
    expect(eth.directCalls[P_ADDR]?.['acceptOffer']).toBeUndefined();
    expect(eth.directCalls[P_ADDR]?.['retract']).toBeUndefined();
  });

  it('whitelistAuthor / removeWhitelistedAuthor / whitelistDev / removeWhitelistedDev', async () => {
    const si = await initInstance();
    await si.whitelistAuthor('0xAuthor');
    await si.removeWhitelistedAuthor('0xAuthor');
    await si.whitelistDev('0xDev');
    await si.removeWhitelistedDev('0xDev');

    expect(pub.interface.encodeFunctionData).toHaveBeenCalledWith('whitelistAuthor', ['0xAuthor']);
    expect(pub.interface.encodeFunctionData).toHaveBeenCalledWith('removeWhitelistedAuthor', ['0xAuthor']);
    expect(pub.interface.encodeFunctionData).toHaveBeenCalledWith('whitelistDev', ['0xDev']);
    expect(pub.interface.encodeFunctionData).toHaveBeenCalledWith('removeWhitelistedDev', ['0xDev']);
    expect(sdk.txsSend).toHaveBeenCalledTimes(4);
    // All four target the publication module.
    for (const call of sdk.txsSend.mock.calls) {
      expect(call[0].txs[0].to).toBe(P_ADDR);
    }
  });

  it('throws when publication methods are called without initialization', async () => {
    const si = new SafeIntegration();
    await expect(si.makeOffer('0x', 'cid')).rejects.toThrow(/Safe SDK not initialized/);
    await expect(si.acceptOffer('0x')).rejects.toThrow(/Safe SDK not initialized/);
  });

  it('refuses to propose publication txs with no publication module', async () => {
    const si = await initInstance();
    si.publicationModule = null;
    sdk.txsSend.mockClear();

    await expect(si.makeOffer(`0x${'a'.repeat(64)}`, 'cid')).rejects.toThrow(
      'publication module not found on this Safe',
    );
    expect(sdk.txsSend).not.toHaveBeenCalled();
  });
});

describe('read paths (direct contract reads, no sends)', () => {
  it('getAllRecords and getRecord delegate to the records contract', async () => {
    const si = await initInstance();
    records.getAllRecords.mockResolvedValue([['k1'], ['v1']]);
    records.getRecord.mockResolvedValue('value-x');

    await expect(si.getAllRecords()).resolves.toEqual([['k1'], ['v1']]);
    await expect(si.getRecord('key-x')).resolves.toBe('value-x');
    expect(records.getRecord).toHaveBeenCalledWith('key-x');
    expect(sdk.txsSend).not.toHaveBeenCalled();
  });

  it('getRecord rethrows on contract failure', async () => {
    const si = await initInstance();
    records.getRecord.mockRejectedValue(new Error('read failed'));
    await expect(si.getRecord('k')).rejects.toThrow('read failed');
  });

  it('getAllRecords throws when the records module is missing', async () => {
    const si = new SafeIntegration();
    await expect(si.getAllRecords()).rejects.toThrow('Records module not initialized');
  });

  it('hasDeal / getDeals / getOffers delegate with bytes32 genesis and default pagination', async () => {
    const si = await initInstance();
    const genesis = `0x${'c'.repeat(64)}`;
    pub.hasDeal.mockResolvedValue(true);
    pub.getDeals.mockResolvedValue([{ genesis, author: '0xA', cid: 'c1', timestamp: 1n }]);
    pub.getOffers.mockResolvedValue([]);

    await expect(si.hasDeal(genesis)).resolves.toBe(true);
    expect(pub.hasDeal).toHaveBeenCalledWith(toBytes32Id(genesis));

    await si.getDeals();
    expect(pub.getDeals).toHaveBeenCalledWith(0, 50);
    await si.getDeals(5, 10);
    expect(pub.getDeals).toHaveBeenCalledWith(5, 10);

    await si.getOffers();
    expect(pub.getOffers).toHaveBeenCalledWith(0, 50);
  });

  it('getAllDealsAndOffers maps both lists with status and coalesces errors to empty', async () => {
    const si = await initInstance();
    const deal = { genesis: '0xgen', author: '0xA', cid: 'c1', timestamp: 1n };
    const offer = { genesis: '0xgen', author: '0xB', cid: 'c2', timestamp: 2n };
    pub.getDeals.mockResolvedValue([deal]);
    pub.getOffers.mockResolvedValue([offer]);

    const all = await si.getAllDealsAndOffers();
    expect(all.deals).toEqual([{ ...deal, status: 'deal' }]);
    expect(all.offers).toEqual([{ ...offer, status: 'offer' }]);
    expect(pub.getDeals).toHaveBeenCalledWith(0, 200);
    expect(pub.getOffers).toHaveBeenCalledWith(0, 200);

    // On read failure it coalesces to empty lists (never throws).
    pub.getDeals.mockRejectedValue(new Error('boom'));
    await expect(si.getAllDealsAndOffers()).resolves.toEqual({ deals: [], offers: [] });
  });

  it('getWhitelistedAuthors / getWhitelistedDevs / canPublish delegate to the contract', async () => {
    const si = await initInstance();
    pub.getWhitelistedAuthors.mockResolvedValue(['0xA']);
    pub.getWhitelistedDevs.mockResolvedValue(['0xD']);
    pub.canPublish.mockResolvedValue(false);

    await expect(si.getWhitelistedAuthors()).resolves.toEqual(['0xA']);
    await expect(si.getWhitelistedDevs()).resolves.toEqual(['0xD']);
    await expect(si.canPublish('0xWho')).resolves.toBe(false);
    expect(pub.canPublish).toHaveBeenCalledWith('0xWho');
  });
});

describe('evmSetup / evmRead / signWithSigner', () => {
  it('evmSetup returns a provider + contract for a known chainId', () => {
    const si = new SafeIntegration();
    const { provider, contract } = si.evmSetup('0xContract', [], 8453);
    expect(provider.url).toBe('https://lb.drpc.live/base/testkey');
    expect(contract).toBeDefined();
  });

  it('evmSetup leaves provider undefined for an unknown chainId but still builds a contract', () => {
    const si = new SafeIntegration();
    const { provider, contract } = si.evmSetup('0xContract', [], 999);
    expect(provider).toBeUndefined();
    expect(contract).toBeDefined();
  });

  it('evmRead calls the requested contract method with args', async () => {
    const si = new SafeIntegration();
    eth.contractStubs['0xTarget'] = { getBalance: vi.fn(async () => 42n) };
    await expect(si.evmRead(1, '0xTarget', [], 'getBalance', ['0xWho'])).resolves.toBe(42n);
    expect(eth.contractStubs['0xTarget'].getBalance).toHaveBeenCalledWith('0xWho');
  });

  it('signWithSigner uses a BrowserProvider over window.ethereum and signs', async () => {
    const si = new SafeIntegration();
    const sig = await si.signWithSigner('hello');
    expect(eth.browserProviderCalls).toEqual(['0xETHEREUM']);
    expect(sig).toBe('signed:hello');
  });
});
