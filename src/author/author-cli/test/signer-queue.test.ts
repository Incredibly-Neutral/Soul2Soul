// ============================================================================
// `s2s signer queue` — what is waiting, oldest nonce first, and whether this
// key still owes a signature.
//
// The service is faked; the chain read is a literal. No socket, no chain.
// ============================================================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Address, Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addOwnerWithThresholdData, type SafeTxRecord, type SafeTxService } from '../src/adapters/safe-tx';
import { addSigner, authorsFilePath, readAuthors, writeAuthors } from '../src/core/authors';
import { parseCommandArgs, type ParsedArgs } from '../src/lib/args';
import { loadConfig } from '../src/core/config';
import { runSignerQueue, signerQueue } from '../src/commands/signer-queue';
import type { ChainSafe, SignerDeps } from '../src/commands/signer-store';
import { UsageError } from '../src/lib/errors';
import type { CliOut } from '../src/lib/out';

/** Valid keys nobody can use: privkey 1 and 4. */
const KEY_SIGNER = `0x${'00'.repeat(31)}01`;
const EOA_SIGNER = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const KEY_OTHER = `0x${'00'.repeat(31)}04`;

const SAFE: Address = '0x1111111111111111111111111111111111111111';
const OWNER_B: Address = '0x2222222222222222222222222222222222222222';
const OWNER_C: Address = '0x3333333333333333333333333333333333333333';
const NEW_OWNER: Address = '0x4444444444444444444444444444444444444444';
const RPC = 'https://rpc.example';

const HASH_7: Hex = `0x${'11'.repeat(32)}`;
const HASH_8: Hex = `0x${'22'.repeat(32)}`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's2s-signer-queue-'));
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
  vi.stubEnv('S2S_RPC_L2', RPC);
  vi.stubEnv('BASE_RPC_URL', '');
  vi.stubEnv('S2S_PRIVATE_KEY', KEY_SIGNER);
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
      if (text !== undefined) human.push(text);
    },
  };
  return { out, results, human, warnings };
}

function record(overrides: Partial<SafeTxRecord>): SafeTxRecord {
  return {
    safeTxHash: HASH_7,
    safe: SAFE,
    nonce: 7,
    to: SAFE,
    value: '0',
    data: addOwnerWithThresholdData(NEW_OWNER, 2),
    operation: 0,
    confirmations: [],
    confirmationsRequired: 2,
    isExecuted: false,
    ...overrides,
  };
}

function service(records: SafeTxRecord[], complete = true): SafeTxService {
  return {
    register() {
      return Promise.reject(new Error('not used by signer queue'));
    },
    propose() {
      return Promise.reject(new Error('not used by signer queue'));
    },
    pending() {
      return Promise.resolve({ records, complete });
    },
    get() {
      return Promise.reject(new Error('not used by signer queue'));
    },
    confirm() {
      return Promise.reject(new Error('not used by signer queue'));
    },
  };
}

function deps(
  records: SafeTxRecord[],
  chain: ChainSafe = { deployed: true, owners: [EOA_SIGNER, OWNER_B, OWNER_C], threshold: 2, nonce: 7 },
): Partial<SignerDeps> {
  return {
    config: () => loadConfig(),
    service: () => service(records),
    readSafe: () => Promise.resolve(chain),
    readCode: () => Promise.resolve(false),
  };
}

/**
 * The Safe this machine files for its active author, which is what the command
 * reads now that it takes no `<safe>`: a row that signs names an address.
 */
function args(argv: string[]): ParsedArgs {
  const parsed = parseCommandArgs(argv, signerQueue.flags);
  return { flags: parsed.flags, positionals: parsed.positionals.slice(2) };
}

function filesSafe(safe: Address = SAFE): void {
  addSigner({ name: 'zomi', privateKey: KEY_SIGNER, safe }, authorsFilePath());
}

