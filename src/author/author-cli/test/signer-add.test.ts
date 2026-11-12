// ============================================================================
// `s2s signer add` — the key is filed, the owner proposal is made.
//
// No socket: the chain read and the service are both injected through
// `SignerDeps`, and the one real computation (the safeTxHash) is checked
// against `computeSafeTxHash` on the very transaction the command built.
// ============================================================================

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeFunctionData, recoverAddress, type Address, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { safeAbi } from '@s2s/soul2soul-shared';

import { addOwnerWithThresholdData, computeSafeTxHash, type SafeTxInput } from '../src/adapters/safe-tx';
import type { SafeTxService } from '../src/adapters/safe-tx';
import { activeAuthorRecord, addSigner, authorEoa, readAuthors } from '../src/core/authors';
import { loadConfig } from '../src/core/config';
import { runSignerAdd, signerAdd } from '../src/commands/signer-add';
import type { ChainSafe, SignerDeps } from '../src/commands/signer-store';
import { parseCommandArgs, type ParsedArgs } from '../src/lib/args';
import { CliError, UsageError } from '../src/lib/errors';
import type { CliOut } from '../src/lib/out';

/** Valid keys nobody can use: privkey 1, 2 and 3. */
const KEY_OWNER = `0x${'00'.repeat(31)}01`;
const EOA_OWNER = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const KEY_NEW = `0x${'00'.repeat(31)}02`;
const EOA_NEW = '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF';
const KEY_OTHER = `0x${'00'.repeat(31)}03`;

const SAFE: Address = '0x1111111111111111111111111111111111111111';
const OWNER_A: Address = '0x2222222222222222222222222222222222222222';
const RPC = 'https://rpc.example';

const CHAIN: ChainSafe = { deployed: true, owners: [OWNER_A], threshold: 2, nonce: 7 };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's2s-signer-add-'));
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
  vi.stubEnv('S2S_RPC_L2', RPC);
  vi.stubEnv('BASE_RPC_URL', '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

interface Captured {
  out: CliOut;
  results: Record<string, unknown>[];
  warnings: string[];
  logs: string[];
}

function capture(): Captured {
  const results: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const logs: string[] = [];
  const out: CliOut = {
    json: true,
    log: (line: string) => logs.push(line),
    warn: (message: string) => warnings.push(message),
    result: (data: unknown, text?: string) => {
      results.push(data as Record<string, unknown>);
      if (text !== undefined) logs.push(text);
    },
  };
  return { out, results, warnings, logs };
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

/**
 * The two methods `signer add` uses. `fail` makes the service unreachable the
 * way an HTTP error surfaces: a CliError from the transport, nothing thrown
 * past the command.
 */
function fakeService(fail?: CliError): FakeService {
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
        safeTxHash: computeSafeTxHash({
          chainId: 8453,
          safe: input.safe,
          tx: input.tx,
        }),
      });
    },
    pending() {
      return Promise.reject(new Error('not used by signer add'));
    },
    get() {
      return Promise.reject(new Error('not used by signer add'));
    },
    confirm() {
      return Promise.reject(new Error('not used by signer add'));
    },
  };
  return { service, registered, proposed };
}

function deps(fake: FakeService, chain: ChainSafe = CHAIN): Partial<SignerDeps> {
  return {
    config: () => loadConfig(),
    service: () => fake.service,
    readSafe: () => Promise.resolve(chain),
    readCode: () => Promise.resolve(false),
    authorsPath: () => join(dir, 'xdg', 's2s', 'authors.json'),
  };
}

function args(argv: string[]): ParsedArgs {
  const parsed = parseCommandArgs(argv, signerAdd.flags);
  return { flags: parsed.flags, positionals: parsed.positionals.slice(2) };
}

