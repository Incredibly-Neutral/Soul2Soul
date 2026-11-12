// ============================================================================
// The author contracts install and migration, against a fake chain.
//
// No network, no bundler, no Safe: the seam (`AuthorContractsSeam`) is replaced
// with a mutable fake that answers the factory index, the Safe's enabled-module
// list (classified by ERC-165 role, as a gate sees it), the guard slot, the
// guard proof (`module()` / `safe()` on the guard and the module), the CREATE2
// predictions and the drafts log size — and records every userOp the commands
// send. What is under test is the DECISION — which of the four states a Safe is
// in, and what gets sent — not viem's encoding.
//
// The fake mutates its state on every write, so the re-reads the commands do are
// answered the way a chain would answer them: a reverted userOp changes nothing,
// and a write that landed is visible to the next read.
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
  migrateAuthorContracts,
  SAFE_GUARD_SLOT,
  type AuthorContracts,
  type AuthorContractsSeam,
  type EnabledAuthorModules,
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
/** A module the factory index names but that answers no role. */
const FOREIGN_MODULE = '0x0000000000000000000000000000000000000d05' as Address;
/** The modules a newer factory generation predicts for the same Safe. */
const NEW_DRAFTS = '0x0000000000000000000000000000000000000d11' as Address;
const NEW_HISTORY = '0x0000000000000000000000000000000000000d12' as Address;
const NEW_GUARD = '0x0000000000000000000000000000000000000d13' as Address;

const PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as `0x${string}`;
/** The EOA the test key derives to: the commands derive it themselves. */
const PRIVATE_KEY_ADDRESS = privateKeyToAccount(PRIVATE_KEY).address;

const RPC = 'http://127.0.0.1:8545';

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
  /** The modules the Safe has enabled, in the Safe's list order. */
  enabled?: Address[];
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
  /** The CREATE2 addresses this factory predicts; DRAFTS/HISTORY by default. */
  predicted?: { drafts: Address; ownerHistory: Address };
  /** The guard minted with the owner-history module; GUARD by default. */
  mintedGuard?: Address;
  /** The factory has no CREATE2 prediction (an older deployment). */
  noPrediction?: boolean;
  /** Genesis logs each drafts module holds (`count()`). */
  draftsCounts?: Record<string, number>;
}

/**
 * The fake chain: mutable state the seam reads, and the userOps written into it.
 *
 * The role of a module is decided the way the contracts answer it — a known
 * drafts module answers `type(IDraftsModule).interfaceId`, a known owner-history
 * module answers its own, and anything else answers nothing. The guard proof is
 * faked the same way the chain answers it: `module()` and `safe()` on the guard,
 * `safe()` on the module. No factory takes part. `GUARD` names `HISTORY` and is
 * bound to `SAFE`; `FOREIGN_GUARD` names a module of another Safe, so it can
 * never be proved ours.
 */
