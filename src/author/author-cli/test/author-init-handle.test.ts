// ============================================================================
// `s2s author init --handle` — the same post-install handle step `author new`
// carries, on the recovery path.
//
// The Safe deploy, the contract install and the registry step are mocked; what
// is under test is the wiring: the flag reaches `registerOnInstall`, the answer
// lands in the `contracts` block under `handle` / `handleNote`, and a refused
// handle is a note rather than a failed init.
// ============================================================================

import { describe, expect, it, vi } from 'vitest';

import type { Address } from 'viem';

import type { CliOut } from '../src/lib/out';

const SAFE = '0x00000000000000000000000000000000000000aa' as Address;
const EOA = '0x00000000000000000000000000000000000000ee' as Address;
const FACTORY = '0x00000000000000000000000000000000000000f1';
const DRAFTS = '0x00000000000000000000000000000000000000d1';
const OWNER_HISTORY = '0x00000000000000000000000000000000000000d2';
const GUARD = '0x00000000000000000000000000000000000000d3';
const RECORDS = '0x00000000000000000000000000000000000000d4';
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const RPC = 'http://127.0.0.1:8545';

interface RegistryCall {
  safe: Address;
  records: Address | null;
  privateKey: string;
  rpcUrl: string;
  handle: string | undefined;
}

const state = vi.hoisted(() => ({
  install: undefined as
    | (() => {
        factory: string;
        drafts: string | null;
        ownerHistory: string | null;
        guard: string | null;
        records: string | null;
        recordsNote?: string;
        state: 'installed' | 'already' | 'pending-safe' | 'skipped';
        txs: string[];
        note?: string;
      })
    | undefined,
  registryCalls: [] as RegistryCall[],
  registryAnswer: undefined as (() => { handle: string | null; handleNote?: string }) | undefined,
}));

vi.mock('../src/core/author-safe', () => ({
  initAuthorSafe: () =>
    Promise.resolve({
      address: SAFE,
      eoa: EOA,
      salt: 's2s_0x00000000000000000000000000000000000000ee',
      safeSource: 'derived',
      chain: 'base',
      deployed: true,
      txHash: undefined,
    }),
}));

vi.mock('../src/core/authors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/authors')>();
  return { ...actual, rememberAuthorSafe: () => undefined, rememberAuthorContracts: () => undefined };
});

vi.mock('../src/core/author-contracts', () => ({
  installAuthorContracts: () => {
    const answer = state.install;
    if (!answer) return Promise.reject(new Error('test did not set an install answer'));
    return Promise.resolve(answer());
  },
}));

vi.mock('../src/core/author-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/author-registry')>();
  return {
    ...actual,
    registerOnInstall: (opts: {
      safe: Address;
      records: Address | null;
      privateKey: string;
      rpcUrl: string;
      handle?: string;
    }): Promise<{ handle: string | null; handleNote?: string }> => {
      state.registryCalls.push({
        safe: opts.safe,
        records: opts.records,
        privateKey: opts.privateKey,
        rpcUrl: opts.rpcUrl,
        handle: opts.handle,
      });
      const answer = state.registryAnswer;
      return Promise.resolve(answer ? answer() : { handle: null });
    },
  };
});

import { authorInit } from '../src/commands/init';

interface Sink {
  out: CliOut;
  data: Record<string, unknown>;
  human: string | undefined;
}

function recorder(): Sink {
  const sink: Sink = { out: undefined as unknown as CliOut, data: {}, human: undefined };
  sink.out = {
    json: false,
    log: () => undefined,
    warn: () => undefined,
    result: (data, human) => {
      sink.data = data as Record<string, unknown>;
      sink.human = human;
    },
  };
  return sink;
}

function context(sink: Sink) {
  return {
    out: sink.out,
    config: { privateKey: KEY, author: { name: 'zomi' } },
    rpcs: { L1: [], L2: [RPC] },
  } as never;
}

function installResult(
  overrides: Partial<{
    state: 'installed' | 'already' | 'pending-safe' | 'skipped';
    records: string | null;
    note: string;
  }> = {},
) {
  return {
    factory: FACTORY,
    drafts: DRAFTS,
    ownerHistory: OWNER_HISTORY,
    guard: GUARD,
    records: RECORDS,
    state: 'installed' as const,
    txs: ['0xtx1'],
    ...overrides,
  };
}

function reset(): void {
  state.install = undefined;
  state.registryCalls.length = 0;
  state.registryAnswer = undefined;
}

describe('author init --handle', () => {
  it('passes the flag and the installed records module to the registry step', async () => {
    reset();
    state.install = () => installResult();
    state.registryAnswer = () => ({ handle: 'zomi' });
    const sink = recorder();

    await authorInit.run(context(sink), { flags: { handle: 'zomi' }, positionals: [] });

    expect(state.registryCalls).toHaveLength(1);
    expect(state.registryCalls[0]).toEqual({
      safe: SAFE,
      records: RECORDS,
      privateKey: KEY,
      rpcUrl: RPC,
      handle: 'zomi',
    });
    const contracts = sink.data.contracts as Record<string, unknown>;
    expect(contracts.handle).toBe('zomi');
    expect(sink.human).toContain('handle      : zomi');
  });

  it('leaves a refused registration as a note', async () => {
    reset();
    state.install = () => installResult();
    state.registryAnswer = () => ({
      handle: null,
      handleNote: "the handle 'taken' was not registered: 'taken' is already registered",
    });
    const sink = recorder();

    await authorInit.run(context(sink), { flags: { handle: 'taken' }, positionals: [] });

    const contracts = sink.data.contracts as Record<string, unknown>;
    expect(contracts.handle).toBeNull();
    expect(contracts.handleNote).toContain('already registered');
    expect(sink.human).toContain('handle note :');
  });

  it('reports what the Safe holds when no --handle was given', async () => {
    reset();
    state.install = () => installResult({ state: 'already' });
    state.registryAnswer = () => ({ handle: 'zomi' });
    const sink = recorder();

    await authorInit.run(context(sink), { flags: {}, positionals: [] });

    expect(state.registryCalls).toHaveLength(1);
    expect(state.registryCalls[0]?.handle).toBeUndefined();
    expect((sink.data.contracts as Record<string, unknown>).handle).toBe('zomi');
  });

  it('leaves the skipped install\'s --handle as a note', async () => {
    reset();
    state.install = () => installResult({ state: 'skipped', records: null, note: 'no records impl' });
    state.registryAnswer = () => ({
      handle: null,
      handleNote: "the handle 'zomi' was not registered: the Safe has no records module",
    });
    const sink = recorder();

    await authorInit.run(context(sink), { flags: { handle: 'zomi' }, positionals: [] });

    expect(state.registryCalls).toHaveLength(1);
    expect(state.registryCalls[0]?.records).toBeNull();
    const contracts = sink.data.contracts as Record<string, unknown>;
    expect(contracts.handleNote).toContain("the handle 'zomi' was not registered");
  });
});
