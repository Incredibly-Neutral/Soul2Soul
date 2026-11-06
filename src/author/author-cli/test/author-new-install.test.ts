// ============================================================================
// `s2s author new` — the author contracts install, and the promise that it is
// an ADDITION to filing a key, never a new way to fail.
//
//   * the key is written before any network call, and stays written whatever the
//     install does;
//   * the install runs against the key that was just filed, not the one the
//     active config holds (`author new` may run with S2S_PRIVATE_KEY set);
//   * `pending-safe` (a Safe that is not deployed yet) is reported with the
//     exact Safe call to propose, not an error;
//   * `skipped` and a thrown chain error are warnings naming `s2s author init`.
//
// `installAuthorContracts` and the Safe prediction are the core worker's
// module; both are mocked here, so this file never touches an RPC. The store is
// real (XDG_CONFIG_HOME points at a temp dir).
// ============================================================================

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliOut } from '../src/lib/out';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const SAFE = '0x00000000000000000000000000000000000000aa';
const FACTORY = '0x00000000000000000000000000000000000000f1';
const DRAFTS = '0x00000000000000000000000000000000000000d1';
const OWNER_HISTORY = '0x00000000000000000000000000000000000000d2';
const GUARD = '0x00000000000000000000000000000000000000d3';
const RPC = 'http://127.0.0.1:0/test-rpc';

interface InstallCall {
  privateKey: string;
  safe: string;
  rpcUrl: string;
  configKey: string | undefined;
}

/** The argument shape `installAuthorContracts` is called with (as we call it). */
interface InstallOpts {
  config: { privateKey?: string };
  safe: string;
  rpcUrl: string;
  privateKey: string;
  out: CliOut;
}

/** The shape the mocked install answers with (mirrors `InstallResult`). */
interface InstallResultLike {
  factory: string;
  drafts: string | null;
  ownerHistory: string | null;
  guard: string | null;
  state: 'installed' | 'already' | 'pending-safe' | 'skipped';
  txs: string[];
  note?: string;
  safeTx?: { to: string; data: string };
}

/** What the mocked install answers, and every argument it was handed. */
const installState = vi.hoisted(() => ({
  calls: [] as InstallCall[],
  /** The InstallResult to return; throwing here exercises the command's catch. */
  answer: undefined as (() => InstallResultLike) | undefined,
  safePrediction: null as { address: `0x${string}`; salt: string; deployed: boolean } | null,
}));

vi.mock('../src/core/author-contracts', () => ({
  authorContractsFactory: () => FACTORY,
  installAuthorContracts: (opts: InstallOpts): Promise<InstallResultLike> => {
    installState.calls.push({
      privateKey: opts.privateKey,
      safe: opts.safe,
      rpcUrl: opts.rpcUrl,
      configKey: opts.config.privateKey,
    });
    const answer = installState.answer;
    if (!answer) return Promise.reject(new Error('test did not set an install answer'));
    try {
      return Promise.resolve(answer());
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  },
  readAuthorContracts: (): Promise<never> =>
    Promise.reject(new Error('readAuthorContracts is not used by author new')),
}));

/** Persist calls, kept separate from the store so the test does not assume the
 * core write-back's field names — only that `author new` asked it to persist. */
const memory = vi.hoisted(() => ({
  contracts: [] as {
    name: string;
    drafts: string | null;
    ownerHistory: string | null;
    guard: string | null;
  }[],
}));

vi.mock('../src/core/authors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/authors')>();
  return {
    ...actual,
    // The store is real; only the contracts write-back is recorded here (its
    // record shape belongs to the core module, not to this command).
    rememberAuthorContracts: (
      name: string,
      contracts: { drafts: string | null; ownerHistory: string | null; guard: string | null },
    ) => {
      memory.contracts.push({ name, ...contracts });
    },
  };
});

vi.mock('../src/core/author-safe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/author-safe')>();
  return {
    ...actual,
    predictAuthorSafe: () => {
      const prediction = installState.safePrediction;
      return prediction
        ? Promise.resolve(prediction)
        : Promise.reject(new Error('test did not set a safe prediction'));
    },
  };
});

vi.mock('../src/adapters/rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/adapters/rpc')>();
  return { ...actual, buildRpcEndpoints: () => ({ L1: [], L2: [RPC] }) };
});

import { authorNew } from '../src/commands/author-new';

/** A `CliOut` that keeps every channel, so a test can assert on each. */
interface Sink {
  out: CliOut;
  warnings: string[];
  logs: string[];
  data: Record<string, unknown>;
  human: string | undefined;
}

function recorder(): Sink {
  const sink: Sink = {
    out: undefined as unknown as CliOut,
    warnings: [],
    logs: [],
    data: {},
    human: undefined,
  };
  sink.out = {
    json: false,
    log: (msg) => sink.logs.push(msg),
    warn: (msg) => sink.warnings.push(msg),
    result: (data, human) => {
      sink.data = data as Record<string, unknown>;
      sink.human = human;
    },
  };
  return sink;
}