function fakeChain(options: FakeChainOptions = {}) {
  const predicted = options.predicted ?? { drafts: DRAFTS, ownerHistory: HISTORY };
  const mintedGuard = options.mintedGuard ?? GUARD;
  const state = {
    drafts: [...(options.drafts ?? [])],
    history: [...(options.history ?? [])],
    enabled: [...(options.enabled ?? [])],
    slotGuard: options.slotGuard ?? null,
    owners: options.owners ?? [PRIVATE_KEY_ADDRESS],
    threshold: options.threshold ?? 1,
    deployed: options.deployed ?? true,
  };

  /** module → the guard the factory minted for it (`guardFor`). */
  const minted = new Map<string, Address>();
  if (options.boundGuard !== null) minted.set(predicted.ownerHistory.toLowerCase(), mintedGuard);
  /** guard → the module it names (`OwnerHistoryGuard.module()`). */
  const guardModules = new Map<string, Address>([
    [GUARD.toLowerCase(), HISTORY],
    [FOREIGN_GUARD.toLowerCase(), FOREIGN_MODULE],
    [mintedGuard.toLowerCase(), predicted.ownerHistory],
  ]);
  /** guard → the Safe it was minted for (`OwnerHistoryGuard.safe()`). */
  const guardSafes = new Map<string, Address>([
    [GUARD.toLowerCase(), SAFE],
    // A guard from another product, installed on another Safe.
    [FOREIGN_GUARD.toLowerCase(), OTHER_SAFE],
    [mintedGuard.toLowerCase(), SAFE],
  ]);
  /** module → the Safe it is bound to (`safe()`), for the modules that exist. */
  const moduleSafes = new Map<string, Address>([
    [HISTORY.toLowerCase(), SAFE],
    [DRAFTS.toLowerCase(), SAFE],
    [predicted.drafts.toLowerCase(), SAFE],
  ]);
  /** Addresses that carry bytecode. */
  const code = new Set<string>([
    ...state.drafts.map((entry) => entry.toLowerCase()),
    ...state.history.map((entry) => entry.toLowerCase()),
  ]);
  /** Address → the number of genesis logs it holds (`count()`). */
  const counts = new Map<string, number>(
    Object.entries(options.draftsCounts ?? {}).map(([address, count]) => [
      address.toLowerCase(),
      count,
    ]),
  );

  const draftsModules = new Set([DRAFTS.toLowerCase(), predicted.drafts.toLowerCase()]);
  const historyModules = new Set([HISTORY.toLowerCase(), predicted.ownerHistory.toLowerCase()]);

  const calls: Call[] = [];
  const seen = { ensureSafe: 0, openRunner: 0, readGuard: 0, readOwners: 0, readEnabled: 0 };
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

  const readEnabled = (): Promise<EnabledAuthorModules> => {
    seen.readEnabled += 1;
    if (options.unreachable) return Promise.reject(new Error('fetch failed'));
    const byRole: { drafts: Address[]; ownerHistory: Address[] } = { drafts: [], ownerHistory: [] };
    for (const module of state.enabled) {
      const key = module.toLowerCase();
      if (draftsModules.has(key)) byRole.drafts.push(module);
      if (historyModules.has(key)) byRole.ownerHistory.push(module);
    }
    return Promise.resolve({
      modules: [...state.enabled],
      byRole,
      drafts: byRole.drafts[byRole.drafts.length - 1] ?? null,
      ownerHistory: byRole.ownerHistory[byRole.ownerHistory.length - 1] ?? null,
    });
  };

  /** A flaky RPC read: a transport error, not an answer from the address. */
  const guardReadFails = options.guardReadFails === true;

  const seam: AuthorContractsSeam = {
    readContracts,
    readEnabled,
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
    readGuardRole: ({ guard }) => {
      if (guardReadFails) return Promise.reject(new Error('fetch failed: ECONNRESET'));
      return Promise.resolve(guardSafes.has(guard.toLowerCase()));
    },
    readModuleSafe: ({ module }) => {
      if (guardReadFails) return Promise.reject(new Error('fetch failed: ECONNRESET'));
      return Promise.resolve(moduleSafes.get(module.toLowerCase()) ?? null);
    },
    readOwners: () => {
      seen.readOwners += 1;
      return Promise.resolve({ owners: state.owners, threshold: state.threshold });
    },
    readGuardFor: ({ module }) => {
      if (options.unreachable) return Promise.reject(new Error('fetch failed'));
      return Promise.resolve(minted.get(module.toLowerCase()) ?? null);
    },
    readPredicted: () => {
      if (options.unreachable) return Promise.reject(new Error('fetch failed'));
      if (options.noPrediction) return Promise.resolve({ drafts: null, ownerHistory: null });
      return Promise.resolve({ drafts: predicted.drafts, ownerHistory: predicted.ownerHistory });
    },
    readHasCode: ({ address }) => Promise.resolve(code.has(address.toLowerCase())),
    readDraftsCount: ({ module }) => Promise.resolve(BigInt(counts.get(module.toLowerCase()) ?? 0)),
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
            state.drafts.push(predicted.drafts);
            code.add(predicted.drafts.toLowerCase());
            moduleSafes.set(predicted.drafts.toLowerCase(), SAFE);
          }
          if (functionName === 'createOwnerHistoryModule') {
            state.history.push(predicted.ownerHistory);
            code.add(predicted.ownerHistory.toLowerCase());
            moduleSafes.set(predicted.ownerHistory.toLowerCase(), SAFE);
            minted.set(predicted.ownerHistory.toLowerCase(), mintedGuard);
            guardModules.set(mintedGuard.toLowerCase(), predicted.ownerHistory);
            guardSafes.set(mintedGuard.toLowerCase(), SAFE);
          }
          if (functionName === 'setGuard') state.slotGuard = args[0] as Address;
          if (functionName === 'enableModule') state.enabled.push(args[0] as Address);
          if (functionName === 'disableModule') {
            const target = (args[1] as Address).toLowerCase();
            state.enabled = state.enabled.filter((entry) => entry.toLowerCase() !== target);
          }
          if (functionName === 'absorb') {
            const [from, offset, limit] = args as [Address, bigint, bigint];
            const held = counts.get(from.toLowerCase()) ?? 0;
            const taken = Math.max(0, Math.min(Number(limit), held - Number(offset)));
            const key = to.toLowerCase();
            counts.set(key, (counts.get(key) ?? 0) + taken);
          }
          return Promise.resolve(hashFor(calls.length));
        },
      });
    },
  };

  return { seam, calls, state, seen, code, counts };
}

