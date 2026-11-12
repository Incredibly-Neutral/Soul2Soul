// ============================================================================
// `s2s signer confirm` — sign the hash, post it, and execute when it is enough.
//
// The signature is checked by recovering it (`verifyMessage`) against the raw
// safeTxHash, and the packed list is decoded back out of the `execTransaction`
// calldata. No socket: `send` and `sendSponsored` are fakes that record their
// call, and `read4337` answers from the test.
// ============================================================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeFunctionData, size, verifyMessage, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OwnerHistoryModuleV1 } from '@s2s/author-contracts';
import { safeAbi } from '@s2s/soul2soul-shared';

import type { SafeTxRecord, SafeTxService } from '../src/adapters/safe-tx';
import { computeSafeTxHash } from '../src/adapters/safe-tx';
import {
  addSigner,
  pendingReplacement,
  readAuthors,
  storeLockPath,
} from '../src/core/authors';
import { loadConfig, type CliConfig } from '../src/core/config';
import { SAFE_4337_MODULE } from '../src/core/author-safe';
import { runSignerConfirm, signerConfirm } from '../src/commands/signer-confirm';
import type { ChainSafe, Safe4337Reads, SignerDeps } from '../src/commands/signer-store';
import type { OwnerHistoryRead } from '../src/core/author-contracts';
import { read4337From } from '../src/commands/signer-store';
import { parseCommandArgs, type ParsedArgs } from '../src/lib/args';
import {
  SponsoredSendRefused,
  SponsoredSendReverted,
  SponsoredSendUncertain,
} from '../src/adapters/tx-runner';
import { CliError } from '../src/lib/errors';
import type { CliOut } from '../src/lib/out';

/** Valid keys nobody can use: privkey 1 and 5. */
const KEY_SIGNER = `0x${'00'.repeat(31)}01`;
const EOA_SIGNER = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const KEY_STRANGER = `0x${'00'.repeat(31)}05`;
/** The key a pending rotation would file: not an owner yet. */
const KEY_REPLACEMENT: Hex = `0x${'00'.repeat(31)}03`;
const EOA_REPLACEMENT: Address = privateKeyToAccount(KEY_REPLACEMENT).address;

const SAFE: Address = '0x1111111111111111111111111111111111111111';
/** A second owner with a key, so its confirmation can actually be recovered. */
const KEY_B: Hex = `0x${'00'.repeat(31)}02`;
const OWNER_B: Address = privateKeyToAccount(KEY_B).address;
const RPC = 'https://rpc.example';
/** `keccak256("fallback_manager.handler.address")`, the Safe's handler slot. */
const FALLBACK_HANDLER_SLOT: Hex =
  '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5';

/** One storage word holding `address` in its low 20 bytes. */
function addressWord(address: Address): Hex {
  return `0x${'00'.repeat(12)}${address.slice(2)}`.toLowerCase() as Hex;
}
const CHAIN_ID = 8453;

/**
 * The hash `confirm` is given, computed from the same fields the fixture record
 * carries. A made-up hash would prove nothing: the command hands its record to
 * `execTransactionArgs` with the chain id, and only a hash the fields reproduce
 * gets past that check. The fixture that would catch its removal is the one
 * whose fields and hash disagree, below.
 */
function hashFor(nonce: number): Hex {
  return computeSafeTxHash({
    chainId: CHAIN_ID,
    safe: SAFE,
    tx: { to: SAFE, value: 0n, data: '0xdeadbeef', operation: 0, nonce },
  });
}

const HASH: Hex = hashFor(7);
/** What the fake `send` answers with — one transaction hash, asserted on. */
const TX_HASH: Hex = `0x${'77'.repeat(32)}`;
/** The OwnerHistory module the confirmation syncs once the swap has landed. */
const HISTORY_MODULE: Address = '0x2222222222222222222222222222222222222222';
/** The owner the swap adds: the era opened by the sync, not the one it replaced. */
const OWNER_NEW: Address = '0xEF5cB7c22605ABF0CdE475fc4d8fB6bf3643dF3B';

/**
 * The module as the sponsored rail leaves it: the swap executed, and era 0 still
 * names the owner it replaced — the failure guard 0x4a28…f44a swallowed on Safe
 * 0x8507…8dfB.
 */
function laggingHistory(): OwnerHistoryRead {
  return {
    module: HISTORY_MODULE,
    moduleSource: 'enabled',
    guard: null,
    guardModule: null,
    eraCount: 1,
    eras: [{ index: 0, startBlock: 100, endBlock: null, owners: [EOA_SIGNER] }],
    ownersEver: [EOA_SIGNER],
    lastSyncedBlock: 100,
    lags: true,
  };
}

/** The module after the sync: era 0 closed, era 1 open with the new owner. */
function syncedHistory(): OwnerHistoryRead {
  return {
    module: HISTORY_MODULE,
    moduleSource: 'enabled',
    guard: null,
    guardModule: null,
    eraCount: 2,
    eras: [
      { index: 0, startBlock: 100, endBlock: 640, owners: [EOA_SIGNER] },
      { index: 1, startBlock: 640, endBlock: null, owners: [OWNER_NEW] },
    ],
    ownersEver: [EOA_SIGNER, OWNER_NEW],
    lastSyncedBlock: 640,
    lags: false,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's2s-signer-confirm-'));
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
  vi.stubEnv('S2S_RPC_L2', RPC);
  vi.stubEnv('BASE_RPC_URL', '');
  vi.stubEnv('S2S_PRIVATE_KEY', KEY_SIGNER);
  // No sponsorship unless a test asks for it: the paymaster lookup reads env.
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

function capture(): Captured {
  const results: Record<string, unknown>[] = [];
  const human: string[] = [];
  const warnings: string[] = [];
  const out: CliOut = {
    json: true,
    log: () => undefined,
    warn: (message: string) => warnings.push(message),
    result: (data: unknown, text?: string) => {
      results.push(data as Record<string, unknown>);
      human.push(text ?? '');
    },
  };
  return { out, results, human, warnings };
}

/** Owner B's `signMessage` over the hash — a confirmation the packer can prove. */
async function signedByB(): Promise<Hex> {
  return privateKeyToAccount(KEY_B).signMessage({ message: { raw: HASH } });
}

/** This machine's own signature over the hash, in the same scheme. */
async function signedByMine(): Promise<Hex> {
  return privateKeyToAccount(KEY_SIGNER as Hex).signMessage({ message: { raw: HASH } });
}

function baseRecord(overrides: Partial<SafeTxRecord> = {}): SafeTxRecord {
  return {
    safeTxHash: HASH,
    safe: SAFE,
    nonce: 7,
    to: SAFE,
    value: '0',
    data: '0xdeadbeef',
    operation: 0,
    confirmations: [],
    confirmationsRequired: 2,
    isExecuted: false,
    ...overrides,
  };
}

interface FakeService {
  service: SafeTxService;
  confirmed: { safe: Address; safeTxHash: Hex; signature: Hex }[];
  gets: number;
}

/**
 * A service that remembers one proposal. `indexConfirmation: false` models the
 * indexing lag: the POST succeeds but the next `get` does not show it, and the
 * command must still execute on the signature it holds.
 */
