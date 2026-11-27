// ============================================================================
// `registerOnInstall` — the post-install handle step, exercised for real.
//
// The command-level tests mock this function whole, so its note branches never
// ran. Here the registry is the real module and only its seams are faked:
//
//   * a codeless registry is "not deployed yet", not an RPC failure;
//   * a Safe with no records module is refused before any check;
//   * an invalid name carries the registry's own sentence;
//   * no `--handle` reads what the Safe holds and registers nothing;
//   * a sole-owned Safe registers and reads the name back;
//   * a multisig gets the self-call to propose, and nothing is sent.
// ============================================================================

import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, type Address } from 'viem';
import { S2SRegistry } from '@s2s/author-contracts';
import { describe, expect, it } from 'vitest';

import {
  registerOnInstall,
  ZERO_ADDRESS,
  type RegistryDeps,
  type RegistryEntry,
} from '../src/core/author-registry';
import type { CliConfig } from '../src/core/config';

const SAFE = '0x934E20411C9E8E92946BD8786D7c3E5bC4DB1387' as Address;
const OTHER = '0x1111111111111111111111111111111111111111' as Address;
const REGISTRY = '0x00000000000000000000000000000000000000c1' as Address;
const RECORDS = '0x0000000000000000000000000000000000000d06' as Address;
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const OWNER = privateKeyToAccount(KEY).address;
const RPC = 'http://127.0.0.1:8545';

const CONFIG = { contracts: { registry: REGISTRY } } as unknown as CliConfig;

const ZERO_ENTRY: RegistryEntry = {
  safe: ZERO_ADDRESS,
  handle: '',
  version: 0,
  registeredAt: 0,
  recordsLocation: ZERO_ADDRESS,
};

interface FakeOptions {
  /** Whether the registry address carries code. */
  deployed?: boolean;
  /** What the Safe holds before the run. */
  name?: string;
  /** The registry's answer for `check`. */
  available?: boolean;
  reason?: number;
  owners?: { owners: Address[]; threshold: number };
}

function fakeDeps(options: FakeOptions = {}) {
  const names = new Map<Address, string>();
  if (options.name) names.set(SAFE, options.name);

  const sent: { method: string; args: unknown[] }[] = [];

  const deps: RegistryDeps = {
    readHasCode: () => Promise.resolve(options.deployed ?? true),
    check: () =>
      Promise.resolve({
        available: options.available ?? true,
        reason: options.reason ?? 0,
      }),
    nameOf: ({ safe }) => Promise.resolve(names.get(safe) ?? null),
    entry: () => Promise.resolve(ZERO_ENTRY),
    versionOf: () => Promise.resolve(0),
    resolve: ({ handle }) =>
      Promise.resolve(names.get(SAFE) === handle ? SAFE : null),
    readOwners: () => Promise.resolve(options.owners ?? { owners: [OWNER], threshold: 1 }),
    openRunner: () =>
      Promise.resolve({
        genericTx: (_to: Address, _abi: string, method: string, args: unknown[]) => {
          sent.push({ method, args });
          if (method === 'register') names.set(SAFE, args[0] as string);
          return Promise.resolve('0xdeadbeef');
        },
      }),
  };

  return { deps, sent };
}

function opts(overrides: Partial<Parameters<typeof registerOnInstall>[0]> = {}) {
  return {
    config: CONFIG,
    safe: SAFE,
    records: RECORDS,
    privateKey: KEY,
    rpcUrl: RPC,
    ...overrides,
  };
}

describe('registerOnInstall', () => {
  it('says the registry is not deployed rather than failing the install', async () => {
    const { deps, sent } = fakeDeps({ deployed: false });

    const report = await registerOnInstall(opts({ handle: 'alice' }), deps);

    expect(report.handle).toBeNull();
    expect(report.handleNote).toContain('is not deployed yet');
    expect(sent).toHaveLength(0);
  });

  it('refuses before check when the Safe has no records module', async () => {
    const { deps, sent } = fakeDeps();

    const report = await registerOnInstall(opts({ handle: 'alice', records: null }), deps);

    expect(report.handle).toBeNull();
    expect(report.handleNote).toContain('no records module');
    expect(sent).toHaveLength(0);
  });

  it('carries the registry sentence for an invalid name', async () => {
    const { deps, sent } = fakeDeps({ available: false, reason: 1 });

    const report = await registerOnInstall(opts({ handle: 'al ice' }), deps);

    expect(report.handle).toBeNull();
    expect(report.handleNote).toContain("the handle 'al ice' was not registered");
    expect(report.handleNote).toContain('outside a-z, 0-9');
    expect(sent).toHaveLength(0);
  });

  it('with no --handle reports what the Safe holds and registers nothing', async () => {
    const { deps, sent } = fakeDeps({ name: 'zomi' });

    const report = await registerOnInstall(opts(), deps);

    expect(report).toEqual({ handle: 'zomi' });
    expect(sent).toHaveLength(0);
  });

  it('with no --handle and an empty Safe says nothing', async () => {
    const { deps, sent } = fakeDeps();

    const report = await registerOnInstall(opts(), deps);

    expect(report).toEqual({ handle: null });
    expect(sent).toHaveLength(0);
  });

  it('registers on a sole-owned Safe and reads the name back', async () => {
    const { deps, sent } = fakeDeps();

    const report = await registerOnInstall(opts({ handle: 'alice' }), deps);

    expect(report).toEqual({ handle: 'alice' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('register');
    expect(sent[0]?.args).toEqual(['alice', RECORDS]);
  });

  it('hands a multisig the self-call to propose instead of sending', async () => {
    const { deps, sent } = fakeDeps({
      owners: { owners: [OWNER, OTHER], threshold: 2 },
    });

    const report = await registerOnInstall(opts({ handle: 'alice' }), deps);

    expect(sent).toHaveLength(0);
    expect(report.handle).toBeNull();
    expect(report.handleNote).toContain('needs owner signatures (2-of-2)');
    expect(report.handleSafeTxs).toEqual([
      {
        to: SAFE,
        data: encodeFunctionData({
          abi: S2SRegistry,
          functionName: 'register',
          args: ['alice', RECORDS],
        }),
      },
    ]);
  });
});
