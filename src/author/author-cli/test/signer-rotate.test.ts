// ============================================================================
// `s2s signer rotate` — swap this machine's key for a fresh one, in one Safe
// transaction, threshold untouched.
//
// No socket: the chain read and the service are both injected through
// `SignerDeps`, and the one real computation (the safeTxHash) is checked
// against `computeSafeTxHash` on the very transaction the command built. The
// calldata is decoded back to the three addresses `swapOwner` takes, in order.
// ============================================================================

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeFunctionData, recoverAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { safeAbi } from '@s2s/soul2soul-shared';

import type { SafeTxRecord, SafeTxService } from '../src/adapters/safe-tx';
import {
  SENTINEL_OWNERS,
  computeSafeTxHash,
  swapOwnerData,
  type SafeTxInput,
} from '../src/adapters/safe-tx';
import { addSigner, pendingReplacement, readAuthors } from '../src/core/authors';
import { storeLockPath } from '../src/core/authors';
import { loadConfig } from '../src/core/config';
import { runSignerRotate, signerRotate } from '../src/commands/signer-rotate';
import type { ChainSafe, SignerDeps } from '../src/commands/signer-store';
import { commandHelp, parseCommandArgs, type ParsedArgs } from '../src/lib/args';
import type { CliOut } from '../src/lib/out';

/** Valid keys nobody can use: privkey 1, 2, 3 and 4. */
const KEY_OLD = `0x${'00'.repeat(31)}01`;
const EOA_OLD = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const KEY_NEW = `0x${'00'.repeat(31)}02`;
const EOA_NEW = '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF';
const KEY_OTHER = `0x${'00'.repeat(31)}04`;
/** A second owner that is not this machine's key. */
const KEY_B: Hex = `0x${'00'.repeat(31)}03`;
/** A key that is on no owner list: what a never-accepted row holds. */
const KEY_FIVE: Hex = `0x${'00'.repeat(31)}05`;
const OWNER_B: Address = privateKeyToAccount(KEY_B).address;

