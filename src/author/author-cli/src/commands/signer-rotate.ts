// ============================================================================
// s2s signer rotate <safe> — swap this machine's key for a fresh one.
//
//   s2s signer rotate 0xSafe…                      # generate a key, propose the swap
//   s2s signer rotate 0xSafe… --key 0x…            # swap in a key you already hold
//   s2s signer rotate 0xSafe… --name zomi-next     # and name it
//
// One Safe transaction: `swapOwner(prevOwner, oldOwner, newOwner)`. The Safe
// keeps its threshold — a rotation is a swap, not a remove followed by an add,
// so the owner count and the bar for a signature never move. `prevOwner` is
// read out of the Safe's own owner list (`predecessorOf`), never asked for.
//
// The old key is the row filed for this Safe whose stored key derives to one of
// its owners, preferring the active row — and when the active row is not an
// owner of this Safe, the row that is wins, so the run says `s2s author switch`
// plainly: `signer confirm` signs with the active key and nothing else. That row
// is also the proposer: the service stores a proposal's signature as its
// sender's confirmation and refuses a sender that is not an owner, so the swap
// is posted by the OLD key — even when it is not the active one — and never by
// the key that joins only when the swap executes. The new key comes from the
// same resolver `author new` and `signer add` use, so `--key`, `--mnemonic`, a
// piped line and a generated phrase all work the same way. The new row is filed
// inactive, with `replaces` naming the old one: the old key is still the owner
// of the Safe, which is what lets it confirm the swap.
//
// Step 1 is a reconcile, not a read: if a previous rotation already executed,
// `settleReplacement` moves the store on before anything is decided. A
// `collision` — the owners name both filed keys, or neither — is a warning,
// because the store is not the authority here and refusing would leave no way
// forward; in the `neither` case the run then refuses `not_owner` and names
// every key it holds for the Safe.
//
// The key is filed BEFORE the service is touched, and a failed proposal is
// reported, never thrown: the old key is still an owner and the `{to, data}`
// pair to propose by hand goes into the result.
//
// Nothing here needs a bundler and nothing sends a userOp: proposing is an HTTP
// POST, and the swap executes when the owners confirm and one of them sends it.
// Runs without `buildContext`.
// ============================================================================

import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { ParsedArgs } from '../lib/args';
import { flagString } from '../lib/args';
import type { StoreCommandSpec } from '../lib/command';
import { CliError, UsageError } from '../lib/errors';
import type { CliOut } from '../lib/out';
import {
  activeAuthorRecord,
  addSigner,
  authorEoa,
  authorsFilePath,
  pendingReplacement,
  readAuthors,
  settleReplacement,
  type AuthorsStore,
} from '../core/authors';
import { hexKey } from '../core/config';
import {
  computeSafeTxHash,
  predecessorOf,
  swapOwnerData,
  type SafeTxInput,
} from '../adapters/safe-tx';
import {
  asSafeAddress,
  l2Rpc,
  reasonOf,
  signerDeps,
  type SignerDeps,
} from './signer-store';

/** One row of the store that names this Safe, with the EOA its key signs as. */
interface FiledKey {
  name: string;
  privateKey: string;
  eoa: Address;
}

/** Every row filed for `safe`, in store order, skipping a key that cannot sign. */
function keysForSafe(store: AuthorsStore, safe: Address): FiledKey[] {
  const rows: FiledKey[] = [];
  for (const [name, record] of Object.entries(store.authors)) {
    if (record.safe?.toLowerCase() !== safe.toLowerCase()) continue;
    const eoa = authorEoa(record.privateKey);
    if (eoa) rows.push({ name, privateKey: record.privateKey, eoa });
  }
  return rows;
}

/**
 * Reconcile the store against the chain's owner list: a pending replacement
 * whose swap has executed becomes the active key and its old row disappears.
 *
 * Returns the pet name that became the Safe's key, or undefined when nothing
 * settled. Never throws: a reconcile is bookkeeping after the fact, and a store
 * that cannot be written must not fail a run whose chain work already landed.
 * `collision` is warned about, not refused — the owners name both filed keys or
 * neither, and the user is the one who can say which row to keep.
 *
 * `path` is the store the caller is working on, the same one it reads and writes
 * everywhere else in the run: the reconcile must move that file, not whatever
 * sits at the default location.
 *
 * Shared with `signer confirm`, which calls it before reading the record (so a
 * run that died after executing still reconciles) and again after executing.
 */