/** The hash the n-th userOp of a fake run resolves with. */
function hashFor(n: number): string {
  return `0x${String(n).padStart(64, '0')}`;
}

function installArgs(config: CliConfig = configWith()) {
  return { config, safe: SAFE, rpcUrl: RPC, privateKey: PRIVATE_KEY, out: quietOut };
}

describe('installAuthorContracts', () => {
  it('installs the modules, enables both, and installs the guard', async () => {
    const { seam, calls, state } = fakeChain();

    const result = await installAuthorContracts(installArgs(), seam);

    expect(result.state).toBe('installed');
    expect(result.txs).toHaveLength(5);
    expect(calls.map((call) => call.functionName)).toEqual([
      'createDraftsModule',
      'createOwnerHistoryModule',
      'enableModule',
      'enableModule',
      'setGuard',
    ]);
    // The factory calls name the Safe as the beneficiary; the rest are the Safe
    // calling itself.
    expect(calls[0]?.to).toBe(FACTORY);
    expect(calls[1]?.to).toBe(FACTORY);
    expect(calls[2]?.to).toBe(SAFE);
    expect(calls[2]?.args).toEqual([DRAFTS]);
    expect(calls[3]?.args).toEqual([HISTORY]);
    expect(calls[4]?.to).toBe(SAFE);
    expect(calls[4]?.args).toEqual([GUARD]);

    // Enabling is proved by re-reading the Safe's module list, not by the hash.
    expect(state.enabled).toEqual([DRAFTS, HISTORY]);
    expect(result.drafts).toBe(DRAFTS);
    expect(result.ownerHistory).toBe(HISTORY);
    expect(result.guard).toBe(GUARD);
    expect(result.safeTx).toBeUndefined();
  });

  it('enables neither module twice and sends nothing on a second run', async () => {
    const { seam, calls } = fakeChain();

    const first = await installAuthorContracts(installArgs(), seam);
    const sent = calls.length;
    const second = await installAuthorContracts(installArgs(), seam);

    expect(first.state).toBe('installed');
    expect(second.state).toBe('already');
    expect(second.txs).toEqual([]);
    expect(calls).toHaveLength(sent);
  });

  it('is `pending-safe` when an enableModule userOp reverted', async () => {
    // The module list is the read-back: a hash from a reverted userOp proves
    // nothing, so this must not report `installed`.
    const { seam, calls, state } = fakeChain({
      drafts: [DRAFTS],
      history: [HISTORY],
      slotGuard: GUARD,
      reverted: ['enableModule'],
    });

    const result = await installAuthorContracts(installArgs(), seam);

    expect(calls.map((call) => call.functionName)).toEqual(['enableModule', 'enableModule']);
    expect(result.state).toBe('pending-safe');
    expect(result.note).toMatch(/did not enable/);
    expect(state.enabled).toEqual([]);
  });

  it('records what the Safe enabled, not what the factory index claims', async () => {
    // Any address can append to the index. `rememberAuthorContracts` is fed this
    // result, so it must name the enabled modules and not the newest index entry.
    const { seam } = fakeChain({
      drafts: [DRAFTS],
      history: [HISTORY, FOREIGN_MODULE],
      enabled: [DRAFTS, HISTORY],
      slotGuard: GUARD,
    });

    const index = await seam.readContracts({ factory: FACTORY, safe: SAFE, rpcUrl: RPC });
    const result = await installAuthorContracts(installArgs(), seam);
    const enabled = await seam.readEnabled({ safe: SAFE, rpcUrl: RPC });

    expect(index.ownerHistory).toBe(FOREIGN_MODULE);
    expect(enabled.ownerHistory).toBe(HISTORY);
    expect(result.state).toBe('already');
    expect(result.ownerHistory).toBe(HISTORY);
    expect(result.drafts).toBe(DRAFTS);
  });

  it('is a no-op when everything is already installed', async () => {
    const { seam, calls, seen } = fakeChain({
      drafts: [DRAFTS],
      history: [HISTORY],
      enabled: [DRAFTS, HISTORY],
      slotGuard: GUARD,
    });

    const result = await installAuthorContracts(installArgs(), seam);

    expect(result.state).toBe('already');
    expect(result.txs).toEqual([]);
    expect(calls).toHaveLength(0);
    // The Safe was already live: no deployment, no runner, no userOp.
    expect(seen.openRunner).toBe(0);
    expect(seen.ensureSafe).toBe(1);
  });

  it('installs only what is missing (a Safe with the drafts module already)', async () => {
    const { seam, calls } = fakeChain({ drafts: [DRAFTS], enabled: [DRAFTS] });

    const result = await installAuthorContracts(installArgs(), seam);

    expect(result.state).toBe('installed');
    expect(calls.map((call) => call.functionName)).toEqual([
      'createOwnerHistoryModule',
      'enableModule',
      'setGuard',
    ]);
    expect(calls.some((call) => call.functionName === 'createDraftsModule')).toBe(false);
  });

  it('never overwrites a foreign guard — and offers no call that would', async () => {
    const { seam, calls, state } = fakeChain({
      drafts: [DRAFTS],
      history: [HISTORY],
      enabled: [DRAFTS, HISTORY],
      slotGuard: FOREIGN_GUARD,
    });

    const result = await installAuthorContracts(installArgs(), seam);

    expect(result.state).toBe('pending-safe');
    expect(calls).toHaveLength(0);
    expect(result.note).toContain(FOREIGN_GUARD);
    // `safe()` names another Safe: the immutables cannot prove it is ours.
    expect(result.safeTx).toBeUndefined();
    expect(state.slotGuard).toBe(FOREIGN_GUARD);
  });

  it('is `already` when a griefer appends a module to the factory index', async () => {
    // Any address can push an index entry. The guard's own immutables are what
    // decide, so the healthy author stays installed and nothing is sent.
    const { seam, calls, state } = fakeChain({
      drafts: [DRAFTS],
      history: [HISTORY, FOREIGN_MODULE],
      enabled: [DRAFTS, HISTORY],
      slotGuard: GUARD,
    });

    const result = await installAuthorContracts(installArgs(), seam);

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
      enabled: [DRAFTS, HISTORY],
      // `guardFor` answers nothing: this factory never minted this guard.
      boundGuard: null,
      slotGuard: GUARD,
    });

    const result = await installAuthorContracts(installArgs(), seam);

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
      enabled: [DRAFTS, HISTORY],
      slotGuard: GUARD,
      guardReadFails: true,
    });

    const result = await installAuthorContracts(installArgs(), seam);

    expect(result.state).toBe('skipped');
    expect(result.note).toContain('ECONNRESET');
    expect(result.note).not.toMatch(/did not install/);
    expect(result.safeTx).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('creates a missing drafts module on a Safe that already carries the guard', async () => {
    // The README's manual order with step 1 skipped: the guard is right, the
    // drafts module is absent. `already` would leave it absent for ever.
    const { seam, calls } = fakeChain({
      history: [HISTORY],
      enabled: [HISTORY],
      slotGuard: GUARD,
    });

    const result = await installAuthorContracts(installArgs(), seam);

    expect(calls.map((call) => call.functionName)).toEqual(['createDraftsModule', 'enableModule']);
    expect(calls[0]?.to).toBe(FACTORY);
    expect(result.state).toBe('installed');
    expect(result.drafts).toBe(DRAFTS);
    expect(result.ownerHistory).toBe(HISTORY);
    expect(result.guard).toBe(GUARD);
    expect(result.txs).toHaveLength(2);
  });

  it('is `pending-safe` when the drafts module could not be created', async () => {
    const { seam, calls } = fakeChain({
      history: [HISTORY],
      enabled: [HISTORY],
      slotGuard: GUARD,
      reverted: ['createDraftsModule'],
    });

    const result = await installAuthorContracts(installArgs(), seam);

    expect(calls.map((call) => call.functionName)).toEqual(['createDraftsModule']);
    expect(result.state).toBe('pending-safe');
    expect(result.drafts).toBeNull();
    expect(result.guard).toBe(GUARD);
    expect(result.txs).toHaveLength(1);
    expect(result.note).toMatch(/drafts module transaction/);
    expect(result.safeTx).toBeUndefined();
  });

  it('does not report `installed` when the setGuard userOp reverted', async () => {
    // `genericTx` resolves with a hash either way: only a re-read of the slot
    // proves the guard landed.
    const { seam, calls, state } = fakeChain({
      drafts: [DRAFTS],
      history: [HISTORY],
      enabled: [DRAFTS, HISTORY],
      reverted: ['setGuard'],
    });

    const result = await installAuthorContracts(installArgs(), seam);

    expect(calls.map((call) => call.functionName)).toEqual(['setGuard']);
    expect(result.state).toBe('pending-safe');
    expect(result.txs).toHaveLength(1);
    expect(result.txs[0]).toBe(hashFor(1));
    expect(result.note).toMatch(/revert/i);
    expect(state.slotGuard).toBeNull();
  });

  it('skips when the Safe is still not deployed after ensureSafe', async () => {
    const { seam, calls, seen } = fakeChain({ deployed: false });

    const result = await installAuthorContracts(installArgs(), seam);

    expect(result.state).toBe('skipped');
    expect(result.txs).toEqual([]);
    expect(result.note).toContain('not deployed');
    // No userOp to an address with no code, and no bundler client opened.
    expect(calls).toHaveLength(0);
    expect(seen.openRunner).toBe(0);
  });

  it('installs the permissionless modules but leaves the enables and the guard to a multisig', async () => {
    const { seam, calls, state } = fakeChain({
      owners: [PRIVATE_KEY_ADDRESS, OTHER_SAFE],
      threshold: 2,
    });

    const result = await installAuthorContracts(installArgs(), seam);

    expect(result.state).toBe('pending-safe');
    expect(calls.map((call) => call.functionName)).toEqual([
      'createDraftsModule',
      'createOwnerHistoryModule',
    ]);
    expect(calls.some((call) => call.functionName === 'enableModule')).toBe(false);
    expect(calls.some((call) => call.functionName === 'setGuard')).toBe(false);
    expect(state.slotGuard).toBeNull();
    expect(state.enabled).toEqual([]);
    // Every self-call the owners must propose, in order, then the guard.
    expect(result.safeTxs?.map((call) => call.to)).toEqual([SAFE, SAFE, SAFE]);
    expect(result.safeTx?.to).toBe(SAFE);
    expect(result.safeTx?.data).toBe(result.safeTxs?.[2]?.data);
    expect(result.note).toContain('2-of-2');
  });

  it('treats a single-owner Safe owned by another key as a multisig', async () => {
    // A 1-of-1 Safe whose owner is NOT this key: the userOp would revert, so the
    // enables and the guard must go through the Safe's own owners.
    const { seam, calls } = fakeChain({ owners: [OTHER_SAFE], threshold: 1 });

    const result = await installAuthorContracts(installArgs(), seam);

    expect(result.state).toBe('pending-safe');
    expect(calls.some((call) => call.functionName === 'enableModule')).toBe(false);
    expect(calls.some((call) => call.functionName === 'setGuard')).toBe(false);
    expect(result.safeTx?.to).toBe(SAFE);
    expect(result.safeTxs).toHaveLength(3);
  });

  it('skips without a bundler, naming the env vars, and never throws', async () => {
    const { seam, seen } = fakeChain();
    const config = {
      bundler: {},
      paymaster: {},
      contracts: { authorFactory: FACTORY },
    } as unknown as CliConfig;

    const result = await installAuthorContracts(installArgs(config), seam);

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

    const result = await installAuthorContracts(installArgs(), seam);

    expect(result.state).toBe('skipped');
    expect(result.txs).toEqual([]);
    expect(result.note).toContain('S2S_RPC_L2');
    expect(result.note).toContain('BASE_RPC_URL');
    expect(calls).toHaveLength(0);
  });

  it('is `pending-safe` when the modules exist but the guard is not bound yet', async () => {
    // The create's index has not caught up: `guardFor` yields nothing, so the
    // guard is not on the Safe. That is not `installed` — it is not usable yet.
    const { seam } = fakeChain({
      drafts: [DRAFTS],
      history: [HISTORY],
      enabled: [DRAFTS, HISTORY],
      boundGuard: null,
    });

    const result = await installAuthorContracts(installArgs(), seam);

    expect(result.state).toBe('pending-safe');
    expect(result.txs).toEqual([]);
    expect(result.safeTx).toBeUndefined();
    expect(result.note).toContain('run again to install the guard');
  });

  it('is `pending-safe` when a create userOp left the index unchanged', async () => {
    // The same no-proof rule for the creates: the index is the read-back.
    const { seam, calls } = fakeChain({ reverted: ['createDraftsModule'] });

    const result = await installAuthorContracts(installArgs(), seam);

    expect(calls.map((call) => call.functionName)).toEqual(['createDraftsModule']);
    expect(result.state).toBe('pending-safe');
    expect(result.txs).toHaveLength(1);
    expect(result.note).toMatch(/revert/i);
  });
});

