// ============================================================================
// `s2s signer history` — what the OwnerHistory module recorded, and whether it
// still matches the Safe's owners.
//
// The module read is a fake on `SignerDeps.readHistory`; the config and the L2
// endpoint are the queue test's stubs. No socket, no chain, no key: the command
// reads and prints.
// ============================================================================

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeFunctionData, type Address, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OwnerHistoryModuleV1 } from '@s2s/author-contracts';

import type { OwnerHistoryRead } from '../src/core/author-contracts';
import { loadConfig } from '../src/core/config';
import { findSignerCommand, signerHelpEntries } from '../src/commands/index';
import { runSignerHistory, signerHistory } from '../src/commands/signer-history';
import type { SignerDeps } from '../src/commands/signer-store';
import { parseCommandArgs, type ParsedArgs } from '../src/lib/args';
import { CliError, UsageError } from '../src/lib/errors';
import type { CliOut } from '../src/lib/out';

const SAFE: Address = '0x8507CDa436d39D433acC9c88A813dd052C828dfB';
const GUARD: Address = '0x5a7b1c9D4e2F3A6c8B0d1E4f2A7c9B3d5E8f1A2c';
const MODULE: Address = '0x4c1e8A2b6D9f3B7a5C0e2D4f6A8b1C3d5E7f9A0b';
/** Era 0: the owner the rotation replaced. */
const HARRY: Address = '0x018Df141a124F8B6b96136Ae7C9Ab476E856190e';
/** Era 1: the owner the rotation added. */
const HARRY_NEXT: Address = '0xEF5cB7c22605ABF0CdE475fc4d8fB6bf3643dF3B';
const RPC = 'https://rpc.example';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's2s-signer-history-'));
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
  vi.stubEnv('S2S_RPC_L2', RPC);
  vi.stubEnv('BASE_RPC_URL', '');
  // No key: reading the history needs none.
  vi.stubEnv('S2S_PRIVATE_KEY', '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

interface Captured {
  out: CliOut;
  results: Record<string, unknown>[];
  human: string[];
  warnings: string[];
}

function capture(json = false): Captured {
  const results: Record<string, unknown>[] = [];
  const human: string[] = [];
  const warnings: string[] = [];
  const out: CliOut = {
    json,
    log: () => undefined,
    warn: (message: string) => warnings.push(message),
    result: (data: unknown, text?: string) => {
      results.push(data as Record<string, unknown>);
      if (text !== undefined) human.push(text);
    },
  };
  return { out, results, human, warnings };
}

/** Two eras: the old owner's era closed, the new owner's era current. */
function rotated(): OwnerHistoryRead {
  return {
    module: MODULE,
    moduleSource: 'enabled',
    guard: GUARD,
    guardModule: MODULE,
    eraCount: 2,
    eras: [
      { index: 0, startBlock: 100, endBlock: 640, owners: [HARRY] },
      { index: 1, startBlock: 640, endBlock: null, owners: [HARRY_NEXT] },
    ],
    ownersEver: [HARRY, HARRY_NEXT],
    lastSyncedBlock: 640,
    lags: false,
  };
}

interface Sent {
  rpcUrl: string;
  privateKey: Hex;
  to: Address;
  data: Hex;
}

/**
 * A history that lags: the swap executed as a module self-call, or the guard's
 * hook was starved, so era 0 still names the owner it replaced.
 */
function lagging(): OwnerHistoryRead {
  return {
    ...rotated(),
    eraCount: 1,
    eras: [{ index: 0, startBlock: 100, endBlock: null, owners: [HARRY] }],
    lastSyncedBlock: 100,
    lags: true,
  };
}

function deps(
  history: OwnerHistoryRead,
  options: {
    after?: OwnerHistoryRead;
    sent?: Sent[];
    /** The key the sync is sent with; empty by default, as the read needs none. */
    privateKey?: string;
    sendFails?: unknown;
    receipts?: { rpcUrl: string; hash: Hex }[];
  } = {},
): Partial<SignerDeps> {
  const sent = options.sent ?? [];
  const receipts = options.receipts ?? [];
  let reads = 0;
  return {
    config: () => {
      const config = loadConfig();
      return options.privateKey === undefined
        ? config
        : { ...config, privateKey: options.privateKey };
    },
    // The first read is what the command finds; the second is what the sync
    // produced, which is the block the output has to print.
    readHistory: () => {
      reads += 1;
      return Promise.resolve(reads === 1 ? history : (options.after ?? history));
    },
    send: (input) => {
      const failure = options.sendFails;
      if (failure !== undefined) {
        return Promise.reject(failure instanceof Error ? failure : new Error('send failed'));
      }
      sent.push(input);
      return Promise.resolve(SYNC_TX);
    },
    waitForReceipt: (input) => {
      receipts.push(input);
      return Promise.resolve();
    },
  };
}

/** The transaction hash the fake send answers with. */
const SYNC_TX: Hex = `0x${'55'.repeat(32)}`;

function args(argv: string[]): ParsedArgs {
  const parsed = parseCommandArgs(argv, signerHistory.flags);
  return { flags: parsed.flags, positionals: parsed.positionals.slice(2) };
}

describe('s2s signer history', () => {
  it('shows both owners, one era each, and no closing complaint when the history agrees', async () => {
    const captured = capture();

    await runSignerHistory(captured.out, args(['signer', 'history', SAFE]), deps(rotated()));

    expect(captured.human[0]).toBe(
      [
        `safe    ${SAFE}`,
        `guard   ${GUARD}  owner-history guard (bound to this Safe)`,
        `module  ${MODULE}  S2S Owner History Module V1`,
        'eras    2',
        `  #0  blocks 0x64 → 0x280  owners ${HARRY}`,
        `  #1  blocks 0x280 → head  owners ${HARRY_NEXT}`,
        'synced  block 0x280',
      ].join('\n'),
    );

    const result = captured.results[0];
    expect(result).toMatchObject({
      action: 'signer.history',
      safe: SAFE,
      guard: GUARD,
      module: MODULE,
      moduleSource: 'enabled',
      eraCount: 2,
      ownersEver: [HARRY, HARRY_NEXT],
      lastSyncedBlock: 640,
      lags: false,
    });
    const eras = result?.eras as Record<string, unknown>[];
    expect(eras.map((era) => era.owners)).toEqual([[HARRY], [HARRY_NEXT]]);
    // `endBlock == 0` is the current era; the read reports that as null, not 0.
    expect(eras[1]?.endBlock).toBeNull();
  });

  it('says nothing is recorded when the Safe carries no owner-history module', async () => {
    const captured = capture();

    await runSignerHistory(
      captured.out,
      args(['signer', 'history', SAFE]),
      deps({
        module: null,
        moduleSource: null,
        guard: null,
        guardModule: null,
        eraCount: 0,
        eras: [],
        ownersEver: [],
        lastSyncedBlock: null,
        lags: false,
      }),
    );

    expect(captured.human[0]).toBe(
      [
        `safe    ${SAFE}`,
        'guard   (none)  no owner-history hook is installed',
        'module  (none)',
        'no owner-history module is enabled on this Safe: nothing recorded the rotation',
      ].join('\n'),
    );
    expect(captured.results[0]).toMatchObject({ module: null, moduleSource: null, guard: null });
  });

  it('ends with the repair when the newest era is not the Safe\'s owner set', async () => {
    const captured = capture();
    const lagging: OwnerHistoryRead = {
      ...rotated(),
      // The swap ran as a module self-call: the owners moved, the era did not.
      eraCount: 1,
      eras: [{ index: 0, startBlock: 100, endBlock: null, owners: [HARRY] }],
      lastSyncedBlock: 100,
      lags: true,
    };

    await runSignerHistory(captured.out, args(['signer', 'history', SAFE]), deps(lagging));

    expect(captured.results[0]?.lags).toBe(true);
    const lines = captured.human[0]?.split('\n') ?? [];
    expect(lines[lines.length - 1]).toBe(
      "the history lags the Safe's owners: sync() is permissionless and repairs it — rerun with --sync to send it",
    );
  });

  it('prints the whole document in --json, with the module the guard named', async () => {
    const captured = capture(true);

    await runSignerHistory(captured.out, args(['signer', 'history', SAFE]), deps(rotated()));

    expect(captured.results[0]).toEqual({
      action: 'signer.history',
      safe: SAFE,
      guard: GUARD,
      module: MODULE,
      moduleSource: 'enabled',
      eraCount: 2,
      eras: [
        { index: 0, startBlock: 100, endBlock: 640, owners: [HARRY] },
        { index: 1, startBlock: 640, endBlock: null, owners: [HARRY_NEXT] },
      ],
      ownersEver: [HARRY, HARRY_NEXT],
      lastSyncedBlock: 640,
      lags: false,
    });
  });

  it('takes the Safe from --safe, and refuses when neither the flag nor the store has one', async () => {
    const captured = capture();
    await runSignerHistory(captured.out, args(['signer', 'history', '--safe', SAFE]), deps(rotated()));
    expect(captured.results[0]?.safe).toBe(SAFE);

    await expect(
      runSignerHistory(capture().out, args(['signer', 'history']), deps(rotated())),
    ).rejects.toThrow(/no Safe given/);
  });

  it('is an action of `s2s signer`, listed in the group help', () => {
    expect(findSignerCommand('history')).toBe(signerHistory);
    expect(signerHelpEntries.map((entry) => entry.name)).toContain('history');
    expect(findSignerCommand('bogus')).toBeUndefined();
  });
});

/** A usable key: privkey 1, and the EOA it belongs to. */
const KEY: Hex = `0x${'00'.repeat(31)}01`;
const EOA: Address = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';

/**
 * `--sync` is the repair the lag line names. The sync needs no Safe — `sync()`
 * is permissionless — so it goes from the EOA straight to the module, and the
 * eras are read back afterwards: the block is the evidence.
 */
describe('s2s signer history --sync', () => {
  it('sends sync() to the module, then prints the eras the sync produced', async () => {
    const sent: Sent[] = [];
    const receipts: { rpcUrl: string; hash: Hex }[] = [];
    const captured = capture();

    await runSignerHistory(
      captured.out,
      args(['signer', 'history', SAFE, '--sync']),
      deps(lagging(), { after: rotated(), sent, receipts, privateKey: KEY }),
    );

    // One transaction, from the key, straight to the module, carrying `sync()`.
    expect(sent).toHaveLength(1);
    const sync = sent[0];
    expect(sync?.to).toBe(MODULE);
    expect(sync?.privateKey).toBe(KEY);
    expect(decodeFunctionData({ abi: OwnerHistoryModuleV1, data: sync?.data ?? '0x' }).functionName).toBe(
      'sync',
    );
    // The receipt is waited for before the eras are read: a read at broadcast
    // time answers the era before the sync.
    expect(receipts).toEqual([{ rpcUrl: RPC, hash: SYNC_TX }]);
    expect(captured.warnings[0]).toContain(`sent sync() to ${MODULE} in ${SYNC_TX} as ${EOA}`);

    // The block is the re-read: two eras, the new owner current, the sync point
    // moved to the block the sync landed in.
    expect(captured.human[0]?.split('\n')).toEqual([
      `safe    ${SAFE}`,
      `sync    ${SYNC_TX}`,
      `guard   ${GUARD}  owner-history guard (bound to this Safe)`,
      `module  ${MODULE}  S2S Owner History Module V1`,
      'eras    2',
      `  #0  blocks 0x64 → 0x280  owners ${HARRY}`,
      `  #1  blocks 0x280 → head  owners ${HARRY_NEXT}`,
      'synced  block 0x280',
    ]);
    expect(captured.results[0]).toMatchObject({
      action: 'signer.history',
      safe: SAFE,
      eraCount: 2,
      lastSyncedBlock: 640,
      lags: false,
      syncTx: SYNC_TX,
    });
  });

  it('refuses a history that already matches, and sends nothing', async () => {
    const sent: Sent[] = [];
    const captured = capture();

    const err = await runSignerHistory(
      captured.out,
      args(['signer', 'history', SAFE, '--sync']),
      deps(rotated(), { sent, privateKey: KEY }),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // `sync()` writes nothing when the set matches, so this would buy no fact.
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('history_in_sync');
    expect((err as Error).message).toBe(
      "the history already matches the Safe's owners; nothing to sync",
    );
    expect(sent).toHaveLength(0);
    expect(captured.results).toHaveLength(0);
  });

  it('refuses --sync when the Safe carries no module, rather than sending into nothing', async () => {
    const sent: Sent[] = [];
    const captured = capture();

    const err = await runSignerHistory(
      captured.out,
      args(['signer', 'history', SAFE, '--sync']),
      deps(
        {
          module: null,
          moduleSource: null,
          guard: null,
          guardModule: null,
          eraCount: 0,
          eras: [],
          ownersEver: [],
          lastSyncedBlock: null,
          lags: false,
        },
        { sent, privateKey: KEY },
      ),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect((err as CliError).code).toBe('no_history_module');
    expect((err as Error).message).toContain('nothing to sync');
    expect(sent).toHaveLength(0);
  });

  it('refuses --sync with no key, before it tries to send', async () => {
    const sent: Sent[] = [];
    const captured = capture();

    const err = await runSignerHistory(
      captured.out,
      args(['signer', 'history', SAFE, '--sync']),
      deps(lagging(), { sent }),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // Reading needs no key; sending does.
    expect(err).toBeInstanceOf(UsageError);
    expect(sent).toHaveLength(0);
  });

  it('reports a sync that could not be sent as sync_failed, and says the history still lags', async () => {
    const sent: Sent[] = [];
    const captured = capture();

    const err = await runSignerHistory(
      captured.out,
      args(['signer', 'history', SAFE, '--sync']),
      deps(lagging(), { sent, privateKey: KEY, sendFails: new Error('nonce too low') }),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect((err as CliError).code).toBe('sync_failed');
    expect((err as Error).message).toContain('was not recorded (nonce too low)');
    expect(sent).toHaveLength(0);
  });
});
