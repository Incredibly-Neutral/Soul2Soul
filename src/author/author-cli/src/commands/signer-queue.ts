// ============================================================================
// s2s signer queue [<safe>] — what is waiting on the Safe, oldest nonce first.
//
// A Safe executes one nonce at a time, so the queue is a sequence, not a set:
// the proposal with the Safe's current nonce comes first and the rest wait
// behind it. The service holds the proposals and the confirmations; the owners
// and the threshold come from the chain, because the service's answer for a
// Safe it was told about once can be older than the Safe itself.
//
// The one question a signer has is "does this need me?". It is answered per
// row: whether this machine's key is an owner, and whether it has confirmed
// already. An owner that has not confirmed is the row to run `confirm` on.
//
// Read-only: no proposal, no signature, no gas. Runs without `buildContext`.
// ============================================================================

import { size, type Address } from 'viem';

import type { ParsedArgs } from '../lib/args';
import type { StoreCommandSpec } from '../lib/command';
import { CliError, UsageError } from '../lib/errors';
import type { CliOut } from '../lib/out';
import { authorEoa } from '../core/authors';
import type { SafeTxRecord } from '../adapters/safe-tx';
import {
  asSafeAddress,
  l2Rpc,
  reasonOf,
  resolveSignerSafe,
  shortAddress,
  signerDeps,
  type ChainSafe,
  type SignerDeps,
} from './signer-store';

/** One row of the queue, in the shape both output modes report. */
interface QueueRow {
  nonce: number;
  safeTxHash: string;
  method: string | undefined;
  newOwner: string | undefined;
  to: Address;
  data: string;
  /** 65-byte confirmations: what `execTransaction` can actually pack. */
  confirmations: number;
  /** The chain's threshold when the Safe could be read, else the service's. */
  confirmationsRequired: number;
  /** Enough packable confirmations to execute, once the nonce comes up. */
  executable: boolean;
  /** null when there is no key, or the owners could not be read — not "no". */
  keyIsOwner: boolean | null;
  keyConfirmed: boolean;
}

/**
 * The new owner a decoded method names, when the service decoded one. The Safe
 * OwnerManager methods that carry a new owner all call the parameter `owner`
 * (`addOwnerWithThreshold`, `removeOwner`, `swapOwner`).
 */
function newOwnerOf(record: SafeTxRecord): string | undefined {
  const parameter = record.dataDecoded?.parameters.find((entry) => entry.name === 'owner');
  return typeof parameter?.value === 'string' ? parameter.value : undefined;
}

/** What this key's relation to a row is, in one phrase for the human line. */
function keyState(row: QueueRow, hasKey: boolean): string {
  if (!hasKey) return 'no key filed here';
  if (row.keyIsOwner === null) return 'owners unreadable';
  if (!row.keyIsOwner) return 'not an owner';
  return row.keyConfirmed ? 'already confirmed' : 'not yet confirmed';
}

export async function runSignerQueue(
  out: CliOut,
  args: ParsedArgs,
  overrides: Partial<SignerDeps> = {},
): Promise<void> {
  const deps = signerDeps(overrides);
  const config = deps.config();

  const target = args.positionals[0];
  const safe = target ? asSafeAddress(target) : resolveSignerSafe(config);
  if (!safe) {
    throw new UsageError(
      'no Safe given and no stored author to take one from — pass <safe>, or file one with `s2s signer add <safe>`',
    );
  }

  const rpcUrl = l2Rpc(config);
  const eoa = config.privateKey ? authorEoa(config.privateKey) : undefined;

  let chain: ChainSafe | undefined;
  try {
    chain = await deps.readSafe(rpcUrl, safe);
  } catch (err) {
    // A dead RPC costs the owner columns, not the listing: the service answers
    // with the proposals and its own confirmation counts.
    out.warn(`could not read the Safe's owners (${reasonOf(err)}) — the queue is shown without them`);
  }
  if (chain && !chain.deployed) {
    throw new CliError(
      `no Safe at ${safe} on Base — \`s2s signer queue\` lists proposals of a deployed Safe`,
      1,
      'safe_not_deployed',
    );
  }

  const pending = [...(await deps.service(config).pending(safe))].sort((a, b) => a.nonce - b.nonce);
  const threshold = chain?.threshold ?? 0;

  const rows: QueueRow[] = pending.map((record) => {
    // Only 65-byte entries can be packed into the signature list
    // `execTransaction` reads; a 32-byte one is a contract owner's approval by
    // hash and does not count towards the threshold. `confirm` filters the same
    // way, so the two commands agree on how many signatures a row has.
    const signable = record.confirmations.filter((entry) => size(entry.signature) === 65);
    const confirmedBy = new Set(signable.map((entry) => entry.owner.toLowerCase()));
    // The chain's threshold is the one a transaction must meet. The service's
    // count is only a fallback for a row whose Safe could not be read, because
    // its copy of a Safe it was told about once can be older than the Safe.
    const required = chain ? chain.threshold : record.confirmationsRequired;
    const keyIsOwner = eoa && chain
      ? chain.owners.some((owner) => owner.toLowerCase() === eoa.toLowerCase())
      : null;
    return {
      nonce: record.nonce,
      safeTxHash: record.safeTxHash,
      method: record.dataDecoded?.method,
      newOwner: newOwnerOf(record),
      to: record.to,
      data: record.data,
      confirmations: signable.length,
      confirmationsRequired: required,
      executable: required > 0 && signable.length >= required,
      keyIsOwner,
      keyConfirmed: eoa ? confirmedBy.has(eoa.toLowerCase()) : false,
    };
  });

  const headline =
    rows.length === 0
      ? `no unexecuted proposals on ${safe}`
      : `${String(rows.length)} unexecuted proposal${rows.length === 1 ? '' : 's'} on ${safe}`;

  out.result(
    {
      action: 'signer.queue',
      safe,
      eoa: eoa ?? null,
      threshold,
      owners: chain?.owners ?? [],
      pending: rows,
    },
    [
      headline,
      `safe        : ${safe}${chain ? ` (${String(threshold)} of ${String(chain.owners.length)})` : ''}`,
      ...rows.map((row) =>
        [
          `nonce ${String(row.nonce)}`,
          row.safeTxHash,
          row.method
            ? `${row.method}(${row.newOwner ? shortAddress(row.newOwner) : '…'})`
            : '(method not decoded)',
          `${String(row.confirmations)} of ${String(row.confirmationsRequired)} confirmed`,
          `yours: ${keyState(row, eoa !== undefined)}`,
        ].join('  '),
      ),
      ...(rows.some((row) => row.keyIsOwner === true && !row.keyConfirmed)
        ? ['', 'confirm one with `s2s signer confirm <safeTxHash>` — execution costs gas from this key']
        : []),
    ].join('\n'),
  );
}

export const signerQueue: StoreCommandSpec = {
  name: 'queue',
  summary: 'List unexecuted proposals on the Safe, oldest nonce first, and what this key still owes.',
  params: '[<safe>]',
  flags: {},
  async run(out: CliOut, args: ParsedArgs) {
    await runSignerQueue(out, args);
  },
};
