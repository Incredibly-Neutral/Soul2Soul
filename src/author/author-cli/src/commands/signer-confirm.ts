// ============================================================================
// s2s signer confirm <safeTxHash> [--safe <safe>] [--no-execute]
//
// Two steps, and the second one is not optional in the usual case: sign the
// safeTxHash as a message with this key, POST the confirmation to the service,
// then — when the confirmations now meet the Safe's threshold and the nonce is
// still the Safe's own — send `execTransaction` on chain from the EOA.
//
// The signature is `signMessage` over the raw 32 bytes, which is the eth_sign
// scheme the Safe reads from a `v` of 31/32. Packing is `packVerifiedSignatures`:
// it recovers every signature in the set against the
// digest before sending, so a confirmation from another tool that signed a
// different digest is refused here with `signature_not_owner` instead of
// arriving at the Safe as `GS026` with no owner named. The packed list is the
// proof that what is executed is what the owners signed.
//
// Everything is refused before anything is signed when it cannot work: a key
// that is not an owner, a Safe with no bytecode, a proposal already executed, a
// proposal whose nonce the Safe has passed. A proposal with a nonce ahead of
// the Safe is fine — it is queued behind other transactions — so it is
// confirmed and left alone.
//
// Execution costs gas, paid by the EOA that sends it: the Safe transaction has
// zero gas fields, so nothing is refunded to the sender. `--no-execute` stops
// after the confirmation, for a key that should not spend.
//
// Runs without `buildContext`: no bundler, no userOp.
// ============================================================================