function installResult(
  state: InstallResultLike['state'],
  extra: Partial<InstallResultLike> = {},
): InstallResultLike {
  const pending = state === 'pending-safe';
  return {
    factory: FACTORY,
    drafts: pending ? null : DRAFTS,
    ownerHistory: pending ? null : OWNER_HISTORY,
    guard: pending ? null : GUARD,
    state,
    txs: state === 'installed' ? ['0xtx1'] : [],
    ...extra,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's2s-author-new-'));
  vi.stubEnv('XDG_CONFIG_HOME', dir);
  // The active config must NOT be the key under test: the install has to use
  // the key this run filed.
  vi.stubEnv('S2S_PRIVATE_KEY', '0x11'.repeat(32));
  installState.calls.length = 0;
  memory.contracts.length = 0;
  installState.answer = undefined;
  installState.safePrediction = { address: SAFE, salt: 's2s_0x', deployed: false };
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function store(): { authors: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(dir, 's2s', 'authors.json'), 'utf8')) as {
    authors: Record<string, Record<string, unknown>>;
  };
}

describe('author new installs the author contracts', () => {
  it('installs with the key it filed and reports the addresses', async () => {
    installState.answer = () => installResult('installed');
    const sink = recorder();
    await authorNew.run(sink.out, { flags: { key: KEY }, positionals: ['zomi'] });

    expect(installState.calls).toHaveLength(1);
    expect(installState.calls[0]).toEqual({
      privateKey: KEY,
      safe: SAFE,
      rpcUrl: RPC,
      configKey: KEY,
    });

    const contracts = sink.data.contracts as Record<string, unknown>;
    expect(contracts.state).toBe('installed');
    expect(contracts.factory).toBe(FACTORY);
    expect(contracts.drafts).toBe(DRAFTS);
    expect(contracts.ownerHistory).toBe(OWNER_HISTORY);
    expect(contracts.guard).toBe(GUARD);

    expect(sink.human).toContain(`safe        : ${SAFE}`);
    expect(sink.human).toContain(`drafts      : ${DRAFTS}`);
    expect(sink.human).toContain(`ownerHistory: ${OWNER_HISTORY}`);
    expect(sink.human).toContain(`guard       : ${GUARD}`);
    expect(sink.human).toContain('contracts   : installed');
    // A supplied key is never echoed back, whatever the install did.
    expect(sink.data).not.toHaveProperty('privateKey');
  });

  it('records the contracts so author list can report them offline', async () => {
    installState.answer = () => installResult('installed');
    const sink = recorder();
    await authorNew.run(sink.out, { flags: { key: KEY }, positionals: ['zomi'] });

    expect(memory.contracts).toHaveLength(1);
    expect(memory.contracts[0]).toMatchObject({
      name: 'zomi',
      drafts: DRAFTS,
      ownerHistory: OWNER_HISTORY,
      guard: GUARD,
    });
    // The Safe itself is written back by the same run, so the store is current.
    expect(store().authors.zomi?.safe).toBe(SAFE);
  });

  it('reports pending-safe with the call the owners must propose, and does not fail', async () => {
    const safeTx = { to: DRAFTS, data: '0xdeadbeef' };
    installState.answer = () => installResult('pending-safe', { safeTx });
    const sink = recorder();
    await authorNew.run(sink.out, { flags: { key: KEY }, positionals: ['zomi'] });

    const contracts = sink.data.contracts as Record<string, unknown>;
    expect(contracts.state).toBe('pending-safe');
    expect(contracts.safeTx).toEqual(safeTx);
    expect(sink.human).toContain(`to   ${DRAFTS}`);
    expect(sink.human).toContain('data 0xdeadbeef');
    // The drafts module is appended through the proxy: nothing to install.
    expect(sink.human).toContain('needs no install');
    // Still not an error: the author was created.
    expect(sink.data.active).toBe(true);
  });

  it('turns a skipped install into a warning pointing at author init', async () => {
    installState.answer = () =>
      installResult('skipped', {
        drafts: null,
        ownerHistory: null,
        guard: null,
        note: 'install pending the owners of the Safe',
      });
    const sink = recorder();
    await authorNew.run(sink.out, { flags: { key: KEY }, positionals: ['zomi'] });

    expect(sink.warnings.join('\n')).toContain('s2s author init');
    expect(sink.warnings.join('\n')).toContain('install pending the owners of the Safe');
    expect((sink.data.contracts as Record<string, unknown>).state).toBe('skipped');
    // The author itself is still created: the key is filed and active.
    expect(sink.data.name).toBe('zomi');
    expect(sink.data.active).toBe(true);
  });

  it('keeps the key and the command when the chain throws', async () => {
    installState.answer = () => {
      throw new Error('execution reverted: factory out of gas');
    };
    const sink = recorder();
    await authorNew.run(sink.out, { flags: { key: KEY }, positionals: ['zomi'] });

    expect(sink.warnings.join('\n')).toContain('factory out of gas');
    expect(sink.warnings.join('\n')).toContain('s2s author init');
    expect((sink.data.contracts as Record<string, unknown>).state).toBe('skipped');

    const record = store().authors.zomi ?? {};
    expect(String(record.privateKey).toLowerCase()).toBe(KEY.toLowerCase());
    expect(record.safe).toBe(SAFE);
  });
});
