// ============================================================================
// `s2s signer propose --file` — the owner-machine half of a join.
//
// The file comes from `signer add --emit` on the machine that cannot sign as an
// owner. No socket: the chain read and the service are injected, and the hash
// the owner signs is the one the file carries, recomputed.
// ============================================================================

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recoverAddress, type Address, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeSafeTxHash, type SafeTxInput, type SafeTxService } from '../src/adapters/safe-tx';
import type { ChainSafe, SignerDeps } from '../src/commands/signer-store';
import { runSignerPropose, signerPropose } from '../src/commands/signer-propose';
import { writeProposal, type ProposalFile } from '../src/core/proposal-file';
import { loadConfig } from '../src/core/config';
import { parseCommandArgs, type ParsedArgs } from '../src/lib/args';
import { CliError, UsageError } from '../src/lib/errors';
import type { CliOut } from '../src/lib/out';

/** Valid keys nobody can use: privkey 1 (the owner here), 2 (the joiner). */
const EOA_OWNER = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const NEW_OWNER: Address = '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF';
const SAFE: Address = '0x1111111111111111111111111111111111111111';
const KEY_OWNER = `0x${'00'.repeat(31)}01`;
const RPC = 'https://rpc.example';
/** `addOwnerWithThreshold` selector and padding — hex is all this test needs. */
const DATA = `0x0d582f13${'00'.repeat(32)}` as Hex;

const CHAIN: ChainSafe = { deployed: true, owners: [EOA_OWNER], threshold: 1, nonce: 1 };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's2s-signer-propose-'));
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
  vi.stubEnv('S2S_RPC_L2', RPC);
  vi.stubEnv('BASE_RPC_URL', '');
  vi.stubEnv('S2S_PRIVATE_KEY', KEY_OWNER);
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

interface Proposed {
  safe: Address;
  sender: Address;
  tx: SafeTxInput;
  signature: Hex;
}

function fakeService(fail?: CliError): { service: SafeTxService; proposed: Proposed[] } {
  const proposed: Proposed[] = [];
  const service: SafeTxService = {
    register() {
      return Promise.resolve();
    },
    propose(input) {
      if (fail) return Promise.reject(fail);
      proposed.push({ ...input });
      return Promise.resolve({
        safeTxHash: computeSafeTxHash({ chainId: 8453, safe: input.safe, tx: input.tx }),
      });
    },
    pending() {
      return Promise.reject(new Error('not used by signer propose'));
    },
    get() {
      return Promise.reject(new Error('not used by signer propose'));
    },
    confirm() {
      return Promise.reject(new Error('not used by signer propose'));
    },
  };
  return { service, proposed };
}

function deps(fake: { service: SafeTxService }, chain: ChainSafe = CHAIN): Partial<SignerDeps> {
  return {
    config: () => loadConfig(),
    service: () => fake.service,
    readSafe: () => Promise.resolve(chain),
    chainId: 8453,
  };
}

function proposal(overrides: Partial<ProposalFile> = {}): ProposalFile {
  const tx: SafeTxInput = { to: SAFE, value: 0n, data: DATA as Hex, operation: 0, nonce: 1 };
  return {
    schemaVersion: 1,
    action: 'signer.add',
    safe: SAFE,
    chainId: 8453,
    newOwner: NEW_OWNER,
    threshold: 1,
    to: SAFE,
    value: '0',
    data: DATA as Hex,
    operation: 0,
    nonce: 1,
    safeTxHash: computeSafeTxHash({ chainId: 8453, safe: SAFE, tx }),
    createdAt: '2026-11-14T11:00:00.000Z',
    ...overrides,
  };
}

function file(value: ProposalFile, name = 'call.json'): string {
  return writeProposal(join(dir, name), value);
}

function args(path: string): ParsedArgs {
  const parsed = parseCommandArgs(['signer', 'propose', '--file', path], signerPropose.flags);
  return { flags: parsed.flags, positionals: parsed.positionals.slice(2) };
}

