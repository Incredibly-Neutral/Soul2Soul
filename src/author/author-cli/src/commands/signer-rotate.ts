// ============================================================================
// s2s signer rotate — swap this machine's key for a fresh one.
//
//   s2s signer rotate                              # the Safe this machine files
//   s2s signer rotate --key 0x…                    # swap in a key you already hold
//   s2s signer rotate --name zomi-next             # and name it
//
// One Safe transaction: `swapOwner(prevOwner, oldOwner, newOwner)`. The Safe
// keeps its threshold — a rotation is a swap, not a remove followed by an add,
// so the owner count and the bar for a signature never move. `prevOwner` is
// read out of the Safe's own owner list (`predecessorOf`), never asked for.
//
// There is no `<safe>` argument, because this machine already files the Safe it
// signs for: a row that signs is a row that names an address, and naming it
// again on the command line is a third copy of one fact. The target is the
// active row's Safe when that row's key is one of its owners, else the Safe a
// pending replacement row is filed for (which is where a retry lands), else a
// usage error pointing at `s2s signer add <safe>`. `signer add` is the one
// command that names a Safe, because it is the one command with no row to read
// one from.
//
// The old key is a row, always: what a swap retires is a row, and the new row's
// `replaces` has to name one. It is the row for this Safe whose key the chain
// lists as an owner (active row first, then any other). Only when no row holds
// an owner is the effective key — `S2S_PRIVATE_KEY`, then the project config —
// considered, and then it is filed for this Safe first, so the swap is still
// recorded against a row. A row for this Safe whose key is not an owner is a
// stale row: the chain never accepted it, so it is refused and no swap is filed
// against it.
//
// The key that signs the swap is a separate question: any owner may post it, so
// the effective key signs when it owns the Safe, and otherwise the old key does.
// The output names both, because the advice differs: a store row that is not
// active is closed by `s2s author switch`, an env or project key by unsetting it
// — switching authors changes neither.
//
// A row filed for a swap that never got queued (`replaces` and no `proposal`)
// is the ONLY copy of the key that swap puts on the Safe: the phrase was printed
// once. So a run against that Safe reuses the row — same name, same EOA, same
// key — signs with the old key again and records the hash it queues under. It
// generates nothing and prints no phrase. "Never queued" is not decided from the
// store alone: a POST whose reply was lost leaves the row exactly as a POST that
// never landed, so the service is asked first. A swap already at that nonce with
// the same call is adopted and the hash printed; a different transaction at that
// nonce means the row cannot be queued and is refused, naming both hashes. A row
// that does carry a `proposal` refuses `replacement_pending`: `s2s signer confirm`
// executes it.
//
// The store is a read-modify-write with no transaction of its own, so the
// decide-and-file section runs under `withStoreLock`: two rotates racing would
// otherwise both find the same name free and one printed key would be lost.
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
  authorEoa,
  authorsFilePath,
  pendingReplacement,
  planSignerAdd,
  readAuthors,
  setPendingProposal,
  settleReplacement,
  settledAuthorName,
  withStoreLock,
  writeAuthors,
  type AuthorsStore,
  type StoreLockOptions,
} from '../core/authors';
import { hexKey } from '../core/config';
import {
  computeSafeTxHash,
  predecessorOf,
  swapOwnerData,
  type SafeTxInput,
  type SafeTxRecord,
} from '../adapters/safe-tx';
import {
  l2Rpc,
  reasonOf,
  refuseSafeArgument,
  signerDeps,
  type SignerDeps,
} from './signer-store';

/** One row of the store that names this Safe, with the EOA its key signs as. */
interface FiledKey {
  name: string;
  privateKey: string;
  /** Undefined for a hand-edited row whose key this build cannot read. */
  eoa?: Address;
  /** The row this one is taking over, when it is a filed swap. */
  replaces?: string;
  /** The hash that swap was queued under, when the store recorded one. */
  proposal?: string;
}

/**
 * Every row filed for `safe`, in store order, including the ones whose key
 * cannot be derived: a row that cannot sign is still a fact about the store, and
 * "no key filed" is the wrong thing to say when rows exist and none is usable.
 */