describe('migrateAuthorContracts', () => {
  /** A Safe installed with the old modules, and the factory's new prediction. */
  function oldInstall(overrides: FakeChainOptions = {}) {
    return fakeChain({
      drafts: [DRAFTS],
      history: [HISTORY],
      enabled: [DRAFTS, HISTORY],
      slotGuard: GUARD,
      predicted: { drafts: NEW_DRAFTS, ownerHistory: NEW_HISTORY },
      mintedGuard: NEW_GUARD,
      // 250 genesis logs: three absorb pages (100, 100, 50).
      draftsCounts: { [DRAFTS]: 250 },
      ...overrides,
    });
  }

  it('creates the predicted modules, absorbs in pages, swaps the guard and enables', async () => {
    const { seam, calls, state } = oldInstall();

    const result = await migrateAuthorContracts(installArgs(), seam);

    expect(result.state).toBe('installed');
    expect(calls.map((call) => call.functionName)).toEqual([
      'createDraftsModule',
      'createOwnerHistoryModule',
      'absorb',
      'absorb',
      'absorb',
      'setGuard',
      'enableModule',
      'enableModule',
      'disableModule',
      'disableModule',
    ]);

    // The creates name the Safe; the absorb pages call the new module.
    expect(calls[0]?.to).toBe(FACTORY);
    expect(calls[0]?.args).toEqual([SAFE]);
    expect(calls[2]?.to).toBe(NEW_DRAFTS);
    expect(calls[2]?.args).toEqual([DRAFTS, 0n, 100n]);
    expect(calls[3]?.args).toEqual([DRAFTS, 100n, 100n]);
    expect(calls[4]?.args).toEqual([DRAFTS, 200n, 50n]);
    expect(calls[5]?.args).toEqual([NEW_GUARD]);
    expect(calls[6]?.args).toEqual([NEW_DRAFTS]);
    expect(calls[7]?.args).toEqual([NEW_HISTORY]);
    // `disableModule(prev, module)`: both old modules were the head of the list.
    expect(calls[8]?.args).toEqual(['0x0000000000000000000000000000000000000001', DRAFTS]);
    expect(calls[9]?.args).toEqual(['0x0000000000000000000000000000000000000001', HISTORY]);

    expect(result.pages).toBe(3);
    expect(result.drafts).toBe(NEW_DRAFTS);
    expect(result.ownerHistory).toBe(NEW_HISTORY);
    expect(result.guard).toBe(NEW_GUARD);
    // The old modules are left on chain, abandoned, and no longer enabled.
    expect(result.oldDrafts).toBe(DRAFTS);
    expect(result.oldOwnerHistory).toBe(HISTORY);
    expect(state.enabled).toEqual([NEW_DRAFTS, NEW_HISTORY]);
    expect(state.slotGuard).toBe(NEW_GUARD);
  });

  it('sends nothing on a second run', async () => {
    const { seam, calls } = oldInstall();

    const first = await migrateAuthorContracts(installArgs(), seam);
    const sent = calls.length;
    const second = await migrateAuthorContracts(installArgs(), seam);

    expect(first.state).toBe('installed');
    expect(second.state).toBe('already');
    expect(second.txs).toEqual([]);
    expect(calls).toHaveLength(sent);
  });

  it("refuses to replace a guard that is not this package's own", async () => {
    const { seam, calls, state } = oldInstall({ slotGuard: FOREIGN_GUARD });

    const result = await migrateAuthorContracts(installArgs(), seam);

    expect(result.state).toBe('pending-safe');
    expect(calls).toHaveLength(0);
    expect(result.note).toContain('refusing to replace the guard');
    expect(result.note).toContain(FOREIGN_GUARD);
    // Nothing moved: the foreign guard is still in the slot.
    expect(state.slotGuard).toBe(FOREIGN_GUARD);
    expect(state.enabled).toEqual([DRAFTS, HISTORY]);
  });

  it('finishes a half-done migration: the guard is already the new one', async () => {
    // A previous run moved the guard and stopped. The modules and the leftover
    // old drafts module are still to do, and nothing is copied twice.
    const { seam, calls, state } = oldInstall({ slotGuard: NEW_GUARD, enabled: [DRAFTS] });

    const result = await migrateAuthorContracts(installArgs(), seam);

    expect(result.state).toBe('installed');
    expect(calls.some((call) => call.functionName === 'setGuard')).toBe(false);
    expect(calls.some((call) => call.functionName === 'absorb')).toBe(false);
    expect(calls.map((call) => call.functionName)).toEqual([
      'createDraftsModule',
      'createOwnerHistoryModule',
      'enableModule',
      'enableModule',
      'disableModule',
    ]);
    expect(calls[4]?.args).toEqual(['0x0000000000000000000000000000000000000001', DRAFTS]);
    expect(state.enabled).toEqual([NEW_DRAFTS, NEW_HISTORY]);
  });

  it('stops at the multisig gate and hands over every call, in order', async () => {
    const { seam, calls } = oldInstall({ owners: [PRIVATE_KEY_ADDRESS, OTHER_SAFE], threshold: 2 });

    const result = await migrateAuthorContracts(installArgs(), seam);

    expect(result.state).toBe('pending-safe');
    // The creates are permissionless: they go out before the gate.
    expect(calls.map((call) => call.functionName)).toEqual([
      'createDraftsModule',
      'createOwnerHistoryModule',
    ]);
    // 3 absorb pages, setGuard, 2 enables, 2 disables.
    expect(result.safeTxs).toHaveLength(8);
    expect(result.safeTx).toBe(result.safeTxs?.[7]);
    expect(result.note).toContain('2-of-2');
  });

  it('is `pending-safe` when the absorb pages did not reach the new module', async () => {
    const { seam, calls } = oldInstall({ reverted: ['absorb'] });

    const result = await migrateAuthorContracts(installArgs(), seam);

    expect(calls.filter((call) => call.functionName === 'absorb')).toHaveLength(3);
    expect(result.state).toBe('pending-safe');
    expect(result.note).toMatch(/did not reach/);
    // Nothing past the absorb was sent: the guard would make the half-copy live.
    expect(calls.some((call) => call.functionName === 'setGuard')).toBe(false);
  });

  it('is `pending-safe` when the factory predicts no module addresses', async () => {
    const { seam, calls } = oldInstall({ noPrediction: true });

    const result = await migrateAuthorContracts(installArgs(), seam);

    expect(result.state).toBe('pending-safe');
    expect(result.note).toContain('predicts no module addresses');
    expect(calls).toHaveLength(0);
  });

  it('skips without a bundler', async () => {
    const { seam, calls } = oldInstall();
    const config = {
      bundler: {},
      paymaster: {},
      contracts: { authorFactory: FACTORY },
    } as unknown as CliConfig;

    const result = await migrateAuthorContracts(installArgs(config), seam);

    expect(result.state).toBe('skipped');
    expect(result.pages).toBe(0);
    expect(calls).toHaveLength(0);
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
    expect(authorContractsFactory({} as unknown as CliConfig)).toBe(
      DEFAULT_AUTHOR_CONTRACTS_FACTORY,
    );

    process.env.S2S_AUTHOR_CONTRACTS_FACTORY = OTHER_SAFE;
    expect(authorContractsFactory({} as unknown as CliConfig)).toBe(OTHER_SAFE);
  });

  it('rejects a non-address as a usage error', () => {
    expect(() =>
      authorContractsFactory({ contracts: { authorFactory: 'nope' } } as unknown as CliConfig),
    ).toThrow(/not an address/);
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
    writeAuthors(
      { active: 'alice', authors: { alice: { privateKey: PRIVATE_KEY, safe: SAFE } } },
      file,
    );

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
    writeAuthors(
      { active: 'bob', authors: { bob: { privateKey: PRIVATE_KEY, safe: null } } },
      file,
    );

    const record = readAuthors(file).authors.bob;
    expect(record?.contracts).toBeUndefined();
    expect(
      writeBackAuthorContracts('bob', { drafts: null, ownerHistory: null, guard: null }, file),
    ).toBe(true);
    expect(readAuthors(file).authors.bob?.contracts).toEqual({
      drafts: null,
      ownerHistory: null,
      guard: null,
    });
  });
});
