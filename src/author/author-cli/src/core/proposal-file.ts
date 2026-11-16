// ============================================================================
// The proposal file: the call one machine writes and another one posts.
//
// `signer add` on a machine with no owner key can do everything except sign as
// an owner. The signature is the only thing it lacks, and the key it just made
// is the last thing that should travel to get it. So the command writes the
// CALL — the safe, the calldata, the nonce, the hash — and the owner machine
// posts it with `signer propose --file`, signing with its own key.
//
// Two properties make that safe to hand over:
//
//   the file cannot be edited. `safeTxHash` is over the call's own fields, so
//   the reader recomputes it and refuses a file whose hash does not match what
//   the call now says. Without that check, a proposal file would be a way to
//   put arbitrary calldata in front of an owner's signature.
//
//   the file carries no secret. Addresses, a calldata blob, a nonce and a hash
//   are all public: what crosses machines is the same information the chain
//   would show after execution.
//
// `schemaVersion` matches the JSON envelope (`lib/out.ts`): a host that reads
// one of these refuses a version it does not know, exactly as it refuses a
// result document it does not know.
// ============================================================================

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';

import { UsageError } from '../lib/errors';
import { SCHEMA_VERSION } from '../lib/out';

/** One Safe transaction, written by `signer add`, posted by `signer propose`. */
export interface ProposalFile {
  schemaVersion: number;
  /** Which command wrote it. One value today; the field is what a reader switches on. */
  action: 'signer.add';
  safe: Address;
  /** The chain the hash was computed for; the service indexes per chain. */
  chainId: number;
  /** The key this proposal, once executed, adds to the owner list. */
  newOwner: Address;
  /** The Safe's threshold at the time of writing: unchanged by the add. */
  threshold: number;
  to: Address;
  value: string;
  data: Hex;
  operation: 0 | 1;
  nonce: number;
  safeTxHash: Hex;
  /** ISO 8601, informational: what a person reads to tell two files apart. */
  createdAt: string;
}

function bad(path: string, reason: string): UsageError {
  return new UsageError(`${path} is not a proposal file — ${reason}`);
}

function addressOf(path: string, field: string, value: unknown): Address {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw bad(path, `${field} is not an address`);
  }
  return getAddress(value);
}

function hexOf(path: string, field: string, value: unknown): Hex {
  if (typeof value !== 'string' || !isHex(value)) {
    throw bad(path, `${field} is not hex`);
  }
  return value;
}

/**
 * Read and validate a proposal. Shape only: whether the hash still matches the
 * call needs the chain id rule and belongs to the command, which recomputes it.
 */
export function readProposal(path: string): ProposalFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw bad(path, 'it cannot be read as JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw bad(path, 'it is not an object');
  const record = parsed as Record<string, unknown>;

  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw bad(
      path,
      `schemaVersion is ${String(record.schemaVersion)}, this build reads ${String(SCHEMA_VERSION)}`,
    );
  }
  if (record.action !== 'signer.add') {
    throw bad(path, `action is '${String(record.action)}', this command posts 'signer.add'`);
  }
  const chainId = record.chainId;
  if (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId <= 0) {
    throw bad(path, 'chainId is not a positive integer');
  }
  const nonce = record.nonce;
  if (typeof nonce !== 'number' || !Number.isInteger(nonce) || nonce < 0) {
    throw bad(path, 'nonce is not a non-negative integer');
  }
  const threshold = record.threshold;
  if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold <= 0) {
    throw bad(path, 'threshold is not a positive integer');
  }
  const operation = record.operation;
  if (operation !== 0 && operation !== 1) {
    throw bad(path, 'operation is not 0 or 1');
  }
  const value = record.value;
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw bad(path, 'value is not a decimal string');
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    action: 'signer.add',
    safe: addressOf(path, 'safe', record.safe),
    chainId,
    newOwner: addressOf(path, 'newOwner', record.newOwner),
    threshold,
    to: addressOf(path, 'to', record.to),
    value,
    data: hexOf(path, 'data', record.data),
    operation,
    nonce,
    safeTxHash: hexOf(path, 'safeTxHash', record.safeTxHash),
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
  };
}

/**
 * The same call as a Safe Transaction Builder batch: what an owner imports and
 * signs in the Safe web app when they would rather not run a CLI at all.
 *
 * A different file from the proposal because it is for a different reader. The
 * proposal is this CLI's input and is checked against its own hash; the batch is
 * the Safe app's input, which carries no hash and is signed by the owner who
 * loads it. Same transaction either way.
 */
export function safeBatch(proposal: ProposalFile): Record<string, unknown> {
  return {
    version: '1.0',
    chainId: String(proposal.chainId),
    createdAt: Date.parse(proposal.createdAt) || Date.now(),
    meta: {
      name: `Add ${proposal.newOwner} as an owner of ${proposal.safe}`,
      description: `addOwnerWithThreshold(${proposal.newOwner}, ${String(proposal.threshold)}) — the threshold is unchanged`,
      txBuilderVersion: '1.16.5',
      createdFromSafeAddress: proposal.safe,
      createdFromOwnerAddress: '',
    },
    transactions: [{ to: proposal.to, value: proposal.value, data: proposal.data }],
  };
}

/** Write the batch form of the same call. Returns the absolute path. */
export function writeBatch(path: string, proposal: ProposalFile): string {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(safeBatch(proposal), null, 2)}\n`);
  return target;
}

/** Write a proposal, creating the parent directory. Returns the absolute path. */
export function writeProposal(path: string, proposal: ProposalFile): string {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(proposal, null, 2)}\n`);
  return target;
}