function rowsForSafe(store: AuthorsStore, safe: Address): FiledKey[] {
  const rows: FiledKey[] = [];
  for (const [name, record] of Object.entries(store.authors)) {
    if (record.safe?.toLowerCase() !== safe.toLowerCase()) continue;
    rows.push({
      name,
      privateKey: record.privateKey,
      eoa: authorEoa(record.privateKey),
      ...(record.replaces === undefined ? {} : { replaces: record.replaces }),
      ...(record.proposal === undefined ? {} : { proposal: record.proposal }),
    });
  }
  return rows;
}

/** The key this run swaps out, and the row that names it. */
interface OldKey {
  /** Always set: a swap retires a row, and a row is what the store names. */
  name: string;
  privateKey: string;
  eoa: Address;
  /** What the operator has to change to make `signer confirm` use it. */
  source: string;
  /** The `s2s` layer the effective key came from. */
  from: 'env' | 'project' | 'store' | 'user';
}

/** How a key's provenance is named in output: the thing to change, not a code. */
function sourceLabel(from: OldKey['from']): string {
  switch (from) {
    case 'env':
      return 'S2S_PRIVATE_KEY';
    case 'project':
      return 'the project config file';
    case 'user':
      return 'the user config file';
    default:
      return 'the store';
  }
}

/**
 * The key to swap out, which is always a row: what a rotation retires is a row,
 * and the new row's `replaces` has to name one.
 *
 * The Safe comes from the store (see `resolveRotateSafe`), so a row for it always
 * exists, and there are two outcomes rather than three:
 *
 *  1. The row for this Safe whose key the chain lists as an owner, active row
 *     first. This is the ordinary case and it writes nothing.
 *  2. Otherwise refuse. A row for this Safe whose key is not an owner is a stale
 *     row: the chain does not list it, so there is no owner in it to swap out and
 *     no swap is filed against it. It also holds the Safe's slot, so no other key
 *     can be filed there until it is dealt with, and the message says which.
 */
function resolveOldKey(
  store: AuthorsStore,
  safe: Address,
  owners: readonly Address[],
): OldKey {
  const isOwner = (eoa: Address | undefined): boolean =>
    eoa !== undefined && owners.some((owner) => owner.toLowerCase() === eoa.toLowerCase());

  const rows = rowsForSafe(store, safe);
  const owned = rows.filter((row) => isOwner(row.eoa));
  const chosen = owned.find((row) => row.name === store.active) ?? owned[0];
  if (chosen?.eoa !== undefined) {
    return {
      name: chosen.name,
      privateKey: chosen.privateKey,
      eoa: chosen.eoa,
      source: `the store row '${chosen.name}'`,
      from: 'store',
    };
  }

  if (rows.length > 0) {
    const unreadable = rows.filter((row) => row.eoa === undefined).map((row) => `'${row.name}'`);
    if (unreadable.length === rows.length) {
      throw new CliError(
        `the row${rows.length === 1 ? '' : 's'} filed for ${safe} hold no key this build can read: ${unreadable.join(', ')} — \`s2s author list\` shows them; fix or remove the row before rotating`,
        1,
        'not_owner',
      );
    }
    const named = rows.map((row) => `'${row.name}' (${row.eoa ?? 'unreadable key'})`).join(', ');
    // The remedy depends on what the row is. A plain row is removable; a row
    // carrying `replaces` holds the only copy of the key its swap installs —
    // `author rm` refuses it, and `--force` destroys that key — so it is never
    // offered for removal. Such a row also never carries `proposal` by the time
    // this runs: a proposed row makes `pending` non-empty and `rotate` refuses
    // `replacement_pending` before asking for the old key. The swap is therefore
    // finished by `rotate`, which is what queues or adopts its hash.
    const plain = rows.find((row) => row.replaces === undefined);
    const chasing = rows.find((row) => row.replaces !== undefined);
    const advice = [
      ...(plain === undefined
        ? []
        : [
            `\`s2s author rm '${plain.name}'\` frees the slot once the key is no longer wanted`,
          ]),
      ...(chasing === undefined
        ? []
        : [
            `'${chasing.name}' carries the swap that would make it this Safe's key (→ replaces '${chasing.replaces ?? ''}') and is not removable — the phrase that key came from was printed once; run \`s2s signer rotate ${safe}\` to finish that swap`,
          ]),
    ].join('; ');
    throw new CliError(
      `the row${rows.length === 1 ? ' holds' : 's hold'} a key the chain does not list as an owner of ${safe}: ${named} — a swap removes an owner, and none of these keys is one, so there is nothing for it to retire; \`s2s signer queue\` shows what the Safe actually holds. That row is what holds this Safe's slot in the store, so no other key can be filed here${advice === '' ? '' : `; ${advice}`}`,
      1,
      'not_owner',
    );
  }

  throw new CliError(
    `no row filed for ${safe} names a key the chain lists as an owner — \`s2s signer add ${safe}\` files the key that owns it, and a rotation retires a row`,
    1,
    'not_owner',
  );
}

