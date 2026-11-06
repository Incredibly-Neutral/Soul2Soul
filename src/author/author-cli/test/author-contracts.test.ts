// ============================================================================
// The author contracts install, against a fake chain.
//
// No network, no bundler, no Safe: the seam (`AuthorContractsSeam`) is replaced
// with a mutable fake that answers the factory index, the guard slot and the
// owners, and records every userOp the install sends. What is under test is the
// DECISION — which of the four states a Safe is in, and what gets sent — not
// viem's encoding.
// ============================================================================

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeFunctionData, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';

import { safeAbi } from '@s2s/soul2soul-shared';

import {
  authorContractsFactory,
  DEFAULT_AUTHOR_CONTRACTS_FACTORY,
  installAuthorContracts,
  SAFE_GUARD_SLOT,
  type AuthorContracts,
  type AuthorContractsSeam,
} from '../src/core/author-contracts';
import type { CliOut } from '../src/lib/out';
import { readAuthors, writeAuthors, writeBackAuthorContracts } from '../src/core/authors';
import type { CliConfig } from '../src/core/config';

const FACTORY = '0xbf394ea4e984D473cAFE094a27B88aeaeD788d6A' as Address;
const SAFE = '0x934E20411C9E8E92946BD8786D7c3E5bC4DB1387' as Address;
const OTHER_SAFE = '0x1111111111111111111111111111111111111111' as Address;
const DRAFTS = '0x0000000000000000000000000000000000000d01' as Address;
const HISTORY = '0x0000000000000000000000000000000000000d02' as Address;
const GUARD = '0x0000000000000000000000000000000000000d03' as Address;
const FOREIGN_GUARD = '0x0000000000000000000000000000000000000d04' as Address;

const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
/** The EOA the test key derives to: `installAuthorContracts` derives it itself. */
const PRIVATE_KEY_ADDRESS = privateKeyToAccount(PRIVATE_KEY).address;

const quietOut: CliOut = {
  json: false,
  log: () => undefined,
  warn: () => undefined,
  result: () => undefined,
};

/** A config with a bundler endpoint and the factory — enough for the install. */
function configWith(overrides: Record<string, unknown> = {}): CliConfig {
  return {
    bundler: { url: 'http://127.0.0.1:4337' },
    paymaster: {},
    contracts: { authorFactory: FACTORY },
    ...overrides,
  } as unknown as CliConfig;
}

interface Call {
  to: string;
  functionName: string;
  args: unknown[];
}

interface FakeChainOptions {
  drafts?: Address[];
  history?: Address[];
  /** The guard the factory binds to the newest history module. */
  boundGuard?: Address | null;
  /** The guard actually in the Safe's slot. */
  slotGuard?: Address | null;
  owners?: Address[];
  threshold?: number;
  /** Make every read fail, as a dead RPC does. */
  unreachable?: boolean;
}

/**
 * The fake chain: mutable state the seam reads, and the userOps written into it.
 * Each fake write updates the state the next read sees, so a re-read after a
 * `create*Module` returns what the real factory index would.
 */