import { getAddress, size, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { ParsedArgs } from '../lib/args';
import { flagBool, flagString } from '../lib/args';
import type { StoreCommandSpec } from '../lib/command';
import { CliError, UsageError } from '../lib/errors';
import type { CliOut } from '../lib/out';
import { authorEoa } from '../core/authors';
import { hexKey } from '../core/config';
import { execTransactionArgs, packVerifiedSignatures } from '../adapters/safe-tx';
import {
  asSafeAddress,
  l2Rpc,
  resolveSignerSafe,
  signerDeps,
  type SignerDeps,
} from './signer-store';

export async function runSignerConfirm(
  out: CliOut,
  args: ParsedArgs,
  overrides: Partial<SignerDeps> = {},
): Promise<void> {
  const deps = signerDeps(overrides);
  const hashArgument = args.positionals[0];
  if (!hashArgument) {
    throw new UsageError('missing required argument: <safeTxHash>');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(hashArgument.trim())) {
    throw new UsageError(
      `'${hashArgument}' is not a safeTxHash — expected 0x followed by 64 hex chars`,
    );
  }
  const safeTxHash = hashArgument.trim() as Hex;

  const config = deps.config();
  const configured = hexKey(config.privateKey);
  const privateKey = configured && /^0x[0-9a-fA-F]{64}$/.test(configured) ? (configured as Hex) : undefined;
  const eoa = privateKey ? authorEoa(privateKey) : undefined;
  if (!privateKey || !eoa) {
    throw new UsageError(
      'no signing key — activate one with `s2s author switch <name>`, or file one with `s2s signer add <safe>`',
    );
  }

  const safeFlag = flagString(args.flags, 'safe');
  const safe = safeFlag ? asSafeAddress(safeFlag, '--safe') : resolveSignerSafe(config);
  if (!safe) {
    throw new UsageError(
      'no Safe given and no stored author to take one from — pass --safe <safe>',
    );
  }
  // `--no-execute` is parsed as `execute: false`; absent means execute.
  const execute = args.flags.execute === undefined ? true : flagBool(args.flags, 'execute');

  const rpcUrl = l2Rpc(config);
  const chain = await deps.readSafe(rpcUrl, safe);
  if (!chain.deployed) {
    throw new CliError(`no Safe at ${safe} on Base — nothing to confirm`, 1, 'safe_not_deployed');
  }
  if (!chain.owners.some((owner) => owner.toLowerCase() === eoa.toLowerCase())) {
    throw new CliError(
      `${eoa} is not an owner of ${safe} — an owner has to add it first (\`s2s signer add ${safe}\`)`,
      1,
      'not_owner',
    );
  }
  // A contract cannot produce an eth_sign signature. Safe's answer for a
  // contract owner is `approveHash` from that contract, i.e. a transaction the
  // contract itself must make.
  if (await deps.readCode(rpcUrl, eoa)) {
    throw new CliError(
      `the owner entry ${eoa} is a contract — it confirms by calling approveHash on ${safe} from its own code, which this key cannot do for it`,
      1,
      'contract_owner',
    );
  }

  const service = deps.service(config);
  const record = await service.get(safe, safeTxHash);
  if (record.isExecuted) {
    throw new CliError(`${safeTxHash} is already executed on ${safe}`, 1, 'already_executed');
  }
  if (record.nonce < chain.nonce) {
    throw new CliError(
      `stale proposal: ${safeTxHash} is for nonce ${String(record.nonce)}, the Safe is at nonce ${String(chain.nonce)} — it can never execute; propose it again`,
      1,
      'stale_nonce',
    );
  }

  const signature = await privateKeyToAccount(privateKey).signMessage({
    message: { raw: safeTxHash },
  });
  await service.confirm({ safe, safeTxHash, signature });

  // Re-read: the service is the record of who confirmed, and our own signature
  // is merged in because it may not have been indexed yet. A 32-byte entry is a
  // contract owner's approval by hash, which cannot be packed into the
  // signature list `execTransaction` reads.
  const after = await service.get(safe, safeTxHash);
  const byOwner = new Map<Address, Hex>();
  for (const confirmation of after.confirmations) {
    if (size(confirmation.signature) !== 65) continue;
    byOwner.set(getAddress(confirmation.owner.toLowerCase()), confirmation.signature);
  }
  if (!byOwner.has(eoa)) byOwner.set(eoa, signature);

  const required = chain.threshold;
  const signing = [...byOwner.keys()];
  let executed = false;
  let txHash: Hex | undefined;
  let note: string | undefined;

  if (!execute) {
    note = '--no-execute: confirmation posted, nothing sent on chain';
  } else if (record.nonce !== chain.nonce) {
    note = `queued behind the Safe's current nonce ${String(chain.nonce)} — confirmed, not executed; run confirm again on the proposal at the front`;
  } else if (signing.length < required) {
    note = `${String(required - signing.length)} more confirmation${required - signing.length === 1 ? '' : 's'} needed`;
  } else {
    const packed = await packVerifiedSignatures(signing, byOwner, safeTxHash);
    // The record came from the service, but the command is where the hash the
    // user typed has to be tied to the fields that get sent: the service's own
    // check proves the fields reproduce *its* hash, not this one. With the
    // chain id, `execTransactionArgs` re-hashes and refuses a record that is
    // not the proposal that was signed.
    const call = execTransactionArgs(after, packed, { chainId: deps.chainId });
    txHash = await deps.send({ rpcUrl, privateKey, to: call.to, data: call.data });
    executed = true;
  }

  out.result(
    {
      action: 'signer.confirm',
      safe,
      safeTxHash,
      eoa,
      nonce: record.nonce,
      confirmations: signing.length,
      required,
      confirmed: true,
      executed,
      ...(txHash ? { txHash } : {}),
      ...(note ? { note } : {}),
    },
    [
      `confirmation posted for ${safeTxHash} as ${eoa}`,
      `safe          : ${safe}`,
      `confirmations : ${String(signing.length)} of ${String(required)}`,
      ...(txHash
        ? [
            `executed      : ${txHash}`,
            `                gas for this transaction was paid from ${eoa}`,
          ]
        : [`not executed  : ${note ?? 'unknown reason'}`]),
    ].join('\n'),
  );
}

export const signerConfirm: StoreCommandSpec = {
  name: 'confirm',
  summary:
    'Sign a queued proposal with this key, then execute it when the threshold is met (execution costs gas from the EOA).',
  params: '<safeTxHash>',
  flags: {
    safe: {
      type: 'string',
      value: '<safe>',
      summary: 'the Safe that holds the proposal (default: the active stored author Safe)',
    },
    execute: {
      type: 'boolean',
      summary:
        'send execTransaction when the confirmations meet the threshold (default); --no-execute stops after the confirmation',
    },
  },
  async run(out: CliOut, args: ParsedArgs) {
    await runSignerConfirm(out, args);
  },
};
