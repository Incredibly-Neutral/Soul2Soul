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

  function JsonRpcProvider(this: any, url: string) {
    rpcUrls.push(url);
    this.url = url;
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
  return { contractStubs, directCalls, rpcUrls, contractCtorArgs, browserProviderCalls, JsonRpcProvider, BrowserProvider, Contract };
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
    await expect(si.setRecord('k', 'v')).rejects.toThrow('Safe SDK or records module not initialized');
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
    await expect(si.makeOffer('0x', 'cid')).rejects.toThrow(/publication module not initialized/);
    await expect(si.acceptOffer('0x')).rejects.toThrow(/publication module not initialized/);
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