describe('s2s signer queue', () => {
  it('lists proposals oldest nonce first with the method, the new owner and who confirmed', async () => {
    const captured = capture();
    filesSafe();
    const records = [
      // the service answers in its own order on purpose
      record({
        safeTxHash: HASH_8,
        nonce: 8,
        data: '0xdeadbeef',
        confirmations: [],
        dataDecoded: undefined,
      }),
      record({
        nonce: 7,
        confirmations: [{ owner: OWNER_B, signature: `0x${'ab'.repeat(65)}` }],
        dataDecoded: {
          method: 'addOwnerWithThreshold',
          parameters: [
            { name: 'owner', value: NEW_OWNER },
            { name: '_threshold', value: '2' },
          ],
        },
      }),
    ];

    await runSignerQueue(captured.out, args(['signer', 'queue']), deps(records));

    const result = captured.results[0];
    expect(result).toMatchObject({
      action: 'signer.queue',
      safe: SAFE,
      eoa: EOA_SIGNER,
      threshold: 2,
      owners: [EOA_SIGNER, OWNER_B, OWNER_C],
    });

    const pending = result?.pending as Record<string, unknown>[];
    expect(pending.map((row) => row.nonce)).toEqual([7, 8]);
    expect(pending[0]).toMatchObject({
      safeTxHash: HASH_7,
      method: 'addOwnerWithThreshold',
      newOwner: NEW_OWNER,
      confirmations: 1,
      confirmationsRequired: 2,
      executable: false,
      keyIsOwner: true,
      // OWNER_B confirmed, this key has not
      keyConfirmed: false,
    });
    expect(pending[1]).toMatchObject({
      nonce: 8,
      method: undefined,
      newOwner: undefined,
      confirmations: 0,
      executable: false,
      keyIsOwner: true,
      keyConfirmed: false,
    });

    // The hash is printed whole: it is the argument the next command takes.
    expect(captured.human[0]).toContain(HASH_7);
    expect(captured.human[0]).toContain('1 of 2 confirmed');
    expect(captured.human[0]).toContain('yours: not yet confirmed');
  });

  it('marks a proposal this key already confirmed', async () => {
    const captured = capture();
    filesSafe();
    const records = [
      record({ confirmations: [{ owner: EOA_SIGNER, signature: `0x${'cd'.repeat(65)}` }] }),
    ];

    await runSignerQueue(captured.out, args(['signer', 'queue']), deps(records));

    const pending = captured.results[0]?.pending as Record<string, unknown>[];
    expect(pending[0]).toMatchObject({ keyIsOwner: true, keyConfirmed: true });
    expect(captured.human[0]).toContain('yours: already confirmed');
  });

  it('says so when this key is not an owner', async () => {
    const captured = capture();
    filesSafe();
    await runSignerQueue(captured.out, args(['signer', 'queue']), {
      ...deps([record({})]),
      config: () => ({ ...loadConfig(), privateKey: KEY_OTHER }),
    });

    const pending = captured.results[0]?.pending as Record<string, unknown>[];
    expect(pending[0]).toMatchObject({ keyIsOwner: false });
    expect(captured.human[0]).toContain('yours: not an owner');
  });

  it('defaults to the Safe of the active stored author', async () => {
    const captured = capture();
    vi.stubEnv('S2S_PRIVATE_KEY', '');
    addSigner(
      { name: 'zomi', privateKey: KEY_SIGNER, safe: '0x9999999999999999999999999999999999999999' },
      join(dir, 'xdg', 's2s', 'authors.json'),
    );

    await runSignerQueue(captured.out, args(['signer', 'queue']), {
      ...deps([record({ safe: '0x9999999999999999999999999999999999999999' })]),
      readSafe: () =>
        Promise.resolve({ deployed: true, owners: [EOA_SIGNER], threshold: 1, nonce: 1 }),
    });

    expect(captured.results[0]?.safe).toBe('0x9999999999999999999999999999999999999999');
  });

  it('refuses to take a default Safe from a row whose safeSource it cannot read', async () => {
    // The row cannot say whether the address is given or derived, so every
    // other command refuses it (`safeProblem`). The queue must not be the one
    // path that acts on it anyway.
    const captured = capture();
    vi.stubEnv('S2S_PRIVATE_KEY', '');
    const path = join(dir, 'xdg', 's2s', 'authors.json');
    mkdirSync(join(dir, 'xdg', 's2s'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        active: 'zomi',
        authors: { zomi: { privateKey: KEY_SIGNER, safe: SAFE, safeSource: 'hinted' } },
      }),
    );

    await expect(
      runSignerQueue(captured.out, args(['signer', 'queue']), deps([record({})])),
    ).rejects.toThrow(/has safeSource/);
  });

  it('reports an empty queue without inventing rows', async () => {
    const captured = capture();
    filesSafe();
    await runSignerQueue(captured.out, args(['signer', 'queue']), deps([]));

    expect(captured.results[0]?.pending).toEqual([]);
    expect(captured.human[0]).toContain('no unexecuted proposals');
  });

  it('still lists the queue when the owners cannot be read, with the key column unknown', async () => {
    const captured = capture();
    filesSafe();
    await runSignerQueue(captured.out, args(['signer', 'queue']), {
      ...deps([record({})]),
      readSafe: () => Promise.reject(new Error('rpc 503')),
    });

    const pending = captured.results[0]?.pending as Record<string, unknown>[];
    expect(pending[0]).toMatchObject({ keyIsOwner: null, keyConfirmed: false });
    expect(captured.warnings).toHaveLength(1);
    expect(captured.warnings[0]).toContain('rpc 503');
    expect(captured.human[0]).toContain('owners unreadable');
  });

  it('says a page-capped list is not the whole queue, in both output modes', async () => {
    const captured = capture();
    filesSafe();
    await runSignerQueue(captured.out, args(['signer', 'queue']), {
      ...deps([record({})]),
      service: () => service([record({})], false),
    });

    expect(captured.results[0]?.complete).toBe(false);
    expect(captured.human[0]).toContain('unread      : the page cap cut this list short');
    expect(captured.warnings.join('\n')).toContain('may be longer than this command reads');
  });

  it('clears a filed-not-an-owner mark on the owner list it already read', async () => {
    // `signer add` filed the key inactive and marked it unconfirmed; the chain
    // has since accepted it, and this command is the only one that reads the
    // owner list without a rotation to settle. The mark cannot outlive that.
    addSigner({ name: 'signer-7e5f45', privateKey: KEY_SIGNER, safe: SAFE, activate: false });
    expect(readAuthors(authorsFilePath()).authors['signer-7e5f45']?.unconfirmed).toBe(true);

    const captured = capture();
    await runSignerQueue(captured.out, args(['signer', 'queue']), deps([]));

    expect(readAuthors(authorsFilePath()).authors['signer-7e5f45']?.unconfirmed).toBeUndefined();
  });

  it('refuses with no Safe and no stored author', async () => {
    const captured = capture();
    vi.stubEnv('S2S_PRIVATE_KEY', '');
    await expect(
      runSignerQueue(captured.out, args(['signer', 'queue']), deps([])),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('refuses a <safe> typed as an argument, and the --safe flag it no longer declares', async () => {
    // The address is on the row. A typed one is refused rather than ignored: a
    // run that listed the store's Safe while the operator read their own words
    // as the target would answer a question nobody asked.
    const captured = capture();
    filesSafe();
    await expect(
      runSignerQueue(captured.out, args(['signer', 'queue', SAFE]), deps([])),
    ).rejects.toThrow(/takes no <safe>[\s\S]*s2s signer add <safe>[\s\S]*0x1111/);
    expect(() => parseCommandArgs(['signer', 'queue', '--safe', SAFE], signerQueue.flags)).toThrow(
      /unknown flag --safe/,
    );
  });

  it('counts only the confirmations that can be packed', async () => {
    const captured = capture();
    filesSafe();
    // A 32-byte entry is a contract owner's approveHash: `confirm` drops it, and
    // the queue must count the same set or it promises an execution that is
    // refused.
    const records = [
      record({
        confirmations: [
          { owner: OWNER_B, signature: `0x${'ab'.repeat(65)}` },
          { owner: OWNER_C, signature: `0x${'cd'.repeat(32)}` },
        ],
      }),
    ];

    await runSignerQueue(captured.out, args(['signer', 'queue']), deps(records));

    const pending = captured.results[0]?.pending as Record<string, unknown>[];
    expect(pending[0]).toMatchObject({ confirmations: 1, executable: false });
    expect(captured.human[0]).toContain('1 of 2 confirmed');
  });

  it('takes k of n and the executable flag from the chain, not the service', async () => {
    const captured = capture();
    filesSafe();
    // The service's copy of the Safe is stale: it asks for 5, the chain says 2.
    const records = [
      record({
        confirmationsRequired: 5,
        confirmations: [
          { owner: OWNER_B, signature: `0x${'ab'.repeat(65)}` },
          { owner: OWNER_C, signature: `0x${'cd'.repeat(65)}` },
        ],
      }),
    ];

    await runSignerQueue(captured.out, args(['signer', 'queue']), deps(records));

    const pending = captured.results[0]?.pending as Record<string, unknown>[];
    expect(pending[0]).toMatchObject({ confirmations: 2, confirmationsRequired: 2, executable: true });
    expect(captured.human[0]).toContain('2 of 2 confirmed');
  });

  it('says there is no key rather than calling this machine not an owner', async () => {
    const captured = capture();
    vi.stubEnv('S2S_PRIVATE_KEY', '');
    // The Safe comes from the row this machine files; no key in that row is one
    // this build can read, which is the state the column reports.
    writeAuthors({
      active: 'zomi',
      authors: { zomi: { privateKey: `0x${'00'.repeat(32)}`, safe: SAFE, safeSource: 'given' } },
    });

    await runSignerQueue(captured.out, args(['signer', 'queue']), deps([record({})]));

    const pending = captured.results[0]?.pending as Record<string, unknown>[];
    expect(pending[0]).toMatchObject({ keyIsOwner: null, keyConfirmed: false });
    expect(captured.results[0]?.eoa).toBeNull();
    expect(captured.human[0]).toContain('yours: no key filed here');
  });

  it('refuses a Safe with no bytecode', async () => {
    const captured = capture();
    filesSafe();
    await expect(
      runSignerQueue(
        captured.out,
        args(['signer', 'queue']),
        deps([], { deployed: false, owners: [], threshold: 0, nonce: 0 }),
      ),
    ).rejects.toMatchObject({ code: 'safe_not_deployed' });
  });
});
