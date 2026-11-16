// ============================================================================
// The proposal file — the call, not the key, is what crosses machines.
//
// The reader's job is to refuse anything a person would not recognise as the
// call they are about to sign, so every shape error is checked here rather than
// discovered when the service answers.
// ============================================================================

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readProposal,
  safeBatch,
  writeBatch,
  writeProposal,
  type ProposalFile,
} from '../src/core/proposal-file';
import { UsageError } from '../src/lib/errors';

const SAFE = '0x1111111111111111111111111111111111111111';
const NEW_OWNER = '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF';
const DATA = '0x0d582f13000000000000000000000000' as const;
const HASH = `0x${'ab'.repeat(32)}` as const;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 's2s-proposal-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function proposal(overrides: Partial<ProposalFile> = {}): ProposalFile {
  return {
    schemaVersion: 1,
    action: 'signer.add',
    safe: SAFE,
    chainId: 8453,
    newOwner: NEW_OWNER,
    threshold: 1,
    to: SAFE,
    value: '0',
    data: DATA,
    operation: 0,
    nonce: 1,
    safeTxHash: HASH,
    createdAt: '2026-11-14T11:00:00.000Z',
    ...overrides,
  };
}

function writeAndRead(value: unknown, name = 'call.json'): ProposalFile {
  const path = join(dir, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return readProposal(path);
}

describe('proposal file', () => {
  it('round-trips through disk unchanged', () => {
    const path = writeProposal(join(dir, 'nested', 'call.json'), proposal());
    expect(path).toBe(join(dir, 'nested', 'call.json'));
    expect(readProposal(path)).toEqual(proposal());
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });

  it('refuses a file that is not JSON', () => {
    expect(() => writeAndRead('not json')).toThrow(UsageError);
    expect(() => writeAndRead('not json')).toThrow(/cannot be read as JSON/);
  });

  it('refuses a schema version it does not know', () => {
    expect(() => writeAndRead({ ...proposal(), schemaVersion: 2 })).toThrow(/schemaVersion is 2/);
  });

  it('refuses an action it cannot post', () => {
    expect(() => writeAndRead({ ...proposal(), action: 'signer.rotate' })).toThrow(
      /this command posts 'signer.add'/,
    );
  });

  it('refuses a call field that is not the shape it claims', () => {
    expect(() => writeAndRead({ ...proposal(), safe: 'nope' })).toThrow(/safe is not an address/);
    expect(() => writeAndRead({ ...proposal(), data: 'xyz' })).toThrow(/data is not hex/);
    expect(() => writeAndRead({ ...proposal(), nonce: -1 })).toThrow(/nonce/);
    expect(() => writeAndRead({ ...proposal(), threshold: 0 })).toThrow(/threshold/);
    expect(() => writeAndRead({ ...proposal(), operation: 2 })).toThrow(/operation/);
    expect(() => writeAndRead({ ...proposal(), value: '0x0' })).toThrow(/decimal string/);
    expect(() => writeAndRead({ ...proposal(), chainId: 0 })).toThrow(/chainId/);
  });

  it('writes the same call as a Transaction Builder batch for the Safe app', () => {
    const path = writeBatch(join(dir, 'batch.json'), proposal());
    const batch = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(batch).toMatchObject({
      version: '1.0',
      chainId: '8453',
      transactions: [{ to: SAFE, value: '0', data: DATA }],
    });
    // The meta names the Safe the batch belongs to: the app refuses a batch
    // loaded into another Safe, and this is the field that decides it.
    expect((batch.meta as Record<string, unknown>).createdFromSafeAddress).toBe(SAFE);
    expect(safeBatch(proposal()).transactions).toHaveLength(1);
  });

  it('does not judge the hash: that needs the chain id rule and belongs to the command', () => {
    const read = writeAndRead(proposal({ safeTxHash: `0x${'cd'.repeat(32)}` }));
    expect(read.safeTxHash).toBe(`0x${'cd'.repeat(32)}`);
  });
});
