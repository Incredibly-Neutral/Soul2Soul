// ============================================================================
// `s2s signer history` — what the OwnerHistory module recorded, and whether it
// still matches the Safe's owners.
//
// The module read is a fake on `SignerDeps.readHistory`; the config and the L2
// endpoint are the queue test's stubs. No socket, no chain: the Safe's owners,
// threshold and 4337 facts are faked too, because `--sync` decides the rail the
// way `confirm` does. A read needs no key; `--sync` sends, so those tests hand
// the command one through the config stub.
// ============================================================================

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeFunctionData, type Address, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OwnerHistoryModuleV1 } from '@s2s/author-contracts';

import {
  SponsoredSendRefused,
  SponsoredSendReverted,
} from '../src/adapters/tx-runner';
import type { OwnerHistoryRead } from '../src/core/author-contracts';
import { SAFE_4337_MODULE } from '../src/core/author-safe';
import { addSigner, authorsFilePath } from '../src/core/authors';
import { loadConfig, type CliConfig } from '../src/core/config';
import { findSignerCommand, signerHelpEntries } from '../src/commands/index';
import { runSignerHistory, signerHistory } from '../src/commands/signer-history';
import { read4337From, type ChainSafe, type Safe4337Reads, type SignerDeps } from '../src/commands/signer-store';
import { parseCommandArgs, type ParsedArgs } from '../src/lib/args';
import { CliError } from '../src/lib/errors';
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
  // No paymaster unless a test asks for one, so the rail is the EOA by default.
  vi.stubEnv('S2S_PIMLICO_KEY', '');
  vi.stubEnv('PIMLICO_KEY', '');
  vi.stubEnv('PIMLICO_API_KEY', '');
  vi.stubEnv('S2S_PAYMASTER_URL', '');
  vi.stubEnv('S2S_BUNDLER_URL', '');
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

/** A sponsored send: the same call, addressed through the Safe, with the config. */
interface Sponsored extends Sent {
  safe: Address;
  config: CliConfig;
}

/**
 * The Safe's owners and threshold, as `readSafe` answers them: one owner, the
 * EOA for private key 1, which is the shape `s2s author new` creates.
 */
const ONE_OF_ONE: ChainSafe = {
  deployed: true,
  owners: ['0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'],
  threshold: 1,
  nonce: 7,
};

/** `keccak256("fallback_manager.handler.address")`, the Safe's handler slot. */
const FALLBACK_HANDLER_SLOT: Hex =
  '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5';