export function reconcileReplacement(
  safe: Address,
  owners: readonly Address[],
  out: CliOut,
  path: string = authorsFilePath(),
): string | undefined {
  const before = pendingReplacement(safe, path);
  let outcome: ReturnType<typeof settleReplacement>;
  try {
    outcome = settleReplacement(safe, owners, path);
  } catch (err) {
    out.warn(`could not reconcile the pending replacement for ${safe} (${reasonOf(err)})`);
    return undefined;
  }
  if (outcome === 'collision') {
    out.warn(
      `both keys, or neither, are owners of ${safe} — the pending replacement was left filed as it is; \`s2s author list\` shows the rows`,
    );
    return undefined;
  }
  if (outcome !== 'settled') return undefined;
  return before?.name ?? activeAuthorRecord(readAuthors(path))?.name;
}

export async function runSignerRotate(
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

  const config = deps.config();
  const rpcUrl = l2Rpc(config);
  const chain = await deps.readSafe(rpcUrl, safe);
  if (!chain.deployed) {
    throw new CliError(
      `no Safe at ${safe} on Base — \`s2s signer rotate\` swaps an owner of a Safe that is already deployed`,
      1,
      'safe_not_deployed',
    );
  }

  // 1. Settle first: a rotation already executed is a fact the store has to
  // catch up with before this run decides anything.
  const settled = reconcileReplacement(safe, chain.owners, out, deps.authorsPath());

  // 2. The old key: the row for this Safe that derives to one of its owners.
  const store = readAuthors(deps.authorsPath());
  const filed = keysForSafe(store, safe);
  if (filed.length === 0) {
    throw new UsageError(
      `no key filed for ${safe} on this machine — file the key that is already an owner first: \`s2s signer add ${safe}\``,
    );
  }
  const owned = filed.filter((row) =>
    chain.owners.some((owner) => owner.toLowerCase() === row.eoa.toLowerCase()),
  );
  const oldKey = owned.find((row) => row.name === store.active) ?? owned.at(0);
  if (!oldKey) {
    const named = filed.map((row) => `'${row.name}' (${row.eoa})`).join(', ');
    throw new CliError(
      `the key filed for ${safe} is not one of its owners: ${named} — \`s2s signer rotate\` swaps a key that is on the owner list`,
      1,
      'not_owner',
    );
  }

  // 3. The new key: the same resolver every other key-filing command uses.
  const source = deps.keySource(args.flags);
  const privateKey = hexKey(source.privateKey);
  const eoa = privateKey ? authorEoa(privateKey) : undefined;
  if (!privateKey || !eoa) {
    throw new UsageError(
      'invalid private key — expected 32 bytes of hex (0x followed by 64 hex chars)',
    );
  }

  // 4. Refusals, all before anything is filed.
  if (eoa.toLowerCase() === oldKey.eoa.toLowerCase()) {
    throw new CliError(
      `${eoa} is the key already filed as '${oldKey.name}' — a rotation needs a different key; pass --key, or let this command generate one`,
      1,
      'same_key',
    );
  }
  if (chain.owners.some((owner) => owner.toLowerCase() === eoa.toLowerCase())) {
    throw new CliError(
      `${eoa} is already an owner of ${safe} — a rotation swaps one owner for a key that is not on the list`,
      1,
      'already_owner',
    );
  }
  const pending = pendingReplacement(safe, deps.authorsPath());
  if (pending) {
    throw new CliError(
      `a replacement is already in flight on ${safe}: '${pending.name}' is filed and waits for its swap to execute — finish that swap with \`s2s signer confirm\` (\`s2s signer queue ${safe}\` shows it) or wait for an owner to send it; '${pending.name}' holds the only copy of the key that swap puts on the Safe, so it is removed only after the swap settles`,
      1,
      'replacement_pending',
    );
  }

  // 5. The predecessor comes from the Safe's own list: a mapping has no reverse
  // lookup, and asking the user for it invites a `GS005` revert.
  const prevOwner = predecessorOf(chain.owners, oldKey.eoa);

  // 6. File the new key first. It lands inactive so the old key stays the one
  // this machine signs with — that is what confirms the swap below.
  const name = flagString(args.flags, 'name') ?? `${oldKey.name}-next`;
  const filedRow = addSigner(
    { name, privateKey, safe, replaces: oldKey.name },
    deps.authorsPath(),
  );

  const tx: SafeTxInput = {
    to: safe,
    value: 0n,
    data: swapOwnerData(prevOwner, oldKey.eoa, eoa),
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
      // Idempotent, as in `signer add`: a Safe the service does not index is
      // registered, one it knows is left alone. No `modules` — see signer-add.
      await service.register(safe, { owners: chain.owners, threshold: chain.threshold });
      // Signed by the owner whose key this run is retiring, not by the key it is
      // installing: the new key is on the owner list only after this transaction
      // executes, and the service refuses a proposal from a sender that is not an
      // owner. The old row signs whether or not it is the active author — the
      // active slot only decides which key `signer confirm` signs with.
      const signature = await privateKeyToAccount(oldKey.privateKey as Hex).sign({ hash: localHash });
      safeTxHash = (await service.propose({ safe, sender: oldKey.eoa, tx, signature })).safeTxHash;
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

  // The key that signs this swap is not always the active author: a store can
  // hold a row for this Safe that is not the one selected, and `signer confirm`
  // signs with the active key only. Say which command closes that gap rather
  // than telling the user to confirm with a key that is not the active one.
  const switchTo = oldKey.name === store.active ? undefined : oldKey.name;

  out.result(
    {
      action: 'signer.rotate',
      name: filedRow.name,
      replaces: oldKey.name,
      eoa,
      oldEoa: oldKey.eoa,
      safe,
      threshold: chain.threshold,
      owners: chain.owners,
      nonce: chain.nonce,
      safeTxHash,
      proposed,
      // Always present: the same call the service was given, so a proposal that
      // never reached it can still be made from an owner's wallet.
      safeTx: { to: safe, data: tx.data },
      ...(switchTo ? { switchTo } : {}),
      ...(note ? { note } : {}),
      ...(source.mnemonic ? { mnemonic: source.mnemonic } : {}),
      ...(source.generated ? { privateKey } : {}),
    },
    [
      `signer '${filedRow.name}' filed, inactive until the swap executes (replaces '${oldKey.name}')`,
      `eoa         : ${eoa}`,
      `old eoa     : ${oldKey.eoa} ('${oldKey.name}', still the key that owns the swap)`,
      `safe        : ${safe}`,
      `threshold   : ${String(chain.threshold)} (unchanged — a swap keeps it)`,
      `nonce       : ${String(chain.nonce)}`,
      `safeTxHash  : ${safeTxHash}`,
      ...(switchTo
        ? [
            `switch first: '${store.active ?? '(none)'}' is the active author, so \`s2s signer confirm\` would sign with a key that does not own ${safe}`,
            `              run \`s2s author switch ${switchTo}\`, then \`s2s signer confirm ${safeTxHash}\``,
          ]
        : []),
      ...(settled ? [`settled     : ${settled} is now the key for ${safe}`] : []),
      ...(proposed
        ? [
            `proposal    : queued — '${oldKey.name}' signed it (1 of ${String(chain.threshold)} confirmations)`,
            ...(switchTo
              ? []
              : chain.threshold > 1
                ? [
                    `              the remaining owners run \`s2s signer confirm ${safeTxHash}\` from their own machines`,
                  ]
                : [
                    `              the threshold is met: \`s2s signer confirm ${safeTxHash}\` executes the swap`,
                  ]),
            `              '${oldKey.name}' stops being an owner only when the swap executes, not when this proposal is filed`,
            `              proposing costs no gas; executing the swap costs gas from whichever owner sends it`,
          ]
        : [
            `proposal    : not queued — ${note ?? 'unknown error'}`,
            `              the service accepts a proposal only from an owner of ${safe}: post this call from an owner machine`,
            `              to   ${safe}`,
            `              data ${tx.data}`,
          ]),
      `store       : ${deps.authorsPath()}`,
      ...(source.mnemonic
        ? [
            `mnemonic    : ${source.mnemonic}`,
            `              (${source.generated ? 'generated' : 'restored'}) — printed once, this is the only copy: write it down, it restores this signer anywhere`,
          ]
        : []),
    ].join('\n'),
  );
}

export const signerRotate: StoreCommandSpec = {
  name: 'rotate',
  summary:
    "Swap this machine's key on a deployed Safe for a fresh one, in one transaction, threshold untouched.",
  params: '<safe>',
  flags: {
    name: {
      type: 'string',
      value: '<pet-name>',
      summary: "name to file the new key under (default: '<old name>-next')",
    },
    key: {
      type: 'string',
      value: '<0x…>',
      summary: 'the new private key to swap in (0x…); default: stdin if piped, else a generated phrase',
    },
    mnemonic: {
      type: 'string',
      value: '<words…>',
      summary: 'BIP39 phrase to restore the new key from (or pipe it on stdin)',
    },
  },
  async run(out: CliOut, args: ParsedArgs) {
    await runSignerRotate(out, args);
  },
};