/** A stored address this build can read, or undefined when the row holds none. */
function storedSafe(value: string | null | undefined): Address | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? getAddress(trimmed.toLowerCase()) : undefined;
}

/**
 * The Safe a run rotates on: the one this machine files.
 *
 * The active row names a Safe and holds a key; when that key is on the Safe's
 * owner list, that is the Safe this machine can rotate on. When it is not — the
 * active author is a key for some other Safe — the fallback is a row filed to
 * replace a key, which is the row a failed run left behind and the one a retry
 * has to finish. Neither is a usage error for the user to fix by guessing: the
 * message names `s2s signer add`, which is the command that files a Safe.
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
  // Which Safe to act on is the row's `safe`, not whether its key can be read:
  // a row with a key this build cannot derive still names the Safe its operator
  // meant, and `resolveOldKey` has the message for a row no owner key backs.
  const activeSafe = storedSafe(active?.safe);
  if (activeSafe) {
    const chain = await deps.readSafe(rpcUrl, activeSafe);
    // A Safe that is not deployed there is not "a key that does not own it":
    // saying so would send the user to look at keys for a contract that does
    // not exist. The active row named the address; that is the fact to report.
    if (!chain.deployed) {
      throw new CliError(
        `no Safe at ${activeSafe} on Base — the active author '${active?.name ?? '(none)'}' names it, and \`s2s signer rotate\` rotates a Safe that is already deployed`,
        1,
        'safe_not_deployed',
      );
    }
    // The row names the Safe, so that is the Safe this run acts on, whether or
    // not its key turns out to be an owner: "that row's key is stale" is a fact
    // about the store, and `resolveOldKey` says it with the remedy. Refusing here
    // would report a missing Safe where the store names one.
    return activeSafe;
  }
  const chaser = Object.entries(store.authors).find(
    ([, record]) => record.replaces !== undefined && storedSafe(record.safe) !== undefined,
  );
  const pendingSafe = chaser === undefined ? undefined : storedSafe(chaser[1].safe);
  if (pendingSafe) return pendingSafe;

  // `activeSafe` falsy here means the active row names no Safe: the deployed-Safe
  // check above already returned for one that does.
  const why =
    active === undefined
      ? 'this machine holds no active key'
      : `the active author '${active.name}' has no Safe on file`;
  throw new UsageError(
    `${why}, and nothing is filed to replace a key on any Safe — file the Safe and its key with \`s2s signer add <safe>\``,
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
  lock: StoreLockOptions = {},
): string | undefined {
  const before = pendingReplacement(safe, path);
  let outcome: ReturnType<typeof settleReplacement>;
  try {
    outcome = settleReplacement(safe, owners, path, lock);
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
  // The row was renamed by the settle when the filed name was this CLI's own
  // `<replaces>-next`: the name to print is the row's, not the one it was filed
  // with. `replaces` is recorded on the pending row, so it names the old row even
  // when that row is no longer in the file.
  return before === undefined
    ? activeAuthorRecord(readAuthors(path))?.name
    : settledAuthorName(before.name, before.replaces);
}

/** What the locked section decided: the key out, the key in, and the swap. */
interface RotationPlan {
  oldKey: OldKey;
  /** True when the row a failed run filed is being finished, not a new key. */
  reused: boolean;
  name: string;
  /** The private key the new row holds; reported only when this run made it. */
  newPrivateKey: string;
  eoa: Address;
  mnemonic?: string;
  generated: boolean;
  tx: SafeTxInput;
  localHash: Hex;
  /** The row this run's new key replaces. */
  replaces: string;
}

