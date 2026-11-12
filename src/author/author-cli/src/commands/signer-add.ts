// ============================================================================
// s2s signer add <safe> — file a key and propose it as one more owner.
//
//   s2s signer add 0xSafe…                        # generate a key, propose it
//   s2s signer add 0xSafe… --key 0x…              # file a key you already hold
//   s2s signer add 0xSafe… --name zomi --key 0x…  # and name it
//
// The Safe already exists and has owners. This command adds the new EOA to that
// list with `addOwnerWithThreshold(newEoa, threshold)` — the Safe's CURRENT
// threshold, read from the chain, never raised: one more owner must not change
// how many signatures a transaction needs. The proposal is `to: safe`, so the
// Safe calls itself; the service carries it until the owners have confirmed.
//
// The proposal is signed by a key that already owns the Safe, never by the key
// being added: the service stores a proposal's signature as its sender's
// confirmation and refuses a sender that is not on the owner list, and the key
// this run files joins the list only when the transaction executes. A machine
// that holds no owner key for the Safe — the usual case for a machine that is
// joining — posts nothing and reports the same `{to, data}` call for an owner
// machine to make.
//
// The key comes from the same resolver `author new` uses (`--key`, `--mnemonic`,
// a piped line, else a generated BIP39 phrase printed once). It is filed BEFORE
// the service is touched, and a failed proposal is reported, never thrown: the
// key is the thing that cannot be recovered, and the `{to, data}` pair to
// propose by hand goes into the result.
//
// The row is filed INACTIVE (`activate: false`). The active author is the key
// every command signs with, and this key is not on the owner list until the add
// executes — activating it would leave a store whose selected author the chain
// rejects, with `signer confirm` refusing its own machine's key as `not_owner`.
//
// Nothing here needs a bundler and nothing sends a userOp: proposing is an HTTP
// POST, and execution is some owner's later business (`s2s signer confirm`).
// Runs without `buildContext`.
// ============================================================================

import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { ParsedArgs } from '../lib/args';
import { flagString } from '../lib/args';
import type { StoreCommandSpec } from '../lib/command';
import { CliError, UsageError } from '../lib/errors';
import type { CliOut } from '../lib/out';
import { addSigner, authorEoa, readAuthors } from '../core/authors';
import { hexKey } from '../core/config';
import {
  addOwnerWithThresholdData,
  computeSafeTxHash,
  type SafeTxInput,
} from '../adapters/safe-tx';
import {
  asSafeAddress,
  defaultSignerName,
  l2Rpc,
  reasonOf,
  shortAddress,
  signerDeps,
  type SignerDeps,
} from './signer-store';

