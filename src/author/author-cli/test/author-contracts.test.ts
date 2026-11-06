// ============================================================================
// The author contracts install, against a fake chain.
//
// No network, no bundler, no Safe: the seam (`AuthorContractsSeam`) is replaced
// with a mutable fake that answers the factory index, the guard slot, the guard
// proof (`module()` / `safe()` on the guard and the module) and the owners, and
// records every userOp the install sends. What is under test is the DECISION —
// which of the four states a Safe is in, and what gets sent — not viem's encoding.
// ============================================================================

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';

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
/** A module the factory index names but never minted a guard for. */
const FOREIGN_MODULE = '0x0000000000000000000000000000000000000d05' as Address;

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
  /** What `ensureSafe` reports: false = no code at the address. */
  deployed?: boolean;
  /** Function names whose userOp is sent but changes nothing (a reverted tx). */
  reverted?: string[];
  /** Make the guard-proof reads fail as a flaky RPC does (a transport error). */
  guardReadFails?: boolean;
  /** Make every read fail, as a dead RPC does. */
  unreachable?: boolean;
}

/**
 * The fake chain: mutable state the seam reads, and the userOps written into it.
 * Each fake write updates the state the next read sees, so a re-read after a
 * `create*Module` returns what the real factory index would.
 *
 * The guard proof is faked the same way the chain answers it: `module()` and
 * `safe()` on the guard, `safe()` on the module. No factory takes part. `GUARD`
 * names `HISTORY`; `FOREIGN_GUARD` names a module that is not an owner-history
 * module of this Safe, so it can never be proved ours.
 */
function fakeChain(options: FakeChainOptions = {}) {
  const state = {
    drafts: [...(options.drafts ?? [])],
    history: [...(options.history ?? [])],
    boundGuard: options.boundGuard === undefined ? GUARD : options.boundGuard,
    slotGuard: options.slotGuard ?? null,
    owners: options.owners ?? [PRIVATE_KEY_ADDRESS],
    threshold: options.threshold ?? 1,
    deployed: options.deployed ?? true,
  };
  /** guard → the module it names (`OwnerHistoryGuard.module()`). */
  const guardModules = new Map<string, Address>([
    [GUARD.toLowerCase(), HISTORY],
    [FOREIGN_GUARD.toLowerCase(), FOREIGN_MODULE],
  ]);
  /** guard → the Safe it was minted for (`OwnerHistoryGuard.safe()`). */
  const guardSafes = new Map<string, Address>([
    [GUARD.toLowerCase(), SAFE],
    // A guard from another product, installed on another Safe.
    [FOREIGN_GUARD.toLowerCase(), OTHER_SAFE],
  ]);
  /** module → the Safe it is bound to (`OwnerHistoryModuleV1.safe()`). */
  const moduleSafes = new Map<string, Address>([
    [HISTORY.toLowerCase(), SAFE],
    [DRAFTS.toLowerCase(), SAFE],
    // Not a module at all: it answers nothing, hence no `safe()` binding.
  ]);
  /** module → the guard the factory minted for it (`guardFor`). */
  const minted = new Map<string, Address>();
  if (state.boundGuard !== null) minted.set(HISTORY.toLowerCase(), state.boundGuard);

  const calls: Call[] = [];
  const seen = { ensureSafe: 0, openRunner: 0, readGuard: 0, readOwners: 0 };
  const reverts = new Set(options.reverted ?? []);

  const readContracts = (): Promise<AuthorContracts> => {
    if (options.unreachable) return Promise.reject(new Error('fetch failed'));
    const drafts = state.drafts[state.drafts.length - 1] ?? null;
    const ownerHistory = state.history[state.history.length - 1] ?? null;
    return Promise.resolve({
      factory: FACTORY,
      drafts,
      ownerHistory,
      guard: ownerHistory === null ? null : (minted.get(ownerHistory.toLowerCase()) ?? null),
    });
  };

  /** A flaky RPC read: a transport error, not an answer from the address. */
  const guardReadFails = options.guardReadFails === true;

  const seam: AuthorContractsSeam = {
    readContracts,
    readGuard: () => {
      seen.readGuard += 1;
      return Promise.resolve(state.slotGuard);
    },
    readGuardModule: ({ guard }) => {
      if (guardReadFails) return Promise.reject(new Error('fetch failed: ECONNRESET'));
      return Promise.resolve(guardModules.get(guard.toLowerCase()) ?? null);
    },
    readGuardSafe: ({ guard }) => {
      if (guardReadFails) return Promise.reject(new Error('fetch failed: ECONNRESET'));
      return Promise.resolve(guardSafes.get(guard.toLowerCase()) ?? null);
    },
    readModuleSafe: ({ module }) => {
      if (guardReadFails) return Promise.reject(new Error('fetch failed: ECONNRESET'));
      return Promise.resolve(moduleSafes.get(module.toLowerCase()) ?? null);
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
          if (reverts.has(functionName)) return Promise.resolve(hashFor(calls.length));
          if (functionName === 'createDraftsModule') {
            state.drafts.push(DRAFTS);
            moduleSafes.set(DRAFTS.toLowerCase(), SAFE);
          }
          if (functionName === 'createOwnerHistoryModule') {
            state.history.push(HISTORY);
            moduleSafes.set(HISTORY.toLowerCase(), SAFE);
            minted.set(HISTORY.toLowerCase(), GUARD);
            guardModules.set(GUARD.toLowerCase(), HISTORY);
          }
          if (functionName === 'setGuard') state.slotGuard = args[0] as Address;
          return Promise.resolve(hashFor(calls.length));
        },
      });
    },
  };

  return { seam, calls, state, seen };
}

