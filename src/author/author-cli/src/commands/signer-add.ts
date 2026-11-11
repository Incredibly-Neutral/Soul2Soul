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
// The key comes from the same resolver `author new` uses (`--key`, `--mnemonic`,
// a piped line, else a generated BIP39 phrase printed once). It is filed BEFORE
// the service is touched, and a failed proposal is reported, never thrown: the
// key is the thing that cannot be recovered, and the `{to, data}` pair to
// propose by hand goes into the result.
//
// Nothing here needs a bundler and nothing sends a userOp: proposing is an HTTP
// POST, and execution is some owner's later business (`s2s signer confirm`).
// Runs without `buildContext`.
// ============================================================================

import type { ParsedArgs } from '../lib/args';
import { flagString } from '../lib/args';
import type { StoreCommandSpec } from '../lib/command';
import { UsageError } from '../lib/errors';
import type { CliOut } from '../lib/out';
import { addSigner, authorEoa } from '../core/authors';
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
    throw new UsageError(
      `no Safe at ${safe} on Base — \`s2s signer add\` proposes an owner of a Safe that is already deployed`,
    );
  }
  if (chain.owners.some((owner) => owner.toLowerCase() === eoa.toLowerCase())) {
    throw new UsageError(
      `${eoa} is already an owner of ${safe} — nothing to add; \`s2s signer queue ${safe}\` shows what is pending`,
    );
  }

  const name = flagString(args.flags, 'name') ?? defaultSignerName(eoa);
  // A taken name or a key filed elsewhere is a UsageError from `addSigner`, and
  // it is thrown before anything is written — including this Safe's record.
  const filed = addSigner({ name, privateKey, safe }, deps.authorsPath());

  const tx: SafeTxInput = {
    to: safe,
    value: 0n,
    // The Safe's own threshold, unchanged: a new owner joins at the same bar.
    data: addOwnerWithThresholdData(eoa, chain.threshold),
    operation: 0,
    nonce: chain.nonce,
  };
  const localHash = computeSafeTxHash({ chainId: deps.chainId, safe, tx });

  let proposed = false;
  let safeTxHash = localHash;
  let note: string | undefined;
  if (config.safeTx.url.trim() === '') {
    note = 'no Safe Transaction Service URL configured (safeTx.url)';
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
      safeTxHash = (await service.propose({ safe, sender: eoa, tx })).safeTxHash;
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
      file: deps.authorsPath(),
      ...(note ? { note } : {}),
      ...(source.mnemonic ? { mnemonic: source.mnemonic } : {}),
      ...(source.generated ? { privateKey } : {}),
    },
    [
      `signer '${filed.name}' filed and activated`,
      `eoa         : ${eoa}`,
      `safe        : ${safe}`,
      `threshold   : ${String(chain.threshold)} (unchanged — the owner list grows, the bar does not)`,
      `nonce       : ${String(chain.nonce)}`,
      `safeTxHash  : ${safeTxHash}`,
      ...(proposed
        ? [
            `proposal    : queued — 0 of ${String(chain.threshold)} confirmations`,
            `              the other owners run \`s2s signer confirm ${safeTxHash}\` from their own machines`,
            `              proposing costs no gas; execution costs gas from whichever EOA sends it`,
          ]
        : [
            `proposal    : not queued — ${note ?? 'unknown error'}`,
            '              propose this call by hand from an owner wallet:',
            `              to   ${safe}`,
            `              data ${tx.data}`,
          ]),
      `store       : ${deps.authorsPath()}`,
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