/**
 * Whether a queued record is the transaction this run would propose.
 *
 * Comparing fields, not hashes: the hash the service stores is the one it
 * computed, and adoption is only safe when what it holds is the same call —
 * same target, value, calldata, operation and nonce. A record for another
 * transaction at this nonce is a collision, not a swap already queued.
 */
function sameCall(record: SafeTxRecord, tx: SafeTxInput): boolean {
  return (
    record.nonce === tx.nonce &&
    record.to.toLowerCase() === tx.to.toLowerCase() &&
    record.operation === tx.operation &&
    record.data.toLowerCase() === tx.data.toLowerCase() &&
    BigInt(record.value) === tx.value
  );
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

  refuseSafeArgument(args, 'signer rotate');
  const safe = await resolveRotateSafe(deps, rpcUrl, readAuthors(path));

  const chain = await deps.readSafe(rpcUrl, safe);
  if (!chain.deployed) {
    throw new CliError(
      `no Safe at ${safe} on Base — \`s2s signer rotate\` swaps an owner of a Safe that is already deployed`,
      1,
      'safe_not_deployed',
    );
  }

  // A lock left by a killed command is cleared, because a process that is gone
  // cannot still be mid-write. The user is told: that command may have died
  // between writing the file and printing a key, and the key it printed is worth
  // looking for. Both store transactions pass the same handler, because either
  // one may be the first to meet the leftover.
  const onStaleLock = (pid: number): void => {
    out.warn(
      `cleared the author store lock left by pid ${String(pid)}, which was not running — that command was killed before it could release the lock or finish, so if it printed a key, check the store holds it`,
    );
  };
  const lock = { onStaleLock };

  // 1. Settle first: a rotation already executed is a fact the store has to
  // catch up with before this run decides anything.
  const settled = reconcileReplacement(safe, chain.owners, out, path, lock);

  // The key this process signs with, and the layer it came from. `signer
  // confirm` resolves its key the same way, so this is also the key a confirm
  // would use — the output has to name it when it is not the old key.
  const effectiveKey = hexKey(config.privateKey);
  const effectiveFrom: OldKey['from'] = config.author?.source ?? 'store';

  // 2. The decisions and the filing are one store transaction: two rotates
  // racing would otherwise both find the same name free, file two rows, and
  // lose one printed key. The lock is the store's, not the network's — it is
  // released before the service is touched.
  const plan = withStoreLock(path, (): RotationPlan => {
    const store = readAuthors(path);

    // 3. A row that carries `proposal` is a queued swap: only executing it moves
    // the store on, so nothing about it may be re-proposed or replaced.
    const pending = pendingReplacement(safe, path);
    if (pending?.proposal !== undefined) {
      throw new CliError(
        `a replacement is already queued on ${safe}: '${pending.name}' is filed and its swap ${pending.proposal} waits to execute — \`s2s signer confirm ${pending.proposal}\` signs and executes it once the threshold is met (\`s2s signer queue\` lists it)`,
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
      if (
        flagString(args.flags, 'key') !== undefined ||
        flagString(args.flags, 'mnemonic') !== undefined
      ) {
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
      privateKey = key;
      eoa = derived;
      mnemonic = source.mnemonic;
      generated = source.generated;
      name = '';
    }

    // 4. The old key, always a row. Resolved before anything is filed and after
    // the new key is known, so a run that refuses below leaves no row behind:
    // `filedNow` is what this run would file, not what it has filed.
    const oldKey = resolveOldKey(store, safe, chain.owners);
    // The row the new row replaces: `settleReplacement` reads it as a row name,
    // so it is defined on every path that gets this far.
    const replaces = oldKey.name;
    if (pending && pending.replaces !== oldKey.name) {
      throw new CliError(
        `the filed swap on ${safe} replaces '${pending.replaces}', but the key this machine signs with (${oldKey.eoa}, from ${oldKey.source}) is filed as '${oldKey.name}' — the swap can be signed by the key it retires only; \`s2s signer queue\` shows what is queued`,
        1,
        'not_owner',
      );
    }

    // 5. Refusals, all before anything is filed.
    if (eoa.toLowerCase() === oldKey.eoa.toLowerCase()) {
      throw new CliError(
        `${eoa} is the key this machine already signs with for ${safe} — a rotation needs a different key; pass --key, or let this command generate one`,
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

    // 6. File the new row. It is PLANNED here and written once at the end, so
    // every refusal `planSignerAdd` makes — a taken `--name`, a key already filed
    // under another row, a chase already in flight — is thrown before the first
    // byte is written, and a run that refuses leaves the store byte-identical.
    let staged = store;
    if (!reused) {
      name = flagString(args.flags, 'name') ?? `${replaces}-next`;
      // The new key lands inactive: the old key is still the Safe's owner and is
      // what signs the swap and confirms it.
      staged = planSignerAdd(staged, { name, privateKey, safe, replaces }).store;
    }
    if (staged !== store) writeAuthors(staged, path);

    // 7. The predecessor comes from the Safe's own list: a mapping has no
    // reverse lookup, and asking the user for it invites a `GS005` revert.
    const prevOwner = predecessorOf(chain.owners, oldKey.eoa);
    const tx: SafeTxInput = {
      to: safe,
      value: 0n,
      data: swapOwnerData(prevOwner, oldKey.eoa, eoa),
      operation: 0,
      nonce: chain.nonce,
    };
    return {
      oldKey,
      reused,
      name,
      newPrivateKey: privateKey,
      eoa,
      ...(mnemonic === undefined ? {} : { mnemonic }),
      generated,
      tx,
      localHash: computeSafeTxHash({ chainId: deps.chainId, safe, tx }),
      replaces: replaces,
    };
  }, lock);

  const {
    oldKey,
    reused,
    name,
    eoa,
    tx,
    localHash,
    mnemonic,
    newPrivateKey,
    generated,
    replaces,
  } = plan;

  // 8. A stored row with no `proposal` is not proof that nothing was queued: a
  // POST that landed with its reply lost leaves exactly that state. Ask the
  // service what it holds at this nonce before proposing it again. The same call
  // is adopted (the hash is written and printed, which is the fact the earlier
  // run never got); a different transaction is a collision this row cannot pass.
  let alreadyQueued: Hex | undefined;
  // Set when the queue could not be read far enough to answer. It outranks
  // "not queued": the POST is skipped, because a second proposal at a nonce
  // already used is refused by the service and a swap that is queued twice is
  // worse than one that is queued late.
  let queueUnread: string | undefined;
  if (reused && config.safeTx.url.trim() !== '') {
    try {
      const listed = await deps.service(config).pending(safe);
      const same = listed.records.find((record) => sameCall(record, tx));
      if (same) {
        alreadyQueued = same.safeTxHash;
      } else {
        const atNonce = listed.records.find((record) => record.nonce === tx.nonce);
        if (atNonce) {
          throw new CliError(
            `the service already holds a different transaction for ${safe} at nonce ${String(tx.nonce)}: ${atNonce.safeTxHash} (to ${atNonce.to}) — '${name}' cannot be queued behind it, and proposing it again would be refused; \`s2s signer queue\` shows what is pending, and that hash has to execute or be cancelled first`,
            1,
            'nonce_taken',
          );
        }
        if (!listed.complete) {
          // The walk stopped at its page cap with pages unread. That is not
          // "nothing is queued": the record may be on a page nobody read.
          queueUnread = `the service did not answer with a whole queue for ${safe}, so this command cannot say whether nonce ${String(tx.nonce)} is already taken — \`s2s signer queue\` reads the same pages and says the same; execute or cancel what is there, then run this again`;
        }
      }
    } catch (err) {
      if (err instanceof CliError && err.code === 'nonce_taken') throw err;
      out.warn(
        `could not read what the service holds for ${safe} (${reasonOf(err)}) — proposing again; a swap already queued as this one is adopted by the next run`,
      );
    }
  }

  // Who posts the swap. Any owner of the Safe may, and the run already trusts
  // the effective key enough to be the one every later command signs with — so
  // when it owns the Safe it signs the swap, even if the key being retired is a
  // different row's. Otherwise the key being retired signs it: it is an owner by
  // construction, and the new key is not one until the swap executes.
  const effectiveEoa = effectiveKey === undefined ? undefined : authorEoa(effectiveKey);
  const effectiveOwns =
    effectiveEoa !== undefined &&
    chain.owners.some((owner) => owner.toLowerCase() === effectiveEoa.toLowerCase());
  let swapSigner: { privateKey: string; eoa: Address; from: OldKey['from'] } = {
    privateKey: oldKey.privateKey,
    eoa: oldKey.eoa,
    from: oldKey.from,
  };
  if (effectiveOwns && effectiveKey !== undefined) {
    swapSigner = { privateKey: effectiveKey, eoa: effectiveEoa, from: effectiveFrom };
  }

  let proposed = false;
  let safeTxHash = localHash;
  let note: string | undefined;
  if (alreadyQueued !== undefined) {
    safeTxHash = alreadyQueued;
    proposed = true;
  } else if (queueUnread !== undefined) {
    note = queueUnread;
  } else if (config.safeTx.url.trim() === '') {
    note = 'no Safe Transaction Service URL configured (safeTx.url)';
  } else {
    try {
      const service = deps.service(config);
      // Idempotent, as in `signer add`: a Safe the service does not index is
      // registered, one it knows is left alone. No `modules` — see signer-add.
      await service.register(safe, { owners: chain.owners, threshold: chain.threshold });
      // Signed by the key this run retires, not by the key it installs: the new
      // key is on the owner list only after this transaction executes, and the
      // service refuses a proposal from a sender that is not an owner.
      const signature = await privateKeyToAccount(swapSigner.privateKey as Hex).sign({
        hash: localHash,
      });
      safeTxHash = (await service.propose({ safe, sender: swapSigner.eoa, tx, signature }))
        .safeTxHash;
      proposed = true;
    } catch (err) {
      note = reasonOf(err);
    }
  }

  // The hash is what tells the next run that this row is queued rather than
  // stranded. A store write that fails here is a warning, not the proposal
  // lost: the next run asks the service and adopts the hash.
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

  // 9. `s2s signer confirm` signs with this process's effective key, which is not
  // always the old one. Name the change that closes the gap: a store row moves
  // with `author switch`, an env or project key does not — switching authors
  // there changes nothing and the confirm refuses `not_owner`.
  // Which key `confirm` will sign with is decided by the LAYER, not by the old
  // key's own row: an env or project key beats any stored row, so switching
  // authors there changes nothing and the advice has to be to unset or remove it.
  const confirmKey = effectiveKey === undefined ? undefined : authorEoa(effectiveKey);
  const confirmKeyDiffers =
    effectiveKey?.toLowerCase() !== oldKey.privateKey.toLowerCase();
  // No advice when the effective key is itself an owner: `confirm` signs with it
  // and the Safe accepts it, whatever row it came from. The gap the advice closes
  // is a confirm key the chain refuses. There is no `author switch` advice: the
  // old key is the row this run retires, and it is the active row whenever its
  // key is the one that owns the Safe, so a store-sourced confirm key that is not
  // an owner has no other row to switch to.
  const confirmFix =
    !effectiveOwns && confirmKeyDiffers && effectiveKey !== undefined && effectiveFrom !== 'store'
      ? effectiveFrom === 'env'
        ? `\`S2S_PRIVATE_KEY\` holds ${confirmKey ?? 'a key this build cannot derive'}, which does not own ${safe} — unset it so '${oldKey.name}' signs, or run confirm where that key is the one in the environment`
        : effectiveFrom === 'project'
          ? `the project config file holds ${confirmKey ?? 'a key this build cannot derive'}, which does not own ${safe} — remove it (\`s2s config unset privateKey --local\`) so '${oldKey.name}' signs`
          : `the user config file holds ${confirmKey ?? 'a key this build cannot derive'}, which does not own ${safe} — remove it (\`s2s config unset privateKey\`) so '${oldKey.name}' signs`
      : undefined;
  // At threshold 1 the proposer's signature is the whole quorum.
  const thresholdMet = chain.threshold <= 1;
  // The old key as a name and where the key came from, without saying either
  // twice: a store row's provenance IS the row.
  const oldKeyLabel =
    oldKey.from === 'store' ? `'${oldKey.name}'` : `'${oldKey.name}', key from ${oldKey.source}`;

  const sameSigner = swapSigner.eoa.toLowerCase() === oldKey.eoa.toLowerCase();
  const signerLabel = sameSigner ? `'${oldKey.name}'` : swapSigner.eoa;
  const signerLine = sameSigner
    ? []
    : [
        `signs it    : ${swapSigner.eoa} (${swapSigner.from === 'store' ? 'the active author' : sourceLabel(swapSigner.from)}) — an owner of ${safe}; the key this swap removes is ${oldKey.eoa}, so that one is retired and this one stays`,
      ];

  out.result(
    {
      action: 'signer.rotate',
      name,
      replaces,
      eoa,
      oldEoa: oldKey.eoa,
      oldKeyName: oldKey.name,
      oldKeySource: oldKey.from,
      safe,
      threshold: chain.threshold,
      owners: chain.owners,
      nonce: chain.nonce,
      safeTxHash,
      proposed,
      // Always present: the same call the service was given, so a proposal that
      // never reached it can still be made from the owner's wallet.
      safeTx: { to: safe, data: tx.data },
      ...(reused ? { reused: true } : {}),
      ...(alreadyQueued === undefined ? {} : { alreadyQueued: true }),
      ...(swapSigner.eoa.toLowerCase() === oldKey.eoa.toLowerCase()
        ? {}
        : { signedBy: swapSigner.eoa, signedBySource: swapSigner.from }),
      ...(note ? { note } : {}),
      ...(mnemonic ? { mnemonic } : {}),
      ...(generated ? { privateKey: newPrivateKey } : {}),
    },
    [
      reused
        ? `signer '${name}' was already filed — reusing the key filed by the failed run (replaces '${replaces}')`
        : `signer '${name}' filed, inactive until the swap executes (replaces '${replaces}')`,
      `eoa         : ${eoa}`,
      `old eoa     : ${oldKey.eoa} (${oldKeyLabel}, still the key that owns the swap)`,
      ...signerLine,
      `safe        : ${safe}`,
      `threshold   : ${String(chain.threshold)} (unchanged — a swap keeps it)`,
      `nonce       : ${String(chain.nonce)}`,
      `safeTxHash  : ${safeTxHash}`,
      ...(confirmFix === undefined ? [] : [`confirm key : ${confirmFix}`]),
      ...(settled ? [`settled     : ${settled} is now the key for ${safe}`] : []),
      ...(proposed
        ? [
            alreadyQueued === undefined
              ? `proposal    : queued — ${signerLabel} signed it (1 of ${String(chain.threshold)} confirmations)`
              : `proposal    : already queued — ${safeTxHash} was on the service from an earlier run whose reply never arrived, and ${signerLabel} signed it`,
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
            // No guess at the cause: the sender is an owner by construction, so
            // a failure here is transport, config or the service, never "not an
            // owner". The call itself is always worth printing.
            `              the swap is not lost: fix the cause above and run this again, or post this call from any owner of ${safe}`,
            `              to    ${safe}`,
            `              data  ${tx.data}`,
            `              nonce ${String(chain.nonce)}`,
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
    'The Safe is the one this machine files for its active author; `s2s signer add <safe>` is the command that files one.',
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