export async function runSignerAdd(
  out: CliOut,
  args: ParsedArgs,
  overrides: Partial<SignerDeps> = {},
): Promise<void> {
  const deps = signerDeps(overrides);
  const target = args.positionals[0];
  if (!target) {
    throw new UsageError('missing required argument: <safe>');
  }
  const safe = asSafeAddress(target);

  const source = deps.keySource(args.flags);
  const privateKey = hexKey(source.privateKey);
  const eoa = privateKey ? authorEoa(privateKey) : undefined;
  if (!privateKey || !eoa) {
    throw new UsageError(
      'invalid private key — expected 32 bytes of hex (0x followed by 64 hex chars)',
    );
  }

  const config = deps.config();
  const rpcUrl = l2Rpc(config);
  const chain = await deps.readSafe(rpcUrl, safe);
  if (!chain.deployed) {
    // Chain state, not a spelling mistake: the address was well formed and the
    // answer is that no contract lives there. Same refusal as `signer confirm`,
    // so one condition has one outcome across the group.
    throw new CliError(
      `no Safe at ${safe} on Base — \`s2s signer add\` proposes an owner of a Safe that is already deployed`,
      1,
      'safe_not_deployed',
    );
  }
  if (chain.owners.some((owner) => owner.toLowerCase() === eoa.toLowerCase())) {
    throw new UsageError(
      `${eoa} is already an owner of ${safe} — nothing to add; \`s2s signer queue ${safe}\` shows what is pending`,
    );
  }

  const name = flagString(args.flags, 'name') ?? defaultSignerName(eoa);
  // Read before filing: the point of `activate: false` is that filing a joining
  // key does not move this, and saying so needs the value it kept.
  const keptActive = readAuthors(deps.authorsPath()).active;
  // A taken name or a key filed elsewhere is a UsageError from `addSigner`, and
  // it is thrown before anything is written — including this Safe's record.
  // `activate: false`: the key being filed is NOT an owner of the Safe yet. The
  // store's active row is the key every command signs with, and pointing it at a
  // key the chain does not recognise is how `signer confirm` comes to refuse its
  // own machine's key. The active slot stays where it was; the join is completed
  // by whoever posts the add, not by filing it here.
  const filed = addSigner(
    { name, privateKey, safe, activate: false },
    deps.authorsPath(),
  );

  const tx: SafeTxInput = {
    to: safe,
    value: 0n,
    // The Safe's own threshold, unchanged: a new owner joins at the same bar.
    data: addOwnerWithThresholdData(eoa, chain.threshold),
    operation: 0,
    nonce: chain.nonce,
  };
  const localHash = computeSafeTxHash({ chainId: deps.chainId, safe, tx });

  // The key this process can sign for: an env or project key that is on the
  // Safe's owner list, because the service files a proposal's signature as its
  // sender's confirmation and refuses a sender that is not an owner. `signer add`
  // refuses a key that is already an owner, so a machine joining a Safe it does
  // not own has no such key — that is the ordinary case for this command.
  const configKey = hexKey(config.privateKey);
  const configEoa = configKey ? authorEoa(configKey) : undefined;
  const proposer =
    configKey && configEoa && chain.owners.some((o) => o.toLowerCase() === configEoa.toLowerCase())
      ? { privateKey: configKey, eoa: configEoa }
      : undefined;

  let proposed = false;
  let safeTxHash = localHash;
  let note: string | undefined;
  if (config.safeTx.url.trim() === '') {
    note = 'no Safe Transaction Service URL configured (safeTx.url)';
  } else if (!proposer) {
    // Decided offline: the service answers "Sender is not an owner" to every
    // POST this machine could make, and no round trip is spent learning it.
    note = `no key this machine can sign with is an owner of ${safe}, and the service accepts a proposal only from an owner — an owner machine has to post it [not_owner_key]`;
  } else {
    try {
      const service = deps.service(config);
      // Idempotent: the service is told about a Safe it does not index, and left
      // alone when it already knows it.
      // No `modules`: this CLI reads a Safe's owners, threshold and nonce, not
      // its module set, and an author Safe is an ERC-4337 account with the
      // Safe4337Module enabled — so `modules: []` would be a false claim about
      // the Safe, not a default. The field stays unstated until something here
      // can read `isModuleEnabled` for the module address.
      await service.register(safe, { owners: chain.owners, threshold: chain.threshold });
      // Signed by the owner, because the service files the signature as that
      // owner's confirmation. Not by `eoa`: the key this run adds is not on the
      // owner list yet, and a proposal from it is refused.
      const signature = await privateKeyToAccount(proposer.privateKey as Hex).sign({
        hash: localHash,
      });
      safeTxHash = (await service.propose({ safe, sender: proposer.eoa, tx, signature })).safeTxHash;
      proposed = true;
    } catch (err) {
      note = reasonOf(err);
    }
  }

  if (!proposed) {
    out.warn(
      `the proposal was not queued — ${note ?? 'unknown error'}; the key is filed and the call to propose by hand is in the result`,
    );
  }

  out.result(
    {
      action: 'signer.add',
      name: filed.name,
      eoa,
      safe,
      threshold: chain.threshold,
      owners: chain.owners,
      nonce: chain.nonce,
      safeTxHash,
      proposed,
      // Always present: the same call the service was given, so a proposal that
      // never reached it can still be made from an owner's wallet.
      safeTx: { to: safe, data: tx.data },
      activated: false,
      file: deps.authorsPath(),
      ...(note ? { note } : {}),
      ...(source.mnemonic ? { mnemonic: source.mnemonic } : {}),
      ...(source.generated ? { privateKey } : {}),
    },
    [
      `signer '${filed.name}' filed, not activated — the key is not an owner until an owner posts the proposal`,
      `eoa         : ${eoa}`,
      `safe        : ${safe}`,
      `threshold   : ${String(chain.threshold)} (unchanged — the owner list grows, the bar does not)`,
      `nonce       : ${String(chain.nonce)}`,
      `safeTxHash  : ${safeTxHash}`,
      ...(proposed
        ? [
            `proposal    : queued — ${shortAddress(proposer?.eoa ?? '')} signed it (1 of ${String(chain.threshold)} confirmations)`,
            ...(chain.threshold > 1
              ? [
                  `              the other owners run \`s2s signer confirm ${safeTxHash}\` from their own machines`,
                ]
              : [
                  `              the threshold is met: \`s2s signer confirm ${safeTxHash}\` executes it`,
                ]),
            `              proposing costs no gas; execution costs gas from whichever EOA sends it`,
          ]
        : [
            `proposal    : not queued — ${note ?? 'unknown error'}`,
            ...(proposer
              ? []
              : [
                  `              this machine cannot queue it: the service accepts a proposal only from an owner of ${safe}, and no key it can sign with is one`,
                  `              an owner has to post this call from their own machine — nothing here retries it`,
                ]),
            `              to    ${safe}`,
            `              data  ${tx.data}`,
            `              nonce ${String(chain.nonce)}`,
          ]),
      `store       : ${deps.authorsPath()}`,
      `active      : ${keptActive ?? '(none)'} (unchanged — a joined key is not an owner yet, so it does not take the slot)`,
      ...(source.mnemonic
        ? [
            `mnemonic    : ${source.mnemonic}`,
            `              (${source.generated ? 'generated' : 'restored'} — write it down: it restores this signer anywhere)`,
          ]
        : []),
    ].join('\n'),
  );
}

export const signerAdd: StoreCommandSpec = {
  name: 'add',
  summary: 'File a key (generated or given) and propose it as a new owner of a deployed Safe.',
  params: '<safe>',
  flags: {
    name: {
      type: 'string',
      value: '<pet-name>',
      summary: 'name to file the key under (default: signer-<6 hex of the new EOA>)',
    },
    key: {
      type: 'string',
      value: '<0x…>',
      summary: 'private key to file (0x…); default: stdin if piped, else a generated phrase',
    },
    mnemonic: {
      type: 'string',
      value: '<words…>',
      summary: 'BIP39 phrase to restore from (or pipe it on stdin)',
    },
  },
  async run(out: CliOut, args: ParsedArgs) {
    await runSignerAdd(out, args);
  },
};
