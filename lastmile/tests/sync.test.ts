// lastmile — sync loop tests.
//
// No real network, no real Kubo, no real nginx: everything goes through
// injected fake services. State dirs are REAL tmp dirs under the OS tmp
// (node:fs mkdtemp), so loadState/writeState/writeS2sJson run against real
// files.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AppConfig, MagazineConfig } from '../src/config';
import type { ResolveOutcome } from '../src/ens';
import type { NginxWriteResult, WriteNginxIncludeArgs } from '../src/nginx';
import { writeState, type MagazineState } from '../src/state';
import {
  makeDefaultServices,
  syncMagazine,
  type SyncResult,
  type SyncServices,
} from '../src/sync';

const DOMAIN = 's3ntiment.com';
const ENS = 's3ntiment.eth';
const NOW = new Date('2026-10-13T12:00:00.000Z');

// Distinct CID strings (the loop treats them as opaque; no real CID math).
const CID_A = 'cid-a';
const CID_B = 'cid-b';
const CID_C = 'cid-c';
const CID_D = 'cid-d';
const CID_E = 'cid-e';

function baseMag(stateDir: string, overrides: Partial<MagazineConfig> = {}): MagazineConfig {
  return {
    domain: DOMAIN,
    ensName: ENS,
    nginxInclude: path.join(stateDir, 'nginx-s3ntiment.conf'),
    stateDir,
    kuboGatewayUrl: 'http://127.0.0.1:28080',
    ...overrides,
  };
}

function baseApp(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    magazines: [],
    rpcUrls: ['https://rpc-a.example', 'https://rpc-b.example'],
    kuboApiUrl: 'http://127.0.0.1:25011',
    kuboGatewayUrl: 'http://127.0.0.1:28080',
    pollIntervalMs: 60_000,
    rollbackDepth: 3,
    nginxTestCmd: 'sudo -n nginx -t',
    nginxReloadCmd: 'sudo -n nginx -s reload',
    alertCmd: null,
    ...overrides,
  };
}

function okOutcome(cid: string | null, blockNumber: bigint | null = 12345n): ResolveOutcome {
  return {
    status: 'ok',
    result: {
      ensName: ENS,
      contenthashHex: cid === null ? null : `0xe30101701220${cid}`,
      cid,
      blockNumber,
      rpcUrl: 'https://rpc-a.example',
      timestamp: Date.now(),
    },
  };
}

interface FakeCalls {
  pinAdd: string[];
  writeNginx: WriteNginxIncludeArgs[];
  unpin: string[];
  alerts: string[];
}

