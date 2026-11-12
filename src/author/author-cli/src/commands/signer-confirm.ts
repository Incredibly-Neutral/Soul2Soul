// ============================================================================
// s2s signer confirm <safeTxHash> [--safe <safe>] [--no-execute]
//
// Two steps, and the second one is not optional in the usual case: sign the
// safeTxHash as a message with this key, POST the confirmation to the service,
// then — when the confirmations now meet the Safe's threshold and the nonce is
// still the Safe's own — send `execTransaction` on chain.
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
// Who pays for the execution is decided before the send, never after it. The
// paymaster sponsors it only when all four hold: a paymaster URL is configured,
// the Safe is 1-of-1 (the module checks the userOp signature against the Safe's
// own threshold, and this build signs once), the Safe4337Module is enabled, and
// it is also the Safe's fallback handler (the module is reached through the
// fallback, so an enabled module with another handler validates nothing). Then
// the same `execTransaction` goes out as a userOp through the author Safe runner
// and the paymaster fronts the gas. Anything else pays from the EOA, and the
// output names the condition that failed.
//
// A sponsored send that fails is never retried on the EOA. The failure is
// classified first: refused before submission (nothing landed, retrying is
// safe) or submitted with an unknown outcome (it may have executed, so the user
// checks the queue before retrying). Collapsing those two is how a retry becomes
// a double execution.
//
// Runs without `buildContext`: the sponsored rail is the author Safe runner
// (`createAuthorSafeRunner`), not the CLI context.
// ============================================================================