/** One storage word holding `address` in its low 20 bytes. */
function addressWord(address: Address): Hex {
  return `0x${'00'.repeat(12)}${address.slice(2)}`.toLowerCase() as Hex;
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
    sponsored?: Sponsored[];
    /** The key the sync is sent with; empty by default, as the read needs none. */
    privateKey?: string;
    sendFails?: unknown;
    sponsoredFails?: unknown;
    receipts?: { rpcUrl: string; hash: Hex }[];
    /** The Safe's owners and threshold; 1-of-1 unless a test says otherwise. */
    chain?: ChainSafe;
    /** What the 4337 reads answer: the module is off unless a test says on. */
    moduleEnabled?: boolean;
    /** The handler the Safe's storage slot holds. */
    fallbackHandler?: Address | null;
    /** A 4337 read that cannot answer: a warning, then the EOA pays. */
    read4337Fails?: unknown;
  } = {},
): Partial<SignerDeps> {
  const sent = options.sent ?? [];
  const sponsored = options.sponsored ?? [];
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
    readSafe: () => Promise.resolve(options.chain ?? ONE_OF_ONE),
    // The real decode over a fake chain, as `confirm`'s fixture does: a stubbed
    // decision would hide a reader that asks the wrong slot or the wrong module.
    read4337: () => {
      const failure = options.read4337Fails;
      if (failure !== undefined) {
        return Promise.reject(failure instanceof Error ? failure : new Error('read failed'));
      }
      const handler =
        options.fallbackHandler === null ? undefined : (options.fallbackHandler ?? SAFE_4337_MODULE);
      const chainReads: Safe4337Reads = {
        word: (slot) => {
          if (slot !== FALLBACK_HANDLER_SLOT) throw new Error(`unexpected slot ${slot}`);
          return Promise.resolve(handler === undefined ? '0x' : addressWord(handler));
        },
        moduleEnabled: (module) => {
          if (module !== SAFE_4337_MODULE) throw new Error(`unexpected module ${module}`);
          return Promise.resolve(options.moduleEnabled ?? false);
        },
      };
      return read4337From(chainReads);
    },
    send: (input) => {
      const failure = options.sendFails;
      if (failure !== undefined) {
        return Promise.reject(failure instanceof Error ? failure : new Error('send failed'));
      }
      sent.push(input);
      return Promise.resolve(SYNC_TX);
    },
    sendSponsored: (input) => {
      const failure = options.sponsoredFails;
      if (failure !== undefined) {
        return Promise.reject(
          failure instanceof Error ? failure : new Error('sponsored send failed'),
        );
      }
      sponsored.push(input);
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

/** The Safe this machine files for its active author: the command takes no `<safe>`. */
function filesSafe(): void {
  addSigner({ name: 'harry', privateKey: KEY_HARRY, safe: SAFE }, authorsFilePath());
}

describe('s2s signer history', () => {
  it('shows both owners, one era each, and no closing complaint when the history agrees', async () => {
    filesSafe();
    const captured = capture();

    await runSignerHistory(captured.out, args(['signer', 'history']), deps(rotated()));

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
    filesSafe();
    const captured = capture();

    await runSignerHistory(
      captured.out,
      args(['signer', 'history']),
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
    filesSafe();
    const lagging: OwnerHistoryRead = {
      ...rotated(),
      // The swap ran as a module self-call: the owners moved, the era did not.
      eraCount: 1,
      eras: [{ index: 0, startBlock: 100, endBlock: null, owners: [HARRY] }],
      lastSyncedBlock: 100,
      lags: true,
    };

    await runSignerHistory(captured.out, args(['signer', 'history']), deps(lagging));

    expect(captured.results[0]?.lags).toBe(true);
    const lines = captured.human[0]?.split('\n') ?? [];
    expect(lines[lines.length - 1]).toBe(
      "the history lags the Safe's owners: sync() is permissionless and repairs it — rerun with --sync to send it",
    );
  });

  it('prints the whole document in --json, with the module the guard named', async () => {
    filesSafe();
    const captured = capture(true);

    await runSignerHistory(captured.out, args(['signer', 'history']), deps(rotated()));

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

  it('reads the Safe this machine files, and refuses when it files none', async () => {
    const captured = capture();
    filesSafe();
    await runSignerHistory(captured.out, args(['signer', 'history']), deps(rotated()));
    expect(captured.results[0]?.safe).toBe(SAFE);

    rmSync(join(dir, 'xdg'), { recursive: true, force: true });
    await expect(runSignerHistory(capture().out, args(['signer', 'history']), deps(rotated()))).rejects.toThrow(
      /files no Safe for its active author.*s2s signer add <safe>/,
    );
  });

  it('is an action of `s2s signer`, listed in the group help', () => {
    expect(findSignerCommand('history')).toBe(signerHistory);
    expect(signerHelpEntries.map((entry) => entry.name)).toContain('history');
    expect(findSignerCommand('bogus')).toBeUndefined();
  });
});

/** Valid key nobody can use for a read: privkey 6. */
const KEY_HARRY: Hex = `0x${'00'.repeat(31)}06`;

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
    filesSafe();
    const sent: Sent[] = [];
    const receipts: { rpcUrl: string; hash: Hex }[] = [];
    const captured = capture();

    await runSignerHistory(
      captured.out,
      args(['signer', 'history', '--sync']),
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
    filesSafe();
    const sent: Sent[] = [];
    const captured = capture();

    const err = await runSignerHistory(
      captured.out,
      args(['signer', 'history', '--sync']),
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
    filesSafe();
    const sent: Sent[] = [];
    const captured = capture();

    const err = await runSignerHistory(
      captured.out,
      args(['signer', 'history', '--sync']),
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

  it('sends the sync with the key the active author files, and needs no other', async () => {
    const sent: Sent[] = [];
    const captured = capture();
    filesSafe();

    await runSignerHistory(
      captured.out,
      args(['signer', 'history', '--sync']),
      deps(lagging(), { sent }),
    );

    // The store's key: the sync is a transaction from this machine, and the row
    // that files the Safe is the row that signs for it.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.privateKey).toBe(KEY_HARRY);
    expect(captured.warnings[0]).toContain(`sent sync() to ${MODULE}`);
  });

  it('reports a sync that could not be sent as sync_failed, and says the history still lags', async () => {
    filesSafe();
    const sent: Sent[] = [];
    const captured = capture();

    const err = await runSignerHistory(
      captured.out,
      args(['signer', 'history', '--sync']),
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

/**
 * Who pays for the sync. `sync()` is permissionless, so the call needs no Safe,
 * but it still costs gas: an EOA with no ETH on Base cannot send it and a
 * paymaster can, so the rail is chosen by the same gate `confirm` uses — a
 * paymaster URL, a 1-of-1 Safe, the 4337 module enabled, and that module
 * installed as the fallback handler. The EOA is never a retry after a
 * sponsorship refusal; it is a decision taken before the send.
 */
describe('s2s signer history --sync — who pays', () => {
  const PIMLICO_KEY = 'pim_test_key';
  /** The Safe 1.4.1 compatibility handler: installed, but not the 4337 module. */
  const OTHER_HANDLER: Address = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';

  it('sponsors the sync on a 1-of-1 Safe whose handler is the 4337 module', async () => {
    filesSafe();
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const sent: Sent[] = [];
    const sponsored: Sponsored[] = [];
    const receipts: { rpcUrl: string; hash: Hex }[] = [];
    const captured = capture();
    // The config the command resolved is the one the runner must get, key and all.
    const cfg: CliConfig = { ...loadConfig(), privateKey: KEY };

    await runSignerHistory(captured.out, args(['signer', 'history', '--sync']), {
      ...deps(lagging(), {
        after: rotated(),
        sent,
        sponsored,
        receipts,
        moduleEnabled: true,
      }),
      config: () => cfg,
    });

    // The sponsored rail, and only it: the EOA never had to hold ETH, which is
    // the whole reason this command needed the rail at all.
    expect(sponsored).toHaveLength(1);
    expect(sent).toHaveLength(0);
    const call = sponsored[0];
    expect(call?.to).toBe(MODULE);
    expect(call?.safe).toBe(SAFE);
    expect(call?.privateKey).toBe(KEY);
    expect(call?.config).toBe(cfg);
    expect(
      decodeFunctionData({ abi: OwnerHistoryModuleV1, data: call?.data ?? '0x' }).functionName,
    ).toBe('sync');
    // The receipt is still waited for before the re-read.
    expect(receipts).toEqual([{ rpcUrl: RPC, hash: SYNC_TX }]);
    expect(captured.warnings[0]).toBe(
      `sent sync() to ${MODULE} in ${SYNC_TX} as ${EOA}, sponsored by the paymaster`,
    );
    expect(captured.results[0]).toMatchObject({ syncTx: SYNC_TX, lags: false });
  });

  it('sends from the EOA under --self-paid, even when the Safe qualifies', async () => {
    filesSafe();
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const sent: Sent[] = [];
    const sponsored: Sponsored[] = [];
    const captured = capture();

    await runSignerHistory(
      captured.out,
      args(['signer', 'history', '--sync', '--self-paid']),
      deps(lagging(), { after: rotated(), sent, sponsored, privateKey: KEY, moduleEnabled: true }),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(MODULE);
    expect(sponsored).toHaveLength(0);
    expect(captured.warnings[0]).toContain(`as ${EOA}, paid by ${EOA} (--self-paid)`);
    expect(captured.results[0]).toMatchObject({ syncTx: SYNC_TX });
  });

  it('sends from the EOA when the Safe is not 1-of-1, and says why', async () => {
    filesSafe();
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const sent: Sent[] = [];
    const sponsored: Sponsored[] = [];
    const captured = capture();

    await runSignerHistory(captured.out, args(['signer', 'history', '--sync']), deps(lagging(), {
      after: rotated(),
      sent,
      sponsored,
      privateKey: KEY,
      moduleEnabled: true,
      chain: { deployed: true, owners: [EOA, HARRY], threshold: 2, nonce: 7 },
    }));

    // `Safe4337Module` validates the userOp against the Safe's threshold, and
    // this build signs once, so a 2-of-2 Safe cannot take a sponsored send.
    expect(sent).toHaveLength(1);
    expect(sponsored).toHaveLength(0);
    expect(captured.warnings[0]).toContain('the Safe is 2-of-2');
    expect(captured.warnings[0]).toContain(`paid by ${EOA}`);
  });

  it('sends from the EOA when the 4337 state cannot be read, and warns', async () => {
    filesSafe();
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const sent: Sent[] = [];
    const sponsored: Sponsored[] = [];
    const captured = capture();

    await runSignerHistory(captured.out, args(['signer', 'history', '--sync']), deps(lagging(), {
      after: rotated(),
      sent,
      sponsored,
      privateKey: KEY,
      read4337Fails: new Error('HTTP request failed: 429 Too Many Requests'),
    }));

    expect(sent).toHaveLength(1);
    expect(sponsored).toHaveLength(0);
    expect(captured.warnings[0]).toContain(`could not read the Safe's 4337 state`);
    expect(captured.warnings[0]).toContain('429 Too Many Requests');
    expect(captured.warnings[1]).toContain(`paid by ${EOA} (the Safe's 4337 state could not be read`);
  });

  it('sends from the EOA when the handler is the compatibility one', async () => {
    filesSafe();
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const sent: Sent[] = [];
    const sponsored: Sponsored[] = [];
    const captured = capture();

    await runSignerHistory(captured.out, args(['signer', 'history', '--sync']), deps(lagging(), {
      after: rotated(),
      sent,
      sponsored,
      privateKey: KEY,
      moduleEnabled: true,
      fallbackHandler: OTHER_HANDLER,
    }));

    expect(sent).toHaveLength(1);
    expect(sponsored).toHaveLength(0);
    expect(captured.warnings[0]).toContain(`the Safe's fallback handler is ${OTHER_HANDLER}`);
  });

  it('names the unfunded address and the paymaster rail when the EOA cannot pay', async () => {
    filesSafe();
    const sent: Sent[] = [];
    const captured = capture();

    const err = await runSignerHistory(captured.out, args(['signer', 'history', '--sync']), deps(lagging(), {
      sent,
      privateKey: KEY,
      sendFails: new Error(
        `Execution reverted with reason: gas required exceeds allowance (0). Request Arguments: from: ${EOA} to: ${MODULE}`,
      ),
    })).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect((err as CliError).code).toBe('sync_failed');
    const message = (err as Error).message;
    // The address whose balance is the problem, and the alternative, not a viem dump.
    expect(message).toContain(`${EOA} has no ETH on base`);
    expect(message).toContain(`fund ${EOA}`);
    expect(message).toContain('S2S_PIMLICO_KEY');
    expect(message).not.toContain('Request Arguments');
    expect(sent).toHaveLength(0);
  });

  it('reports a refused sponsored send as sync_failed, with the bundler reason', async () => {
    filesSafe();
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const captured = capture();

    const err = await runSignerHistory(captured.out, args(['signer', 'history', '--sync']), deps(lagging(), {
      privateKey: KEY,
      moduleEnabled: true,
      sponsoredFails: new SponsoredSendRefused(
        'bundler refused the userOp (AA31 paymaster deposit too low)',
      ),
    })).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect((err as CliError).code).toBe('sync_failed');
    expect((err as Error).message).toContain(`the sponsored sync on ${MODULE}`);
    expect((err as Error).message).toContain('AA31');
  });

  it('reports a sponsored send that landed and reverted as sync_failed, with the revert reason', async () => {
    filesSafe();
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const captured = capture();

    const err = await runSignerHistory(captured.out, args(['signer', 'history', '--sync']), deps(lagging(), {
      privateKey: KEY,
      moduleEnabled: true,
      sponsoredFails: new SponsoredSendReverted(
        `the sponsored send of sync() on ${SAFE} landed and reverted in transaction ${SYNC_TX}`,
        SYNC_TX,
        'execution reverted: caller is not an owner',
      ),
    })).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // The reason lives on the error, not in its message; a sweep that dropped it
    // would leave "not recorded" with nothing to act on.
    expect((err as CliError).code).toBe('sync_failed');
    expect((err as Error).message).toContain('caller is not an owner');
    expect((err as Error).message).toContain('the history still lags');
  });
});
