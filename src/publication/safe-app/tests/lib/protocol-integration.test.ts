import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProtocolIntegration } from '../../src/lib/protocol-integration';
import type { S2SManifest } from '@s2s/soul2soul-shared/safe-app';

const mocks = vi.hoisted(() => {
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
  const http = vi.fn((url: string) => ({ url }));
  const createPublicClient = vi.fn((cfg: { chain: unknown; transport: unknown }) => ({ cfg }));
  const getManifest = vi.fn();
  return { opts, getInfo, txsSend, SDK, http, createPublicClient, getManifest };
});

vi.mock('@safe-global/safe-apps-sdk', () => ({ default: mocks.SDK }));
vi.mock('viem', () => ({
  createPublicClient: mocks.createPublicClient,
  http: mocks.http,
}));
vi.mock('@s2s/soul2soul-shared/safe-app', () => ({
  getManifest: mocks.getManifest,
}));

const PROTOCOL_INFO: S2SManifest = {
  version: '1.0.0',
  protocolModuleAddress: '0xProto',
  recordsModuleAddress: '0xRecords',
  publicationModuleAddress: '0xPub',
} as S2SManifest;

describe('ProtocolIntegration', () => {
  beforeEach(() => {
    // Deterministic DRPC URLs regardless of the local root .env.
    vi.stubEnv('VITE_DRPC_API_KEY', 'testkey');
    mocks.opts.length = 0;
    mocks.getInfo.mockReset();
    mocks.txsSend.mockReset();
    mocks.http.mockClear();
    mocks.createPublicClient.mockClear();
    mocks.getManifest.mockReset();
  });

  it('starts disconnected', () => {
    const pi = new ProtocolIntegration();
    expect(pi.isConnected()).toBe(false);
  });

  it('constructs the SafeAppsSDK with the allowedDomains / debug opts', async () => {
    mocks.getInfo.mockResolvedValue({ safeAddress: '0xSafe', chainId: 8453, network: 'base' });
    mocks.getManifest.mockResolvedValue(PROTOCOL_INFO);
    const pi = new ProtocolIntegration();
    await pi.initialize();

    expect(mocks.opts).toHaveLength(1);
    const opts = mocks.opts[0] as { allowedDomains: RegExp[]; debug: boolean };
    expect(opts.debug).toBe(false);
    expect(opts.allowedDomains[0].test('https://app.safe.global')).toBe(true);
    expect(opts.allowedDomains[0].test('https://evil.example')).toBe(false);
  });

  it('wires both viem public clients to the DRPC URLs for L1 (1) and L2 (8453) and feeds them into getManifest', async () => {
    mocks.getInfo.mockResolvedValue({ safeAddress: '0xSafe', chainId: 8453, network: 'base' });
    mocks.getManifest.mockResolvedValue(PROTOCOL_INFO);

    const pi = new ProtocolIntegration();
    await pi.initialize();

    // Two public clients created: mainnet + base.
    expect(mocks.createPublicClient).toHaveBeenCalledTimes(2);
    const l1Cfg = mocks.createPublicClient.mock.calls[0][0];
    const l2Cfg = mocks.createPublicClient.mock.calls[1][0];
    expect((l1Cfg.transport as { url: string }).url).toBe('https://lb.drpc.live/ethereum/testkey');
    expect((l2Cfg.transport as { url: string }).url).toBe('https://lb.drpc.live/base/testkey');
    expect(l1Cfg.chain).toBeUndefined();
    expect(l2Cfg.chain).toBeUndefined();

    // getManifest receives (providerL1, providerL2). It took a `dev` flag as its
    // first argument once; that is gone, and the clients are the arguments.
    expect(mocks.getManifest).toHaveBeenCalledTimes(1);
    const [pL1, pL2] = mocks.getManifest.mock.calls[0];
    expect(pL1.cfg).toEqual(l1Cfg);
    expect(pL2.cfg).toEqual(l2Cfg);
  });

  it('returns the protocol info from initialize() and exposes it via getInfo()', async () => {
    mocks.getInfo.mockResolvedValue({ safeAddress: '0xSafe', chainId: 1, network: 'mainnet' });
    mocks.getManifest.mockResolvedValue(PROTOCOL_INFO);

    const pi = new ProtocolIntegration();
    const result = await pi.initialize();
    expect(result).toBe(PROTOCOL_INFO);
    expect(pi.getInfo()).toBe(PROTOCOL_INFO);
    expect(pi.isConnected()).toBe(true);
  });

  it('returns undefined and never calls getManifest when the Safe SDK getInfo fails', async () => {
    mocks.getInfo.mockRejectedValue(new Error('wallet not connected'));
    const pi = new ProtocolIntegration();
    await expect(pi.initialize()).resolves.toBeUndefined();
    expect(mocks.getManifest).not.toHaveBeenCalled();
    // NB: the source assigns safeSdk before awaiting getInfo, so the instance
    // still reports connected after a failed initialize.
    expect(pi.isConnected()).toBe(true);
  });

  it('returns undefined when getManifest itself throws', async () => {
    mocks.getInfo.mockResolvedValue({ safeAddress: '0xSafe', chainId: 1, network: 'mainnet' });
    mocks.getManifest.mockRejectedValue(new Error('protocol discovery failed'));
    const pi = new ProtocolIntegration();
    await expect(pi.initialize()).resolves.toBeUndefined();
  });
});
