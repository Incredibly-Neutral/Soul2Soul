// ============================================================================
// s2s signer propose --file <call.json> — an owner machine posts a proposal a
// joining machine could not.
//
//   s2s signer add 0xSafe… --emit call.json      # on the machine joining
//   s2s signer propose --file call.json          # on a machine holding an owner key
//
// The joining machine writes the call because it cannot produce the one thing
// the service needs: a signature from an owner of that Safe. This command has
// that key and nothing else travels — no mnemonic, no private key, just the
// `{to, data, nonce}` the other machine already printed.
//
// Three checks before anything is signed, because a proposal is a signature:
//
//   the file's hash still matches its own call. Recomputed here, not trusted:
//   the whole reason to hand a file to an owner is that the owner can tell what
//   they are signing, and a mismatch means the file was edited after writing.
//
//   the chain id is this one. The service indexes per chain and rejects a hash
//   computed for another, so the refusal is local and names the field.
//
//   the nonce is still the Safe's next. A file written before another proposal
//   landed names a nonce the Safe has passed; posting it would queue something
//   that can never execute.
//
// Runs without `buildContext`, like the rest of the group.
// ============================================================================

import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { ParsedArgs } from '../lib/args';
import { flagString } from '../lib/args';
import type { StoreCommandSpec } from '../lib/command';
import { CliError, UsageError } from '../lib/errors';
import type { CliOut } from '../lib/out';
import { authorEoa } from '../core/authors';
import { hexKey } from '../core/config';
import { readProposal, type ProposalFile } from '../core/proposal-file';
import { computeSafeTxHash, type SafeTxInput } from '../adapters/safe-tx';
import { l2Rpc, reasonOf, shortAddress, signerDeps, type SignerDeps } from './signer-store';

/** The call the file describes, in the shape the hash and the service take. */
function txOf(proposal: ProposalFile): SafeTxInput {
  return {
    to: proposal.to,
    value: BigInt(proposal.value),
    data: proposal.data,
    operation: proposal.operation,
    nonce: proposal.nonce,
  };
}

export async function runSignerPropose(
  out: CliOut,
  args: ParsedArgs,
  overrides: Partial<SignerDeps> = {},
): Promise<void> {
  const deps = signerDeps(overrides);
  const path = flagString(args.flags, 'file');
  if (!path) {
    throw new UsageError('missing required flag: --file <call.json>');
  }

  const proposal = readProposal(path);
  const tx = txOf(proposal);
  // Chain first: the hash was computed for the file's chain, so a file from
  // another chain would fail the recomputation below and be reported as edited
  // when it is merely foreign.
  if (proposal.chainId !== deps.chainId) {
    throw new CliError(
      `${path} was written for chain ${String(proposal.chainId)}; this machine proposes on ${String(deps.chainId)}`,
      1,
      'wrong_chain',
    );
  }
  const recomputed = computeSafeTxHash({
    chainId: proposal.chainId,
    safe: proposal.safe,
    tx,
  });
  if (recomputed.toLowerCase() !== proposal.safeTxHash.toLowerCase()) {
    throw new CliError(
      `${path} does not match its own hash — the call was edited after it was written; re-run \`s2s signer add --emit\` on the joining machine`,
      1,
      'proposal_mismatch',
    );
  }
  const config = deps.config();
  const rpcUrl = l2Rpc(config);
  const chain = await deps.readSafe(rpcUrl, proposal.safe);
  if (!chain.deployed) {
    throw new CliError(
      `no Safe at ${proposal.safe} on Base — there is nothing to propose to`,
      1,
      'safe_not_deployed',
    );
  }
  if (chain.nonce !== proposal.nonce) {
    throw new CliError(
      `${path} names nonce ${String(proposal.nonce)} and ${proposal.safe} is at nonce ${String(chain.nonce)} — a transaction landed since it was written; re-run \`s2s signer add --emit\` on the joining machine`,
      1,
      'stale_proposal',
    );
  }

  // The signing key has to be an owner, decided here rather than learnt from a
  // 403: the service files a proposal's signature as its sender's confirmation.
  const key = hexKey(config.privateKey);
  const eoa = key ? authorEoa(key) : undefined;
  const isOwner =
    eoa !== undefined && chain.owners.some((owner) => owner.toLowerCase() === eoa.toLowerCase());
  if (!key || !eoa || !isOwner) {
    throw new CliError(
      `no key this machine can sign with is an owner of ${proposal.safe} — run this on a machine that holds one, or post the call from an owner wallet [not_owner_key]`,
      1,
      'not_owner_key',
    );
  }

  if (config.safeTx.url.trim() === '') {
    throw new UsageError('no Safe Transaction Service URL configured (safeTx.url)');
  }

  let safeTxHash: Hex;
  try {
    const service = deps.service(config);
    await service.register(proposal.safe, {
      owners: chain.owners,
      threshold: chain.threshold,
    });
    const signature = await privateKeyToAccount(key as Hex).sign({ hash: recomputed });
    safeTxHash = (await service.propose({ safe: proposal.safe, sender: eoa, tx, signature }))
      .safeTxHash;
  } catch (err) {
    // Nothing is unrecoverable here: the file is on disk and the owner can try
    // again or post the call by hand, so a failure is an error, not a result.
    const code = (err as { code?: unknown }).code;
    throw new CliError(
      `the proposal was not queued — ${reasonOf(err)}`,
      1,
      typeof code === 'string' && code ? code : 'propose_failed',
    );
  }

  const newOwner: Address = proposal.newOwner;
  out.result(
    {
      action: 'signer.propose',
      safe: proposal.safe,
      newOwner,
      sender: eoa,
      nonce: proposal.nonce,
      safeTxHash,
      proposed: true,
      confirmationsRequired: chain.threshold,
      file: path,
    },
    [
      `proposal queued — ${shortAddress(eoa)} signed it (1 of ${String(chain.threshold)} confirmations)`,
      `safe        : ${proposal.safe}`,
      `new owner   : ${newOwner} (joins when the transaction executes)`,
      `nonce       : ${String(proposal.nonce)}`,
      `safeTxHash  : ${safeTxHash}`,
      ...(chain.threshold > 1
        ? [
            `              the other owners run \`s2s signer confirm ${safeTxHash}\` from their own machines`,
          ]
        : [`              the threshold is met: \`s2s signer confirm ${safeTxHash}\` executes it`]),
      `              proposing costs no gas; execution is sponsored only for a 1-of-1 Safe with the 4337 module enabled as its handler and a paymaster configured, otherwise the sending EOA pays`,
    ].join('\n'),
  );
}

export const signerPropose: StoreCommandSpec = {
  name: 'propose',
  summary:
    'Post a proposal file written by `s2s signer add --emit` — the owner-machine half of a join.',
  params: '--file <call.json>',
  flags: {
    file: {
      type: 'string',
      value: '<path>',
      summary: 'the proposal file to post (written with `s2s signer add --emit`)',
    },
  },
  async run(out: CliOut, args: ParsedArgs) {
    await runSignerPropose(out, args);
  },
};