/** The hash the n-th userOp of a fake run resolves with. */
function hashFor(n: number): string {
  return `0x${String(n).padStart(64, '0')}`;
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

  it('never overwrites a foreign guard — and offers no call that would', async () => {
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
    // `safe()` names another Safe: the immutables cannot prove it is ours.
    expect(result.safeTx).toBeUndefined();
  });

  it('is `already` when a griefer appends a module to the factory index', async () => {
    // Any address can push an index entry. The guard's own immutables are what
    // decide, so the healthy author stays installed and nothing is sent.
    const { seam, calls, state } = fakeChain({
      drafts: [DRAFTS],
      history: [HISTORY, FOREIGN_MODULE],
      slotGuard: GUARD,
    });

    const result = await installAuthorContracts(
      { config: configWith(), safe: SAFE, rpcUrl: 'http://127.0.0.1:8545', privateKey: PRIVATE_KEY, out: quietOut },
      seam,
    );

    expect(result.state).toBe('already');
    expect(result.ownerHistory).toBe(HISTORY);
    expect(result.guard).toBe(GUARD);
    expect(result.safeTx).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(state.slotGuard).toBe(GUARD);
  });

  it('is `already` when the configured factory is another deployment', async () => {
    // The guard was minted by a factory this config no longer names (a dev chain,
    // a redeploy). The proof has no factory in it, so the author is installed.
    const { seam, calls } = fakeChain({
      drafts: [DRAFTS],
      history: [HISTORY],
      // `guardFor` answers nothing: this factory never minted this guard.
      boundGuard: null,
      slotGuard: GUARD,
    });

    const result = await installAuthorContracts(
      { config: configWith(), safe: SAFE, rpcUrl: 'http://127.0.0.1:8545', privateKey: PRIVATE_KEY, out: quietOut },
      seam,
    );

    expect(result.state).toBe('already');
    expect(result.guard).toBe(GUARD);
    expect(result.ownerHistory).toBe(HISTORY);
    expect(result.note).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('does not call an unreadable guard foreign — a transport error is reported', async () => {
    // A flaky RPC read is not an answer from the chain. It must reach the
    // caller's note, not the "remove that guard" advice.
    const { seam, calls } = fakeChain({
      drafts: [DRAFTS],
      history: [HISTORY],
      slotGuard: GUARD,
      guardReadFails: true,
    });

    const result = await installAuthorContracts(
      { config: configWith(), safe: SAFE, rpcUrl: 'http://127.0.0.1:8545', privateKey: PRIVATE_KEY, out: quietOut },
      seam,
    );

    expect(result.state).toBe('skipped');
    expect(result.note).toContain('ECONNRESET');
    expect(result.note).not.toMatch(/did not install/);
    expect(result.safeTx).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('creates a missing drafts proxy on a Safe that already carries the guard', async () => {
    // The README's manual order with step 1 skipped: the guard is right, the
    // drafts proxy is absent. `already` would leave it absent for ever.
    const { seam, calls } = fakeChain({ history: [HISTORY], slotGuard: GUARD });

    const result = await installAuthorContracts(
      { config: configWith(), safe: SAFE, rpcUrl: 'http://127.0.0.1:8545', privateKey: PRIVATE_KEY, out: quietOut },
      seam,
    );

    expect(calls.map((call) => call.functionName)).toEqual(['createDraftsModule']);
    expect(calls[0]?.to).toBe(FACTORY);
    expect(result.state).toBe('installed');
    expect(result.drafts).toBe(DRAFTS);
    expect(result.ownerHistory).toBe(HISTORY);
    expect(result.guard).toBe(GUARD);
    expect(result.txs).toHaveLength(1);
  });

  it('is `pending-safe` when the drafts proxy could not be created', async () => {
    const { seam, calls } = fakeChain({
      history: [HISTORY],
      slotGuard: GUARD,
      reverted: ['createDraftsModule'],
    });

    const result = await installAuthorContracts(
      { config: configWith(), safe: SAFE, rpcUrl: 'http://127.0.0.1:8545', privateKey: PRIVATE_KEY, out: quietOut },
      seam,
    );

    expect(calls.map((call) => call.functionName)).toEqual(['createDraftsModule']);
    expect(result.state).toBe('pending-safe');
    expect(result.drafts).toBeNull();
    expect(result.guard).toBe(GUARD);
    expect(result.txs).toHaveLength(1);
    expect(result.note).toMatch(/drafts proxy/);
    expect(result.safeTx).toBeUndefined();
  });

  it('does not report `installed` when the setGuard userOp reverted', async () => {
    // `genericTx` resolves with a hash either way: only a re-read of the slot
    // proves the guard landed.
    const { seam, calls, state } = fakeChain({
      drafts: [DRAFTS],
      history: [HISTORY],
      reverted: ['setGuard'],
    });

    const result = await installAuthorContracts(
      { config: configWith(), safe: SAFE, rpcUrl: 'http://127.0.0.1:8545', privateKey: PRIVATE_KEY, out: quietOut },
      seam,
    );

    expect(calls.map((call) => call.functionName)).toEqual(['setGuard']);
    expect(result.state).toBe('pending-safe');
    expect(result.txs).toHaveLength(1);
    expect(result.txs[0]).toBe(hashFor(1));
    expect(result.note).toMatch(/revert/i);
    // Nothing is claimed on the Safe: the slot is still empty, so no command may
    // record this run as a finished install.
    expect(state.slotGuard).toBeNull();
  });

  it('skips when the Safe is still not deployed after ensureSafe', async () => {
    const { seam, calls, seen } = fakeChain({ deployed: false });

    const result = await installAuthorContracts(
      { config: configWith(), safe: SAFE, rpcUrl: 'http://127.0.0.1:8545', privateKey: PRIVATE_KEY, out: quietOut },
      seam,
    );

    expect(result.state).toBe('skipped');
    expect(result.txs).toEqual([]);
    expect(result.note).toContain('not deployed');
    // No userOp to an address with no code, and no bundler client opened.
    expect(calls).toHaveLength(0);
    expect(seen.openRunner).toBe(0);
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

  it('is `pending-safe` when the modules exist but the guard is not bound yet', async () => {
    // The create's index has not caught up: `guardFor` yields nothing, so the
    // guard is not on the Safe. That is not `installed` — it is not usable yet.
    const { seam } = fakeChain({ drafts: [DRAFTS], history: [HISTORY], boundGuard: null });

    const result = await installAuthorContracts(
      { config: configWith(), safe: SAFE, rpcUrl: 'http://127.0.0.1:8545', privateKey: PRIVATE_KEY, out: quietOut },
      seam,
    );

    expect(result.state).toBe('pending-safe');
    expect(result.txs).toEqual([]);
    expect(result.safeTx).toBeUndefined();
    expect(result.note).toContain('run again to install the guard');
  });

  it('is `pending-safe` when a create userOp left the index unchanged', async () => {
    // The same no-proof rule for the creates: the index is the read-back.
    const { seam, calls } = fakeChain({ reverted: ['createDraftsModule'] });

    const result = await installAuthorContracts(
      { config: configWith(), safe: SAFE, rpcUrl: 'http://127.0.0.1:8545', privateKey: PRIVATE_KEY, out: quietOut },
      seam,
    );

    expect(calls.map((call) => call.functionName)).toEqual(['createDraftsModule']);
    expect(result.state).toBe('pending-safe');
    expect(result.txs).toHaveLength(1);
    expect(result.note).toMatch(/revert/i);
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
