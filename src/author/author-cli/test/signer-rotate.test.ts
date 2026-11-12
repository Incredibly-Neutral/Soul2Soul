// ============================================================================
// `s2s signer rotate` — swap this machine's key for a fresh one, in one Safe
// transaction, threshold untouched.
//
// No socket: the chain read and the service are both injected through
// `SignerDeps`, and the one real computation (the safeTxHash) is checked
// against `computeSafeTxHash` on the very transaction the command built. The
// calldata is decoded back to the three addresses `swapOwner` takes, in order.
// ============================================================================

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeFunctionData, recoverAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { safeAbi } from '@s2s/soul2soul-shared';

import type { SafeTxService } from '../src/adapters/safe-tx';
import {
  SENTINEL_OWNERS,
  computeSafeTxHash,
  swapOwnerData,
  type SafeTxInput,
} from '../src/adapters/safe-tx';
import { addSigner, pendingReplacement, readAuthors } from '../src/core/authors';
import { loadConfig } from '../src/core/config';
import { runSignerRotate, signerRotate } from '../src/commands/signer-rotate';
import type { ChainSafe, SignerDeps } from '../src/commands/signer-store';
import { parseCommandArgs, type ParsedArgs } from '../src/lib/args';
import type { CliOut } from '../src/lib/out';

/** Valid keys nobody can use: privkey 1, 2, 3 and 4. */
const KEY_OLD = `0x${'00'.repeat(31)}01`;
const EOA_OLD = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const KEY_NEW = `0x${'00'.repeat(31)}02`;
const EOA_NEW = '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF';
const KEY_OTHER = `0x${'00'.repeat(31)}04`;
/** A second owner that is not this machine's key. */
const KEY_B: Hex = `0x${'00'.repeat(31)}03`;
const OWNER_B: Address = privateKeyToAccount(KEY_B).address;

const SAFE: Address = '0x1111111111111111111111111111111111111111';
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
}

/** The two methods `rotate` uses; `fail` models an unreachable service. */
function fakeService(fail?: Error): FakeService {
  const registered: Registered[] = [];
  const proposed: Proposed[] = [];
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
    pending() {
      return Promise.reject(new Error('not used by signer rotate'));
    },
    get() {
      return Promise.reject(new Error('not used by signer rotate'));
    },
    confirm() {
      return Promise.reject(new Error('not used by signer rotate'));
    },
  };
  return { service, registered, proposed };
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

/** File the old key the way `signer add` does: a given Safe, active. */
function seedOld(name = 'zomi', privateKey = KEY_OLD): void {
  addSigner({ name, privateKey, safe: SAFE }, storePath());
}

function args(argv: string[]): ParsedArgs {
  const parsed = parseCommandArgs(argv, signerRotate.flags);
  return { flags: parsed.flags, positionals: parsed.positionals.slice(2) };
}

describe('s2s signer rotate', () => {
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

  it('refuses a filed key that is not an owner, calling it by name', async () => {
    const fake = fakeService();
    const captured = capture();
    addSigner({ name: 'zomi', privateKey: KEY_OTHER, safe: SAFE }, storePath());

    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_NEW]), deps(fake)),
    ).rejects.toMatchObject({ code: 'not_owner' });
    expect(fake.proposed).toHaveLength(0);
    expect(readAuthors(storePath()).authors['zomi-next']).toBeUndefined();
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

  it('refuses a second replacement while one is pending, naming the row', async () => {
    const fake = fakeService();
    const captured = capture();
    seedOld();
    addSigner({ name: 'zomi-next', privateKey: KEY_NEW, safe: SAFE, replaces: 'zomi' }, storePath());

    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_OTHER]), deps(fake)),
    ).rejects.toThrow(/'zomi-next' is filed/);
    await expect(
      runSignerRotate(captured.out, args(['signer', 'rotate', SAFE, '--key', KEY_OTHER]), deps(fake)),
    ).rejects.toMatchObject({ code: 'replacement_pending' });
    expect(fake.proposed).toHaveLength(0);
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

  it('names `author switch` when the active author does not own the Safe', async () => {
    const fake = fakeService();
    const captured = capture();
    const otherSafe: Address = '0x2222222222222222222222222222222222222222';

    // `signer confirm` signs with the active key and nothing else, so filing a
    // swap under a row that is not active leaves it unconfirmable until the
    // slot moves. The output has to say which command moves it.
    seedOld();
    addSigner({ name: 'other', privateKey: KEY_B, safe: otherSafe }, storePath());
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