function fakeChain(options: FakeChainOptions = {}) {
  const state = {
    drafts: [...(options.drafts ?? [])],
    history: [...(options.history ?? [])],
    boundGuard: options.boundGuard ?? GUARD,
    slotGuard: options.slotGuard ?? null,
    owners: options.owners ?? [PRIVATE_KEY_ADDRESS],
    threshold: options.threshold ?? 1,
    deployed: true,
  };
  const calls: Call[] = [];
  const seen = { ensureSafe: 0, openRunner: 0, readGuard: 0, readOwners: 0 };

  const readContracts = (): Promise<AuthorContracts> => {
    if (options.unreachable) return Promise.reject(new Error('fetch failed'));
    const drafts = state.drafts[state.drafts.length - 1] ?? null;
    const ownerHistory = state.history[state.history.length - 1] ?? null;
    return Promise.resolve({
      factory: FACTORY,
      drafts,
      ownerHistory,
      guard: ownerHistory === null ? null : state.boundGuard,
    });
  };

  const seam: AuthorContractsSeam = {
    readContracts,
    readGuard: () => {
      seen.readGuard += 1;
      return Promise.resolve(state.slotGuard);
    },
    readOwners: () => {
      seen.readOwners += 1;
      return Promise.resolve({ owners: state.owners, threshold: state.threshold });
    },
    ensureSafe: () => {
      seen.ensureSafe += 1;
      if (options.unreachable) return Promise.reject(new Error('fetch failed'));
      return Promise.resolve({
        address: SAFE,
        eoa: PRIVATE_KEY_ADDRESS,
        deployed: state.deployed,
        txHash: undefined,
      });
    },
    openRunner: () => {
      seen.openRunner += 1;
      return Promise.resolve({
        genericTx: (
          to: string,
          _signature: string,
          functionName: string,
          args: unknown[],
        ): Promise<string> => {
          calls.push({ to, functionName, args });
          if (functionName === 'createDraftsModule') state.drafts.push(DRAFTS);
          if (functionName === 'createOwnerHistoryModule') state.history.push(HISTORY);
          if (functionName === 'setGuard') state.slotGuard = args[0] as Address;
          return Promise.resolve(`0x${String(calls.length).padStart(64, '0')}`);
        },
      });
    },
  };

  return { seam, calls, state, seen };
}