function fakeServices(
  overrides: Partial<SyncServices> = {},
  writeResult: Partial<NginxWriteResult> = {},
): { services: SyncServices; calls: FakeCalls } {
  const calls: FakeCalls = { pinAdd: [], writeNginx: [], unpin: [], alerts: [] };
  const services: SyncServices = {
    resolve: async () => okOutcome(CID_E),
    pinAdd: async (cid) => {
      calls.pinAdd.push(cid);
      return { cid, pinned: true };
    },
    unpin: async (cid) => {
      calls.unpin.push(cid);
    },
    writeNginx: async (args) => {
      calls.writeNginx.push(args);
      return {
        includePath: args.includePath,
        wrote: true,
        testOk: true,
        reloaded: true,
        ...writeResult,
      };
    },
    alert: (msg) => {
      calls.alerts.push(msg);
    },
    now: () => NOW,
    ...overrides,
  };
  return { services, calls };
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lastmile-sync-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('syncMagazine — updated', () => {
  it('pins, writes nginx with cid+s2sJsonPath, persists state+s2s.json, unpins trimmed cids', async () => {
    const mag = baseMag(dir);
    const app = baseApp({ magazines: [mag], rollbackDepth: 3 });

    // Seed a previous state with a 4-deep history; depth 3 keeps head + 1,
    // trimming the 2 oldest.
    const seeded: MagazineState = {
      domain: DOMAIN,
      ensName: ENS,
      cid: CID_A,
      previousCids: [CID_B, CID_C, CID_D],
      blockNumber: '100',
      rpcs: app.rpcUrls,
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    writeState(dir, seeded);

    const { services, calls } = fakeServices();
    const result = await syncMagazine(mag, app, services, { now: NOW });

    expect(result.status).toBe('updated');
    expect(result.cid).toBe(CID_E);
    expect(result.blockNumber).toBe('12345');

    // pinAdd first, with the freshly resolved CID.
    expect(calls.pinAdd).toEqual([CID_E]);

    // writeNginx with the right args.
    expect(calls.writeNginx).toHaveLength(1);
    expect(calls.writeNginx[0]).toEqual({
      includePath: mag.nginxInclude,
      domain: DOMAIN,
      ensName: ENS,
      cid: CID_E,
      s2sJsonPath: path.join(dir, 's2s.json'),
      gatewayBase: mag.kuboGatewayUrl,
    });

    // state.json: new cid, reconciled domain/ensName, trimmed history, pinned rpcs.
    const state = readJson(path.join(dir, 'state.json')) as MagazineState;
    expect(state.cid).toBe(CID_E);
    expect(state.domain).toBe(DOMAIN);
    expect(state.ensName).toBe(ENS);
    expect(state.previousCids).toEqual([CID_A, CID_B]);
    expect(state.blockNumber).toBe('12345');
    expect(state.rpcs).toEqual(app.rpcUrls);
    expect(state.updatedAt).toBe(NOW.toISOString());

    // s2s.json mirror.
    const s2s = readJson(path.join(dir, 's2s.json')) as Record<string, unknown>;
    expect(s2s).toEqual({
      name: ENS,
      cid: CID_E,
      blockNumber: '12345',
      timestamp: NOW.toISOString(),
      rpcs: app.rpcUrls,
    });

    // Only the cids trimmed out of depth are unpinned.
    expect(calls.unpin).toEqual([CID_C, CID_D]);
    expect(calls.alerts).toEqual([]);
  });

  it('handles a null resolved blockNumber as null', async () => {
    const mag = baseMag(dir);
    const app = baseApp({ magazines: [mag] });
    const { services } = fakeServices({ resolve: async () => okOutcome(CID_E, null) });

    const result = await syncMagazine(mag, app, services, { now: NOW });
    expect(result.status).toBe('updated');
    expect(result.blockNumber).toBeNull();

    const state = readJson(path.join(dir, 'state.json')) as MagazineState;
    expect(state.blockNumber).toBeNull();
  });
});

describe('syncMagazine — unchanged', () => {
  it('same cid -> no pin, no nginx write, no state write', async () => {
    const mag = baseMag(dir);
    const app = baseApp({ magazines: [mag] });

    const seeded: MagazineState = {
      domain: DOMAIN,
      ensName: ENS,
      cid: CID_A,
      previousCids: [CID_B],
      blockNumber: '100',
      rpcs: app.rpcUrls,
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    writeState(dir, seeded);
    const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');

    const { services, calls } = fakeServices({ resolve: async () => okOutcome(CID_A) });
    const result = await syncMagazine(mag, app, services, { now: NOW });

    expect(result.status).toBe('unchanged');
    expect(result.cid).toBe(CID_A);
    expect(result.blockNumber).toBe('100');
    expect(calls.pinAdd).toEqual([]);
    expect(calls.writeNginx).toEqual([]);
    expect(calls.unpin).toEqual([]);
    expect(calls.alerts).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).toBe(before);
  });
});

describe('syncMagazine — resolution failures fail closed', () => {
  it('resolve throwing -> error, alert, no pin / no nginx / no state write', async () => {
    const mag = baseMag(dir);
    const app = baseApp({ magazines: [mag] });
    const { services, calls } = fakeServices({
      resolve: async () => {
        throw new Error('rpc boom');
      },
    });

    const result = await syncMagazine(mag, app, services, { now: NOW });
    expect(result.status).toBe('error');
    expect(result.cid).toBeNull();
    expect(result.detail).toContain('rpc boom');
    expect(calls.alerts).toHaveLength(1);
    expect(calls.alerts[0]).toContain('rpc boom');
    expect(calls.pinAdd).toEqual([]);
    expect(calls.writeNginx).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(false);
  });

  it('disagreement -> error, alert with detail, fail closed', async () => {
    const mag = baseMag(dir);
    const app = baseApp({ magazines: [mag] });
    const { services, calls } = fakeServices({
      resolve: async () => ({
        status: 'disagreement' as const,
        results: [],
        detail: 'CID disagreement across RPCs: a, b',
      }),
    });

    const result = await syncMagazine(mag, app, services, { now: NOW });
    expect(result.status).toBe('error');
    expect(result.detail).toBe('CID disagreement across RPCs: a, b');
    expect(calls.alerts).toEqual(['CID disagreement across RPCs: a, b']);
    expect(calls.pinAdd).toEqual([]);
    expect(calls.writeNginx).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(false);
  });

  it('null contenthash -> error, alert, fail closed', async () => {
    const mag = baseMag(dir);
    const app = baseApp({ magazines: [mag] });
    const { services, calls } = fakeServices({ resolve: async () => okOutcome(null) });

    const result = await syncMagazine(mag, app, services, { now: NOW });
    expect(result.status).toBe('error');
    expect(result.detail).toBe(`no contenthash on ${ENS}`);
    expect(calls.alerts).toEqual([`no contenthash on ${ENS}`]);
    expect(calls.pinAdd).toEqual([]);
    expect(calls.writeNginx).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(false);
  });
});

describe('syncMagazine — pin/nginx failures stall', () => {
  it('pinAdd throwing -> stalled, no writeNginx, no state write, alert', async () => {
    const mag = baseMag(dir);
    const app = baseApp({ magazines: [mag] });
    const { services, calls } = fakeServices({
      pinAdd: async () => {
        throw new Error('pin boom');
      },
    });

    const result = await syncMagazine(mag, app, services, { now: NOW });
    expect(result.status).toBe('stalled');
    expect(result.detail).toContain('pin boom');
    expect(calls.alerts).toHaveLength(1);
    expect(calls.writeNginx).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(false);
  });

  it('writeNginx wrote:false -> stalled, no state write, alert', async () => {
    const mag = baseMag(dir);
    const app = baseApp({ magazines: [mag] });
    const { services, calls } = fakeServices(
      {},
      { wrote: false, testOk: false, reloaded: false },
    );

    const result = await syncMagazine(mag, app, services, { now: NOW });
    expect(result.status).toBe('stalled');
    expect(calls.pinAdd).toEqual([CID_E]); // pin happened first
    expect(calls.writeNginx).toHaveLength(1);
    expect(calls.alerts).toHaveLength(1);
    expect(calls.unpin).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 's2s.json'))).toBe(false);
  });
});

