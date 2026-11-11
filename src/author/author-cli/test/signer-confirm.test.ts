// ============================================================================
// `s2s signer confirm` — sign the hash, post it, and execute when it is enough.
//
// The signature is checked by recovering it (`verifyMessage`) against the raw
// safeTxHash, and the packed list is decoded back out of the `execTransaction`
// calldata. No socket: `send` is a fake that records its call.
// ============================================================================

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeFunctionData, size, verifyMessage, type Address, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { safeAbi } from '@s2s/soul2soul-shared';

import type { SafeTxRecord, SafeTxService } from '../src/adapters/safe-tx';
import { loadConfig } from '../src/core/config';
import { runSignerConfirm, signerConfirm } from '../src/commands/signer-confirm';
import type { ChainSafe, SignerDeps } from '../src/commands/signer-store';
import { parseCommandArgs, type ParsedArgs } from '../src/lib/args';
import { CliError } from '../src/lib/errors';
import type { CliOut } from '../src/lib/out';

/** Valid keys nobody can use: privkey 1 and 5. */
const KEY_SIGNER = `0x${'00'.repeat(31)}01`;
const EOA_SIGNER = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const KEY_STRANGER = `0x${'00'.repeat(31)}05`;

const SAFE: Address = '0x1111111111111111111111111111111111111111';
const OWNER_B: Address = '0x2222222222222222222222222222222222222222';
const RPC = 'https://rpc.example';
const HASH: Hex = `0x${'11'.repeat(32)}`;
/** What the fake `send` answers with — one transaction hash, asserted on. */
const TX_HASH: Hex = `0x${'77'.repeat(32)}`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's2s-signer-confirm-'));
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
}

function capture(): Captured {
  const results: Record<string, unknown>[] = [];
  const human: string[] = [];
  const out: CliOut = {
    json: true,
    log: () => undefined,
    warn: () => undefined,
    result: (data: unknown, text?: string) => {
      results.push(data as Record<string, unknown>);
      human.push(text ?? '');
    },
  };
  return { out, results, human };
}

/** A 65-byte confirmation from another owner; Safe reads v=28 as eth_sign. */
const OTHER_SIGNATURE: Hex = `0x${'ab'.repeat(64)}1c`;

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
  return { service, confirmed };
}

interface Sent {
  rpcUrl: string;
  privateKey: Hex;
  to: Address;
  data: Hex;
}

function deps(
  fake: FakeService,
  options: { chain?: ChainSafe; code?: boolean; sent?: Sent[] } = {},
): Partial<SignerDeps> {
  const sent = options.sent ?? [];
  return {
    config: () => loadConfig(),
    service: () => fake.service,
    readSafe: () =>
      Promise.resolve(
        options.chain ?? { deployed: true, owners: [EOA_SIGNER, OWNER_B], threshold: 2, nonce: 7 },
      ),
    readCode: () => Promise.resolve(options.code ?? false),
    send: (input) => {
      sent.push(input);
      return Promise.resolve(TX_HASH);
    },
  };
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
      baseRecord({ confirmations: [{ owner: OWNER_B, signature: OTHER_SIGNATURE }] }),
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
    const signature = first(fake.confirmed).signature;
    expect(await verifyMessage({ address: EOA_SIGNER, message: { raw: HASH }, signature })).toBe(true);

    // One transaction, to the Safe, carrying the proposal's own fields.
    expect(sent).toHaveLength(1);
    const sentOnce = first(sent);
    expect(sentOnce.to).toBe(SAFE);
    expect(sentOnce.privateKey).toBe(KEY_SIGNER);
    const call = decodeFunctionData({ abi: safeAbi, data: sentOnce.data });
    expect(call.functionName).toBe('execTransaction');
    const execArgs = call.args as readonly Hex[];
    const packed = execArgs[9] ?? '0x';
    // two owners signed: 2 × 65 bytes, ascending address order, v bumped to 31/32
    expect(size(packed)).toBe(130);
    expect(packed.slice(2, 66)).toBe(OTHER_SIGNATURE.slice(2, 66));
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
    expect(captured.human[0]).toContain('gas');
  });

  it('executes on its own signature when the service has not indexed it yet', async () => {
    const fake = fakeService(
      baseRecord({ confirmations: [{ owner: OWNER_B, signature: OTHER_SIGNATURE }] }),
      { indexConfirmation: false },
    );
    const sent: Sent[] = [];
    const captured = capture();

    await runSignerConfirm(
      captured.out,
      args(['signer', 'confirm', HASH, '--safe', SAFE]),
      deps(fake, { sent }),
    );

    expect(sent).toHaveLength(1);
    expect(captured.results[0]).toMatchObject({ confirmations: 2, executed: true });
  });

  it('posts the confirmation and stops when --no-execute is given', async () => {
    const fake = fakeService(
      baseRecord({ confirmations: [{ owner: OWNER_B, signature: OTHER_SIGNATURE }] }),
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
        nonce: 8,
        confirmations: [{ owner: OWNER_B, signature: OTHER_SIGNATURE }],
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
    const fake = fakeService(baseRecord({ nonce: 6 }));
    const captured = capture();

    await expect(
      runSignerConfirm(captured.out, args(['signer', 'confirm', HASH, '--safe', SAFE]), deps(fake)),
    ).rejects.toMatchObject({ code: 'stale_nonce' });
    expect(fake.confirmed).toHaveLength(0);
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
      baseRecord({ confirmations: [{ owner: OWNER_B, signature: OTHER_SIGNATURE }] }),
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
});