describe('installAuthorContracts', () => {
  it('installs the drafts module, the owner-history module and the guard on a bare Safe', async () => {
    const { seam, calls } = fakeChain();

    const result = await installAuthorContracts(
      { config: configWith(), safe: SAFE, rpcUrl: 'http://127.0.0.1:8545', privateKey: PRIVATE_KEY, out: quietOut },
      seam,
    );

    expect(result.state).toBe('installed');
    expect(result.txs).toHaveLength(3);
    expect(calls.map((call) => call.functionName)).toEqual([
      'createDraftsModule',
      'createOwnerHistoryModule',
      'setGuard',
    ]);
    // The factory calls name the Safe as the beneficiary; the guard call is the
    // Safe calling itself.
    expect(calls[0]?.to).toBe(FACTORY);
    expect(calls[1]?.to).toBe(FACTORY);
    expect(calls[2]?.to).toBe(SAFE);
    expect(calls[2]?.args).toEqual([GUARD]);

    expect(result.drafts).toBe(DRAFTS);
    expect(result.ownerHistory).toBe(HISTORY);
    expect(result.guard).toBe(GUARD);
    expect(result.safeTx).toBeUndefined();
  });

  it('never calls enableModule — neither module needs module powers', async () => {
    const { seam, calls } = fakeChain();
    await installAuthorContracts(
      { config: configWith(), safe: SAFE, rpcUrl: 'http://127.0.0.1:8545', privateKey: PRIVATE_KEY, out: quietOut },
      seam,
    );
    expect(calls.some((call) => call.functionName === 'enableModule')).toBe(false);
  });

  it('is a no-op when everything is already installed', async () => {
    const { seam, calls, seen } = fakeChain({
      drafts: [DRAFTS],
      history: [HISTORY],
      slotGuard: GUARD,
    });

    const result = await installAuthorContracts(
      { config: configWith(), safe: SAFE, rpcUrl: 'http://127.0.0.1:8545', privateKey: PRIVATE_KEY, out: quietOut },
      seam,
    );

    expect(result.state).toBe('already');
    expect(result.txs).toEqual([]);
    expect(calls).toHaveLength(0);
    // The Safe was already live: no deployment, no runner, no userOp.
    expect(seen.openRunner).toBe(0);
    expect(seen.ensureSafe).toBe(1);
  });

  it('installs only what is missing (a Safe with the drafts module already)', async () => {
    const { seam, calls } = fakeChain({ drafts: [DRAFTS] });

    const result = await installAuthorContracts(
      { config: configWith(), safe: SAFE, rpcUrl: 'http://127.0.0.1:8545', privateKey: PRIVATE_KEY, out: quietOut },
      seam,
    );

    expect(result.state).toBe('installed');
    expect(calls.map((call) => call.functionName)).toEqual(['createOwnerHistoryModule', 'setGuard']);
    expect(calls.some((call) => call.functionName === 'createDraftsModule')).toBe(false);
  });

  it('never overwrites a foreign guard — reports the Safe transaction instead', async () => {
    const { seam, calls } = fakeChain({
      drafts: [DRAFTS],
      history: [HISTORY],
      slotGuard: FOREIGN_GUARD,
    });

    const result = await installAuthorContracts(
      { config: configWith(), safe: SAFE, rpcUrl: 'http://127.0.0.1:8545', privateKey: PRIVATE_KEY, out: quietOut },
      seam,
    );

    expect(result.state).toBe('pending-safe');
    expect(calls).toHaveLength(0);
    expect(result.note).toContain(FOREIGN_GUARD);
    expect(result.safeTx).toEqual({
      to: SAFE,
      data: encodeFunctionData({ abi: safeAbi, functionName: 'setGuard', args: [GUARD] }),
    });
  });

  it('installs the permissionless modules but leaves the guard to a multisig', async () => {
    const { seam, calls, state } = fakeChain({
      owners: [PRIVATE_KEY_ADDRESS, OTHER_SAFE],
      threshold: 2,
    });

    const result = await installAuthorContracts(
      { config: configWith(), safe: SAFE, rpcUrl: 'http://127.0.0.1:8545', privateKey: PRIVATE_KEY, out: quietOut },
      seam,
    );

    expect(result.state).toBe('pending-safe');
    expect(calls.map((call) => call.functionName)).toEqual([
      'createDraftsModule',
      'createOwnerHistoryModule',
    ]);
    expect(calls.some((call) => call.functionName === 'setGuard')).toBe(false);
    expect(state.slotGuard).toBeNull();
    expect(result.safeTx?.to).toBe(SAFE);
    expect(result.note).toContain('2-of-2');
  });

  it('treats a single-owner Safe owned by another key as a multisig', async () => {
    // A 1-of-1 Safe whose owner is NOT this key: the userOp would revert, so the
    // guard must go through the Safe's own owners.
    const { seam, calls } = fakeChain({ owners: [OTHER_SAFE], threshold: 1 });

    const result = await installAuthorContracts(
      { config: configWith(), safe: SAFE, rpcUrl: 'http://127.0.0.1:8545', privateKey: PRIVATE_KEY, out: quietOut },
      seam,
    );

    expect(result.state).toBe('pending-safe');
    expect(calls.some((call) => call.functionName === 'setGuard')).toBe(false);
    expect(result.safeTx?.to).toBe(SAFE);
  });

  it('skips without a bundler, naming the env vars, and never throws', async () => {
    const { seam, seen } = fakeChain();
    const config = { bundler: {}, paymaster: {}, contracts: { authorFactory: FACTORY } } as unknown as CliConfig;

    const result = await installAuthorContracts(
      { config, safe: SAFE, rpcUrl: 'http://127.0.0.1:8545', privateKey: PRIVATE_KEY, out: quietOut },
      seam,
    );

    expect(result.state).toBe('skipped');
    expect(result.txs).toEqual([]);
    expect(result.note).toContain('S2S_PIMLICO_KEY');
    expect(result.note).toContain('S2S_BUNDLER_URL');
    // Nothing was attempted beyond the best-effort read.
    expect(seen.ensureSafe).toBe(0);
    expect(seen.openRunner).toBe(0);
  });

  it('skips when the chain cannot be reached, naming the RPC env vars', async () => {
    const { seam, calls } = fakeChain({ unreachable: true });

    const result = await installAuthorContracts(
      { config: configWith(), safe: SAFE, rpcUrl: 'http://127.0.0.1:8545', privateKey: PRIVATE_KEY, out: quietOut },
      seam,
    );

    expect(result.state).toBe('skipped');
    expect(result.txs).toEqual([]);
    expect(result.note).toContain('S2S_RPC_L2');
    expect(result.note).toContain('BASE_RPC_URL');
    expect(calls).toHaveLength(0);
  });

  it('reports the modules as installed when the guard cannot be bound yet', async () => {
    // The history module was submitted but the index has not caught up: the
    // modules are real, the guard step is the next run's.
    const { seam } = fakeChain({ drafts: [DRAFTS] });

    const result = await installAuthorContracts(
      { config: configWith(), safe: SAFE, rpcUrl: 'http://127.0.0.1:8545', privateKey: PRIVATE_KEY, out: quietOut },
      {
        ...seam,
        readContracts: () =>
          Promise.resolve({
            factory: FACTORY,
            drafts: DRAFTS,
            ownerHistory: null,
            guard: null,
          }),
      },
    );

    expect(result.state).toBe('installed');
    expect(result.txs).toHaveLength(1);
    expect(result.note).toContain('run again');
  });
});

