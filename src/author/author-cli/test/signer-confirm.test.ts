// ============================================================================
// `s2s signer confirm` — sign the hash, post it, and execute when it is enough.
//
// The signature is checked by recovering it (`verifyMessage`) against the raw
// safeTxHash, and the packed list is decoded back out of the `execTransaction`
// calldata. No socket: `send` is a fake that records its call.
// ============================================================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeFunctionData, size, verifyMessage, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { safeAbi } from '@s2s/soul2soul-shared';

import type { SafeTxRecord, SafeTxService } from '../src/adapters/safe-tx';
import { computeSafeTxHash } from '../src/adapters/safe-tx';
import {
  addSigner,
  pendingReplacement,
  readAuthors,
  storeLockPath,
} from '../src/core/authors';
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
/** The key a pending rotation would file: not an owner yet. */
const KEY_REPLACEMENT: Hex = `0x${'00'.repeat(31)}03`;
const EOA_REPLACEMENT: Address = privateKeyToAccount(KEY_REPLACEMENT).address;

const SAFE: Address = '0x1111111111111111111111111111111111111111';
/** A second owner with a key, so its confirmation can actually be recovered. */
const KEY_B: Hex = `0x${'00'.repeat(31)}02`;
const OWNER_B: Address = privateKeyToAccount(KEY_B).address;
const RPC = 'https://rpc.example';
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

function deps(
  fake: FakeService,
  options: { chain?: ChainSafe; code?: boolean; sent?: Sent[]; ownersAfter?: Address[] } = {},
): Partial<SignerDeps> {
  const sent = options.sent ?? [];
  let reads = 0;
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

    expect(sent).toHaveLength(1);
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
      expect(sent, scheme.name).toHaveLength(1);
      expect(captured.results[0]).toMatchObject({
        posted: false,
        confirmed: true,
        executed: true,
        confirmations: 1,
        required: 1,
      });
      expect(captured.human[0]).toContain('had already signed');
      // The signature that was already on the record is the one that was packed.
      const call = decodeFunctionData({ abi: safeAbi, data: first(sent).data });
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

    expect(sent).toHaveLength(1);
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