describe('s2s signer propose', () => {
  it('posts the file, signs the hash as the owner, and names the new owner', async () => {
    const fake = fakeService();
    const captured = capture();
    const path = file(proposal());

    await runSignerPropose(captured.out, args(path), deps(fake));

    expect(fake.proposed).toHaveLength(1);
    const posted = fake.proposed[0]!;
    expect(posted.safe).toBe(SAFE);
    expect(posted.sender).toBe(EOA_OWNER);
    expect(posted.tx).toMatchObject({ to: SAFE, data: DATA, nonce: 1 });
    // The signature is the owner's, over the hash in the file.
    expect(
      (
        await recoverAddress({ hash: proposal().safeTxHash, signature: posted.signature })
      ).toLowerCase(),
    ).toBe(EOA_OWNER.toLowerCase());

    expect(captured.results[0]).toMatchObject({
      action: 'signer.propose',
      safe: SAFE,
      newOwner: NEW_OWNER,
      sender: EOA_OWNER,
      nonce: 1,
      proposed: true,
      confirmationsRequired: 1,
      file: path,
      safeTxHash: proposal().safeTxHash,
    });
    expect(captured.logs.join('\n')).toContain('proposal queued');
    expect(captured.logs.join('\n')).toContain('`s2s signer confirm ');
  });

  it('refuses a file whose call was edited after the hash was written', async () => {
    const fake = fakeService();
    const edited = file(proposal({ data: `${DATA}00` as Hex }));
    const call = () => runSignerPropose(capture().out, args(edited), deps(fake));

    await expect(call()).rejects.toBeInstanceOf(CliError);
    await expect(call()).rejects.toMatchObject({ code: 'proposal_mismatch' });
    expect(fake.proposed).toHaveLength(0);
  });

  it('refuses a file for another chain', async () => {
    const fake = fakeService();
    const path = file(proposal({ chainId: 1 }));
    await expect(runSignerPropose(capture().out, args(path), deps(fake))).rejects.toMatchObject({
      code: 'wrong_chain',
    });
    expect(fake.proposed).toHaveLength(0);
  });

  it('refuses a nonce the Safe has passed, naming both', async () => {
    const fake = fakeService();
    const path = file(proposal());
    const call = () =>
      runSignerPropose(capture().out, args(path), deps(fake, { ...CHAIN, nonce: 2 }));

    await expect(call()).rejects.toMatchObject({ code: 'stale_proposal' });
    await expect(call()).rejects.toThrow(/names nonce 1 .* is at nonce 2/);
    expect(fake.proposed).toHaveLength(0);
  });

  it('refuses when this machine holds no owner key', async () => {
    vi.stubEnv('S2S_PRIVATE_KEY', `0x${'00'.repeat(31)}02`);
    const fake = fakeService();
    const path = file(proposal());
    await expect(runSignerPropose(capture().out, args(path), deps(fake))).rejects.toMatchObject({
      code: 'not_owner_key',
    });
    expect(fake.proposed).toHaveLength(0);
  });

  it('refuses a Safe with no bytecode', async () => {
    const fake = fakeService();
    const path = file(proposal());
    await expect(
      runSignerPropose(capture().out, args(path), deps(fake, { ...CHAIN, deployed: false })),
    ).rejects.toMatchObject({ code: 'safe_not_deployed' });
  });

  it('throws the service refusal instead of reporting a false success', async () => {
    const fake = fakeService(new CliError('Sender is not an owner', 422, 'not_owner_key'));
    const path = file(proposal());
    await expect(runSignerPropose(capture().out, args(path), deps(fake))).rejects.toMatchObject({
      code: 'not_owner_key',
    });
  });

  it('requires --file', async () => {
    await expect(
      runSignerPropose(capture().out, { flags: {}, positionals: [] }, deps(fakeService())),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('posts a file written by the writer, not one built in this process', async () => {
    const fake = fakeService();
    // Written the way `signer add --emit` writes it: a real file in a directory
    // that did not exist, read back by the poster.
    const path = writeProposal(join(dir, 'handoff', 'call.json'), proposal());
    await runSignerPropose(capture().out, args(path), deps(fake));
    expect(fake.proposed).toHaveLength(1);
  });
});