const SAFE: Address = '0x1111111111111111111111111111111111111111';
/** A second Safe, for rows that must not occupy this one's slot. */
const OTHER_SAFE: Address = '0x9999999999999999999999999999999999999999';
/** A well-formed safeTxHash for a queued swap: 32 bytes, nothing else. */
const QUEUED_HASH: Hex = `0x${'ab'.repeat(32)}`;
const RPC = 'https://rpc.example';
const CHAIN_ID = 8453;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's2s-signer-rotate-'));
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
  vi.stubEnv('S2S_RPC_L2', RPC);
  vi.stubEnv('BASE_RPC_URL', '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const storePath = (): string => join(dir, 'xdg', 's2s', 'authors.json');

interface Captured {
  out: CliOut;
  results: Record<string, unknown>[];
  warnings: string[];
  human: string[];
}

function capture(): Captured {
  const results: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const human: string[] = [];
  const out: CliOut = {
    json: true,
    log: () => undefined,
    warn: (message: string) => warnings.push(message),
    result: (data: unknown, text?: string) => {
      results.push(data as Record<string, unknown>);
      human.push(text ?? '');
    },
  };
  return { out, results, warnings, human };
}

interface Registered {
  safe: Address;
  owners: Address[];
  threshold: number;
}

interface Proposed {
  safe: Address;
  sender: Address;
  tx: SafeTxInput;
  signature: Hex;
}

interface FakeService {
  service: SafeTxService;
  registered: Registered[];
  proposed: Proposed[];
  /** Every `pending(safe)` the command made — the store-alone decision cannot
   * be tested without knowing whether the service was asked at all. */
  asked: Address[];
}

/**
 * The three methods `rotate` uses. `fail` models an unreachable service, and
 * `queued` is what `pending(safe)` answers with — the swaps the service already
 * holds, which is how a POST whose reply was lost becomes visible.
 */
function fakeService(
  fail?: Error,
  queued: SafeTxRecord[] = [],
  queuedComplete = true,
): FakeService {
  const registered: Registered[] = [];
  const proposed: Proposed[] = [];
  const asked: Address[] = [];
  const service: SafeTxService = {
    register(safe, info) {
      registered.push({ safe, owners: info.owners, threshold: info.threshold });
      return Promise.resolve();
    },
    propose(input) {
      if (fail) return Promise.reject(fail);
      proposed.push({
        safe: input.safe,
        sender: input.sender,
        tx: input.tx,
        signature: input.signature,
      });
      return Promise.resolve({
        safeTxHash: computeSafeTxHash({ chainId: CHAIN_ID, safe: input.safe, tx: input.tx }),
      });
    },
    pending(safe) {
      asked.push(safe);
      return Promise.resolve({ records: queued, complete: queuedComplete });
    },
    get() {
      return Promise.reject(new Error('not used by signer rotate'));
    },
    confirm() {
      return Promise.reject(new Error('not used by signer rotate'));
    },
  };
  return { service, registered, proposed, asked };
}

function deps(fake: FakeService, chain: Partial<ChainSafe> = {}): Partial<SignerDeps> {
  return {
    config: () => loadConfig(),
    service: () => fake.service,
    readSafe: () =>
      Promise.resolve({ deployed: true, owners: [EOA_OLD, OWNER_B], threshold: 2, nonce: 7, ...chain }),
    readCode: () => Promise.resolve(false),
    authorsPath: storePath,
    chainId: CHAIN_ID,
  };
}

/**
 * A pid that is certainly not running: one past the system's maximum, which
 * `kill(pid, 0)` answers with `ESRCH` exactly as it does for a dead process.
 */
function deadPid(): number {
  return 2 ** 22 + 11;
}

/** File the old key the way `signer add` does: a given Safe, active. */
function seedOld(name = 'zomi', privateKey = KEY_OLD): void {
  addSigner({ name, privateKey, safe: SAFE }, storePath());
}

function args(argv: string[]): ParsedArgs {
  const parsed = parseCommandArgs(argv, signerRotate.flags);
  return { flags: parsed.flags, positionals: parsed.positionals.slice(2) };
}

describe('s2s signer rotate', () => {
  it('shows the optional argument and the reason for it in --help', () => {
    const help = commandHelp(
      'signer',
      signerRotate.name,
      signerRotate.summary,
      signerRotate.flags,
      signerRotate.params,
      signerRotate.detail,
    );
    expect(help.startsWith('s2s signer rotate [<safe>] [flags]')).toBe(true);
    // The reason the argument is optional: the store already names the Safe.
    expect(help).toContain('this machine files when it signs');
    expect(help).toContain('pass <safe> only to pick another one');
  });

  it('files the new key inactive and proposes swapOwner(prev, old, new)', async () => {
    const fake = fakeService();
    const captured = capture();
    seedOld();

    // The old key is second in the list, so its predecessor is a real owner —
    // not the sentinel that a hardcoded `prevOwner` would produce.
    await runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), {
      ...deps(fake, { owners: [OWNER_B, EOA_OLD], nonce: 9 }),
    });

    const expectedTx: SafeTxInput = {
      to: SAFE,
      value: 0n,
      data: swapOwnerData(OWNER_B, EOA_OLD, EOA_NEW),
      operation: 0,
      nonce: 9,
    };

    expect(captured.results[0]).toMatchObject({
      action: 'signer.rotate',
      name: 'zomi-next',
      replaces: 'zomi',
      eoa: EOA_NEW,
      oldEoa: EOA_OLD,
      safe: SAFE,
      threshold: 2,
      nonce: 9,
      proposed: true,
      safeTxHash: computeSafeTxHash({ chainId: CHAIN_ID, safe: SAFE, tx: expectedTx }),
      safeTx: { to: SAFE, data: expectedTx.data },
    });

    // The proposal is addressed to the Safe itself, at zero gas, from the key
    // that is retiring — not from the key that joins when the swap executes.
    expect(fake.registered).toEqual([{ safe: SAFE, owners: [OWNER_B, EOA_OLD], threshold: 2 }]);
    const posted = fake.proposed[0];
    if (posted === undefined) throw new Error('the command posted no proposal');
    expect(posted.sender).toBe(EOA_OLD);
    expect(posted.tx).toEqual(expectedTx);
    // The service files the signature as its sender's confirmation, so it is the
    // old key's own signature over the hash, and it recovers to that key.
    expect(
      await recoverAddress({
        hash: computeSafeTxHash({ chainId: CHAIN_ID, safe: SAFE, tx: expectedTx }),
        signature: posted.signature,
      }),
    ).toBe(EOA_OLD);

    // The calldata is swapOwner(prevOwner, oldOwner, newOwner) — three
    // addresses, in that order, and the threshold appears nowhere.
    const decoded = decodeFunctionData({ abi: safeAbi, data: expectedTx.data });
    expect(decoded.functionName).toBe('swapOwner');
    expect(decoded.args).toEqual([OWNER_B, EOA_OLD, EOA_NEW]);

    // The new row is on disk and inactive; the old row is untouched and still
    // the key this machine signs with, so it can confirm the swap.
    const store = readAuthors(storePath());
    expect(store.active).toBe('zomi');
    expect(store.authors.zomi?.privateKey).toBe(KEY_OLD);
    expect(store.authors['zomi-next']).toMatchObject({
      privateKey: KEY_NEW,
      safe: SAFE,
      safeSource: 'given',
      replaces: 'zomi',
    });

    // The two things the human output has to say about the keys: the old key's
    // signature already counts as its confirmation, and it is an owner until the
    // swap executes.
    const human = captured.human[0] ?? '';
    expect(human).toContain("'zomi' signed it (1 of 2 confirmations)");
    expect(human).toContain('the remaining owners run');
    expect(human).toContain('stops being an owner only when the swap executes');
  });

  it('names the sentinel as prevOwner when the old key is first in the list', async () => {
    const fake = fakeService();
    const captured = capture();
    seedOld();

    await runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), {
      ...deps(fake),
    });

    const data = fake.proposed[0]?.tx.data ?? '0x';
    const decoded = decodeFunctionData({ abi: safeAbi, data });
    expect(decoded.functionName).toBe('swapOwner');
    expect(decoded.args).toEqual([SENTINEL_OWNERS, EOA_OLD, EOA_NEW]);
  });

  it('settles a replacement that already executed, then rotates the key it settled on', async () => {
    const fake = fakeService();
    const captured = capture();
    seedOld();
    addSigner({ name: 'zomi-next', privateKey: KEY_NEW, safe: SAFE, replaces: 'zomi' }, storePath());

    // The chain says the swap landed: the new key is an owner, the old is not.
    await runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_OTHER]), {
      ...deps(fake, { owners: [EOA_NEW, OWNER_B] }),
    });

    expect(captured.results[0]).toMatchObject({ replaces: 'zomi-next', name: 'zomi-next-next' });
    const store = readAuthors(storePath());
    expect(store.active).toBe('zomi-next');
    expect(store.authors.zomi).toBeUndefined();
    expect(store.authors['zomi-next-next']?.replaces).toBe('zomi-next');
  });

  it('calls a row the chain does not own stale, names it, and files no swap against it', async () => {
    const fake = fakeService();
    const captured = capture();
    addSigner({ name: 'zomi', privateKey: KEY_OTHER, safe: SAFE }, storePath());

    const run = (): Promise<void> =>
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), deps(fake));

    await expect(run()).rejects.toMatchObject({ code: 'not_owner' });
    await expect(run()).rejects.toThrow(
      /a key the chain does not list as an owner of 0x1111[\s\S]*'zomi' \(0x[0-9a-fA-F]{40}\)[\s\S]*s2s signer queue/,
    );
    expect(fake.proposed).toHaveLength(0);
    expect(fake.asked).toHaveLength(0);
    expect(readAuthors(storePath()).authors['zomi-next']).toBeUndefined();
  });

  it('refuses when the effective key owns the Safe but the store files it under another one', async () => {
    const fake = fakeService();
    const captured = capture();
    const otherSafe: Address = '0x2222222222222222222222222222222222222222';
    // No row for this Safe, so rule 2 would file the environment key here — but
    // one key keeps one row, and this one already names another Safe.
    addSigner({ name: 'elsewhere', privateKey: KEY_OLD, safe: otherSafe }, storePath());
    vi.stubEnv('S2S_PRIVATE_KEY', KEY_OLD);

    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), deps(fake)),
    ).rejects.toThrow(/is filed as 'elsewhere', a row for 0x2222[\s\S]*one key under one row/);
    expect(fake.proposed).toHaveLength(0);
    expect(Object.keys(readAuthors(storePath()).authors)).toEqual(['elsewhere']);
  });

  it('keeps the Safe slot for its stale row even when the environment key owns the Safe', async () => {
    const fake = fakeService();
    const captured = capture();
    addSigner({ name: 'zomi', privateKey: KEY_OTHER, safe: SAFE }, storePath());
    vi.stubEnv('S2S_PRIVATE_KEY', KEY_OLD);

    // Rule 2 cannot file the effective key here: this store holds one key per
    // Safe, and the stale row holds that slot. Refusing is the only honest
    // answer, and it does not quietly retire a key the chain never accepted.
    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), deps(fake)),
    ).rejects.toThrow(/a key the chain does not list as an owner/);
    expect(readAuthors(storePath()).authors['signer-7e5f45']).toBeUndefined();
    expect(fake.proposed).toHaveLength(0);
  });

  it('refuses a Safe with no key filed for it, naming `signer add`', async () => {
    const fake = fakeService();
    const captured = capture();

    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), deps(fake)),
    ).rejects.toThrow(/s2s signer add/);
    expect(fake.proposed).toHaveLength(0);
  });

  it('refuses a key that is already an owner', async () => {
    const fake = fakeService();
    const captured = capture();
    seedOld();

    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_B]), deps(fake)),
    ).rejects.toMatchObject({ code: 'already_owner' });
    expect(fake.proposed).toHaveLength(0);
    expect(Object.keys(readAuthors(storePath()).authors)).toEqual(['zomi']);
  });

  it('refuses the key that is already filed here', async () => {
    const fake = fakeService();
    const captured = capture();
    seedOld();

    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_OLD]), deps(fake)),
    ).rejects.toMatchObject({ code: 'same_key' });
    expect(fake.proposed).toHaveLength(0);
  });

  it('refuses a second replacement when one is already queued, naming `signer confirm`', async () => {
    const fake = fakeService();
    const captured = capture();
    seedOld();
    addSigner(
      { name: 'zomi-next', privateKey: KEY_NEW, safe: SAFE, replaces: 'zomi', proposal: QUEUED_HASH },
      storePath(),
    );

    // A row WITH a proposal is a queued swap: only executing it moves the store
    // on, so the message names the command that executes it and nothing that
    // would drop the row.
    const err = await runSignerRotate(
      captured.out,
      args(['signer', 'rotate', SAFE, '--key', KEY_OTHER]),
      deps(fake),
    ).catch((thrown: unknown) => thrown);
    expect(err).toMatchObject({ code: 'replacement_pending' });
    const message = err instanceof Error ? err.message : '';
    expect(message).toContain(`s2s signer confirm ${QUEUED_HASH}`);
    expect(message).not.toContain('author rm');
    expect(fake.proposed).toHaveLength(0);
    expect(Object.keys(readAuthors(storePath()).authors)).toEqual(['zomi', 'zomi-next']);
  });

  it('takes the Safe from the active row when no argument names one', async () => {
    const fake = fakeService();
    const captured = capture();
    seedOld();

    await runSignerRotate(captured.out, args(['signer', 'rotate', '--key', KEY_NEW]), {
      ...deps(fake),
    });

    // The row that signs already names its Safe; the command line need not.
    expect(captured.results[0]).toMatchObject({ safe: SAFE, name: 'zomi-next', proposed: true });
    expect(fake.proposed).toHaveLength(1);
  });

  it('refuses without an argument when no filed key owns a Safe, naming <safe>', async () => {
    const fake = fakeService();
    const captured = capture();
    // Filed for SAFE, but not on its owner list, and nothing is chasing a swap.
    addSigner({ name: 'zomi', privateKey: KEY_OTHER, safe: SAFE }, storePath());

    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', '--key', KEY_NEW]), deps(fake)),
    ).rejects.toThrow(/pass <safe>/);
    expect(fake.proposed).toHaveLength(0);
    expect(readAuthors(storePath()).authors['zomi-next']).toBeUndefined();
  });

  it('reuses the key a failed run filed instead of minting another', async () => {
    const fake = fakeService();
    const captured = capture();
    seedOld();
    // `replaces` and no `proposal`: the key was printed once and the swap never
    // queued. Re-running must finish that swap with that key.
    addSigner({ name: 'zomi-next', privateKey: KEY_NEW, safe: SAFE, replaces: 'zomi' }, storePath());

    await runSignerRotate(captured.out, args(['signer', 'rotate']), {
      ...deps(fake),
      keySource: () => {
        throw new Error('a retry must not resolve a new key');
      },
    });

    const expectedTx: SafeTxInput = {
      to: SAFE,
      value: 0n,
      data: swapOwnerData(SENTINEL_OWNERS, EOA_OLD, EOA_NEW),
      operation: 0,
      nonce: 7,
    };
    const expectedHash = computeSafeTxHash({ chainId: CHAIN_ID, safe: SAFE, tx: expectedTx });

    expect(captured.results[0]).toMatchObject({
      name: 'zomi-next',
      eoa: EOA_NEW,
      reused: true,
      proposed: true,
      safeTxHash: expectedHash,
    });
    // Nothing was generated, so no phrase is printed and no key is echoed.
    expect(captured.results[0]?.mnemonic).toBeUndefined();
    expect(captured.human[0]).not.toContain('mnemonic');

    // One key, one row: the store was reused, not extended.
    const store = readAuthors(storePath());
    expect(Object.keys(store.authors)).toEqual(['zomi', 'zomi-next']);
    expect(store.authors['zomi-next']?.privateKey).toBe(KEY_NEW);
    // The successful queue is recorded, which is what stops the next run from
    // treating the row as stranded again.
    expect(store.authors['zomi-next']?.proposal).toBe(expectedHash);

    // Posted with the old key's signature, as the service requires.
    const posted = fake.proposed[0];
    if (posted === undefined) throw new Error('the retry posted no proposal');
    expect(posted.sender).toBe(EOA_OLD);
    expect(await recoverAddress({ hash: expectedHash, signature: posted.signature })).toBe(EOA_OLD);
    expect(captured.human[0]).toContain('reusing the key filed by the failed run');
  });

  it('leaves a failed proposal retryable: the {to, data} is printed and the next run finishes it', async () => {
    seedOld();
    const failing = fakeService(new Error('safe transaction service said 422'));
    const first = capture();

    await runSignerRotate(first.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), {
      ...deps(failing),
    });

    const data = swapOwnerData(SENTINEL_OWNERS, EOA_OLD, EOA_NEW);
    expect(first.results[0]).toMatchObject({ proposed: false, safeTx: { to: SAFE, data } });
    // No hash recorded: the row is stranded, which is exactly what a retry reads.
    expect(readAuthors(storePath()).authors['zomi-next']?.proposal).toBeUndefined();

    const retry = fakeService();
    const second = capture();
    await runSignerRotate(second.out, args(['signer', 'rotate']), {
      ...deps(retry),
      keySource: () => {
        throw new Error('a retry must not resolve a new key');
      },
    });

    expect(second.results[0]).toMatchObject({ reused: true, proposed: true });
    expect(retry.proposed).toHaveLength(1);
    expect(readAuthors(storePath()).authors['zomi-next']?.proposal).toBe(
      second.results[0]?.safeTxHash,
    );
  });

  it('keeps the key and reports the raw call when the service refuses the proposal', async () => {
    const fake = fakeService(new Error('safe transaction service said 422'));
    const captured = capture();
    seedOld();

    await runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), {
      ...deps(fake),
    });

    const data = swapOwnerData(SENTINEL_OWNERS, EOA_OLD, EOA_NEW);
    expect(captured.results[0]).toMatchObject({
      proposed: false,
      note: 'safe transaction service said 422',
      safeTx: { to: SAFE, data },
      safeTxHash: computeSafeTxHash({
        chainId: CHAIN_ID,
        safe: SAFE,
        tx: { to: SAFE, value: 0n, data, operation: 0, nonce: 7 },
      }),
    });
    expect(captured.warnings).toHaveLength(1);
    expect(captured.warnings[0]).toContain('not queued');
    // The key survives the failure, still inactive: the old key is still the
    // owner and still the key this machine signs with.
    const store = readAuthors(storePath());
    expect(store.active).toBe('zomi');
    expect(store.authors['zomi-next']?.privateKey).toBe(KEY_NEW);
  });

  it('reports the call by hand and proposes nothing when no service is configured', async () => {
    const fake = fakeService();
    const captured = capture();
    seedOld();

    await runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), {
      ...deps(fake),
      config: () => ({ ...loadConfig(), safeTx: { url: '', key: undefined } }),
    });

    expect(fake.proposed).toHaveLength(0);
    expect(captured.results[0]).toMatchObject({ proposed: false });
    expect(captured.results[0]?.note).toContain('no Safe Transaction Service URL');
  });

  it('refuses a Safe with no bytecode and files nothing', async () => {
    const fake = fakeService();
    const captured = capture();
    seedOld();

    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), {
        ...deps(fake, { deployed: false, owners: [], threshold: 0, nonce: 0 }),
      }),
    ).rejects.toMatchObject({ code: 'safe_not_deployed' });
    expect(Object.keys(readAuthors(storePath()).authors)).toEqual(['zomi']);
  });

  it('honours --name and prints a generated phrase once', async () => {
    const fake = fakeService();
    const captured = capture();
    seedOld();
    const phrase =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

    await runSignerRotate(
      captured.out,
      args(['signer', 'rotate', SAFE, '--name', 'cold', '--key', KEY_NEW]),
      {
        ...deps(fake),
        keySource: () => ({ privateKey: KEY_NEW, mnemonic: phrase, generated: true }),
      },
    );

    expect(captured.results[0]).toMatchObject({
      name: 'cold',
      replaces: 'zomi',
      mnemonic: phrase,
      privateKey: KEY_NEW,
    });
    expect(captured.human[0]?.split(phrase)).toHaveLength(2);
    expect(captured.human[0]).toContain('printed once, this is the only copy');
    expect(readAuthors(storePath()).authors.cold?.replaces).toBe('zomi');
    expect(pendingReplacement(SAFE)?.name).toBe('cold');
  });

  it('reads and writes the store the seam names, never the default one', async () => {
    const fake = fakeService();
    const captured = capture();
    const seam = join(dir, 'seam', 'authors.json');

    // The default path holds a pending row for the same Safe. A reconcile that
    // went through `authorsFilePath()` rather than the seam would find it and
    // refuse this run as `replacement_pending`.
    seedOld();
    addSigner({ name: 'decoy', privateKey: KEY_NEW, safe: SAFE, replaces: 'zomi' }, storePath());
    addSigner({ name: 'zomi', privateKey: KEY_OLD, safe: SAFE }, seam);

    await runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), {
      ...deps(fake),
      authorsPath: () => seam,
    });

    // The rotation landed in the store the run was given…
    const written = readAuthors(seam);
    expect(written.active).toBe('zomi');
    expect(written.authors.zomi?.privateKey).toBe(KEY_OLD);
    expect(written.authors['zomi-next']?.replaces).toBe('zomi');
    expect(captured.results[0]).toMatchObject({ name: 'zomi-next', proposed: true });
    // …and the default store is exactly as it was, marker and all.
    const untouched = readAuthors(storePath());
    expect(untouched.authors.decoy?.replaces).toBe('zomi');
    expect(untouched.authors['zomi-next']).toBeUndefined();
  });

  it('says the swap is executable as soon as the service holds it when one signature is enough', async () => {
    const fake = fakeService();
    const captured = capture();
    seedOld();

    await runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), {
      ...deps(fake, { threshold: 1 }),
    });

    // At threshold 1 the proposer's own signature is the whole quorum: there is
    // nothing left for a later `confirm` to add, only something left to send.
    const human = captured.human[0] ?? '';
    expect(human).toContain("'zomi' signed it (1 of 1 confirmations)");
    expect(human).toContain('the threshold is met');
    expect(human).toContain('executable as soon as the service holds it');
    expect(human).toContain('nothing left to sign');
    expect(human).not.toContain('the remaining owners run');
  });

  it('adopts a swap the service already holds when the reply never arrived', async () => {
    const captured = capture();
    seedOld();
    addSigner({ name: 'zomi-next', privateKey: KEY_NEW, safe: SAFE, replaces: 'zomi' }, storePath());
    // The store says "never queued"; the service says otherwise. That is exactly
    // the state a POST leaves when it lands and its reply is lost.
    const tx: SafeTxInput = {
      to: SAFE,
      value: 0n,
      data: swapOwnerData(SENTINEL_OWNERS, EOA_OLD, EOA_NEW),
      operation: 0,
      nonce: 7,
    };
    const fake = fakeService(undefined, [
      {
        safeTxHash: QUEUED_HASH,
        safe: SAFE,
        nonce: 7,
        to: SAFE,
        value: '0',
        data: tx.data,
        operation: 0,
        confirmations: [{ owner: EOA_OLD, signature: `0x${'11'.repeat(65)}` }],
        confirmationsRequired: 2,
        isExecuted: false,
      },
    ]);

    // No argument and no --key: the stranded row's key is reused.
    await runSignerRotate(captured.out, args(['signer', 'rotate']), deps(fake));

    expect(fake.asked).toEqual([SAFE]);
    // Nothing was posted a second time, and the hash the service holds is the
    // one the store now records.
    expect(fake.proposed).toHaveLength(0);
    expect(fake.registered).toHaveLength(0);
    expect(captured.results[0]).toMatchObject({
      name: 'zomi-next',
      reused: true,
      proposed: true,
      alreadyQueued: true,
      safeTxHash: QUEUED_HASH,
    });
    expect(readAuthors(storePath()).authors['zomi-next']?.proposal).toBe(QUEUED_HASH);
    const human = captured.human[0] ?? '';
    expect(human).toContain('already queued');
    expect(human).toContain(QUEUED_HASH);
    expect(human).toContain(`s2s signer confirm ${QUEUED_HASH}`);
  });

  it('refuses when the service holds a different transaction at that nonce', async () => {
    const captured = capture();
    seedOld();
    addSigner({ name: 'zomi-next', privateKey: KEY_NEW, safe: SAFE, replaces: 'zomi' }, storePath());
    const other: Address = '0x9999999999999999999999999999999999999999';
    const fake = fakeService(undefined, [
      {
        safeTxHash: QUEUED_HASH,
        safe: SAFE,
        nonce: 7,
        to: other,
        value: '0',
        data: '0xdeadbeef',
        operation: 0,
        confirmations: [],
        confirmationsRequired: 2,
        isExecuted: false,
      },
    ]);

    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate']), deps(fake)),
    ).rejects.toMatchObject({ code: 'nonce_taken' });
    // The refusal names the hash that holds the nonce and the command that shows
    // the queue, and it posts nothing.
    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate']), deps(fake)),
    ).rejects.toThrow(/different transaction[\s\S]*nonce 7[\s\S]*0xabab/);
    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate']), deps(fake)),
    ).rejects.toThrow(/s2s signer queue/);
    expect(fake.proposed).toHaveLength(0);
    expect(readAuthors(storePath()).authors['zomi-next']?.proposal).toBeUndefined();
  });

  it('refuses to call the swap unqueued when the queue could not be read that far', async () => {
    const captured = capture();
    seedOld();
    addSigner({ name: 'zomi-next', privateKey: KEY_NEW, safe: SAFE, replaces: 'zomi' }, storePath());
    // The walk hit the page cap: nonce 7 may be on a page nobody read, so a POST
    // would either be refused by the service or queue a second swap.
    const fake = fakeService(undefined, [], false);

    await runSignerRotate(captured.out, args(['signer', 'rotate']), deps(fake));

    expect(fake.asked).toEqual([SAFE]);
    expect(fake.proposed).toHaveLength(0);
    expect(captured.results[0]).toMatchObject({ reused: true, proposed: false });
    expect(String(captured.results[0]?.note)).toContain('did not answer with a whole queue');
    expect(String(captured.results[0]?.note)).toContain('nonce 7');
    expect(readAuthors(storePath()).authors['zomi-next']?.proposal).toBeUndefined();
  });

  it('proposes the stranded swap again when the service holds nothing at that nonce', async () => {
    const captured = capture();
    seedOld();
    addSigner({ name: 'zomi-next', privateKey: KEY_NEW, safe: SAFE, replaces: 'zomi' }, storePath());
    const fake = fakeService(undefined, []);

    await runSignerRotate(captured.out, args(['signer', 'rotate']), deps(fake));

    expect(fake.asked).toEqual([SAFE]);
    expect(fake.proposed).toHaveLength(1);
    expect(captured.results[0]).toMatchObject({ reused: true, proposed: true });
    expect(captured.results[0]?.alreadyQueued).toBeUndefined();
    expect(readAuthors(storePath()).authors['zomi-next']?.proposal).toBeTruthy();
  });

  it('refuses while a live command holds the store lock, names its pid, and leaves the lock', async () => {
    const fake = fakeService();
    const captured = capture();
    seedOld();
    const lock = storeLockPath(storePath());
    mkdirSync(join(dir, 'xdg', 's2s'), { recursive: true });
    // This process is alive by definition, so the holder is a live writer.
    writeFileSync(lock, `${String(process.pid)}\n`);

    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), deps(fake)),
    ).rejects.toMatchObject({ code: 'store_locked' });
    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), deps(fake)),
    ).rejects.toThrow(`pid ${String(process.pid)}`);
    // Nothing was filed behind the other writer's back, and its lock is its own
    // to release.
    expect(readAuthors(storePath()).authors['zomi-next']).toBeUndefined();
    expect(existsSync(lock)).toBe(true);
    expect(fake.proposed).toHaveLength(0);
  });

  it('takes over a lock left by a dead process, and says whose it was', async () => {
    const fake = fakeService();
    const captured = capture();
    seedOld();
    const lock = storeLockPath(storePath());
    mkdirSync(join(dir, 'xdg', 's2s'), { recursive: true });
    // A pid that is not running: the command that wrote this lock was killed
    // before its `finally` could release it.
    const pid = deadPid();
    writeFileSync(lock, `${String(pid)}\n`);

    await runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), deps(fake));

    expect(captured.results[0]).toMatchObject({ proposed: true, replaces: 'zomi' });
    expect(readAuthors(storePath()).authors['zomi-next']).toBeTruthy();
    // The leftover is gone, and the recovery was reported rather than silent: a
    // killed command is evidence of a write that may have been cut short.
    expect(existsSync(lock)).toBe(false);
    expect(captured.warnings.join('\n')).toContain(`pid ${String(pid)}`);
    expect(captured.warnings.join('\n')).toContain('was not running');
    // The takeover moves the leftover aside before deleting it, and leaves no
    // trace of that private name: only the file at `lock` was ever the lock.
    expect(readdirSync(join(dir, 'xdg', 's2s')).sort()).toEqual(['authors.json']);
  });

  it('waits out an empty lock and then refuses it as a live writer, keeping the file', async () => {
    const fake = fakeService();
    const captured = capture();
    seedOld();
    const lock = storeLockPath(storePath());
    mkdirSync(join(dir, 'xdg', 's2s'), { recursive: true });
    // What a writer looks like between `open(..., 'wx')` and writing its pid.
    writeFileSync(lock, '');

    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), deps(fake)),
    ).rejects.toMatchObject({ code: 'store_locked' });
    // Empty is not stale: the file was read again for long enough that a holder
    // writing its pid would have finished, and the answer is still "held".
    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), deps(fake)),
    ).rejects.toThrow(/names no pid/);
    expect(existsSync(lock)).toBe(true);
    expect(captured.warnings.join('\n')).not.toContain('cleared the author store lock');
  });

  it('refuses a lock whose contents are not a pid, and leaves it for its owner', async () => {
    const fake = fakeService();
    const captured = capture();
    seedOld();
    const lock = storeLockPath(storePath());
    mkdirSync(join(dir, 'xdg', 's2s'), { recursive: true });
    writeFileSync(lock, 'not a pid\n');

    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), deps(fake)),
    ).rejects.toThrow(/names no pid/);
    expect(existsSync(lock)).toBe(true);
    expect(readAuthors(storePath()).authors['zomi-next']).toBeUndefined();
  });

  it('removes the store lock after a run that succeeded and after one that refused', async () => {
    const captured = capture();
    seedOld();
    const lock = storeLockPath(storePath());

    // A refusal thrown inside the lock (the key is already this machine's)
    // leaves no lock behind.
    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_OLD]), {
        ...deps(fakeService()),
      }),
    ).rejects.toMatchObject({ code: 'same_key' });
    expect(existsSync(lock)).toBe(false);

    await runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), {
      ...deps(fakeService()),
    });
    expect(existsSync(lock)).toBe(false);
  });

  it('rotates a key that only the environment holds, filing it first', async () => {
    const fake = fakeService();
    const captured = capture();
    // No store row at all: the owner key arrives from the environment, which is
    // where a key that owns a Safe is most often kept.
    vi.stubEnv('S2S_PRIVATE_KEY', KEY_OLD);

    await runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), {
      ...deps(fake),
    });

    // The store needs a row to record what the swap retires, so one is filed for
    // the old key, and the new row replaces it.
    const store = readAuthors(storePath());
    expect(store.authors['signer-7e5f45']).toMatchObject({
      privateKey: KEY_OLD,
      safe: SAFE,
      safeSource: 'given',
    });
    expect(store.authors['signer-7e5f45-next']).toMatchObject({
      privateKey: KEY_NEW,
      replaces: 'signer-7e5f45',
    });
    expect(captured.results[0]).toMatchObject({
      oldKeySource: 'env',
      oldEoa: EOA_OLD,
      replaces: 'signer-7e5f45',
      filedOldRow: 'signer-7e5f45',
      proposed: true,
    });
    expect(captured.human[0]).toContain("filed first : the owner key from S2S_PRIVATE_KEY as 'signer-7e5f45'");
    // The proposal is still signed by the old key.
    expect(fake.proposed[0]?.sender).toBe(EOA_OLD);
  });

  it('leaves the store byte-identical when the name it would file is taken', async () => {
    const fake = fakeService();
    const captured = capture();
    vi.stubEnv('S2S_PRIVATE_KEY', KEY_OLD);
    // A row already holds this name. Rule 2 would file the environment key for
    // the Safe before `addSigner` ever looked at `--name`, so the refusal has to
    // be planned before the first write or this run halves the store.
    addSigner({ name: 'taken', privateKey: KEY_OTHER, safe: OTHER_SAFE }, storePath());
    const before = readFileSync(storePath(), 'utf8');

    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW, '--name', 'taken']), {
        ...deps(fake),
      }),
    ).rejects.toThrow(/already exists/);

    expect(readFileSync(storePath(), 'utf8')).toBe(before);
    expect(fake.proposed).toHaveLength(0);
  });

  it('reports an unreadable lock by its errno instead of calling it a writer', async () => {
    const fake = fakeService();
    const captured = capture();
    seedOld();
    const lock = storeLockPath(storePath());
    mkdirSync(join(dir, 'xdg', 's2s'), { recursive: true });
    writeFileSync(lock, `${String(process.pid)}\n`);
    // A lock nobody can read is neither a live writer nor a leftover: the remedy
    // is the file's permissions, and the message has to say which file.
    chmodSync(lock, 0o000);

    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), deps(fake)),
    ).rejects.toThrow(/cannot read it \(EACCES\)/);
    chmodSync(lock, 0o600);
    expect(existsSync(lock)).toBe(true);
    // Nothing was taken over, so no warning claims a lock was cleared.
    expect(captured.warnings.join('\n')).not.toContain('cleared the author store lock');
  });

  it('reports a transport failure as one, and prints the call, instead of blaming the sender', async () => {
    const fake = fakeService(new Error('connect ECONNREFUSED 127.0.0.1:443'));
    const captured = capture();
    seedOld();

    await runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), {
      ...deps(fake),
    });

    expect(captured.results[0]).toMatchObject({ proposed: false });
    const human = captured.human[0] ?? '';
    expect(human).toContain('proposal    : not queued — connect ECONNREFUSED');
    expect(human).toContain('post this call from any owner');
    // The sender is an owner by construction; a socket refusal is not a
    // permission problem, and saying so sends the user to the wrong fix.
    expect(human).not.toContain('only from an owner');
  });

  it('offers `author rm` only for a stale row without a swap, never for the filed swap itself', async () => {
    const fake = fakeService();
    const captured = capture();
    // A row filed by `signer add` for this Safe whose key the chain never
    // accepted, plus a filed swap waiting behind it.
    addSigner({ name: 'stale', privateKey: KEY_OTHER, safe: SAFE }, storePath());
    addSigner({ name: 'stale-next', privateKey: KEY_FIVE, safe: SAFE, replaces: 'stale' }, storePath());
    // No `--key`: the retry path refuses one while a row holds the swap's key,
    // so the stale-row refusal is what a bare run meets.
    const run = (): Promise<unknown> =>
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE]), {
        ...deps(fake, { owners: [EOA_OLD, OWNER_B] }),
      });

    // The swap row is the only copy of the key it installs: `author rm` refuses
    // it and `--force` would destroy that key, so it is never offered as the fix.
    await expect(run()).rejects.toThrow(/carries the swap.*not removable/);
    await expect(run()).rejects.toThrow(/signer rotate 0x1111/);
    // `author rm` is offered for the plain row only.
    await expect(run()).rejects.toThrow(/author rm 'stale'/);
    await expect(run()).rejects.not.toThrow(/author rm 'stale-next'/);
  });

  it('files the old key row only once the run goes ahead, never on a refusal', async () => {
    const fake = fakeService();
    const captured = capture();
    // Rule 2 would file this environment key for the Safe, and then the run
    // refuses because the key it would install is already an owner. A refused
    // command leaves the store as it found it.
    vi.stubEnv('S2S_PRIVATE_KEY', KEY_OLD);

    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_B]), {
        ...deps(fake, { owners: [EOA_OLD, OWNER_B] }),
      }),
    ).rejects.toMatchObject({ code: 'already_owner' });

    expect(readAuthors(storePath()).authors).toEqual({});
    expect(fake.proposed).toHaveLength(0);
  });

  it('retires the Safe row\'s key and signs the swap with the environment key when both own the Safe', async () => {
    const fake = fakeService();
    const captured = capture();
    seedOld();
    // Both keys are owners. The row for this Safe holds the key a rotation
    // replaces; the environment key is this machine's and an owner, so the Safe
    // accepts its signature on the swap. Neither fact makes the other a refusal.
    vi.stubEnv('S2S_PRIVATE_KEY', KEY_B);

    await runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), {
      ...deps(fake, { owners: [OWNER_B, EOA_OLD] }),
    });

    expect(captured.results[0]).toMatchObject({
      name: 'zomi-next',
      replaces: 'zomi',
      oldEoa: EOA_OLD,
      eoa: EOA_NEW,
      signedBy: OWNER_B,
      signedBySource: 'env',
      proposed: true,
    });
    // The swap removes the row's key, not the environment's, and the proposal
    // is signed by the environment key.
    expect(fake.proposed).toHaveLength(1);
    expect(fake.proposed[0]?.sender).toBe(OWNER_B);
    const decoded = decodeFunctionData({ abi: safeAbi, data: fake.proposed[0]?.tx.data ?? '0x' });
    expect(decoded.functionName).toBe('swapOwner');
    expect(decoded.args).toEqual([OWNER_B, EOA_OLD, EOA_NEW]);
    // Nothing tells the user to switch authors or remove a row.
    expect(captured.human[0]).toContain(`signs it    : ${OWNER_B}`);
    expect(captured.human[0]).not.toContain('s2s author rm');
    expect(captured.results[0]?.switchTo).toBeUndefined();
  });

  it('tells an environment key to be unset rather than telling the user to switch authors', async () => {
    const captured = capture();
    seedOld();
    // The env key is not an owner, so `signer confirm` would refuse it. The fix
    // is not `author switch` — the environment wins over the stored row whatever
    // the active slot says.
    vi.stubEnv('S2S_PRIVATE_KEY', KEY_OTHER);

    await runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), {
      ...deps(fakeService()),
    });

    const human = captured.human[0] ?? '';
    expect(captured.results[0]?.switchTo).toBeUndefined();
    expect(human).not.toContain('s2s author switch');
    expect(human).toContain('`S2S_PRIVATE_KEY` holds');
    expect(human).toContain("unset it so 'zomi' signs");
  });

  it('refuses more than one positional argument', async () => {
    const captured = capture();
    const other: Address = '0x3333333333333333333333333333333333333333';

    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, other]), deps(fakeService())),
    ).rejects.toMatchObject({ code: 'usage' });
    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, other]), deps(fakeService())),
    ).rejects.toThrow(/one Safe at a time[\s\S]*two|one Safe at a time[\s\S]*2/);
  });

  it('says the Safe is not deployed instead of blaming the key', async () => {
    const captured = capture();
    seedOld();

    // The active row names SAFE; nothing is deployed there.
    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate']), {
        ...deps(fakeService(), { deployed: false, owners: [], threshold: 0, nonce: 0 }),
      }),
    ).rejects.toMatchObject({ code: 'safe_not_deployed' });
    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate']), {
        ...deps(fakeService(), { deployed: false, owners: [], threshold: 0, nonce: 0 }),
      }),
    ).rejects.toThrow(/no Safe at 0x1111[\s\S]*'zomi'/);
  });

  it('says the filed rows hold no readable key, naming them', async () => {
    const captured = capture();
    // A hand-edited row whose key this build cannot derive: "no key filed" would
    // be false, and so would "not an owner".
    addSigner({ name: 'broken', privateKey: '0xnot-a-key', safe: SAFE }, storePath());

    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), {
        ...deps(fakeService()),
      }),
    ).rejects.toMatchObject({ code: 'not_owner' });
    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), {
        ...deps(fakeService()),
      }),
    ).rejects.toThrow(/no key this build can read: 'broken'/);
  });

  it('names `author switch` when the active author does not own the Safe', async () => {
    const fake = fakeService();
    const captured = capture();
    const otherSafe: Address = '0x2222222222222222222222222222222222222222';

    // `signer confirm` signs with the active key and nothing else, so filing a
    // swap under a row that is not active leaves it unconfirmable until the
    // slot moves. The output has to say which command moves it.
    seedOld();
    // A key that is NOT an owner of SAFE: the active slot is on a row that cannot
    // sign this swap, which is the state this test is about.
    addSigner({ name: 'other', privateKey: KEY_OTHER, safe: otherSafe }, storePath());
    expect(readAuthors(storePath()).active).toBe('other');

    await runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), {
      ...deps(fake),
    });

    expect(captured.results[0]).toMatchObject({ replaces: 'zomi', switchTo: 'zomi' });
    const human = captured.human[0] ?? '';
    expect(human).toContain('s2s author switch zomi');
    expect(human).toContain('s2s signer confirm 0x');
    // The claim that would be false here: the old key is not the active one.
    expect(human).not.toContain("while 'zomi' is still the active key");
    // And the store is left as it was: a rotation does not move the slot.
    expect(readAuthors(storePath()).active).toBe('other');
  });
});
