// ============================================================================
// s2s signer rotate [<safe>] — swap this machine's key for a fresh one.
//
//   s2s signer rotate                              # the Safe this machine files
//   s2s signer rotate 0xSafe…                      # that Safe, named again
//   s2s signer rotate 0xSafe… --key 0x…            # swap in a key you already hold
//   s2s signer rotate 0xSafe… --name zomi-next     # and name it
//
// One Safe transaction: `swapOwner(prevOwner, oldOwner, newOwner)`. The Safe
// keeps its threshold — a rotation is a swap, not a remove followed by an add,
// so the owner count and the bar for a signature never move. `prevOwner` is
// read out of the Safe's own owner list (`predecessorOf`), never asked for.
//
// The argument is optional because this machine already files its own Safe: a
// row that signs is a row that names an address, and naming it again on the
// command line is a third copy of one fact. With no argument the target is the
// active row's Safe when that row's key is one of its owners, else the Safe a
// pending replacement row is filed for (which is where a retry lands), else a
// usage error naming `<safe>`. The positional stays as the override for a
// machine holding rows for several Safes.
//
// The old key is the row filed for this Safe whose stored key derives to one of
// its owners, preferring the active row — and when the active row is not an
// owner of this Safe, the row that is wins, so the run says `s2s author switch`
// plainly: `signer confirm` signs with the active key and nothing else. That row
// is also the proposer: the service stores a proposal's signature as its
// sender's confirmation and refuses a sender that is not an owner, so the swap
// is posted by the OLD key — even when it is not the active one — and never by
// the key that joins only when the swap executes.
//
// A row filed for a swap that never got queued (`replaces` and no `proposal`)
// is the ONLY copy of the key that swap puts on the Safe: the phrase was printed
// once. So a run against that Safe reuses the row — same name, same EOA, same
// key — signs with the old key again and records the hash it queues under. It
// generates nothing and prints no phrase. A row that does have a `proposal` is
// a queued swap and refuses: `s2s signer confirm` executes it.
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
// pair to propose by hand goes into the result. That failure is what leaves the
// retryable row behind.
//
// Nothing here needs a bundler and nothing sends a userOp: proposing is an HTTP
// POST, and the swap executes when the owners confirm and one of them sends it.
// Runs without `buildContext`.
// ============================================================================

import { getAddress, type Address, type Hex } from 'viem';
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
  setPendingProposal,
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

/** A stored address this build can read, or undefined when the row holds none. */
function storedSafe(value: string | null | undefined): Address | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? getAddress(trimmed.toLowerCase()) : undefined;
}

/**
 * The Safe a run without an argument rotates on.
 *
 * The active row names a Safe and holds a key; when that key is on the Safe's
 * owner list, that is the Safe this machine can rotate on and the answer needs
 * no argument. When it is not — the active author is a key for some other Safe —
 * the fallback is a row filed to replace a key, which is the row a failed run
 * left behind and the one a retry has to finish. Neither is a usage error for
 * the user to fix by guessing: the message says to pass `<safe>`.
 *
 * A row whose address this build cannot read is no candidate at all, and the
 * chain read of a candidate is not swallowed: an unreachable RPC is an RPC
 * problem, not "nothing to rotate".
 */