function fakeService(
  record: SafeTxRecord,
  options: { indexConfirmation?: boolean } = {},
): FakeService {
  const confirmed: FakeService['confirmed'] = [];
  let current = record;
  const service: SafeTxService = {
    register() {
      return Promise.reject(new Error('not used by signer confirm'));
    },
    propose() {
      return Promise.reject(new Error('not used by signer confirm'));
    },
    pending() {
      return Promise.reject(new Error('not used by signer confirm'));
    },
    get() {
      fake.gets += 1;
      return Promise.resolve(current);
    },
    confirm(input) {
      confirmed.push(input);
      if (options.indexConfirmation === false) return Promise.resolve();
      current = {
        ...current,
        confirmations: [...current.confirmations, { owner: EOA_SIGNER, signature: input.signature }],
      };
      return Promise.resolve();
    },
  };
  const fake: FakeService = { service, confirmed, gets: 0 };
  return fake;
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

function deps(
  fake: FakeService,
  options: {
    chain?: ChainSafe;
    code?: boolean;
    sent?: Sent[];
    ownersAfter?: Address[];
    sponsored?: Sponsored[];
    sponsoredFails?: unknown;
    /** What the two 4337 reads answer; the module is off unless a test says on. */
    moduleEnabled?: boolean;
    /**
     * The fallback handler the Safe's storage slot holds. The fixture below turns
     * it into a storage word, so the command reads it through the real
     * `read4337From` and not through a stubbed decision.
     */
    fallbackHandler?: Address | null;
    /** A failed 4337 read: refused or unreadable RPC, never silently ignored. */
    read4337Fails?: unknown;
    /** A send that resolves with no transaction hash — not a success. */
    noHash?: boolean;
    /** The module read before the sync (default: the era the guard missed). */
    history?: OwnerHistoryRead;
    /** The re-read after the sync (default: the era the sync opened). */
    historyAfter?: OwnerHistoryRead;
    /** A module read that cannot answer: the history is unknown, not absent. */
    historyFails?: unknown;
    /** A sync send that throws, on either rail. */
    syncFails?: unknown;
    /** Receipt waits the sync made, and a receipt that says it reverted. */
    receipts?: { rpcUrl: string; hash: Hex }[];
    receiptFails?: unknown;
  } = {},
): Partial<SignerDeps> {
  const sent = options.sent ?? [];
  const sponsored = options.sponsored ?? [];
  const receipts = options.receipts ?? [];
  const before = options.history ?? laggingHistory();
  const after = options.historyAfter ?? syncedHistory();
  let reads = 0;
  let historyReads = 0;
  return {
    config: () => loadConfig(),
    service: () => fake.service,
    readSafe: () => {
      reads += 1;
      const after = options.ownersAfter;
      if (after && reads > 1) {
        // Post-execution read: the owners the chain reports once the swap ran.
        return Promise.resolve({ deployed: true, owners: after, threshold: 2, nonce: 8 });
      }
      return Promise.resolve(
        options.chain ?? { deployed: true, owners: [EOA_SIGNER, OWNER_B], threshold: 2, nonce: 7 },
      );
    },
    readCode: () => Promise.resolve(options.code ?? false),
    send: (input) => {
      if (input.to === HISTORY_MODULE && options.syncFails !== undefined) {
        return Promise.reject(
          options.syncFails instanceof Error ? options.syncFails : new Error('sync send failed'),
        );
      }
      sent.push(input);
      return Promise.resolve(options.noHash === true ? (undefined as unknown as Hex) : TX_HASH);
    },
    sendSponsored: (input) => {
      if (input.to === HISTORY_MODULE && options.syncFails !== undefined) {
        return Promise.reject(
          options.syncFails instanceof Error ? options.syncFails : new Error('sync send failed'),
        );
      }
      const failure = options.sponsoredFails;
      if (failure !== undefined) {
        return Promise.reject(failure instanceof Error ? failure : new Error('sponsored send failed'));
      }
      sponsored.push(input);
      return Promise.resolve(options.noHash === true ? (undefined as unknown as Hex) : TX_HASH);
    },
    // The real decode, over a fake chain: the storage word goes through
    // `addressFromWord`, the module check through the same function the command
    // calls. Stubbing the resulting state instead is what let a handler read
    // that always threw stay hidden behind a green suite.
    read4337: () => {
      const failure = options.read4337Fails;
      if (failure !== undefined) {
        return Promise.reject(failure instanceof Error ? failure : new Error('read failed'));
      }
      const handler =
        options.fallbackHandler === null ? undefined : (options.fallbackHandler ?? SAFE_4337_MODULE);
      const reads: Safe4337Reads = {
        word: (slot) => {
          // The slot itself is part of the contract: a reader that asks the wrong
          // slot is as wrong as one that cannot read it.
          if (slot !== FALLBACK_HANDLER_SLOT) throw new Error(`unexpected slot ${slot}`);
          return Promise.resolve(handler === undefined ? '0x' : addressWord(handler));
        },
        moduleEnabled: (module) => {
          if (module !== SAFE_4337_MODULE) throw new Error(`unexpected module ${module}`);
          return Promise.resolve(options.moduleEnabled ?? false);
        },
      };
      return read4337From(reads);
    },
    // The first read is what the confirmation finds; the second is what the sync
    // produced. A test that only installs one shape gets it twice.
    readHistory: () => {
      const failure = options.historyFails;
      if (failure !== undefined) {
        return Promise.reject(failure instanceof Error ? failure : new Error('module read failed'));
      }
      historyReads += 1;
      if (before.module === null) return Promise.resolve(before);
      return Promise.resolve(historyReads === 1 ? before : after);
    },
    waitForReceipt: (input) => {
      const failure = options.receiptFails;
      if (failure !== undefined) {
        return Promise.reject(failure instanceof Error ? failure : new Error('receipt reverted'));
      }
      receipts.push(input);
      return Promise.resolve();
    },
  };
}

/**
 * The sends that carried `execTransaction`, on either rail. A confirmation now
 * also sends the owner-history `sync()`, so a bare count of sends is no longer
 * the swap's: they are told apart by what they are addressed to.
 */
function swapSends<T extends { to: Address }>(sends: readonly T[]): T[] {
  return sends.filter((entry) => entry.to === SAFE);
}

/** The sends that carried `sync()` to the module. */
function syncSends<T extends { to: Address }>(sends: readonly T[]): T[] {
  return sends.filter((entry) => entry.to === HISTORY_MODULE);
}

/** The only element of a list the test has already asserted is length 1. */
function first<T>(items: readonly T[]): T {
  const value = items[0];
  if (value === undefined) throw new Error('expected at least one item');
  return value;
}

function args(argv: string[]): ParsedArgs {
  const parsed = parseCommandArgs(argv, signerConfirm.flags);
  return { flags: parsed.flags, positionals: parsed.positionals.slice(2) };
}

describe('s2s signer confirm', () => {
  it('signs the hash and executes when the confirmation meets the threshold', async () => {
    const fake = fakeService(
      baseRecord({ confirmations: [{ owner: OWNER_B, signature: await signedByB() }] }),
    );
    const sent: Sent[] = [];
    const captured = capture();

    await runSignerConfirm(
      captured.out,
      args(['signer', 'confirm', HASH, '--safe', SAFE]),
      deps(fake, { sent }),
    );

    // One confirmation, over the raw hash, from this key.
    expect(fake.confirmed).toHaveLength(1);
    expect(captured.results[0]).toMatchObject({ posted: true });
    const signature = first(fake.confirmed).signature;
    expect(await verifyMessage({ address: EOA_SIGNER, message: { raw: HASH }, signature })).toBe(true);

    // One transaction, to the Safe, carrying the proposal's own fields.
    expect(swapSends(sent)).toHaveLength(1);
    const sentOnce = first(swapSends(sent));
    expect(sentOnce.to).toBe(SAFE);
    expect(sentOnce.privateKey).toBe(KEY_SIGNER);
    const call = decodeFunctionData({ abi: safeAbi, data: sentOnce.data });
    expect(call.functionName).toBe('execTransaction');
    const execArgs = call.args as readonly Hex[];
    const packed = execArgs[9] ?? '0x';
    // two owners signed: 2 × 65 bytes, ascending address order, v bumped to 31/32
    expect(size(packed)).toBe(130);
    // ascending address order, so owner B's signature is the first 65 bytes
    expect(packed.slice(2, 66)).toBe((await signedByB()).slice(2, 66));
    expect(['1f', '20']).toContain(packed.slice(-2));

    expect(captured.results[0]).toMatchObject({
      action: 'signer.confirm',
      safe: SAFE,
      safeTxHash: HASH,
      eoa: EOA_SIGNER,
      nonce: 7,
      confirmations: 2,
      required: 2,
      confirmed: true,
      executed: true,
      txHash: TX_HASH,
    });
    expect(captured.results[0]?.settled).toBeUndefined();
    expect(captured.human[0]).toContain('gas');
  });

  it('executes on its own signature when the service has not indexed it yet', async () => {
    const fake = fakeService(
      baseRecord({ confirmations: [{ owner: OWNER_B, signature: await signedByB() }] }),
      { indexConfirmation: false },
    );
    const sent: Sent[] = [];
    const captured = capture();

    await runSignerConfirm(
      captured.out,
      args(['signer', 'confirm', HASH, '--safe', SAFE]),
      deps(fake, { sent }),
    );

    expect(swapSends(sent)).toHaveLength(1);
    expect(captured.results[0]).toMatchObject({ confirmations: 2, executed: true });
  });

  it('refuses to execute a confirmation that recovers to nobody, before spending gas', async () => {
    const fake = fakeService(
      baseRecord({
        confirmations: [{ owner: OWNER_B, signature: `0x${'ab'.repeat(64)}1c` }],
      }),
    );
    const sent: Sent[] = [];
    const captured = capture();

    await expect(
      runSignerConfirm(
        captured.out,
        args(['signer', 'confirm', HASH, '--safe', SAFE]),
        deps(fake, { sent }),
      ),
    ).rejects.toMatchObject({ code: 'signature_not_owner' });
    // the confirmation reached the service; nothing was sent from the EOA
    expect(fake.confirmed).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it('executes a proposal this key already signed instead of posting the signature again', async () => {
    // Both schemes a confirmation arrives in: a bare 27/28 signature over the
    // digest (`sign({hash})`, which is what `s2s signer rotate` posts with the
    // old key) and a 31/32 eth_sign signature (`signMessage`). Either is this
    // owner's confirmation, and the service already holds it.
    const account = privateKeyToAccount(KEY_SIGNER as Hex);
    const schemes: { name: string; signature: Hex }[] = [
      { name: 'sign({hash})', signature: await account.sign({ hash: HASH }) },
      {
        name: 'signMessage({raw})',
        signature: await account.signMessage({ message: { raw: HASH } }),
      },
    ];

    for (const scheme of schemes) {
      const fake = fakeService(
        baseRecord({
          confirmations: [{ owner: EOA_SIGNER, signature: scheme.signature }],
          confirmationsRequired: 1,
        }),
      );
      const sent: Sent[] = [];
      const captured = capture();

      await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
        ...deps(fake, {
          sent,
          chain: { deployed: true, owners: [EOA_SIGNER], threshold: 1, nonce: 7 },
        }),
      });

      // No POST: the confirmation is already in the record, and a second one
      // would only replace the same entry.
      expect(fake.confirmed, scheme.name).toHaveLength(0);
      expect(swapSends(sent), scheme.name).toHaveLength(1);
      expect(captured.results[0]).toMatchObject({
        posted: false,
        confirmed: true,
        executed: true,
        confirmations: 1,
        required: 1,
      });
      expect(captured.human[0]).toContain('had already signed');
      // The signature that was already on the record is the one that was packed.
      const call = decodeFunctionData({ abi: safeAbi, data: first(swapSends(sent)).data });
      const execArgs = call.args as readonly Hex[];
      expect((execArgs[9] ?? '0x').slice(2, 66)).toBe(scheme.signature.slice(2, 66));
    }
  });

  it('says nothing was posted when this key had already signed a proposal that cannot execute yet', async () => {
    // The combination that used to lie: nothing was posted (the signature was
    // already there) and nothing was executed (the Safe is not at this nonce).
    const fake = fakeService(
      baseRecord({
        safeTxHash: hashFor(9),
        nonce: 9,
        confirmations: [{ owner: EOA_SIGNER, signature: await signedByMine() }],
      }),
    );
    const sent: Sent[] = [];
    const captured = capture();

    await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
      ...deps(fake, {
        sent,
        chain: { deployed: true, owners: [EOA_SIGNER, OWNER_B], threshold: 2, nonce: 7 },
      }),
    });

    expect(fake.confirmed).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(captured.results[0]).toMatchObject({ posted: false, confirmed: true, executed: false });
    const note = String(captured.results[0]?.note);
    expect(note).toContain('already signed by this key, nothing posted');
    expect(note).toContain('nonce 7');
    // The old wording claimed a confirmation that never happened.
    expect(note).not.toContain('confirmed, not executed');
  });

  it('says the confirmation was posted when it was, and what is still missing', async () => {
    const fake = fakeService(baseRecord({ confirmations: [], confirmationsRequired: 3 }));
    const captured = capture();

    await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
      ...deps(fake, {
        chain: { deployed: true, owners: [EOA_SIGNER, OWNER_B], threshold: 3, nonce: 7 },
      }),
    });

    expect(captured.results[0]).toMatchObject({ posted: true, executed: false });
    const note = String(captured.results[0]?.note);
    expect(note).toContain('confirmation posted');
    expect(note).toContain('2 more confirmations needed');
  });

  it('says nothing was posted under --no-execute when the signature was already there', async () => {
    const fake = fakeService(
      baseRecord({ confirmations: [{ owner: EOA_SIGNER, signature: await signedByMine() }] }),
    );
    const sent: Sent[] = [];
    const captured = capture();

    await runSignerConfirm(
      captured.out,
      args(['signer', 'confirm', HASH, '--safe', SAFE, '--no-execute']),
      deps(fake, { sent, chain: { deployed: true, owners: [EOA_SIGNER, OWNER_B], threshold: 2, nonce: 7 } }),
    );

    expect(fake.confirmed).toHaveLength(0);
    expect(sent).toHaveLength(0);
    const note = String(captured.results[0]?.note);
    expect(note).toContain('already signed by this key, nothing posted');
    expect(note).toContain('--no-execute');
  });

  it('posts its own confirmation when the record carries only other owners', async () => {
    const fake = fakeService(
      baseRecord({ confirmations: [{ owner: OWNER_B, signature: await signedByB() }] }),
    );
    const captured = capture();

    await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
      ...deps(fake),
    });

    expect(fake.confirmed).toHaveLength(1);
    expect(captured.results[0]).toMatchObject({ posted: true });
  });

  it('does not read a signature over another digest as this owner\'s confirmation', async () => {
    // Owner B's signature, labelled as this key. Recovery over the wrong digest
    // yields some other valid address rather than an error, so "it recovered"
    // is not the test — "it recovered to this owner" is. Here it does not, so
    // the POST happens even though the label says otherwise.
    const fake = fakeService(
      baseRecord({ confirmations: [{ owner: EOA_SIGNER, signature: await signedByB() }] }),
    );
    const captured = capture();

    await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
      ...deps(fake),
    });

    expect(fake.confirmed).toHaveLength(1);
    expect(captured.results[0]).toMatchObject({ posted: true });
  });

  it('posts the confirmation and stops when --no-execute is given', async () => {
    const fake = fakeService(
      baseRecord({ confirmations: [{ owner: OWNER_B, signature: await signedByB() }] }),
    );
    const sent: Sent[] = [];
    const captured = capture();

    await runSignerConfirm(
      captured.out,
      args(['signer', 'confirm', HASH, '--safe', SAFE, '--no-execute']),
      deps(fake, { sent }),
    );

    expect(fake.confirmed).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect(captured.results[0]).toMatchObject({ confirmed: true, executed: false });
    expect(captured.results[0]?.note).toContain('--no-execute');
  });

  it('waits when the confirmations are still short', async () => {
    const fake = fakeService(baseRecord({ confirmations: [], confirmationsRequired: 3 }));
    const sent: Sent[] = [];
    const captured = capture();

    await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
      ...deps(fake, { sent, chain: { deployed: true, owners: [EOA_SIGNER, OWNER_B], threshold: 3, nonce: 7 } }),
    });

    expect(fake.confirmed).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect(captured.results[0]).toMatchObject({ confirmations: 1, required: 3, executed: false });
    expect(captured.results[0]?.note).toContain('2 more confirmations needed');
  });

  it('confirms but does not execute a proposal queued behind another nonce', async () => {
    const fake = fakeService(
      baseRecord({
        safeTxHash: hashFor(8),
        nonce: 8,
        confirmations: [{ owner: OWNER_B, signature: await signedByB() }],
      }),
    );
    const sent: Sent[] = [];
    const captured = capture();

    await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
      ...deps(fake, { sent }),
    });

    expect(fake.confirmed).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect(captured.results[0]).toMatchObject({ nonce: 8, executed: false });
    expect(captured.results[0]?.note).toContain('nonce 7');
  });

  it('refuses a key that is not an owner, before signing anything', async () => {
    const fake = fakeService(baseRecord());
    const captured = capture();

    await expect(
      runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
        ...deps(fake),
        config: () => ({ ...loadConfig(), privateKey: KEY_STRANGER }),
      }),
    ).rejects.toMatchObject({ code: 'not_owner' });
    expect(fake.confirmed).toHaveLength(0);
  });

  it('refuses an executed proposal', async () => {
    const fake = fakeService(baseRecord({ isExecuted: true }));
    const captured = capture();

    await expect(
      runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), deps(fake)),
    ).rejects.toMatchObject({ code: 'already_executed' });
    expect(fake.confirmed).toHaveLength(0);
  });

  it('refuses a stale proposal the Safe has moved past', async () => {
    const fake = fakeService(baseRecord({ safeTxHash: hashFor(6), nonce: 6 }));
    const captured = capture();

    await expect(
      runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), deps(fake)),
    ).rejects.toMatchObject({ code: 'stale_nonce' });
    expect(fake.confirmed).toHaveLength(0);
  });

  it('refuses a record whose fields are not the hash it was given, before spending gas', async () => {
    // The signatures recover over HASH, so packing succeeds; the fields do not
    // hash to it. Without the chain id handed to `execTransactionArgs` this
    // would send: the record's own hash check passed when it was read.
    const fake = fakeService(
      baseRecord({
        data: '0xfeedface',
        confirmations: [{ owner: OWNER_B, signature: await signedByB() }],
      }),
    );
    const sent: Sent[] = [];
    const captured = capture();

    await expect(
      runSignerConfirm(
        captured.out,
        args(['signer', 'confirm', HASH, '--safe', SAFE]),
        deps(fake, { sent }),
      ),
    ).rejects.toMatchObject({ code: 'safe_tx_hash_mismatch' });
    expect(sent).toHaveLength(0);
  });

  it('refuses a Safe with no bytecode', async () => {
    const fake = fakeService(baseRecord());
    const captured = capture();

    await expect(
      runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
        ...deps(fake, { chain: { deployed: false, owners: [], threshold: 0, nonce: 0 } }),
      }),
    ).rejects.toMatchObject({ code: 'safe_not_deployed' });
    expect(fake.confirmed).toHaveLength(0);
  });

  it('refuses an owner entry that is a contract', async () => {
    const fake = fakeService(baseRecord());
    const captured = capture();

    await expect(
      runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
        ...deps(fake, { code: true }),
      }),
    ).rejects.toMatchObject({ code: 'contract_owner' });
    expect(fake.confirmed).toHaveLength(0);
  });

  it('rejects an argument that is not a safeTxHash', async () => {
    const fake = fakeService(baseRecord());
    const captured = capture();
    await expect(
      runSignerConfirm(captured.out, args(['signer', 'confirm', '0xdead', '--safe', SAFE]), deps(fake)),
    ).rejects.toBeInstanceOf(CliError);
    expect(fake.confirmed).toHaveLength(0);
  });

  it('reports a refused script transaction from the EOA without pretending it landed', async () => {
    const fake = fakeService(
      baseRecord({ confirmations: [{ owner: OWNER_B, signature: await signedByB() }] }),
    );
    const captured = capture();

    await expect(
      runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
        ...deps(fake),
        send: () => Promise.reject(new CliError('insufficient funds for gas', 1, 'rpc_send_failed')),
      }),
    ).rejects.toMatchObject({ code: 'rpc_send_failed' });
    // the confirmation is on the service; only the execution failed
    expect(fake.confirmed).toHaveLength(1);
    expect(captured.results).toHaveLength(0);
  });

  it('names the gas money when the EOA cannot pay for the execution', async () => {
    const fake = fakeService(
      baseRecord({ confirmations: [{ owner: OWNER_B, signature: await signedByB() }] }),
    );
    const captured = capture();

    // viem surfaces a node's refusal as an execution error whose text carries
    // the node's wording; the funds case is matched, not typed.
    const reverted = Object.assign(
      new Error('Execution reverted with reason: gas required exceeds allowance (0).'),
      { shortMessage: 'Execution reverted with reason: gas required exceeds allowance (0).' },
    );

    await expect(
      runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
        ...deps(fake),
        send: () => Promise.reject(reverted),
      }),
    ).rejects.toMatchObject({ code: 'insufficient_gas' });
    // The recovery is funding the address: the confirmation stays posted and
    // the message has to say so.
    expect(fake.confirmed).toHaveLength(1);
    expect(captured.results).toHaveLength(0);
  });

  it('settles a pending replacement once the swap has executed', async () => {
    const fake = fakeService(
      baseRecord({ confirmations: [{ owner: OWNER_B, signature: await signedByB() }] }),
    );
    const sent: Sent[] = [];
    const captured = capture();
    const path = join(dir, 'xdg', 's2s', 'authors.json');
    addSigner({ name: 'zomi', privateKey: KEY_SIGNER, safe: SAFE }, path);
    addSigner(
      { name: 'zomi-next', privateKey: KEY_REPLACEMENT, safe: SAFE, replaces: 'zomi' },
      path,
    );

    await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
      ...deps(fake, { sent, ownersAfter: [EOA_REPLACEMENT, OWNER_B] }),
    });

    expect(swapSends(sent)).toHaveLength(1);
    expect(captured.results[0]).toMatchObject({ executed: true, settled: 'zomi-next' });
    expect(captured.human[0]).toContain(`settled: zomi-next is now the key for ${SAFE}`);
    // the new row is the active one and the old row is gone
    const store = readAuthors(path);
    expect(store.active).toBe('zomi-next');
    expect(store.authors.zomi).toBeUndefined();
    expect(pendingReplacement(SAFE)).toBeUndefined();
  });

  it('settles the store the seam names, not the default one', async () => {
    // No execution here: the only reconcile this run does is the one before the
    // owner check, which is the call that has to hit the seam path.
    const fake = fakeService(baseRecord());
    const captured = capture();
    const seam = join(dir, 'seam', 'authors.json');

    // The same two rows in both files. Only the one the seam names may move.
    for (const path of [seam, join(dir, 'xdg', 's2s', 'authors.json')]) {
      addSigner({ name: 'zomi', privateKey: KEY_SIGNER, safe: SAFE }, path);
      addSigner(
        { name: 'zomi-next', privateKey: KEY_REPLACEMENT, safe: SAFE, replaces: 'zomi' },
        path,
      );
    }

    // The chain says the swap landed, so this key is no longer an owner: the
    // run stops at the owner check, after the reconcile has moved the store.
    await expect(
      runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
        ...deps(fake, {
          chain: { deployed: true, owners: [EOA_REPLACEMENT, OWNER_B], threshold: 2, nonce: 8 },
        }),
        authorsPath: () => seam,
      }),
    ).rejects.toMatchObject({ code: 'not_owner' });

    expect(fake.gets).toBe(0);
    expect(readAuthors(seam).active).toBe('zomi-next');
    expect(readAuthors(seam).authors.zomi).toBeUndefined();
    // The default store is untouched: its chase is still pending.
    const untouched = readAuthors(join(dir, 'xdg', 's2s', 'authors.json'));
    expect(untouched.active).toBe('zomi');
    expect(untouched.authors['zomi-next']?.replaces).toBe('zomi');
  });

  it('reports the dead writer whose lock it cleared, the way rotate does', async () => {
    const fake = fakeService(baseRecord());
    const warnings: string[] = [];
    const out: CliOut = {
      json: true,
      log: () => undefined,
      warn: (message: string) => warnings.push(message),
      result: () => undefined,
    };
    const path = join(dir, 'xdg', 's2s', 'authors.json');
    addSigner({ name: 'zomi', privateKey: KEY_SIGNER, safe: SAFE }, path);
    addSigner(
      { name: 'zomi-next', privateKey: KEY_REPLACEMENT, safe: SAFE, replaces: 'zomi' },
      path,
    );
    // A command killed mid-write: the store lock it left names a pid that is not
    // running. Clearing it is right; clearing it silently is not, because the
    // killed command may have printed a key it never recorded.
    const lock = storeLockPath(path);
    mkdirSync(join(dir, 'xdg', 's2s'), { recursive: true });
    const pid = 2 ** 22 + 11;
    writeFileSync(lock, `${String(pid)}\n`);

    await expect(
      runSignerConfirm(out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
        ...deps(fake, { chain: { deployed: true, owners: [EOA_REPLACEMENT, OWNER_B], threshold: 2, nonce: 8 } }),
      }),
    ).rejects.toMatchObject({ code: 'not_owner' });

    expect(warnings.join('\n')).toContain(`pid ${String(pid)}`);
    expect(warnings.join('\n')).toContain('was not running');
    expect(existsSync(lock)).toBe(false);
    expect(readAuthors(path).active).toBe('zomi-next');
  });

  it('settles before the record read, so a run that died after executing still reconciles', async () => {
    const fake = fakeService(baseRecord());
    const captured = capture();
    const path = join(dir, 'xdg', 's2s', 'authors.json');
    addSigner({ name: 'zomi', privateKey: KEY_SIGNER, safe: SAFE }, path);
    addSigner(
      { name: 'zomi-next', privateKey: KEY_REPLACEMENT, safe: SAFE, replaces: 'zomi' },
      path,
    );

    // The chain says the swap already landed, so this key is no longer an
    // owner: the confirmation is refused, but the store is reconciled first.
    await expect(
      runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
        ...deps(fake, { chain: { deployed: true, owners: [EOA_REPLACEMENT, OWNER_B], threshold: 2, nonce: 8 } }),
      }),
    ).rejects.toMatchObject({ code: 'not_owner' });

    expect(fake.gets).toBe(0);
    expect(readAuthors(path).active).toBe('zomi-next');
    expect(readAuthors(path).authors.zomi).toBeUndefined();
  });
});