import { getAddress, hashMessage, recoverAddress, size, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { ParsedArgs } from '../lib/args';
import { flagBool, flagString } from '../lib/args';
import type { StoreCommandSpec } from '../lib/command';
import { CliError, UsageError } from '../lib/errors';
import type { CliOut } from '../lib/out';
import { authorEoa } from '../core/authors';
import { SAFE_4337_MODULE } from '../core/author-safe';
import { bundlerEndpoints, hexKey } from '../core/config';
import { execTransactionArgs, packVerifiedSignatures } from '../adapters/safe-tx';
import { SponsoredSendRefused, SponsoredSendUncertain } from '../adapters/tx-runner';
import {
  asSafeAddress,
  l2Rpc,
  reasonOf,
  resolveSignerSafe,
  signerDeps,
  type Safe4337State,
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

/**
 * The message for a send that failed because the EOA has no ETH, or undefined
 * when the failure was something else.
 *
 * A node reports this as a reverted execution ("gas required exceeds allowance
 * (0)", geth's wording) or as "insufficient funds", not as an error type, so it
 * is matched rather than classified. It is worth its own message because it is
 * the one execution failure that leaves nothing to be redone: the proposal is
 * queued and the confirmation is posted, so the whole recovery is funding the
 * address and running the same command again.
 */
function fundsMessage(err: unknown, eoa: Address, safe: Address, safeTxHash: Hex): string | undefined {
  const parts: string[] = [];
  for (const field of ['message', 'shortMessage', 'details'] as const) {
    const value = (err as Record<string, unknown> | null)?.[field];
    if (typeof value === 'string') parts.push(value);
  }
  if (!/insufficient funds|gas required exceeds allowance|exceeds the balance/i.test(parts.join(' '))) {
    return undefined;
  }
  return `${eoa} has no ETH on base to pay for executing ${safeTxHash} on ${safe}: the proposal is queued and signed, so fund ${eoa} with a little Base ETH and run this command again — nothing needs re-signing and nothing is lost`;
}


/** A Safe's 4337 facts plus, when a read failed, why. */
interface PayerInput {
  selfPaid: boolean;
  bundlerUrl: string | undefined;
  paymasterUrl: string | undefined;
  threshold: number;
  owners: number;
  /** Read only after everything cheaper has passed. */
  probe: () => Promise<Safe4337State>;
  onReadFailure: (reason: string) => void;
}

/**
 * Why the EOA pays, or `undefined` when the paymaster sponsors the send.
 *
 * Ordered from the cheapest and most certain answer to the most expensive: the
 * user's own flag, the two settings (`bundlerEndpoints` collapses them, so the
 * missing one is named here rather than reported as "no paymaster"), the Safe's
 * threshold, and only then the two chain reads.
 *
 * The threshold is a condition, not a formality: `Safe4337Module.validateUserOp`
 * checks the userOp signature against the Safe's own threshold via
 * `checkNSignatures`, and this build signs with one key. At t>1 the userOp is
 * refused by the bundler's simulation, and a t>1 Safe is exactly the shape that
 * needs several confirmations, so `signer add`-filed Safes would fail every
 * sponsored send.
 *
 * An unreadable chain read is not a refusal to execute: the EOA can still pay,
 * so it is a warning plus a fallback, never a throw after the confirmation is
 * already posted.
 */
async function eoaPayerReason(input: PayerInput): Promise<string | undefined> {
  if (input.selfPaid) return '--self-paid';
  if (input.bundlerUrl === undefined) {
    return 'no bundler configured — set S2S_PIMLICO_KEY or S2S_BUNDLER_URL';
  }
  if (input.paymasterUrl === undefined) {
    return 'no paymaster configured — set S2S_PIMLICO_KEY or S2S_PAYMASTER_URL';
  }
  if (input.threshold !== 1) {
    return `the Safe is ${String(input.threshold)}-of-${String(input.owners)}, so a sponsored send would need ${String(input.threshold)} signatures while this build signs one`;
  }
  let state: Safe4337State;
  try {
    state = await input.probe();
  } catch (err) {
    input.onReadFailure(reasonOf(err));
    return `the Safe's 4337 state could not be read (${reasonOf(err)})`;
  }
  if (!state.moduleEnabled) {
    return `the Safe4337Module (${SAFE_4337_MODULE}) is not enabled on the Safe`;
  }
  if (state.fallbackHandler.toLowerCase() !== SAFE_4337_MODULE.toLowerCase()) {
    return `the Safe's fallback handler is ${state.fallbackHandler}, not the Safe4337Module (${SAFE_4337_MODULE})`;
  }
  return undefined;
}

/** Every word a thrown send error carries, following `cause` a few levels. */
function sendErrorText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    const record = current as Record<string, unknown>;
    for (const field of ['shortMessage', 'details', 'message'] as const) {
      const value = record[field];
      if (typeof value === 'string' && value.trim() !== '' && !parts.includes(value)) {
        parts.push(value);
      }
    }
    current = record.cause;
  }
  return parts.join(': ') || 'no detail from the bundler';
}

/**
 * What a failed send means for whoever retries. `refused` is safe to retry
 * (nothing was submitted); `unknown` may already have executed.
 *
 * The phase markers from `SafeRunnerHandle.sendCall` are authoritative. Text is
 * the fallback for a seam that throws something else, and it defaults to
 * `unknown` on purpose: assuming nothing landed is the error that costs a double
 * execution.
 */
function classifySendFailure(err: unknown): { phase: 'refused' | 'unknown'; detail: string } {
  const detail = sendErrorText(err);
  if (err instanceof SponsoredSendUncertain) return { phase: 'unknown', detail };
  if (err instanceof SponsoredSendRefused) return { phase: 'refused', detail };
  // A UsageError from building the runner: no userOp was ever submitted.
  if (err instanceof CliError) return { phase: 'refused', detail };
  // AA-coded refusals are validation and simulation failures, both pre-submit.
  if (/\bAA\d{2}\b/.test(detail)) return { phase: 'refused', detail };
  if (/timed? ?out|timeout|waiting for user ?operation receipt|receipt .*not/i.test(detail)) {
    return { phase: 'unknown', detail };
  }
  if (/reject|denied|declin|refus|policy|not sponsor|sponsor.*(fail|denied)|simulat|revert/i.test(detail)) {
    return { phase: 'refused', detail };
  }
  return { phase: 'unknown', detail };
}