async function resolveRotateSafe(
  deps: SignerDeps,
  rpcUrl: string,
  store: AuthorsStore,
): Promise<Address> {
  const active = activeAuthorRecord(store);
  const activeEoa = active ? authorEoa(active.privateKey) : undefined;
  const activeSafe = storedSafe(active?.safe);
  if (activeSafe && activeEoa) {
    const chain = await deps.readSafe(rpcUrl, activeSafe);
    if (
      chain.deployed &&
      chain.owners.some((owner) => owner.toLowerCase() === activeEoa.toLowerCase())
    ) {
      return activeSafe;
    }
  }
  const chaser = Object.entries(store.authors).find(
    ([, record]) => record.replaces !== undefined && storedSafe(record.safe) !== undefined,
  );
  const pendingSafe = chaser === undefined ? undefined : storedSafe(chaser[1].safe);
  if (pendingSafe) return pendingSafe;

  const why =
    active === undefined
      ? 'this machine holds no active key'
      : activeSafe === undefined
        ? `the active author '${active.name}' has no Safe on file`
        : `the active author '${active.name}' does not own ${activeSafe}`;
  throw new UsageError(
    `${why}, and nothing is filed to replace a key on any Safe — pass <safe> to name the Safe to rotate on, or file the key that owns it with \`s2s signer add <safe>\``,
  );
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
  const config = deps.config();
  const path = deps.authorsPath();
  const rpcUrl = l2Rpc(config);

  const target = args.positionals[0];
  const safe = target ? asSafeAddress(target) : await resolveRotateSafe(deps, rpcUrl, readAuthors(path));

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
  const settled = reconcileReplacement(safe, chain.owners, out, path);

  // 2. The old key: the row for this Safe that derives to one of its owners.
  const store = readAuthors(path);
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

  // 3. The new key, or the one a failed run already filed. A row carrying
  // `replaces` and no `proposal` is a key that was printed once and never
  // queued: minting another would leave two copies of one fact and abandon the
  // only copy of this one.
  const pending = pendingReplacement(safe, path);
  if (pending?.proposal !== undefined) {
    throw new CliError(
      `a replacement is already queued on ${safe}: '${pending.name}' is filed and its swap ${pending.proposal} waits to execute — \`s2s signer confirm ${pending.proposal}\` signs and executes it once the threshold is met (\`s2s signer queue ${safe}\` lists it)`,
      1,
      'replacement_pending',
    );
  }

  let name: string;
  let privateKey: string;
  let eoa: Address;
  let mnemonic: string | undefined;
  let generated = false;
  let reused = false;

  if (pending) {
    if (pending.replaces !== oldKey.name) {
      throw new CliError(
        `the filed swap on ${safe} replaces '${pending.replaces}', but the key on its owner list is '${oldKey.name}' — the swap can be signed by the key it retires only; \`s2s signer queue ${safe}\` shows what is queued`,
        1,
        'not_owner',
      );
    }
    if (flagString(args.flags, 'key') !== undefined || flagString(args.flags, 'mnemonic') !== undefined) {
      throw new UsageError(
        `'${pending.name}' already holds the key for the swap that failed — a retry finishes that swap with that row's key, which is the only copy of it; a different key would leave this one stranded`,
      );
    }
    const askedName = flagString(args.flags, 'name');
    if (askedName !== undefined && askedName !== pending.name) {
      throw new UsageError(
        `'${pending.name}' is the row the failed swap is filed under — a retry keeps that name; finish the swap before renaming the row`,
      );
    }
    const row = store.authors[pending.name];
    const rowEoa = row === undefined ? undefined : authorEoa(row.privateKey);
    if (row === undefined || rowEoa === undefined) {
      throw new UsageError(
        `author '${pending.name}' holds no key this build can read — \`s2s author list\` shows the rows; the failed swap cannot be retried from this one`,
      );
    }
    name = pending.name;
    privateKey = row.privateKey;
    eoa = rowEoa;
    reused = true;
  } else {
    // The same resolver every other key-filing command uses.
    const source = deps.keySource(args.flags);
    const key = hexKey(source.privateKey);
    const derived = key === undefined ? undefined : authorEoa(key);
    if (key === undefined || derived === undefined) {
      throw new UsageError(
        'invalid private key — expected 32 bytes of hex (0x followed by 64 hex chars)',
      );
    }
    name = flagString(args.flags, 'name') ?? `${oldKey.name}-next`;
    privateKey = key;
    eoa = derived;
    mnemonic = source.mnemonic;
    generated = source.generated;
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

  // 5. The predecessor comes from the Safe's own list: a mapping has no reverse
  // lookup, and asking the user for it invites a `GS005` revert.
  const prevOwner = predecessorOf(chain.owners, oldKey.eoa);

  // 6. File the new key first. It lands inactive so the old key stays the one
  // this machine signs with — that is what confirms the swap below.
  if (!reused) {
    addSigner({ name, privateKey, safe, replaces: oldKey.name }, path);
  }

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

  // The hash is what tells the next run that this row is queued rather than
  // stranded. A store write that fails here is a warning, not the proposal
  // lost: the next run reuses this row's key and proposes it again.
  if (proposed) {
    try {
      setPendingProposal(name, safeTxHash, path);
    } catch (err) {
      out.warn(
        `the swap is queued as ${safeTxHash} but the store does not record it (${reasonOf(err)}) — \`s2s signer confirm ${safeTxHash}\` still signs and executes it`,
      );
    }
  } else {
    out.warn(
      `the proposal was not queued — ${note ?? 'unknown error'}; the key is filed and the call to propose by hand is in the result`,
    );
  }

  // The key that signs this swap is not always the active author: a store can
  // hold a row for this Safe that is not the one selected, and `signer confirm`
  // signs with the active key only. Say which command closes that gap rather
  // than telling the user to confirm with a key that is not the active one.
  const switchTo = oldKey.name === store.active ? undefined : oldKey.name;
  // At threshold 1 the proposer's signature is the whole quorum.
  const thresholdMet = chain.threshold <= 1;

  out.result(
    {
      action: 'signer.rotate',
      name,
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
      ...(reused ? { reused: true } : {}),
      ...(switchTo ? { switchTo } : {}),
      ...(note ? { note } : {}),
      ...(mnemonic ? { mnemonic } : {}),
      ...(generated ? { privateKey } : {}),
    },
    [
      reused
        ? `signer '${name}' was already filed — reusing the key filed by the failed run (replaces '${oldKey.name}')`
        : `signer '${name}' filed, inactive until the swap executes (replaces '${oldKey.name}')`,
      `eoa         : ${eoa}`,
      `old eoa     : ${oldKey.eoa} ('${oldKey.name}', still the key that owns the swap)`,
      `safe        : ${safe}`,
      `threshold   : ${String(chain.threshold)} (unchanged — a swap keeps it)`,
      `nonce       : ${String(chain.nonce)}`,
      `safeTxHash  : ${safeTxHash}`,
      ...(switchTo
        ? [
            `switch first: '${store.active ?? '(none)'}' is the active author, so \`s2s signer confirm\` would sign with a key that does not own ${safe}`,
            `              run \`s2s author switch ${switchTo}\` before the confirm below`,
          ]
        : []),
      ...(settled ? [`settled     : ${settled} is now the key for ${safe}`] : []),
      ...(proposed
        ? [
            `proposal    : queued — '${oldKey.name}' signed it (1 of ${String(chain.threshold)} confirmations)`,
            ...(thresholdMet
              ? [
                  `              that signature is in the proposal and the threshold is met: the swap is executable as soon as the service holds it`,
                  `              \`s2s signer confirm ${safeTxHash}\` sends it: nothing left to sign`,
                ]
              : [
                  `              the remaining owners run \`s2s signer confirm ${safeTxHash}\` from their own machines`,
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
      `store       : ${path}`,
      ...(mnemonic
        ? [
            `mnemonic    : ${mnemonic}`,
            `              (${generated ? 'generated' : 'restored'}) — printed once, this is the only copy: write it down, it restores this signer anywhere`,
          ]
        : []),
    ].join('\n'),
  );
}

export const signerRotate: StoreCommandSpec = {
  name: 'rotate',
  summary:
    "Swap this machine's key on a deployed Safe for a fresh one, in one transaction, threshold untouched.",
  detail:
    'The Safe defaults to the one this machine files when it signs; pass <safe> only to pick another one.',
  params: '[<safe>]',
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
