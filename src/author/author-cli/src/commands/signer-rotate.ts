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
// The old key is whichever key this machine can sign with derives to a current
// owner, in the precedence `signer confirm` also signs by: `S2S_PRIVATE_KEY`,
// then the project config file, then the active store row, then any other row
// filed for this Safe. The output names that source, because the advice differs:
// a store row that is not active is closed by `s2s author switch`, an env or
// project key by unsetting it — switching authors changes neither. The old key
// is the proposer: the service stores a proposal's signature as its sender's
// confirmation and refuses a sender that is not an owner, so the swap is posted
// by the OLD key — even when it is not the active one — and never by the key
// that joins only when the swap executes. When the owner key lives only in the
// environment, the store has no row to record the swap against, so that key is
// filed first and the new row replaces it.
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
  addSigner,
  authorEoa,
  authorRowForKey,
  authorsFilePath,
  pendingReplacement,
  readAuthors,
  setPendingProposal,
  settleReplacement,
  withStoreLock,
  type AuthorsStore,
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
  asSafeAddress,
  defaultSignerName,
  l2Rpc,
  reasonOf,
  signerDeps,
  type SignerDeps,
} from './signer-store';

/** One row of the store that names this Safe, with the EOA its key signs as. */
interface FiledKey {
  name: string;
  privateKey: string;
  /** Undefined for a hand-edited row whose key this build cannot read. */
  eoa?: Address;
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
    rows.push({ name, privateKey: record.privateKey, eoa: authorEoa(record.privateKey) });
  }
  return rows;
}