describe('s2s signer add', () => {
  it('files the key, adds nothing to the queue from a machine with no owner key, and reports the call', async () => {
    const fake = fakeService();
    const captured = capture();

    await runSignerAdd(captured.out, args(['signer', 'add', SAFE, '--key', KEY_NEW]), deps(fake));

    const result = captured.results[0];
    expect(result).toBeDefined();
    const expectedTx: SafeTxInput = {
      to: SAFE,
      value: 0n,
      data: addOwnerWithThresholdData(EOA_NEW, 2),
      operation: 0,
      nonce: 7,
    };

    expect(result).toMatchObject({
      action: 'signer.add',
      name: 'signer-2b5ad5',
      eoa: EOA_NEW,
      safe: SAFE,
      threshold: 2,
      nonce: 7,
      // The key being added is not an owner yet, and the service files a
      // proposal's signature as its sender's confirmation: nothing is posted
      // from this machine.
      proposed: false,
      safeTxHash: computeSafeTxHash({ chainId: 8453, safe: SAFE, tx: expectedTx }),
      safeTx: { to: SAFE, data: expectedTx.data },
    });
    expect(result?.note).toContain('accepts a proposal only from an owner');
    expect(fake.proposed).toHaveLength(0);
    expect(fake.registered).toHaveLength(0);

    // The calldata is addOwnerWithThreshold(newEoa, 2), not a raised threshold.
    const decoded = decodeFunctionData({ abi: safeAbi, data: expectedTx.data });
    expect(decoded.functionName).toBe('addOwnerWithThreshold');
    expect(decoded.args).toEqual([EOA_NEW, 2n]);

    // The human output still carries the call an owner machine has to make.
    expect(captured.logs.join('\n')).toContain('the service accepts a proposal only from an owner');
    expect(captured.logs.join('\n')).toContain(expectedTx.data);

    // The key is on disk, active, and marked as a given Safe.
    const store = readAuthors(join(dir, 'xdg', 's2s', 'authors.json'));
    expect(store.active).toBe('signer-2b5ad5');
    expect(activeAuthorRecord(store)).toEqual({
      name: 'signer-2b5ad5',
      privateKey: KEY_NEW,
      safe: SAFE,
      safeSource: 'given',
    });
  });

  it('proposes from the owner key this machine already signs with, and signs as it', async () => {
    const fake = fakeService();
    const captured = capture();
    // The only owner key a joining machine can hold is the env (or project) key
    // it signs with: `signer add` refuses a second row for one Safe, and the key
    // it files here is not an owner until the transaction executes.
    vi.stubEnv('S2S_PRIVATE_KEY', KEY_OWNER);

    await runSignerAdd(captured.out, args(['signer', 'add', SAFE, '--key', KEY_NEW]), deps(fake, {
      deployed: true,
      owners: [EOA_OWNER],
      threshold: 2,
      nonce: 7,
    }));

    const expectedTx: SafeTxInput = {
      to: SAFE,
      value: 0n,
      data: addOwnerWithThresholdData(EOA_NEW, 2),
      operation: 0,
      nonce: 7,
    };
    const expectedHash = computeSafeTxHash({ chainId: 8453, safe: SAFE, tx: expectedTx });

    expect(captured.results[0]).toMatchObject({ proposed: true, safeTxHash: expectedHash });
    expect(fake.proposed).toHaveLength(1);
    // The sender is the owner, not the key being added.
    const posted = fake.proposed[0];
    if (posted === undefined) throw new Error('the command posted no proposal');
    expect(posted.sender).toBe(EOA_OWNER);
    expect(posted.tx).toEqual(expectedTx);
    expect(await recoverAddress({ hash: expectedHash, signature: posted.signature })).toBe(
      EOA_OWNER,
    );
    expect(captured.logs.join('\n')).toContain('signed it (1 of 2 confirmations)');
  });

  it('honours --name and the default name is six hex of the new EOA', async () => {
    const fake = fakeService();
    const captured = capture();

    await runSignerAdd(
      captured.out,
      args(['signer', 'add', SAFE, '--key', KEY_NEW, '--name', 'zomi']),
      deps(fake),
    );

    expect(captured.results[0]?.name).toBe('zomi');
    expect(readAuthors(join(dir, 'xdg', 's2s', 'authors.json')).active).toBe('zomi');
  });

  it('keeps the key and reports the raw call when the service refuses it', async () => {
    const fake = fakeService(new CliError('safe transaction service said 422', 1, 'safe_tx_rejected'));
    const captured = capture();
    // An owner key has to be here, or there would be nothing to post.
    vi.stubEnv('S2S_PRIVATE_KEY', KEY_OWNER);

    await runSignerAdd(captured.out, args(['signer', 'add', SAFE, '--key', KEY_NEW]), deps(fake, {
      deployed: true,
      owners: [EOA_OWNER],
      threshold: 2,
      nonce: 7,
    }));

    const result = captured.results[0];
    expect(result).toMatchObject({
      proposed: false,
      note: 'safe transaction service said 422 [safe_tx_rejected]',
      safeTx: { to: SAFE, data: addOwnerWithThresholdData(EOA_NEW, 2) },
      // the hash is still computed locally, so the call can be made by hand
      safeTxHash: computeSafeTxHash({
        chainId: 8453,
        safe: SAFE,
        tx: { to: SAFE, value: 0n, data: addOwnerWithThresholdData(EOA_NEW, 2), operation: 0, nonce: 7 },
      }),
    });
    expect(captured.warnings).toHaveLength(1);
    expect(captured.warnings[0]).toContain('not queued');
    // the key survives the failure — it is the part that cannot be recovered
    expect(readAuthors(join(dir, 'xdg', 's2s', 'authors.json')).active).toBe('signer-2b5ad5');
  });

  it('reports the call by hand and queues nothing when no service is configured', async () => {
    const fake = fakeService();
    const captured = capture();

    await runSignerAdd(captured.out, args(['signer', 'add', SAFE, '--key', KEY_NEW]), {
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

    await expect(
      runSignerAdd(
        captured.out,
        args(['signer', 'add', SAFE, '--key', KEY_NEW]),
        deps(fake, { deployed: false, owners: [], threshold: 0, nonce: 0 }),
      ),
    ).rejects.toMatchObject({ code: 'safe_not_deployed' });
    expect(readAuthors(join(dir, 'xdg', 's2s', 'authors.json')).authors).toEqual({});
  });

  it('refuses a key that is already an owner', async () => {
    const fake = fakeService();
    const captured = capture();

    await expect(
      runSignerAdd(
        captured.out,
        args(['signer', 'add', SAFE, '--key', KEY_NEW]),
        deps(fake, { deployed: true, owners: [EOA_NEW], threshold: 1, nonce: 3 }),
      ),
    ).rejects.toThrow(/already an owner/);
    expect(fake.proposed).toHaveLength(0);
    expect(readAuthors(join(dir, 'xdg', 's2s', 'authors.json')).authors).toEqual({});
  });

  it('refuses a taken name before touching the chain', async () => {
    const fake = fakeService();
    const captured = capture();
    const path = join(dir, 'xdg', 's2s', 'authors.json');
    addSigner({ name: 'zomi', privateKey: KEY_OTHER, safe: '0x9999999999999999999999999999999999999999' }, path);

    await expect(
      runSignerAdd(
        captured.out,
        args(['signer', 'add', SAFE, '--key', KEY_NEW, '--name', 'zomi']),
        deps(fake),
      ),
    ).rejects.toThrow(/already exists/);
    expect(fake.proposed).toHaveLength(0);
    // the existing record is untouched
    const kept = readAuthors(path).authors.zomi;
    expect(kept?.privateKey).toBe(KEY_OTHER);
  });

  it('rejects an address that is not one', async () => {
    const fake = fakeService();
    const captured = capture();
    await expect(
      runSignerAdd(captured.out, args(['signer', 'add', '0xnope', '--key', KEY_NEW]), deps(fake)),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('prints a generated phrase once and files the key it made', async () => {
    const fake = fakeService();
    const captured = capture();
    const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

    await runSignerAdd(captured.out, args(['signer', 'add', SAFE]), {
      ...deps(fake),
      keySource: () => ({ privateKey: KEY_NEW, mnemonic: phrase, generated: true }),
    });

    const result = captured.results[0];
    expect(result).toMatchObject({ mnemonic: phrase, privateKey: KEY_NEW, eoa: authorEoa(KEY_NEW) });
    const filed = readAuthors(join(dir, 'xdg', 's2s', 'authors.json')).authors['signer-2b5ad5'];
    expect(filed?.privateKey).toBe(KEY_NEW);
  });
});