describe('syncMagazine — reconcile', () => {
  it('pre-seeded empty domain/ensName (corrupt fallback) -> persisted state has mag values', async () => {
    const mag = baseMag(dir);
    const app = baseApp({ magazines: [mag] });

    // Simulate what loadState returns on a corrupt/missing file: domain/ensName "".
    const corrupt: MagazineState = {
      domain: '',
      ensName: '',
      cid: CID_A,
      previousCids: [CID_B],
      blockNumber: '100',
      rpcs: app.rpcUrls,
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    writeState(dir, corrupt);

    const { services } = fakeServices(); // resolves CID_E (new)
    const result = await syncMagazine(mag, app, services, { now: NOW });
    expect(result.status).toBe('updated');

    const state = readJson(path.join(dir, 'state.json')) as MagazineState;
    expect(state.domain).toBe(DOMAIN);
    expect(state.ensName).toBe(ENS);
    expect(state.cid).toBe(CID_E);

    const s2s = readJson(path.join(dir, 's2s.json')) as Record<string, unknown>;
    expect(s2s.name).toBe(ENS);
  });
});

describe('makeDefaultServices', () => {
  it('wires mag.kuboApiUrl ?? app.kuboApiUrl for the Kubo client', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 } as unknown as Response));
    vi.stubGlobal('fetch', fetchMock);

    const magWithOverride = baseMag(dir, { kuboApiUrl: 'http://mag-api:25011' });
    const app = baseApp({ kuboApiUrl: 'http://app-api:25011' });

    // mag override wins.
    const servicesMag = makeDefaultServices(app, magWithOverride);
    await servicesMag.pinAdd(CID_A);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^http:\/\/mag-api:25011\/api\/v0\/pin\/add/);

    // no mag -> app.kuboApiUrl.
    fetchMock.mockClear();
    const servicesApp = makeDefaultServices(app);
    await servicesApp.pinAdd(CID_A);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^http:\/\/app-api:25011\/api\/v0\/pin\/add/);
  });
});