/**
 * Whether a resolved send produced no hash. Takes `unknown` because the seam's
 * type says `Hex`: the check guards against a stub or an adapter that resolves
 * empty, and a type-level comparison against `undefined` would be optimised
 * away by lint as impossible.
 */
function missingHash(hash: unknown): boolean {
  return hash === undefined || hash === null || hash === '';
}

/** The AMBIGUOUS state, said plainly: it may have executed, so check first. */
function unknownOutcomeMessage(input: {
  rail: 'sponsored' | 'eoa';
  safe: Address;
  safeTxHash: Hex;
  nonce: number;
  detail: string;
}): string {
  const what =
    input.rail === 'sponsored'
      ? `the sponsored send of ${input.safeTxHash} on ${input.safe} was submitted and its outcome is unknown (${input.detail})`
      : `the send of ${input.safeTxHash} on ${input.safe} returned no transaction hash, so its outcome is unknown (${input.detail})`;
  return `${what} — it may have executed: run \`s2s signer queue ${input.safe}\` and check whether nonce ${String(input.nonce)} is still queued before running this again, because a second send could execute the proposal twice`;
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
  // The same notice `signer rotate` gives: a lock cleared here was left by a
  // killed command, and the store may be missing the key that command printed.
  const lock = {
    onStaleLock: (pid: number): void => {
      out.warn(
        `cleared the author store lock left by pid ${String(pid)}, which was not running — that command was killed before it could release the lock or finish, so if it printed a key, check the store holds it`,
      );
    },
  };
  let settledName = reconcileReplacement(safe, chain.owners, out, deps.authorsPath(), lock);
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
  let paidBy: 'paymaster' | 'eoa' | undefined;
  let payerNote: string | undefined;
  let note: string | undefined;

  // Every note leads with what this run actually did to the service: "confirmed,
  // not executed" was printed even when nothing was posted, which reads as a
  // confirmation that does not exist.
  const did = posted ? 'confirmation posted' : 'already signed by this key, nothing posted';
  if (!execute) {
    note = `${did}; not executed (--no-execute)`;
  } else if (record.nonce !== chain.nonce) {
    note = `${did}; not executed — the Safe is at nonce ${String(chain.nonce)}, so this proposal waits behind the transaction at the front; run confirm again on that one`;
  } else if (signing.length < required) {
    const short = required - signing.length;
    note = `${did}; not executed — ${String(short)} more confirmation${short === 1 ? '' : 's'} needed`;
  } else {
    const packed = await packVerifiedSignatures(signing, byOwner, safeTxHash);
    // The record came from the service, but the command is where the hash the
    // user typed has to be tied to the fields that get sent: the service's own
    // check proves the fields reproduce *its* hash, not this one. With the
    // chain id, `execTransactionArgs` re-hashes and refuses a record that is
    // not the proposal that was signed.
    const call = execTransactionArgs(after, packed, { chainId: deps.chainId });

    // Who pays, decided before the send: see `eoaPayerReason` for the four
    // conditions and the order they are checked in.
    const endpoints = bundlerEndpoints(config, deps.chainId);
    const eoaReason = await eoaPayerReason({
      selfPaid: flagBool(args.flags, 'self-paid'),
      bundlerUrl: endpoints?.bundlerUrl,
      paymasterUrl: endpoints?.paymasterUrl,
      threshold: chain.threshold,
      owners: chain.owners.length,
      probe: () => deps.read4337(rpcUrl, safe),
      onReadFailure: (reason) => {
        out.warn(
          `could not read the Safe's 4337 state (${reason}) — sending from ${eoa} instead, whose gas it will pay`,
        );
      },
    });
    const sponsored = eoaReason === undefined;

    let sentHash: Hex | undefined;
    try {
      sentHash = sponsored
        ? await deps.sendSponsored({ config, rpcUrl, privateKey, to: call.to, data: call.data, safe })
        : await deps.send({ rpcUrl, privateKey, to: call.to, data: call.data });
    } catch (err) {
      if (sponsored) {
        const { phase, detail } = classifySendFailure(err);
        const code = /\b(AA\d{2})\b/.exec(detail)?.[1];
        if (phase === 'unknown') {
          throw new CliError(
            unknownOutcomeMessage({ rail: 'sponsored', safe, safeTxHash, nonce: record.nonce, detail }),
            1,
            'send_outcome_unknown',
          );
        }
        // Nothing was submitted, so the recovery is a decision the user makes:
        // pay it themselves, or fix the policy. Funding the EOA only helps with
        // `--self-paid` — a rerun without it asks the paymaster again, because
        // that is what the config says to do.
        throw new CliError(
          `the bundler or paymaster refused the sponsored send of ${safeTxHash} on ${safe}${code ? ` (${code})` : ''}: ${detail} — nothing was sent, the confirmation is posted and the proposal is queued, so fix the paymaster policy and run this again, or run it with --self-paid to pay from ${eoa}, which needs ${eoa} to hold a little Base ETH (funding it only helps with --self-paid: a rerun without --self-paid asks the paymaster again)`,
          1,
          'sponsored_send_failed',
        );
      }
      // A CliError from the seam already says what it is; a node's rejection is
      // where the gas-money case hides, and it is the one worth naming.
      if (err instanceof CliError) throw err;
      const funds = fundsMessage(err, eoa, safe, safeTxHash);
      if (funds === undefined) throw err;
      throw new CliError(funds, 1, 'insufficient_gas');
    }
    // A resolved send with no hash is not a success: `executed` and `paidBy`
    // are claims about the chain, and there is no chain answer to make them on.
    if (missingHash(sentHash)) {
      throw new CliError(
        unknownOutcomeMessage({
          rail: sponsored ? 'sponsored' : 'eoa',
          safe,
          safeTxHash,
          nonce: record.nonce,
          detail: 'the send resolved with no transaction hash',
        }),
        1,
        'send_outcome_unknown',
      );
    }
    txHash = sentHash;
    executed = true;
    paidBy = sponsored ? 'paymaster' : 'eoa';
    payerNote = sponsored ? 'sponsored by the paymaster' : `paid by ${eoa} (${eoaReason})`;
    // The swap has landed: settle again against the owners the chain now
    // reports, so the new row becomes the active one and the old row goes. A
    // failure here is a warning — the chain work is done, the store can catch
    // up on the next run.
    try {
      const ownersAfter = (await deps.readSafe(rpcUrl, safe)).owners;
      settledName =
        reconcileReplacement(safe, ownersAfter, out, deps.authorsPath(), lock) ?? settledName;
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
      ...(paidBy ? { paidBy } : {}),
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
            `                gas for this transaction was ${payerNote ?? 'paid by an unknown party'}`,
          ]
        : [`not executed  : ${note ?? 'unknown reason'}`]),
      ...(settledName ? [`settled: ${settledName} is now the key for ${safe}`] : []),
    ].join('\n'),
  );
}

export const signerConfirm: StoreCommandSpec = {
  name: 'confirm',
  summary:
    'Sign a queued proposal with this key, then execute it when the threshold is met; the paymaster sponsors it only for a 1-of-1 Safe with the 4337 module enabled as its handler and a paymaster configured, otherwise the EOA pays.',
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
    'self-paid': {
      type: 'boolean',
      summary:
        'send execTransaction as a plain transaction from the EOA and pay its gas, even when the paymaster would sponsor it',
    },
  },
  async run(out: CliOut, args: ParsedArgs) {
    await runSignerConfirm(out, args);
  },
};