/** The key this run swaps out, and where this process read it from. */
interface OldKey {
  privateKey: string;
  eoa: Address;
  /** The store row that holds this key, when one does. */
  name?: string;
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
 * The key to swap out, by the precedence `signer confirm` signs by.
 *
 * A key that owns the Safe is the answer whether or not a row files it: the
 * environment is where a key that owns a Safe is most often kept, and sending
 * that user to `s2s signer add` for a key that already owns the Safe is advice
 * that cannot be followed. Rows come second, the active one first, and each
 * refusal names the state that is actually true — no rows, rows whose keys this
 * build cannot read, rows none of whose keys owns the Safe.
 */
function resolveOldKey(
  store: AuthorsStore,
  safe: Address,
  owners: readonly Address[],
  privateKey: string | undefined,
  from: OldKey['from'],
): OldKey {
  const isOwner = (eoa: Address | undefined): boolean =>
    eoa !== undefined && owners.some((owner) => owner.toLowerCase() === eoa.toLowerCase());

  const effectiveEoa = privateKey === undefined ? undefined : authorEoa(privateKey);
  if (privateKey !== undefined && effectiveEoa !== undefined && isOwner(effectiveEoa)) {
    const row = authorRowForKey(store, privateKey);
    return {
      privateKey,
      eoa: effectiveEoa,
      name: row?.name,
      source: sourceLabel(from),
      from,
    };
  }

  const rows = rowsForSafe(store, safe);
  const owned = rows.filter((row) => isOwner(row.eoa));
  const chosen = owned.find((row) => row.name === store.active) ?? owned[0];
  if (chosen?.eoa) {
    return {
      privateKey: chosen.privateKey,
      eoa: chosen.eoa,
      name: chosen.name,
      source: `the store row '${chosen.name}'`,
      from: 'store',
    };
  }
  if (rows.length === 0) {
    throw new UsageError(
      `no key filed for ${safe} on this machine — file the key that is already an owner first: \`s2s signer add ${safe}\``,
    );
  }
  const unreadable = rows.filter((row) => row.eoa === undefined).map((row) => `'${row.name}'`);
  if (unreadable.length === rows.length) {
    throw new CliError(
      `the row${rows.length === 1 ? '' : 's'} filed for ${safe} hold no key this build can read: ${unreadable.join(', ')} — \`s2s author list\` shows them; fix or remove the row before rotating`,
      1,
      'not_owner',
    );
  }
  const named = rows.map((row) => `'${row.name}' (${row.eoa ?? 'unreadable key'})`).join(', ');
  throw new CliError(
    `no key filed for ${safe} is one of its owners: ${named} — \`s2s signer rotate\` swaps a key that is on the owner list`,
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
    // A Safe that is not deployed there is not "a key that does not own it":
    // saying so would send the user to look at keys for a contract that does
    // not exist. The active row named the address; that is the fact to report.
    if (!chain.deployed) {
      throw new CliError(
        `no Safe at ${activeSafe} on Base — the active author '${active?.name ?? '(none)'}' names it; pass <safe> to rotate on another one`,
        1,
        'safe_not_deployed',
      );
    }
    if (chain.owners.some((owner) => owner.toLowerCase() === activeEoa.toLowerCase())) {
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
        : `no key this machine can sign with is an owner of ${activeSafe}`;
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

/** What the locked section decided: the key out, the key in, and the swap. */
interface RotationPlan {
  oldKey: OldKey;
  /** True when the row a failed run filed is being finished, not a new key. */
  reused: boolean;
  name: string;
  /** The private key the new row holds; reported only when this run made it. */
  newPrivateKey: string;
  eoa: Address;
  /** The store's active row at decision time, for the switch advice. */
  active?: string;
  mnemonic?: string;
  generated: boolean;
  tx: SafeTxInput;
  localHash: Hex;
  /** The row filed for an owner key that only the environment held. */
  filedOldRow?: string;
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

  // One Safe per run: a second positional is a mistyped flag or a command from
  // another tool's shape, and silently rotating the first would act on a Safe
  // the user did not mean.
  if (args.positionals.length > 1) {
    throw new UsageError(
      `\`s2s signer rotate\` rotates one Safe at a time — got ${String(args.positionals.length)} arguments (${args.positionals.join(' ')}); keep one <safe>`,
    );
  }
  const target = args.positionals[0];
  const safe = target
    ? asSafeAddress(target)
    : await resolveRotateSafe(deps, rpcUrl, readAuthors(path));

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
    const oldKey = resolveOldKey(store, safe, chain.owners, effectiveKey, effectiveFrom);

    // A row that holds the old key must be filed for THIS Safe: a swap is
    // recorded against the row it retires, and `addSigner` will not file the same
    // key twice. So a key that owns this Safe while its row names another one is
    // a rotation this store cannot describe, and saying so beats a refusal from
    // `addSigner` that talks about the row's Safe as if it were a typo.
    if (oldKey.name !== undefined) {
      const row = store.authors[oldKey.name];
      if (row?.safe?.toLowerCase() !== safe.toLowerCase()) {
        throw new CliError(
          `the key that owns ${safe} (${oldKey.eoa}) is filed as '${oldKey.name}', and that row names ${row?.safe ?? 'no Safe'} — this store keeps one key under one row, so it cannot also file it for ${safe}; rotate from a machine where that key comes from the environment and no row holds it`,
          1,
          'not_owner',
        );
      }
    }

    // 3. A row that carries `proposal` is a queued swap: only executing it moves
    // the store on, so nothing about it may be re-proposed or replaced.
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
    const replaces = oldKey.name;

    if (pending) {
      // The row a failed run left is the ONLY copy of the key its swap adds,
      // and it can only be finished by the key it retires.
      if (pending.replaces !== oldKey.name) {
        throw new CliError(
          `the filed swap on ${safe} replaces '${pending.replaces}', but the key this machine signs with (${oldKey.eoa}, from ${oldKey.source}) is ${oldKey.name === undefined ? 'filed under no row' : `'${oldKey.name}'`} — the swap can be signed by the key it retires only; \`s2s signer queue ${safe}\` shows what is queued`,
          1,
          'not_owner',
        );
      }
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

    // 4. Refusals, all before anything is filed.
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

    // 5. The store records what a swap retires, so it needs a row for the old
    // key. An owner key that only the environment or a config file holds has
    // none: file it, and the new row replaces it like any other. Refusing would
    // send the user to `s2s signer add` for a key that already owns the Safe,
    // where that command refuses an owner.
    // The row the new one replaces; filed below when this machine has none.
    let replacesThis = replaces;
    // Set only when this run filed the old key, so the output can say it did.
    let filedOldRow: string | undefined;
    if (replacesThis === undefined) {
      const holder = rowsForSafe(store, safe)[0];
      if (holder) {
        throw new CliError(
          `the key that owns ${safe} comes from ${oldKey.source}, and the row '${holder.name}' filed for that Safe holds ${holder.eoa ?? 'a key this build cannot read'}, which is not one of its owners — \`s2s author rm ${holder.name}\` clears the way, or make that row's key the one you sign with`,
          1,
          'not_owner',
        );
      }
      const filed = defaultSignerName(oldKey.eoa);
      addSigner({ name: filed, privateKey: oldKey.privateKey, safe }, path);
      replacesThis = filed;
      filedOldRow = filed;
    }

    if (!reused) {
      name = flagString(args.flags, 'name') ?? `${replacesThis}-next`;
      // The new key lands inactive: the old key is still the Safe's owner and is
      // what signs the swap and confirms it.
      addSigner({ name, privateKey, safe, replaces: replacesThis }, path);
    }

    // 6. The predecessor comes from the Safe's own list: a mapping has no
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
      ...(store.active === null ? {} : { active: store.active }),
      eoa,
      ...(mnemonic === undefined ? {} : { mnemonic }),
      generated,
      tx,
      localHash: computeSafeTxHash({ chainId: deps.chainId, safe, tx }),
      ...(filedOldRow === undefined ? {} : { filedOldRow }),
      replaces: replacesThis,
    };
  });

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
    filedOldRow,
    replaces,
    active,
  } = plan;

  // 7. A stored row with no `proposal` is not proof that nothing was queued: a
  // POST that landed with its reply lost leaves exactly that state. Ask the
  // service what it holds at this nonce before proposing it again. The same call
  // is adopted (the hash is written and printed, which is the fact the earlier
  // run never got); a different transaction is a collision this row cannot pass.
  let alreadyQueued: Hex | undefined;
  if (reused && config.safeTx.url.trim() !== '') {
    try {
      const queued = await deps.service(config).pending(safe);
      const same = queued.find((record) => sameCall(record, tx));
      if (same) {
        alreadyQueued = same.safeTxHash;
      } else {
        const atNonce = queued.find((record) => record.nonce === tx.nonce);
        if (atNonce) {
          throw new CliError(
            `the service already holds a different transaction for ${safe} at nonce ${String(tx.nonce)}: ${atNonce.safeTxHash} (to ${atNonce.to}) — '${name}' cannot be queued behind it, and proposing it again would be refused; \`s2s signer queue ${safe}\` shows what is pending, and that hash has to execute or be cancelled first`,
            1,
            'nonce_taken',
          );
        }
      }
    } catch (err) {
      if (err instanceof CliError && err.code === 'nonce_taken') throw err;
      out.warn(
        `could not read what the service holds for ${safe} (${reasonOf(err)}) — proposing again; a swap already queued as this one is adopted by the next run`,
      );
    }
  }

  let proposed = false;
  let safeTxHash = localHash;
  let note: string | undefined;
  if (alreadyQueued !== undefined) {
    safeTxHash = alreadyQueued;
    proposed = true;
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
      const signature = await privateKeyToAccount(oldKey.privateKey as Hex).sign({
        hash: localHash,
      });
      safeTxHash = (await service.propose({ safe, sender: oldKey.eoa, tx, signature })).safeTxHash;
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

  // 8. `s2s signer confirm` signs with this process's effective key, which is not
  // always the old one. Name the change that closes the gap: a store row moves
  // with `author switch`, an env or project key does not — switching authors
  // there changes nothing and the confirm refuses `not_owner`.
  // Which key `confirm` will sign with is decided by the LAYER, not by the old
  // key's own row: an env or project key beats any stored row, so switching
  // authors there changes nothing and the advice has to be to unset or remove it.
  const confirmKey = effectiveKey === undefined ? undefined : authorEoa(effectiveKey);
  const confirmKeyDiffers =
    effectiveKey?.toLowerCase() !== oldKey.privateKey.toLowerCase();
  let switchTo: string | undefined;
  if (effectiveFrom === 'store' && confirmKeyDiffers) switchTo = oldKey.name;
  const confirmFix =
    confirmKeyDiffers && effectiveKey !== undefined && effectiveFrom !== 'store'
      ? effectiveFrom === 'env'
        ? `\`S2S_PRIVATE_KEY\` holds ${confirmKey ?? 'a key this build cannot derive'}, which does not own ${safe} — unset it so '${oldKey.name ?? 'the store row'}' signs, or run confirm where that key is the one in the environment`
        : effectiveFrom === 'project'
          ? `the project config file holds ${confirmKey ?? 'a key this build cannot derive'}, which does not own ${safe} — remove it (\`s2s config unset privateKey --local\`) so '${oldKey.name ?? 'the store row'}' signs`
          : `the user config file holds ${confirmKey ?? 'a key this build cannot derive'}, which does not own ${safe} — remove it (\`s2s config unset privateKey\`) so '${oldKey.name ?? 'the store row'}' signs`
      : undefined;
  // At threshold 1 the proposer's signature is the whole quorum.
  const thresholdMet = chain.threshold <= 1;
  // The old key as a name and where the key came from, without saying either
  // twice: a store row's provenance IS the row.
  const oldKeyLabel =
    oldKey.name === undefined
      ? `from ${oldKey.source}`
      : oldKey.from === 'store'
        ? `'${oldKey.name}'`
        : `'${oldKey.name}', key from ${oldKey.source}`;

  out.result(
    {
      action: 'signer.rotate',
      name,
      replaces,
      eoa,
      oldEoa: oldKey.eoa,
      ...(oldKey.name === undefined ? {} : { oldKeyName: oldKey.name }),
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
      ...(filedOldRow === undefined ? {} : { filedOldRow }),
      ...(switchTo ? { switchTo } : {}),
      ...(note ? { note } : {}),
      ...(mnemonic ? { mnemonic } : {}),
      ...(generated ? { privateKey: newPrivateKey } : {}),
    },
    [
      reused
        ? `signer '${name}' was already filed — reusing the key filed by the failed run (replaces '${replaces}')`
        : `signer '${name}' filed, inactive until the swap executes (replaces '${replaces}')`,
      ...(filedOldRow === undefined
        ? []
        : [
            `filed first : the owner key from ${oldKey.source} as '${filedOldRow}' — this store records a swap against the row it retires`,
          ]),
      `eoa         : ${eoa}`,
      `old eoa     : ${oldKey.eoa} (${oldKeyLabel}, still the key that owns the swap)`,
      `safe        : ${safe}`,
      `threshold   : ${String(chain.threshold)} (unchanged — a swap keeps it)`,
      `nonce       : ${String(chain.nonce)}`,
      `safeTxHash  : ${safeTxHash}`,
      ...(switchTo
        ? [
            `switch first: '${active ?? '(no active author)'}' is the active author, so \`s2s signer confirm\` would sign with a key that does not own ${safe}`,
            `              run \`s2s author switch ${switchTo}\` before the confirm below`,
          ]
        : confirmFix === undefined
          ? []
          : [`confirm key : ${confirmFix}`]),
      ...(settled ? [`settled     : ${settled} is now the key for ${safe}`] : []),
      ...(proposed
        ? [
            alreadyQueued === undefined
              ? `proposal    : queued — '${oldKey.name ?? oldKey.eoa}' signed it (1 of ${String(chain.threshold)} confirmations)`
              : `proposal    : already queued — ${safeTxHash} was on the service from an earlier run whose reply never arrived, and '${oldKey.name ?? oldKey.eoa}' signed it`,
            ...(thresholdMet
              ? [
                  `              that signature is in the proposal and the threshold is met: the swap is executable as soon as the service holds it`,
                  `              \`s2s signer confirm ${safeTxHash}\` sends it: nothing left to sign`,
                ]
              : [
                  `              the remaining owners run \`s2s signer confirm ${safeTxHash}\` from their own machines`,
                ]),
            `              '${oldKey.name ?? oldKey.eoa}' stops being an owner only when the swap executes, not when this proposal is filed`,
            `              proposing costs no gas; executing the swap costs gas from whichever owner sends it`,
          ]
        : [
            `proposal    : not queued — ${note ?? 'unknown error'}`,
            `              the service accepts a proposal only from an owner of ${safe}: post this call from an owner machine`,
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
