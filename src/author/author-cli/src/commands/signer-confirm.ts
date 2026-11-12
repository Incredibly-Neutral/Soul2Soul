// ============================================================================
// s2s signer confirm <safeTxHash> [--safe <safe>] [--no-execute]
//
// Two steps, and the second one is not optional in the usual case: sign the
// safeTxHash as a message with this key, POST the confirmation to the service,
// then — when the confirmations now meet the Safe's threshold and the nonce is
// still the Safe's own — send `execTransaction` on chain from the EOA.
//
// The POST is conditional. `s2s signer rotate` proposes with the old key's
// `sign` signature, and the service files a proposal's signature as its
// sender's confirmation — so the machine that proposed a swap already has its
// signature in the record, and re-posting it adds nothing. At threshold 1 that
// duplicate POST was the whole advertised path: confirm is here to EXECUTE an
// already-satisfied proposal, so the record is read first and the signature
// already on it is reused. The confirmations are recovered against the digest
// rather than compared by the `owner` field, which is the service's claim;
// recovery is what the packing step trusts.
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

import { getAddress, hashMessage, recoverAddress, size, type Address, type Hex } from 'viem';
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
  reasonOf,
  resolveSignerSafe,
  signerDeps,
  type SignerDeps,
} from './signer-store';
import { reconcileReplacement } from './signer-rotate';

/**
 * Whether this stored confirmation was signed by `owner`.
 *
 * Two schemes reach the service: a bare `v` of 27/28 over the digest (a
 * `sign({hash})` signature, which is what `s2s signer rotate` posts) and 31/32
 * over the eth_sign-prefixed digest (`signMessage({raw})`). The `v` byte is
 * normalized to 27/28 because 31/32 is not a recovery id, and BOTH digests are
 * tried: recovering a signature over the wrong digest yields some other valid
 * address rather than an error, so "it recovered" proves nothing — only "it
 * recovered to the owner in question" does.
 *
 * A 32-byte entry is a contract owner's `approveHash`, not an ECDSA signature,
 * and never answers. The service's `owner` label is not consulted: this decides
 * what to POST, and the label is the claim the POST would duplicate.
 */
async function recoversAs(safeTxHash: Hex, signature: Hex, owner: Address): Promise<boolean> {
  if (size(signature) !== 65) return false;
  const raw = Number.parseInt(signature.slice(-2), 16);
  const v = raw > 30 ? raw - 4 : raw;
  if (v !== 27 && v !== 28) return false;
  const normalized = `${signature.slice(0, 130)}${v === 27 ? '1b' : '1c'}` as Hex;
  for (const digest of [safeTxHash, hashMessage({ raw: safeTxHash })]) {
    try {
      const recovered = await recoverAddress({ hash: digest, signature: normalized });
      if (recovered.toLowerCase() === owner.toLowerCase()) return true;
    } catch {
      // try the next scheme
    }
  }
  return false;
}

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
  // Before anything is read from the service: a rotation whose swap already
  // executed is settled here, so a run that died after executing still moves
  // the store on, and this run decides with the key that is actually active.
  let settledName = reconcileReplacement(safe, chain.owners, out, deps.authorsPath());
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

  // A signature by this key that is already in the record needs no second POST:
  // `s2s signer rotate` queued the swap with it, and the service kept it as this
  // owner's confirmation. Signing again would only replace the same entry.
  let known: { owner: Address; signature: Hex } | undefined;
  for (const confirmation of record.confirmations) {
    if (await recoversAs(safeTxHash, confirmation.signature, eoa)) {
      known = confirmation;
      break;
    }
  }

  let signature: Hex;
  let posted = false;
  if (known) {
    signature = known.signature;
  } else {
    signature = await privateKeyToAccount(privateKey).signMessage({
      message: { raw: safeTxHash },
    });
    await service.confirm({ safe, safeTxHash, signature });
    posted = true;
  }

  // Re-read after a POST: the service is the record of who confirmed, and our
  // own signature is merged in because it may not have been indexed yet. A
  // 32-byte entry is a contract owner's approval by hash, which cannot be packed
  // into the signature list `execTransaction` reads.
  const after = posted ? await service.get(safe, safeTxHash) : record;
  const byOwner = new Map<Address, Hex>();
  for (const confirmation of after.confirmations) {
    if (size(confirmation.signature) !== 65) continue;
    // The service's own label is the key here; `packVerifiedSignatures` proves
    // every signature it is given before sending, so a wrong label cannot ride.
    byOwner.set(getAddress(confirmation.owner.toLowerCase()), confirmation.signature);
  }
  if (!byOwner.has(eoa)) byOwner.set(eoa, signature);

  const required = chain.threshold;
  const signing = [...byOwner.keys()];
  let executed = false;
  let txHash: Hex | undefined;
  let note: string | undefined;

  if (!execute) {
    note = posted
      ? '--no-execute: confirmation posted, nothing sent on chain'
      : '--no-execute: this key had already signed the proposal, nothing sent on chain';
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
    // The swap has landed: settle again against the owners the chain now
    // reports, so the new row becomes the active one and the old row goes. A
    // failure here is a warning — the chain work is done, the store can catch
    // up on the next run.
    try {
      const ownersAfter = (await deps.readSafe(rpcUrl, safe)).owners;
      settledName =
        reconcileReplacement(safe, ownersAfter, out, deps.authorsPath()) ?? settledName;
    } catch (err) {
      out.warn(
        `the transaction executed but the store was not reconciled (${reasonOf(err)}) — the next \`s2s signer\` run settles it`,
      );
    }
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
      posted,
      executed,
      ...(txHash ? { txHash } : {}),
      ...(settledName ? { settled: settledName } : {}),
      ...(note ? { note } : {}),
    },
    [
      posted
        ? `confirmation posted for ${safeTxHash} as ${eoa}`
        : `${eoa} had already signed ${safeTxHash} in the proposal — no confirmation posted`,
      `safe          : ${safe}`,
      `confirmations : ${String(signing.length)} of ${String(required)}`,
      ...(txHash
        ? [
            `executed      : ${txHash}`,
            `                gas for this transaction was paid from ${eoa}`,
          ]
        : [`not executed  : ${note ?? 'unknown reason'}`]),
      ...(settledName ? [`settled: ${settledName} is now the key for ${safe}`] : []),
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