/**
 * Who pays for the execution. The decision is made before the send, from four
 * facts: a paymaster URL, the Safe's threshold, the Safe's own
 * `isModuleEnabled(SAFE_4337_MODULE)`, and `getFallbackHandler()` being that
 * module. The EOA rail is a shape the command chooses, never a retry after a
 * sponsorship refusal.
 *
 * A failed sponsored send is classified too: refused before submission (nothing
 * landed) or submitted with an unknown outcome (it may have executed, so the
 * user checks the queue first).
 */
describe('s2s signer confirm — who pays', () => {
  const PIMLICO_KEY = 'pim_test_key';
  /** The Safe 1.4.1 compatibility handler: installed, but not the 4337 module. */
  const OTHER_HANDLER: Address = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';

  /** The shape `s2s author new` creates: one signature can validate a userOp. */
  const ONE_OF_ONE: ChainSafe = {
    deployed: true,
    owners: [EOA_SIGNER, OWNER_B],
    threshold: 1,
    nonce: 7,
  };

  /** A proposal one signature short, which this run's confirmation executes. */
  async function executable(
    overrides: Partial<SafeTxRecord> = {},
  ): Promise<FakeService> {
    return fakeService(
      baseRecord({
        confirmations: [{ owner: OWNER_B, signature: await signedByB() }],
        ...overrides,
      }),
    );
  }

  /** The refusal text a Pimlico policy gives, AA code included. */
  function policyRefusal(): Error {
    return new Error('paymaster refused: policy denied (AA31 paymaster deposit too low)');
  }

  it('sponsors the execution on a 1-of-1 Safe whose handler is the 4337 module', async () => {
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const fake = await executable();
    const sent: Sent[] = [];
    const sponsored: Sponsored[] = [];
    const captured = capture();
    const cfg = loadConfig();

    await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
      ...deps(fake, { chain: ONE_OF_ONE, sent, sponsored, moduleEnabled: true }),
      // The config the command resolved is the one the runner must get: a
      // reload inside the seam would lose an injected config and `--key`.
      config: () => cfg,
    });

    // The sponsored rail, and only it: no plain transaction was sent, so the
    // EOA never had to hold ETH.
    expect(swapSends(sponsored)).toHaveLength(1);
    expect(sent).toHaveLength(0);
    const call = first(swapSends(sponsored));
    expect(call.safe).toBe(SAFE);
    expect(call.privateKey).toBe(KEY_SIGNER);
    expect(call.to).toBe(SAFE);
    expect(call.config).toBe(cfg);
    // The command hands the send the `execTransaction` calldata itself; the
    // adapter is what wraps it in a userOp.
    expect(call.data.startsWith('0x6a761202')).toBe(true);
    expect(decodeFunctionData({ abi: safeAbi, data: call.data }).functionName).toBe('execTransaction');

    expect(captured.results[0]).toMatchObject({
      executed: true,
      txHash: TX_HASH,
      paidBy: 'paymaster',
    });
    expect(captured.human[0]).toContain('sponsored by the paymaster');
  });

  it('sends from the EOA under --self-paid, even with the paymaster configured', async () => {
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const fake = await executable();
    const sent: Sent[] = [];
    const sponsored: Sponsored[] = [];
    const captured = capture();

    await runSignerConfirm(
      captured.out,
      args(['signer', 'confirm', HASH, '--safe', SAFE, '--self-paid']),
      deps(fake, { chain: ONE_OF_ONE, sent, sponsored, moduleEnabled: true }),
    );

    expect(swapSends(sent)).toHaveLength(1);
    expect(sponsored).toHaveLength(0);
    expect(captured.results[0]).toMatchObject({ executed: true, paidBy: 'eoa' });
    expect(captured.human[0]).toContain(`paid by ${EOA_SIGNER}`);
    expect(captured.human[0]).toContain('--self-paid');
  });

  it('sends from the EOA when only the bundler is configured, and names the paymaster setting', async () => {
    vi.stubEnv('S2S_BUNDLER_URL', 'https://bundler.example');
    const fake = await executable();
    const sent: Sent[] = [];
    const sponsored: Sponsored[] = [];
    const captured = capture();

    await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
      ...deps(fake, { chain: ONE_OF_ONE, sent, sponsored, moduleEnabled: true }),
    });

    expect(swapSends(sent)).toHaveLength(1);
    expect(sponsored).toHaveLength(0);
    expect(captured.results[0]).toMatchObject({ executed: true, paidBy: 'eoa' });
    // The setting that is actually missing, not the one the pair is named after.
    expect(captured.human[0]).toContain('no paymaster configured');
    expect(captured.human[0]).toContain('S2S_PAYMASTER_URL');
  });

  it('sends from the EOA when nothing is configured, and names the bundler setting', async () => {
    const fake = await executable();
    const sent: Sent[] = [];
    const sponsored: Sponsored[] = [];
    const captured = capture();

    await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
      ...deps(fake, { chain: ONE_OF_ONE, sent, sponsored, moduleEnabled: true }),
    });

    expect(swapSends(sent)).toHaveLength(1);
    expect(sponsored).toHaveLength(0);
    expect(captured.human[0]).toContain('no bundler configured');
    expect(captured.human[0]).toContain('S2S_BUNDLER_URL');
  });

  it('sends from the EOA on a 2-of-2 Safe, and says the userOp would need two signatures', async () => {
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const fake = await executable();
    const sent: Sent[] = [];
    const sponsored: Sponsored[] = [];
    const captured = capture();

    await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
      ...deps(fake, { sent, sponsored, moduleEnabled: true }),
    });

    expect(swapSends(sent)).toHaveLength(1);
    expect(sponsored).toHaveLength(0);
    expect(captured.results[0]).toMatchObject({ executed: true, paidBy: 'eoa' });
    // The threshold is a condition, not a formality: the module checks the
    // userOp signature against it, and this build signs once.
    expect(captured.human[0]).toContain('2-of-2');
    expect(captured.human[0]).toContain('need 2 signatures');
    expect(captured.human[0]).toContain('signs one');
  });

  it('sends from the EOA when the Safe has no 4337 module, and names the module', async () => {
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const fake = await executable();
    const sent: Sent[] = [];
    const sponsored: Sponsored[] = [];
    const captured = capture();

    await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
      ...deps(fake, { chain: ONE_OF_ONE, sent, sponsored, moduleEnabled: false }),
    });

    expect(swapSends(sent)).toHaveLength(1);
    expect(sponsored).toHaveLength(0);
    expect(captured.results[0]).toMatchObject({ executed: true, paidBy: 'eoa' });
    expect(captured.human[0]).toContain('Safe4337Module');
    expect(captured.human[0]).toContain('not enabled');
  });

  it('sends from the EOA when the fallback handler is not the module, and names the handler', async () => {
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const fake = await executable();
    const sent: Sent[] = [];
    const sponsored: Sponsored[] = [];
    const captured = capture();

    await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
      ...deps(fake, {
        chain: ONE_OF_ONE,
        sent,
        sponsored,
        moduleEnabled: true,
        fallbackHandler: OTHER_HANDLER,
      }),
    });

    expect(swapSends(sent)).toHaveLength(1);
    expect(sponsored).toHaveLength(0);
    // Enabled is not enough: the module is reached through the fallback, so a
    // different handler validates nothing.
    expect(captured.human[0]).toContain(`fallback handler is ${OTHER_HANDLER}`);
    expect(captured.human[0]).toContain('not the Safe4337Module');
  });

  it('sends from the EOA when the Safe has no fallback handler, and says so', async () => {
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const fake = await executable();
    const sent: Sent[] = [];
    const sponsored: Sponsored[] = [];
    const captured = capture();

    await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
      ...deps(fake, { chain: ONE_OF_ONE, sent, sponsored, moduleEnabled: true, fallbackHandler: null }),
    });

    expect(sponsored).toHaveLength(0);
    expect(swapSends(sent)).toHaveLength(1);
    expect(captured.human[0]).toContain('no fallback handler');
  });

  it('sends from the EOA with a warning when the 4337 reads fail, rather than throwing', async () => {
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const fake = await executable();
    const sent: Sent[] = [];
    const sponsored: Sponsored[] = [];
    const captured = capture();

    await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
      ...deps(fake, {
        chain: ONE_OF_ONE,
        sent,
        sponsored,
        read4337Fails: new Error('HTTP request failed: 429 Too Many Requests'),
      }),
    });

    // The confirmation is already posted by now: an unreadable RPC must not
    // turn into a throw that leaves the user without the execution.
    expect(swapSends(sent)).toHaveLength(1);
    expect(sponsored).toHaveLength(0);
    expect(captured.results[0]).toMatchObject({ executed: true, paidBy: 'eoa' });
    expect(captured.warnings.join('\n')).toContain("the Safe's 4337 state");
    expect(captured.warnings.join('\n')).toContain('429');
    expect(captured.human[0]).toContain('could not be read');
  });

  it('reports a refusal before submission as sponsored_send_failed, names the AA code, and never retries on the EOA', async () => {
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const fake = await executable();
    const sent: Sent[] = [];
    const captured = capture();

    const err = await runSignerConfirm(
      captured.out,
      args(['signer', 'confirm', HASH, '--safe', SAFE]),
      deps(fake, {
        chain: ONE_OF_ONE,
        sent,
        moduleEnabled: true,
        sponsoredFails: new SponsoredSendRefused('paymaster refused: policy denied', {
          cause: policyRefusal(),
        }),
      }),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('sponsored_send_failed');
    const message = (err as Error).message;
    // No silent fallback, and the work already done stands: the proposal is
    // queued and this key's confirmation is on the service.
    expect(sent).toHaveLength(0);
    expect(fake.confirmed).toHaveLength(1);
    expect(captured.results).toHaveLength(0);
    // The refusal is named, with its AA code, and claimed as not sent.
    expect(message).toContain('policy denied');
    expect(message).toContain('AA31');
    expect(message).toContain('nothing was sent');
  });

  it('offers two recoveries that work: --self-paid, or fixing the policy', async () => {
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const fake = await executable();
    const captured = capture();

    const err = await runSignerConfirm(
      captured.out,
      args(['signer', 'confirm', HASH, '--safe', SAFE]),
      deps(fake, {
        chain: ONE_OF_ONE,
        moduleEnabled: true,
        sponsoredFails: new SponsoredSendRefused('paymaster refused: policy denied'),
      }),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    const message = (err as Error).message;
    expect(message).toContain('fix the paymaster policy');
    expect(message).toContain(`--self-paid to pay from ${EOA_SIGNER}`);
    // Funding the EOA on its own is not a recovery: a rerun without
    // `--self-paid` asks the same paymaster again. Saying otherwise sends the
    // user round the loop that produced this message.
    expect(message).not.toContain('and run it again');
    expect(message).toContain('a rerun without --self-paid asks the paymaster again');
  });

  it('reports a send whose receipt was lost as send_outcome_unknown, and sends the user to the queue', async () => {
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const fake = await executable();
    const sent: Sent[] = [];
    const captured = capture();

    const err = await runSignerConfirm(
      captured.out,
      args(['signer', 'confirm', HASH, '--safe', SAFE]),
      deps(fake, {
        chain: ONE_OF_ONE,
        sent,
        moduleEnabled: true,
        sponsoredFails: new SponsoredSendUncertain(
          'Timed out while waiting for user operation receipt to be included',
          `0x${'33'.repeat(32)}`,
        ),
      }),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('send_outcome_unknown');
    const message = (err as Error).message;
    // Submitted, so the outcome is unknown — not "nothing was sent", which is
    // what makes a blind retry look safe.
    expect(message).toContain('was submitted');
    expect(message).toContain('outcome is unknown');
    expect(message).not.toContain('nothing was sent');
    expect(message).toContain(`s2s signer queue ${SAFE}`);
    expect(message).toContain('nonce 7');
    expect(message).toContain('twice');
    expect(sent).toHaveLength(0);
    expect(fake.confirmed).toHaveLength(1);
    expect(captured.results).toHaveLength(0);
  });

  it('reports a reverted userOp as sponsored_send_reverted, naming the transaction', async () => {
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const fake = await executable();
    const sent: Sent[] = [];
    const captured = capture();
    const REVERTED_TX: Hex = `0x${'44'.repeat(32)}`;

    const err = await runSignerConfirm(
      captured.out,
      args(['signer', 'confirm', HASH, '--safe', SAFE]),
      deps(fake, {
        chain: ONE_OF_ONE,
        sent,
        moduleEnabled: true,
        sponsoredFails: new SponsoredSendReverted(
          `the userOp landed and reverted in transaction ${REVERTED_TX}`,
          REVERTED_TX,
          'GS026',
        ),
      }),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('sponsored_send_reverted');
    const message = (err as Error).message;
    // The transaction exists, so the hash is the only handle on it.
    expect(message).toContain(REVERTED_TX);
    expect(message).toContain('GS026');
    // Landed and reverted is a third state: not "nothing was sent", not unknown.
    expect(message).toContain('the proposal did not execute and is unchanged');
    expect(message).not.toContain('nothing was sent');
    expect(message).not.toContain('outcome is unknown');
    expect(message).not.toContain('--self-paid');
    expect(sent).toHaveLength(0);
    expect(captured.results).toHaveLength(0);
  });

  it('names the reverted transaction once when the revert carried no reason', async () => {
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const fake = await executable();
    const captured = capture();
    const REVERTED_TX: Hex = `0x${'55'.repeat(32)}`;

    const err = await runSignerConfirm(
      captured.out,
      args(['signer', 'confirm', HASH, '--safe', SAFE]),
      deps(fake, {
        chain: ONE_OF_ONE,
        moduleEnabled: true,
        sponsoredFails: new SponsoredSendReverted(
          `the userOp landed and reverted in transaction ${REVERTED_TX}`,
          REVERTED_TX,
          undefined,
        ),
      }),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect((err as CliError).code).toBe('sponsored_send_reverted');
    const message = (err as Error).message;
    // The error's own sentence already names the transaction, so appending it to
    // a prefix that names it too printed the hash twice.
    expect(message.split(REVERTED_TX)).toHaveLength(2);
    expect(message).toContain('landed and reverted');
    expect(message).toContain('the proposal did not execute and is unchanged');
  });

  it('reports a paymaster that could not price the userOp as not sent, not as unknown', async () => {
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const fake = await executable();
    const sent: Sent[] = [];
    const captured = capture();

    const err = await runSignerConfirm(
      captured.out,
      args(['signer', 'confirm', HASH, '--safe', SAFE]),
      deps(fake, {
        chain: ONE_OF_ONE,
        sent,
        moduleEnabled: true,
        // The fee read that precedes the send fails. No userOp was built, so this
        // may not come back as "it may have executed".
        sponsoredFails: new SponsoredSendRefused(
          'HTTP request failed: 503 Service Unavailable (paymaster down)',
        ),
      }),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('sponsored_send_failed');
    const message = (err as Error).message;
    expect(message).toContain('nothing was sent');
    expect(message).not.toContain('outcome is unknown');
    expect(message).not.toContain('s2s signer queue');
    expect(sent).toHaveLength(0);
  });

  it('treats an untagged timeout as unknown rather than refused', async () => {
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const fake = await executable();
    const captured = capture();

    const err = await runSignerConfirm(
      captured.out,
      args(['signer', 'confirm', HASH, '--safe', SAFE]),
      deps(fake, {
        chain: ONE_OF_ONE,
        moduleEnabled: true,
        sponsoredFails: new Error('Timed out while waiting for user operation receipt to be included'),
      }),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // Nothing in the text says the bundler rejected it, so the safe reading is
    // that it may have landed.
    expect((err as CliError).code).toBe('send_outcome_unknown');
    expect((err as Error).message).toContain(`s2s signer queue ${SAFE}`);
  });

  it('refuses to claim an execution when the send returns no hash', async () => {
    vi.stubEnv('S2S_PIMLICO_KEY', PIMLICO_KEY);
    const fake = await executable();
    const captured = capture();

    const err = await runSignerConfirm(
      captured.out,
      args(['signer', 'confirm', HASH, '--safe', SAFE]),
      deps(fake, { chain: ONE_OF_ONE, moduleEnabled: true, noHash: true }),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('send_outcome_unknown');
    expect((err as Error).message).toContain('no transaction hash');
    // `executed` and `paidBy` are statements about the chain, so a run with no
    // chain answer prints no result at all.
    expect(captured.results).toHaveLength(0);
  });
});

/**
 * The era is not the swap. Under the sponsored rail the guard's hook is starved
 * — the gas limit is the bundler's estimate from a simulation in which the
 * hook's failure is swallowed — so the confirmation sends `sync()` itself, on
 * the payer the swap used, and reports what became of the era.
 */
describe('s2s signer confirm — the owner-history era', () => {
  /** A Safe whose userOp one signature can validate, so sponsorship is offered. */
  const ONE_OF_ONE: ChainSafe = {
    deployed: true,
    owners: [EOA_SIGNER, OWNER_B],
    threshold: 1,
    nonce: 7,
  };

  async function executable(): Promise<FakeService> {
    return fakeService(
      baseRecord({ confirmations: [{ owner: OWNER_B, signature: await signedByB() }] }),
    );
  }

  it('sends sync() to the module after the swap, and names the era it opened', async () => {
    const fake = await executable();
    const sent: Sent[] = [];
    const receipts: { rpcUrl: string; hash: Hex }[] = [];
    const captured = capture();

    await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
      ...deps(fake, { sent, receipts }),
    });

    // Two sends: the swap, then the module's own function. The sync is not
    // guessed at — it is the `sync()` selector addressed to the module — and its
    // receipt was waited for before the eras were read back.
    expect(sent).toHaveLength(2);
    const sync = first(syncSends(sent));
    expect(sync.privateKey).toBe(KEY_SIGNER);
    expect(decodeFunctionData({ abi: OwnerHistoryModuleV1, data: sync.data }).functionName).toBe(
      'sync',
    );
    expect(receipts).toHaveLength(1);

    expect(captured.results[0]).toMatchObject({
      executed: true,
      history: {
        module: HISTORY_MODULE,
        recorded: true,
        txHash: TX_HASH,
        era: 1,
        owners: [OWNER_NEW],
      },
    });
    expect(captured.human[0]).toContain(
      `history: era 1 open with 0xEF5cB7c2…dF3B, recorded in ${TX_HASH}`,
    );
  });

  it('sponsors the sync when the swap was sponsored, and never crosses rails', async () => {
    vi.stubEnv('S2S_PIMLICO_KEY', 'pim_test_key');
    const fake = await executable();
    const sent: Sent[] = [];
    const sponsored: Sponsored[] = [];
    const captured = capture();

    await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
      ...deps(fake, { chain: ONE_OF_ONE, sent, sponsored, moduleEnabled: true }),
    });

    expect(syncSends(sponsored)).toHaveLength(1);
    expect(first(syncSends(sponsored)).safe).toBe(SAFE);
    // The EOA sent nothing: a sponsored rotation earns a sponsored sync.
    expect(sent).toHaveLength(0);
  });

  it('sends the sync from the EOA under --self-paid, on the rail the swap used', async () => {
    vi.stubEnv('S2S_PIMLICO_KEY', 'pim_test_key');
    const fake = await executable();
    const sent: Sent[] = [];
    const sponsored: Sponsored[] = [];
    const captured = capture();

    await runSignerConfirm(
      captured.out,
      args(['signer', 'confirm', HASH, '--safe', SAFE, '--self-paid']),
      deps(fake, { chain: ONE_OF_ONE, sent, sponsored, moduleEnabled: true }),
    );

    expect(swapSends(sent)).toHaveLength(1);
    expect(syncSends(sent)).toHaveLength(1);
    expect(sponsored).toHaveLength(0);
  });

  it('reports a sync that could not be sent, keeps the swap, and still settles the store', async () => {
    const fake = await executable();
    const sent: Sent[] = [];
    const captured = capture();
    const path = join(dir, 'xdg', 's2s', 'authors.json');
    addSigner({ name: 'zomi', privateKey: KEY_SIGNER, safe: SAFE }, path);
    addSigner(
      { name: 'zomi-next', privateKey: KEY_REPLACEMENT, safe: SAFE, replaces: 'zomi' },
      path,
    );

    await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
      ...deps(fake, {
        sent,
        ownersAfter: [EOA_REPLACEMENT, OWNER_B],
        syncFails: new Error('insufficient funds for gas'),
      }),
    });

    // The command does not fail: the swap landed and the only thing missing is
    // the era — which is reported, because a silent failure is how the bug in
    // production got there.
    expect(captured.results[0]).toMatchObject({
      executed: true,
      history: {
        module: HISTORY_MODULE,
        recorded: false,
        reason: 'insufficient funds for gas',
      },
    });
    expect(captured.human[0]).toContain('history: not recorded (insufficient funds for gas)');
    expect(captured.human[0]).toContain('`s2s signer history --sync` repairs it');
    // The store still moved on to the owner the chain reports.
    expect(readAuthors(path).active).toBe('zomi-next');
  });

  it('reports a sync whose receipt says it reverted as not recorded', async () => {
    const fake = await executable();
    const sent: Sent[] = [];
    const captured = capture();

    await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
      ...deps(fake, { sent, receiptFails: new Error('transaction reverted') }),
    });

    // It was sent — a hash came back — and it did not record anything.
    expect(syncSends(sent)).toHaveLength(1);
    expect(captured.results[0]).toMatchObject({
      executed: true,
      history: { recorded: false, reason: 'transaction reverted' },
    });
    expect(captured.human[0]).toContain('history: not recorded (transaction reverted)');
  });

  it('says no module is installed, in one line, and sends nothing after the swap', async () => {
    const fake = await executable();
    const sent: Sent[] = [];
    const captured = capture();
    const empty: OwnerHistoryRead = {
      module: null,
      moduleSource: null,
      guard: null,
      guardModule: null,
      eraCount: 0,
      eras: [],
      ownersEver: [],
      lastSyncedBlock: null,
      lags: false,
    };

    await runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), {
      ...deps(fake, { sent, history: empty }),
    });

    expect(syncSends(sent)).toHaveLength(0);
    expect(captured.results[0]).toMatchObject({
      executed: true,
      history: { module: null, recorded: false, absent: true },
    });
    expect(captured.human[0]).toContain(
      'history: no owner-history module is installed on the Safe, so this rotation is not recorded',
    );
  });
});