describe('authorContractsFactory', () => {
  const saved = process.env.S2S_AUTHOR_CONTRACTS_FACTORY;

  afterEach(() => {
    if (saved === undefined) delete process.env.S2S_AUTHOR_CONTRACTS_FACTORY;
    else process.env.S2S_AUTHOR_CONTRACTS_FACTORY = saved;
  });

  it('reads contracts.authorFactory from the config', () => {
    delete process.env.S2S_AUTHOR_CONTRACTS_FACTORY;
    expect(authorContractsFactory(configWith())).toBe(FACTORY);
  });

  it('falls back to the env var, then to the shipped default', () => {
    delete process.env.S2S_AUTHOR_CONTRACTS_FACTORY;
    expect(authorContractsFactory({} as unknown as CliConfig)).toBe(DEFAULT_AUTHOR_CONTRACTS_FACTORY);

    process.env.S2S_AUTHOR_CONTRACTS_FACTORY = OTHER_SAFE;
    expect(authorContractsFactory({} as unknown as CliConfig)).toBe(OTHER_SAFE);
  });

  it('rejects a non-address as a usage error', () => {
    expect(() => authorContractsFactory({ contracts: { authorFactory: 'nope' } } as unknown as CliConfig)).toThrow(
      /not an address/,
    );
  });
});

describe('the Safe guard slot', () => {
  it('pins the guard-manager slot (getGuard() is internal in Safe 1.4.1)', () => {
    expect(SAFE_GUARD_SLOT).toBe(
      '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8',
    );
  });
});

describe('the author contracts record', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('round-trips through the authors file and is a no-op when unchanged', () => {
    dir = mkdtempSync(join(tmpdir(), 's2s-contracts-'));
    const file = join(dir, 'authors.json');
    writeAuthors({ active: 'alice', authors: { alice: { privateKey: PRIVATE_KEY, safe: SAFE } } }, file);

    const contracts = { drafts: DRAFTS, ownerHistory: HISTORY, guard: GUARD };
    expect(writeBackAuthorContracts('alice', contracts, file)).toBe(true);
    expect(readAuthors(file).authors.alice?.contracts).toEqual(contracts);

    // A second identical write is a no-op — an idempotent install writes nothing.
    expect(writeBackAuthorContracts('alice', contracts, file)).toBe(false);
    // An unknown pet name writes nothing rather than creating a half-row.
    expect(writeBackAuthorContracts('nobody', contracts, file)).toBe(false);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { authors: Record<string, unknown> };
    expect(parsed.authors.nobody).toBeUndefined();
  });

  it('tolerates a row without the contracts field (no migration)', () => {
    dir = mkdtempSync(join(tmpdir(), 's2s-contracts-'));
    const file = join(dir, 'authors.json');
    writeAuthors({ active: 'bob', authors: { bob: { privateKey: PRIVATE_KEY, safe: null } } }, file);

    const record = readAuthors(file).authors.bob;
    expect(record?.contracts).toBeUndefined();
    expect(writeBackAuthorContracts('bob', { drafts: null, ownerHistory: null, guard: null }, file)).toBe(true);
    expect(readAuthors(file).authors.bob?.contracts).toEqual({
      drafts: null,
      ownerHistory: null,
      guard: null,
    });
  });
});
