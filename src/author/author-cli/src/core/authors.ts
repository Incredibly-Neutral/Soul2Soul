// ============================================================================
// The author store — several author identities in one CLI install.
//
//   ~/.config/s2s/authors.json   (XDG_CONFIG_HOME honored), mode 0600
//   { "active": "zomi" | null,
//     "authors": { "<pet name>": { "privateKey": "0x…", "safe": "0x…" | null,
//                                "contracts"?: { "drafts", "ownerHistory", "guard" } } } }
//
// `contracts` is the install record and is OPTIONAL: rows written before the
// author contracts existed have no such field and read the same with or without
// it. It is a cache of what the chain already says (the factory index), never a
// gate — a missing or stale record costs one RPC read, nothing more.
//
// `safeSource` is the provenance of the Safe and is OPTIONAL for the same
// reason: absent means `derived`, the address predicted from the key with the
// `s2s_${eoa}` salt. `given` means the key was filed as one owner of a Safe
// that already existed (`s2s signer add`), so the stored address is the only
// authority for it and nothing here re-derives it.
//
// The pet name is the key of an insertion-ordered map, so `author list` and the
// active-reassignment in `author rm` follow the order authors were added. One
// private key belongs to exactly one pet name (the same identity under two
// names would be two rows that can never diverge).
//
// `replaces` is OPTIONAL and marks a row as FILED BUT NOT YET AN OWNER: the key
// is waiting to take over a Safe from the row it names (`s2s signer rotate`).
// Such a row shares the Safe address with the row it replaces for as long as the
// swap is unconfirmed, so the "one Safe, one author" rule has exactly this one
// exception. The marker is cleared by `settleReplacement` once the chain says
// the new key is an owner and the old one is not; until then the row is printed
// as pending, never as an owner.
//
// `proposal` is OPTIONAL and sits beside `replaces`: the `safeTxHash` the swap
// was queued under. Absent on a row that carries `replaces` means the swap was
// NEVER QUEUED (the proposal failed), which is exactly the row a retry has to
// finish rather than add a third key to. It is dropped with the marker, and it
// never decides on its own whether the swap landed — ownership does that.
//
// The store sits in the key-precedence chain between the project config and the
// user config (see core/config.ts), which is what makes `author switch` a
// one-command identity switch: no env var, no file edit.
//
// Reads are tolerant (missing/corrupt → empty store) because every command
// calls them; a broken file must not brick the CLI. Writes are atomic
// (tmp + rename) and 0600 — the file holds private keys.
//
// A row whose provenance this build cannot read (`safeSource: "Given"`, a
// typo) is kept with that value recorded, never guessed at: it is neither
// derived nor written back. Reading still works — `author list`, `rm` and
// `switch` must repair a broken file, not be blocked by it — and the refusal
// happens where the row would be used to name a Safe.
// ============================================================================

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Address, Hex } from 'viem';
import { getAddress, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { CliError, UsageError } from '../lib/errors';

/** The author-contracts addresses installed on an author's Safe. */
export interface AuthorContractsRecord {
  drafts: string | null;
  ownerHistory: string | null;
  guard: string | null;
}

/**
 * Where a record's Safe came from. Absent means `derived`.
 *
 * `derived`: the address is predicted from the key, which is the Safe's sole
 * owner (`s2s_${eoa}` salt). `given`: the address was handed to the store and
 * is read from the chain — the key is one owner among others.
 */
export type AuthorSafeSource = 'derived' | 'given';

/** One stored author: the signing key and its author Safe. */
export interface AuthorRecord {
  privateKey: string;
  /**
   * The author id: a Safe address. Predicted from the key for `derived`, the
   * stored fact for `given`; null when a derived row has never been predicted.
   */
  safe: string | null;
  /**
   * `given` when the Safe existed before this key was filed into it; absent on
   * every derived row, so rows written before this field existed read as
   * `derived` unchanged.
   */
  safeSource?: AuthorSafeSource;
  /**
   * The `safeSource` the file holds when it is neither of the above, verbatim.
   * Such a row is never derived and never written back: the only honest answer
   * to "where did this address come from" is to ask the user, and guessing
   * `derived` would derive a different Safe and then overwrite this address.
   * A store write puts the value back under `safeSource`.
   */
  unreadableSafeSource?: unknown;
  /**
   * The `@s2s/author-contracts` modules installed on that Safe, once installed.
   * Optional and absent on every row written before this field existed — the
   * record reads the same with or without it, so no migration is needed.
   */
  contracts?: AuthorContractsRecord;
  /**
   * The pet name of the row this key is meant to replace: a rotation that has
   * been proposed but not yet executed. Present only on a row that is filed but
   * is not an owner yet; `settleReplacement` clears it the moment it is one.
   */
  replaces?: string;
  /**
   * The `safeTxHash` the swap was queued under (`s2s signer rotate`). Present
   * only beside `replaces`: absent there means the row is filed but no swap was
   * ever proposed, so the next run must queue this row's swap, not file another.
   * Cleared with the marker when the swap settles.
   */
  proposal?: Hex;
  /**
   * Filed by `s2s signer add` and not yet accepted by the chain: the key is on
   * the owner list only once an owner posts the `addOwnerWithThreshold` proposal
   * and it executes. Such a row is not an owner, so `author list` prints it as
   * unconfirmed rather than claiming a share it does not have. A signer command
   * clears the marker the first time a chain read shows the key as an owner;
   * it is never set by hand.
   */
  unconfirmed?: true;
}

/** The whole store as it lives in `authors.json`. */
export interface AuthorsStore {
  active: string | null;
  authors: Record<string, AuthorRecord>;
}

/** An author together with the pet name it is filed under. */
export interface ActiveAuthor extends AuthorRecord {
  name: string;
}

/**
 * Where a resolved signing key came from. Ordered by precedence in
 * `core/config.ts`: env > project > store > user.
 */
export type AuthorKeySource = 'env' | 'project' | 'store' | 'user';

/** Pet-name shape: starts alphanumeric, then letters/digits/`._-`. */
export const PET_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Pet names stay short enough to type and to read in a table. */
export const PET_NAME_MAX_LENGTH = 64;

/** A pet name the store will accept: shape + length, nothing else. */
export function isValidPetName(name: string): boolean {
  return name.length <= PET_NAME_MAX_LENGTH && PET_NAME_PATTERN.test(name);
}

/** `<config dir>/s2s/authors.json`, honouring XDG (blank falls back to ~/.config). */
export function authorsFilePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim().length > 0 ? xdg.trim() : join(home, '.config');
  return join(base, 's2s', 'authors.json');
}

/**
 * The one normalisation stored keys go through: a key pasted as 64 bare hex
 * chars gains its `0x` prefix, so the file round-trips a form viem accepts
 * (same rule as `hexKey` in `core/config.ts`, kept local so the store does not
 * import the config layer it is read by).
 */
function normalizeKey(value: string): string {
  const trimmed = value.trim();
  return /^[0-9a-fA-F]{64}$/.test(trimmed) ? `0x${trimmed}` : trimmed;
}

function parseContracts(value: unknown): AuthorContractsRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const address = (field: unknown): string | null =>
    typeof field === 'string' && field.trim().length > 0 ? field.trim() : null;
  return {
    drafts: address(record.drafts),
    ownerHistory: address(record.ownerHistory),
    guard: address(record.guard),
  };
}

/** The provenance a row declares, when it is one this build understands. */
function parseSafeSource(value: unknown): AuthorSafeSource | undefined {
  return value === 'derived' || value === 'given' ? value : undefined;
}

/** A `safeTxHash`: exactly 32 bytes of hex, `0x` prefixed. Nothing shorter. */
function isSafeTxHash(value: string): value is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

/**
 * The proposal a row may carry, or undefined when it carries none this build
 * can read. Reading stays tolerant like the rest of the store: a hand-edited
 * non-hash reads as "never proposed", and the write paths refuse it loudly.
 */
function parseProposal(value: unknown): Hex | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return isSafeTxHash(trimmed) ? trimmed : undefined;
}

/**
 * Validate a hash a caller wants written to `name`'s row, naming the row: the
 * refusal has to say which row, because `setPendingProposal` takes the name.
 */
function assertProposal(name: string, value: string): Hex {
  const trimmed = value.trim();
  if (!isSafeTxHash(trimmed)) {
    throw new UsageError(
      `author '${name}' proposal '${value}' is not a safeTxHash — that is 32 bytes of hex (0x and 64 characters), as \`s2s signer queue\` printed it`,
    );
  }
  return trimmed;
}

function parseRecord(value: unknown): AuthorRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const privateKey = record.privateKey;
  if (typeof privateKey !== 'string' || privateKey.trim().length === 0) return undefined;
  const safe = record.safe;
  const contracts = parseContracts(record.contracts);
  const declared = record.safeSource;
  const safeSource = parseSafeSource(declared);
  const unreadable = declared !== undefined && safeSource === undefined ? declared : undefined;
  const replaces = record.replaces;
  const proposal = parseProposal(record.proposal);
  return {
    privateKey: normalizeKey(privateKey),
    safe: typeof safe === 'string' && safe.length > 0 ? safe : null,
    ...(safeSource === undefined ? {} : { safeSource }),
    ...(unreadable === undefined ? {} : { unreadableSafeSource: unreadable }),
    ...(contracts === undefined ? {} : { contracts }),
    ...(typeof replaces === 'string' && replaces.trim().length > 0
      ? { replaces: replaces.trim() }
      : {}),
    ...(proposal === undefined ? {} : { proposal }),
    ...(record.unconfirmed === true ? { unconfirmed: true as const } : {}),
  };
}

/**
 * Whether the record's Safe was given to the store rather than derived from the
 * key. The one place `'given'` is spelled, so no caller compares the string.
 */
export function isGivenSafe(record: AuthorRecord | undefined): boolean {
  return record?.safeSource === 'given';
}

/**
 * The stored Safe address of a `given` record, or undefined for a derived one
 * (including every row written before `safeSource` existed).
 */
export function givenSafeOf(record: AuthorRecord | undefined): Address | undefined {
  if (!isGivenSafe(record) || !record?.safe) return undefined;
  return record.safe as Address;
}

/** The address a record names, when it holds one this build can read. */
function recordSafe(record: AuthorRecord): string | undefined {
  const value = record.safe;
  return typeof value === 'string' && isAddress(value) ? value : undefined;
}

/** `givenSafeOf` by pet name, for a caller holding a name rather than a record. */
export function givenSafeByName(data: AuthorsStore, name: string): Address | undefined {
  return givenSafeOf(findAuthor(data, name));
}

/**
 * The row a private key is filed under, by key rather than by active slot.
 *
 * A `given` Safe belongs to the key, not to the pet name that happens to be
 * selected: filing `signer1` into an existing Safe and then switching to
 * `zomi` must not hand `signer1`'s key a derived Safe to deploy. Keys are
 * unique (`addAuthor` / `addSigner` enforce it), so the first match is the one.
 */
export function authorRowForKey(data: AuthorsStore, privateKey: string): ActiveAuthor | undefined {
  const needle = normalizeKey(privateKey).toLowerCase();
  for (const [name, record] of Object.entries(data.authors)) {
    if (record.privateKey.toLowerCase() === needle) return { name, ...record };
  }
  return undefined;
}

/**
 * Why this row cannot name a Safe, or undefined when it can.
 *
 * Reading stays tolerant; this is the loud half, called where the row is about
 * to decide an author id. An unreadable provenance always refuses, and a
 * `given` row always refuses without a usable address: both would otherwise
 * fall through to the derivation and deploy a Safe the key was never filed
 * into. A derived row's cached address is not checked — it is a prediction,
 * and re-deriving it is the repair.
 */
export function safeProblem(
  name: string,
  record: AuthorRecord,
  path: string = authorsFilePath(),
): string | undefined {
  const where = `authors file ${path}: author '${name}'`;
  if (record.unreadableSafeSource !== undefined) {
    const shown =
      JSON.stringify(record.unreadableSafeSource) ?? String(record.unreadableSafeSource);
    return `${where} has safeSource ${shown} — the only values are 'derived', 'given', or no safeSource at all; fix or remove that row`;
  }
  if (!isGivenSafe(record)) return undefined;
  if (record.safe === null) {
    return `${where} is marked as given but carries no Safe address — put the Safe's address in that row`;
  }
  if (!isAddress(record.safe)) {
    return `${where} has safe ${record.safe} — that is not an address; fix or remove that row`;
  }
  return undefined;
}

/** Read the store tolerantly — missing, unparsable or malformed → empty store. */
export function readAuthors(path: string = authorsFilePath()): AuthorsStore {
  const empty: AuthorsStore = { active: null, authors: {} };
  if (!path) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return empty;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;

  const raw = parsed as Record<string, unknown>;
  const authors: Record<string, AuthorRecord> = {};
  const rawAuthors = raw.authors;
  if (rawAuthors !== null && typeof rawAuthors === 'object' && !Array.isArray(rawAuthors)) {
    for (const [name, value] of Object.entries(rawAuthors as Record<string, unknown>)) {
      const record = parseRecord(value);
      // A hand-edited file with an unusable name or record is skipped, not
      // fatal: the rest of the store still works, and so does `author rm`.
      if (record !== undefined && isValidPetName(name)) authors[name] = record;
    }
  }

  // `active` resolves case-insensitively, like every other name lookup: a
  // hand-edited "ZOMI" still points at the stored `zomi`.
  const rawActive = raw.active;
  const active =
    typeof rawActive === 'string'
      ? (findAuthorName({ active: null, authors }, rawActive) ?? null)
      : null;
  return { active, authors };
}

/**
 * Write the store atomically (tmp + rename) at mode 0600. Returns the path.
 *
 * The tmp name is unique per process and write: a fixed `${path}.tmp` lets two
 * concurrent invocations interleave, and a crash would leave a sidecar holding
 * a private key.
 */
export function writeAuthors(data: AuthorsStore, path: string = authorsFilePath()): string {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  // `unreadableSafeSource` is a reading of the file, not part of the format:
  // the value goes back under `safeSource` so a row the user must repair reads
  // the same after any write. Dropping it would turn the row into `derived`.
  const authors = Object.fromEntries(
    Object.entries(data.authors).map(([name, record]) => {
      const { unreadableSafeSource, ...stored } = record;
      return [
        name,
        unreadableSafeSource === undefined
          ? stored
          : { ...stored, safeSource: unreadableSafeSource as AuthorSafeSource },
      ];
    }),
  );
  const next = { active: data.active, authors };
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // nothing to clean up
    }
    throw err;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // perms are best-effort (e.g. some filesystems)
  }
  return path;
}

/**
 * The store's exclusive lock: `<store>.lock`, created with `wx`, holding the
 * writer's pid.
 *
 * `writeAuthors` is atomic per write, but every mutation is a read-modify-write
 * of the whole file, so two commands racing lose one of the two updates — the
 * duplicate-name check passes in both, both file a row, and one printed key is
 * gone with the overwritten copy of the file. The lock covers the read and the
 * write together.
 *
 * The pid is what makes a leftover lock recoverable without guessing: `kill(pid,
 * 0)` says whether the writer that made it still exists. A dead writer's lock is
 * taken over (the holder cannot still be mid-write — it is gone), and the caller
 * is told. A live writer, or a lock whose pid cannot be read, is refused with
 * the pid it holds. There is no timeout: "old enough to steal" is how a live
 * writer's file gets overwritten.
 */
export function storeLockPath(path: string): string {
  return `${path}.lock`;
}

/** Paths this process already holds, so a nested call re-enters instead of
 * deadlocking against its own lock. */
const heldLocks = new Set<string>();

/** Whether a pid is running: `true`, `false` for a process that is gone, and
 * `undefined` when this process may not ask (`EPERM` means alive). */
function processAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return undefined;
  }
}

/** What a lock file says right now. */
type LockRead =
  /** It names a pid. */
  | { state: 'pid'; pid: number }
  /** It exists but names no pid: a holder that has created it and not written yet. */
  | { state: 'empty' }
  /** It was released between our open and our read. */
  | { state: 'gone' }
  /** It exists and cannot be read at all: a different failure, and a different fix. */
  | { state: 'unreadable'; code: string };

function readLock(lock: string): LockRead {
  let text: string;
  try {
    text = readFileSync(lock, 'utf8').trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    // Only "not there" is gone. EACCES, EISDIR, EIO: the file is there and this
    // process cannot read it, which is not a writer mid-write and not a
    // leftover — deleting it would be guessing, and `onStaleLock` would be a lie.
    return code === 'ENOENT' ? { state: 'gone' } : { state: 'unreadable', code };
  }
  return /^[0-9]+$/.test(text) ? { state: 'pid', pid: Number.parseInt(text, 10) } : { state: 'empty' };
}

/** A sleep that works inside a synchronous function: the lock cannot await. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** How long to wait for a lock that exists but names no pid yet, and how often. */
const LOCK_READ_ATTEMPTS = 10;
const LOCK_READ_WAIT_MS = 25;

/**
 * The pid a lock names, waiting out the window between `open(..., 'wx')` and the
 * holder's `write` of its pid.
 *
 * An empty file is a live holder mid-write, not a leftover: `open` creates it and
 * the pid goes in the next statement, so a reader can catch it empty for a
 * moment. Concluding "no pid, therefore stale" from that moment is how a live
 * writer's lock gets deleted. A lock that is *still* empty after the retry is
 * therefore treated as held, never as stolen.
 */
function lockPid(lock: string): LockRead {
  for (let attempt = 0; attempt < LOCK_READ_ATTEMPTS; attempt += 1) {
    const read = readLock(lock);
    if (read.state !== 'empty') return read;
    if (attempt + 1 < LOCK_READ_ATTEMPTS) sleepSync(LOCK_READ_WAIT_MS);
  }
  return { state: 'empty' };
}

export interface StoreLockOptions {
  /**
   * Called when a lock left by a dead process is taken over, with that pid. The
   * write still happens; the user is told whose leftover was cleared, because a
   * recovered lock is evidence that an earlier command was killed mid-write.
   */
  onStaleLock?: (pid: number) => void;
}

/**
 * Claim a lock left by a dead process, or leave the store alone.
 *
 * The leftover is renamed to a private path first. Two processes that both saw
 * the same dead pid both try; exactly one rename succeeds on a given file and
 * the other sees ENOENT and goes back to `open`, which is correct whether or
 * not the winner has finished. This is what makes the takeover safe without a
 * lock library: a `rm` could delete a lock that a third process created in
 * between, because reading and removing are two steps.
 *
 * The renamed file is read once more. If it is not the dead pid this attempt
 * judged — another process released the leftover and created its own lock in
 * between — it is put back with `link`, which fails rather than overwriting a
 * lock that appeared in the meantime, and this run refuses. The window is small
 * and it is stated, not hidden: a lock this build cannot prove is stale is never
 * deleted.
 */
function takeOverStaleLock(
  lock: string,
  pid: number,
  attempt: number,
  options: StoreLockOptions,
): void {
  const claimed = `${lock}.${String(process.pid)}.${String(attempt)}`;
  try {
    renameSync(lock, claimed);
  } catch (err) {
    // ENOENT: another process moved it first, or its owner released it.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const moved = readLock(claimed);
  if (moved.state !== 'pid' || moved.pid !== pid) {
    // Not the leftover: put it back where its owner expects it. `link` cannot
    // overwrite a lock created in between, so this cannot lose one.
    let restored = true;
    try {
      linkSync(claimed, lock);
    } catch {
      restored = false;
    }
    try {
      rmSync(claimed, { force: true });
    } catch {
      // nothing else to do; the message below names the path
    }
    throw new CliError(
      restored
        ? `the author store lock ${lock} changed while it was being cleared — another s2s command took it; run this again`
        : `the author store lock ${lock} changed while it was being cleared, and the file this run moved is at ${claimed} — another s2s command is writing; put that file back as ${lock} only once no s2s command is running`,
      1,
      'store_locked',
    );
  }
  try {
    rmSync(claimed, { force: true });
    options.onStaleLock?.(pid);
  } catch (err) {
    throw new CliError(
      `cleared the author store lock left by pid ${String(pid)}, but the file this run moved to ${claimed} could not be removed (${(err as NodeJS.ErrnoException).code ?? 'unknown'}) — delete it by hand`,
      1,
      'store_locked',
    );
  }
}

/** Why the lock could not be taken, said for the state the file is actually in. */
function lockRefusal(holder: LockRead, path: string, lock: string): string {
  switch (holder.state) {
    case 'pid':
      return `another s2s command (pid ${String(holder.pid)}) is writing the author store at ${path} — the lock ${lock} is held by a process that is still running; let it finish rather than deleting the lock`;
    case 'unreadable':
      return `the author store lock ${lock} exists and this process cannot read it (${holder.code}), so it cannot tell whether another s2s command is writing ${path} — fix the permissions or ownership of that file; deleting it is safe only once no s2s command is running`;
    case 'empty':
      return `another s2s command is writing the author store at ${path} — the lock ${lock} exists and names no pid, which is what a writer looks like for the moment between creating the lock and writing its pid; if no s2s command is running, the lock is a leftover and can be deleted`;
    case 'gone':
      // Unreachable: the caller retries the open for this state.
      return `the author store at ${path} is unlocked now — run this again`;
  }
}

/**
 * Run `fn` holding the store lock at `path`.
 *
 * The lock is created beside the store and removed on every exit, including a
 * throw, so a refusal leaves nothing behind. Re-entrant within the process:
 * a command may file two rows in one run.
 */
export function withStoreLock<T>(path: string, fn: () => T, options: StoreLockOptions = {}): T {
  if (heldLocks.has(path)) return fn();
  mkdirSync(dirname(path), { recursive: true });
  const lock = storeLockPath(path);
  let fd: number | undefined;
  // A few attempts, not a spin: the first may clear a dead writer's lock, the
  // next can lose the race to another process doing the same thing, and that
  // process is then alive and refused by pid.
  for (let attempt = 0; fd === undefined && attempt < 3; attempt += 1) {
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = lockPid(lock);
      if (holder.state === 'gone') continue;
      if (holder.state === 'pid' && processAlive(holder.pid) === false) {
        // The writer is gone: its lock is a leftover, not a claim. Claim the
        // leftover by MOVING it to a private name. `rename` is atomic and only
        // one process can move a given file: the loser gets ENOENT and retries
        // the open instead of deleting a lock somebody else now holds.
        takeOverStaleLock(lock, holder.pid, attempt, options);
        continue;
      }
      throw new CliError(lockRefusal(holder, path, lock), 1, 'store_locked');
    }
  }
  if (fd === undefined) {
    throw new CliError(
      `could not take the author store lock ${lock} — another process kept re-creating it; try again`,
      1,
      'store_locked',
    );
  }
  heldLocks.add(path);
  try {
    writeSync(fd, `${String(process.pid)}\n`);
    return fn();
  } finally {
    heldLocks.delete(path);
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    try {
      rmSync(lock, { force: true });
    } catch {
      // the lock is advisory; a leftover file is reported by the next run
    }
  }
}

/**
 * Whether this row is filed but not yet an owner: it is waiting on a rotation.
 * A pending row is never described as an owner, and never holds the active slot
 * on the strength of the Safe it shares with the row it replaces.
 */
export function isPendingReplacement(record: AuthorRecord | undefined): boolean {
  return record?.replaces !== undefined;
}

/**
 * What a row is, for a caller printing it: `pending` until the chain moves the
 * share across, `unconfirmed` for a joining key the chain has not accepted yet,
 * `owner` once it has (or for a row that never chased one).
 */
export function ownershipOf(record: AuthorRecord): 'owner' | 'pending' | 'unconfirmed' {
  if (isPendingReplacement(record)) return 'pending';
  return record.unconfirmed === true ? 'unconfirmed' : 'owner';
}

/** One row of `author list`, with the pending marker taken into account. */
export interface AuthorRow {
  name: string;
  eoa: string | null;
  safe: string | null;
  active: boolean;
  /**
   * `pending` for a row filed by `replaces`, `unconfirmed` for a joining key
   * `signer add` filed and no owner has added yet, `owner` otherwise.
   */
  ownership: 'owner' | 'pending' | 'unconfirmed';
  /** True on a `pending` row only: the row it intends to replace. */
  unconfirmed?: true;
  /** The row it intends to replace; absent on an owner row. */
  replaces?: string;
}

/**
 * Every stored author as `author list` prints it. A row carrying `replaces` is
 * marked `pending` and keeps its marker: printing it as an owner would tell the
 * user a key signs for a Safe it is not an owner of, and `s2s signer confirm …`
 * on that belief cannot work.
 */
export function authorRows(store: AuthorsStore): AuthorRow[] {
  return Object.entries(store.authors).map(([name, record]) => ({
    name,
    eoa: authorEoa(record.privateKey) ?? null,
    safe: record.safe,
    active: name === store.active,
    ownership: ownershipOf(record),
    ...(record.replaces === undefined ? {} : { replaces: record.replaces }),
    ...(record.unconfirmed === true ? { unconfirmed: true as const } : {}),
  }));
}

/** The active author's record, or undefined when there is no usable active entry. */
export function activeAuthorRecord(data: AuthorsStore): ActiveAuthor | undefined {
  const name = data.active;
  if (!name) return undefined;
  const record = data.authors[name];
  if (!record) return undefined;
  return { name, ...record };
}

/**
 * Case-insensitive lookup: the stored spelling of `name`, or undefined. Names
 * are unique case-insensitively, so `zomi` and `Zomi` are one author.
 */
export function findAuthorName(data: AuthorsStore, name: string): string | undefined {
  if (Object.hasOwn(data.authors, name)) return name;
  const needle = name.toLowerCase();
  return Object.keys(data.authors).find((key) => key.toLowerCase() === needle);
}

/** The pet name a private key is already filed under, or undefined. */
export function findAuthorByKey(data: AuthorsStore, privateKey: string): string | undefined {
  const needle = normalizeKey(privateKey).toLowerCase();
  return Object.keys(data.authors).find(
    (key) => data.authors[key]?.privateKey.toLowerCase() === needle,
  );
}

/** Case-insensitive lookup of an author, carrying its stored spelling. */
export function findAuthor(data: AuthorsStore, name: string): ActiveAuthor | undefined {
  const key = findAuthorName(data, name);
  if (!key) return undefined;
  const record = data.authors[key];
  if (!record) return undefined;
  return { name: key, ...record };
}

/**
 * Add an author and make it active (a new author is the one you want next).
 *
 * Uniqueness lives here, not in `author new`, so any caller gets it: a pet name
 * is unique case-insensitively and one key belongs to one name.
 */
export function addAuthor(
  data: AuthorsStore,
  name: string,
  privateKey: string,
  safe: string | null,
): AuthorsStore {
  if (!isValidPetName(name)) {
    throw new UsageError(`invalid author name '${name}'`);
  }
  const existing = findAuthorName(data, name);
  if (existing) {
    throw new UsageError(
      `author '${existing}' already exists — pick another name, or \`s2s author rm ${existing}\` first`,
    );
  }
  const owner = findAuthorByKey(data, privateKey);
  if (owner) {
    throw new UsageError(
      `that private key already belongs to author '${owner}' — one key, one author`,
    );
  }
  return {
    active: name,
    authors: { ...data.authors, [name]: { privateKey: normalizeKey(privateKey), safe } },
  };
}

/** What `addSigner` files: a name, the key, and the Safe it gains a share in. */
export interface AddSignerInput {
  name: string;
  privateKey: string;
  /** The existing Safe. Checked as an address and stored checksummed. */
  safe: string;
  /**
   * The pet name of the row this key is meant to replace (`s2s signer rotate`).
   * The row is filed WITHOUT the active slot and WITHOUT being an owner: it is
   * a chase, not a membership, until `settleReplacement` sees the swap land.
   */
  replaces?: string;
  /**
   * The `safeTxHash` the swap was queued under, when the caller has it already
   * (`s2s signer rotate` files and queues in one run). Omitted means the row is
   * filed only: a swap that has to be proposed later, by `setPendingProposal`.
   */
  proposal?: Hex;
  /**
   * Whether the row takes the active slot. Defaults to true, which is right for
   * a key that is already an owner: the store's active row is what every command
   * signs with, and the key that just proved ownership should be it.
   *
   * `s2s signer add` on a *joining* key passes false: that key is not an owner
   * until an owner posts the proposal and the swap… (there is no swap for an
   * add) executes. Making it active would point every later command at a key the
   * chain does not recognise, and `signer confirm` would refuse it `not_owner`
   * with no hint that the active slot is the reason.
   */
  activate?: boolean;
}

/** A row filed for a Safe that is waiting to become one of its owners. */
export interface PendingReplacement {
  name: string;
  replaces: string;
  /**
   * The hash the swap was queued under. Absent means filed only, never
   * proposed: the row is stranded and a retry has to queue it, not replace it.
   */
  proposal?: Hex;
}

/**
 * Every row of `data` filed for `safe` that still carries `replaces`. More than
 * one is refused by `addSigner` (one chase at a time); a hand-edited file can
 * hold two, and then the first in file order is the one that settles.
 */
function pendingRowsIn(data: AuthorsStore, safe: Address): ActiveAuthor[] {
  const needle = safe.toLowerCase();
  return Object.entries(data.authors)
    .filter(([, record]) => record.replaces !== undefined && record.safe?.toLowerCase() === needle)
    .map(([name, record]) => ({ name, ...record }));
}

/** The row filed to replace `name`, while its swap is still queued. */
function chaserOf(data: AuthorsStore, name: string): ActiveAuthor | undefined {
  const needle = name.toLowerCase();
  for (const [candidate, record] of Object.entries(data.authors)) {
    if (record.replaces?.toLowerCase() === needle) {
      return { name: candidate, ...record };
    }
  }
  return undefined;
}

/**
 * The row filed for `safe` that is waiting to become an owner of it, read from
 * `data`: the pet name, the row it intends to replace, and the hash its swap was
 * queued under when one was. Two states a caller must tell apart: a `proposal`
 * means the swap is queued and only has to execute; no `proposal` means the row
 * is filed and stranded, and queuing it is the next step.
 */
export function pendingReplacementIn(
  data: AuthorsStore,
  safe: Address,
): PendingReplacement | undefined {
  const row = pendingRowsIn(data, safe)[0];
  if (!row?.replaces) return undefined;
  return {
    name: row.name,
    replaces: row.replaces,
    ...(row.proposal === undefined ? {} : { proposal: row.proposal }),
  };
}

/**
 * `pendingReplacementIn` against the store on disk: the pending row for `safe`,
 * or undefined when nothing is chasing it.
 */
export function pendingReplacement(
  safe: Address,
  path: string = authorsFilePath(),
): PendingReplacement | undefined {
  return pendingReplacementIn(readAuthors(path), safe);
}

/**
 * File a key as one owner of a Safe that already exists, and make it active.
 *
 * This is the `given` counterpart of `addAuthor`: the Safe is not predicted
 * from the key, so the record carries the address plus `safeSource: 'given'`
 * and every later read of the author id takes the address from the store. The
 * key is the one thing added here; the share on chain is the owners' business
 * (`s2s signer queue` proposes it).
 *
 * Uniqueness covers all three collisions a `given` row can make: a pet name
 * (case-insensitively), a key already filed elsewhere, and a Safe another
 * record already names — two rows pointing at one Safe would be two active
 * identities for one address.
 *
 * The Safe must be an address, checksummed on the way in: a typo would
 * otherwise make every later read throw. Whether the key is an owner of it is
 * a chain fact this file cannot know (the key is usually added to the owners
 * afterwards, by `s2s signer queue`), so the writes that need it check it there.
 */
export function addSigner(input: AddSignerInput, path: string = authorsFilePath()): ActiveAuthor {
  // Read-modify-write of the whole file: the uniqueness checks below are only
  // checks if no other process writes between them and the write.
  return withStoreLock(path, () => addSignerLocked(input, path));
}

function addSignerLocked(input: AddSignerInput, path: string): ActiveAuthor {
  const { store, row } = planSignerAdd(readAuthors(path), input);
  writeAuthors(store, path);
  return row;
}

/**
 * The store `addSigner` would write, and the row it would return — without
 * writing.
 *
 * Every check `addSigner` makes runs here, so a caller that files two rows in
 * one run can plan both before the first write: a refusal from the second (a
 * taken name, a key already filed, a chase already in flight) then leaves the
 * store byte-identical instead of half-written. The caller holds the store lock.
 */
export function planSignerAdd(
  store: AuthorsStore,
  input: AddSignerInput,
): { store: AuthorsStore; row: ActiveAuthor } {
  const { name, privateKey, safe, replaces } = input;
  if (!isValidPetName(name)) {
    throw new UsageError(`invalid author name '${name}'`);
  }
  // A proposal without a row to replace describes no swap, and writing it would
  // put a hash on a row no caller ever reads one from.
  if (input.proposal !== undefined && replaces === undefined) {
    throw new UsageError(
      `author '${name}' cannot carry a proposal without \`replaces\` — a swap is queued for a row that is taking over another one`,
    );
  }
  const proposal = input.proposal === undefined ? undefined : assertProposal(name, input.proposal);
  // Strict checksum: a mixed-case address with a broken checksum is a
  // transcription error, and storing it would put a typo in the record.
  if (!isAddress(safe.trim())) {
    throw new UsageError(
      `'${safe}' is not an address — \`s2s signer add\` needs the Safe's 0x… address`,
    );
  }
  const address = getAddress(safe.trim());
  const existing = findAuthorName(store, name);
  if (existing) {
    throw new UsageError(
      `author '${existing}' already exists — pick another name, or \`s2s author rm ${existing}\` first`,
    );
  }
  const keyOwner = findAuthorByKey(store, privateKey);
  if (keyOwner) {
    throw new UsageError(
      `that private key already belongs to author '${keyOwner}' — one key, one author`,
    );
  }
  // The row this key is meant to replace: it has to exist, it has to be filed
  // for this Safe, and it cannot itself be a chase (a chain of pending rows has
  // no owner at its head for `settleReplacement` to test against).
  const target = replaces === undefined ? undefined : findAuthor(store, replaces);
  if (replaces !== undefined && !target) {
    throw new UsageError(
      `no author '${replaces}' to replace — \`s2s author list\` shows the rows that exist`,
    );
  }
  if (target && target.safe?.toLowerCase() !== address.toLowerCase()) {
    throw new UsageError(
      `author '${target.name}' is filed for safe ${target.safe ?? '(none)'}, not ${address} — a replacement names the row that holds the Safe it is taking over`,
    );
  }
  if (target?.replaces !== undefined) {
    throw new UsageError(
      `author '${target.name}' is itself a pending replacement (→ replaces '${target.replaces}') — name the row that holds the Safe`,
    );
  }

  // One chase at a time: a second pending row for this Safe would mean two keys
  // being swapped in at once, and `settleReplacement` could not say which one
  // the chain landed.
  const chasing = pendingReplacementIn(store, address);
  if (chasing) {
    throw new UsageError(
      `safe ${address} already has a pending replacement under author '${chasing.name}' (→ replaces '${chasing.replaces}') — one chase at a time; \`s2s author rm ${chasing.name}\` drops it`,
    );
  }

  const safeOwner = Object.entries(store.authors).find(
    ([, record]) => record.safe?.toLowerCase() === address.toLowerCase(),
  );
  // A rotation files a SECOND row for one Safe on purpose: the row being
  // replaced is the only row allowed to hold that address alongside this one.
  if (safeOwner && safeOwner[0] !== target?.name) {
    throw new UsageError(
      `safe ${address} is already filed under author '${safeOwner[0]}' — one Safe, one author`,
    );
  }

  // A row filed for a key the chain has not accepted is marked as such: nothing
  // else in the store records it, and `author list` would otherwise print a
  // joining key as an owner of a Safe that never heard of it. A replacement row
  // needs no marker of its own — `replaces` is already one.
  const unconfirmed = target === undefined && input.activate === false;
  const record: AuthorRecord = {
    privateKey: normalizeKey(privateKey),
    safe: address,
    safeSource: 'given',
    ...(target ? { replaces: target.name } : {}),
    ...(proposal === undefined ? {} : { proposal }),
    ...(unconfirmed ? { unconfirmed: true as const } : {}),
  };
  // A replacement row is filed WITHOUT the active slot, and so is a joining key
  // the caller marked `activate: false`. The active row is what every command
  // signs with, so activating a key that is not an owner yet would hand
  // `s2s signer confirm` a key the chain does not recognise. The slot moves in
  // `settleReplacement`, on the evidence, or stays where it was.
  const active = target !== undefined || input.activate === false ? store.active : name;
  return {
    store: { active, authors: { ...store.authors, [name]: record } },
    row: { name, ...record },
  };
}

/**
 * Record (or replace) the `safeTxHash` the pending row's swap was queued under.
 *
 * `addSigner` files the row and `s2s signer queue` proposes the swap as two
 * steps, and the second one can fail: the row then exists with no proposal, and
 * re-running the rotation would file a THIRD key instead of finishing the
 * second. The hash is the fact that says which of the two states the row is in,
 * so it is written here, after the queue, and the caller uses its presence to
 * decide whether to propose again.
 *
 * Only a pending replacement holds a swap, so a row that is not chasing another
 * one is refused by name rather than given a meaningless hash. Returns the row
 * as it now reads.
 */
export function setPendingProposal(
  name: string,
  safeTxHash: Hex,
  path: string = authorsFilePath(),
): ActiveAuthor {
  return withStoreLock(path, () => setPendingProposalLocked(name, safeTxHash, path));
}

function setPendingProposalLocked(name: string, safeTxHash: Hex, path: string): ActiveAuthor {
  const store = readAuthors(path);
  const key = findAuthorName(store, name);
  const current = key === undefined ? undefined : store.authors[key];
  if (key === undefined || current === undefined) {
    throw new UsageError(`no author '${name}' — \`s2s author list\` shows the rows that exist`);
  }
  if (!isPendingReplacement(current)) {
    throw new UsageError(
      `author '${key}' is not a pending replacement — only a row filed to take over another one records a queued swap`,
    );
  }
  const record: AuthorRecord = { ...current, proposal: assertProposal(key, safeTxHash) };
  writeAuthors({ active: store.active, authors: { ...store.authors, [key]: record } }, path);
  return { name: key, ...record };
}

/** What `settleReplacement` found, and therefore what the caller may say. */
export type ReplacementOutcome = 'none' | 'pending' | 'settled' | 'collision';

/**
 * The moment a filed replacement becomes an owner, decided from the on-chain
 * owner list and nothing else.
 *
 * `none` — no row is chasing this Safe. `pending` — the old key is still an
 * owner and the new one is not: the swap has not landed, both rows stay and the
 * chase goes on. `settled` — the new key is an owner and the old one is not: the
 * old row is removed, the marker cleared and the newcomer made active, in one
 * write. `collision` — both keys are owners, or neither is: nothing is touched
 * and the caller warns, because no amount of waiting moves either state on.
 *
 * Ownership is the whole test, and a replaced row that is missing from the file
 * is no old key at all: the chase settles as soon as the newcomer is an owner,
 * and is a collision until then. (A missing row used to pin the marker at
 * `pending` for ever — nothing else can clear it.) Both EOAs are derived from
 * the stored private keys; a row whose key cannot be derived is no evidence at
 * all, so it stays `pending` rather than resolving on a name alone.
 *
 * The queued `proposal` is not evidence either: a row holding one is still
 * settled on ownership, and the hash is dropped with the marker in the same
 * write. A collision writes nothing, so both survive — nothing has landed, and
 * the hash is what lets the caller execute the queue rather than propose it
 * again.
 *
 * The settled row carries the author's name, not the one a rotation picked to
 * keep two rows apart: see `settledAuthorName`.
 */
export function settleReplacement(
  safe: Address,
  owners: readonly Address[],
  path: string = authorsFilePath(),
  options: StoreLockOptions = {},
): ReplacementOutcome {
  // The settle path removes a row and activates another in one write; a second
  // command holding a copy of the store would write that removal back.
  return withStoreLock(path, () => settleReplacementLocked(safe, owners, path), options);
}

/**
 * Clear the `unconfirmed` marker from every row for `safe` whose key the owner
 * list now holds, and return the store as it stands afterwards.
 *
 * `signer add` files a joining key unconfirmed because no chain read has agreed
 * with it yet. The marker is a fact about the chain, so it is dropped wherever
 * the owner list is in hand — settle, queue and confirm all reach this. A marker
 * cleared by hand would be a claim nobody checked; a marker that outlives the
 * owner list would call a key a stranger after it joined.
 *
 * Caller holds the store lock.
 */
function sweepConfirmedLocked(
  safe: Address,
  owners: readonly Address[],
  path: string,
): AuthorsStore {
  const store = readAuthors(path);
  const cleared: Record<string, AuthorRecord> = {};
  for (const [name, record] of Object.entries(store.authors)) {
    if (record.unconfirmed !== true) continue;
    if (recordSafe(record)?.toLowerCase() !== safe.toLowerCase()) continue;
    const eoa = authorEoa(record.privateKey);
    if (!eoa || !owners.some((owner) => owner.toLowerCase() === eoa.toLowerCase())) continue;
    const rest: AuthorRecord = { ...record };
    delete rest.unconfirmed;
    cleared[name] = rest;
  }
  if (Object.keys(cleared).length === 0) return store;
  const swept: AuthorsStore = { active: store.active, authors: { ...store.authors, ...cleared } };
  writeAuthors(swept, path);
  return swept;
}

/**
 * Clear `unconfirmed` from the rows for `safe` the chain now lists as owners.
 * For a command that read the owner list but is not settling a replacement, so
 * a key that joined is reported as an owner the moment that is true.
 */
export function sweepConfirmedSigners(
  safe: Address,
  owners: readonly Address[],
  path: string = authorsFilePath(),
  options: StoreLockOptions = {},
): void {
  // A command that only listed the queue must not create a store to report that
  // there is nothing in it.
  if (!existsSync(path)) return;
  withStoreLock(path, () => sweepConfirmedLocked(safe, owners, path), options);
}

/**
 * The name a settled replacement takes: the author's, unless the operator named
 * the key.
 *
 * Two rows for one author exist only while both keys do. A rotation files the
 * newcomer as `<replaces>-next` because the store cannot hold two rows under one
 * name, and that suffix is this CLI's choice, not a name the author carries: once
 * the old row is gone there is one key again, and calling it `harry-next` would
 * keep a fact about a swap nobody can undo. An explicit `--name` is the
 * operator's choice and survives settlement.
 */
export function settledAuthorName(filed: string, replaces: string): string {
  return filed === `${replaces}-next` ? replaces : filed;
}

function settleReplacementLocked(
  safe: Address,
  owners: readonly Address[],
  path: string,
): ReplacementOutcome {
  const isOwnerOf = (eoa: Address): boolean =>
    owners.some((owner) => owner.toLowerCase() === eoa.toLowerCase());

  const store = sweepConfirmedLocked(safe, owners, path);

  const chasing = pendingRowsIn(store, safe)[0];
  if (!chasing?.replaces) return 'none';

  const newEoa = authorEoa(chasing.privateKey);
  if (!newEoa) return 'pending';
  // The row being replaced may be gone from the file (`author rm` under an
  // older build, a hand edit). Then there is no old key in this store, so the
  // old half of the test is answered `no` and the newcomer decides alone.
  const oldRow = findAuthor(store, chasing.replaces);
  const oldEoa = oldRow ? authorEoa(oldRow.privateKey) : undefined;
  if (oldRow && !oldEoa) return 'pending';

  const newIsOwner = isOwnerOf(newEoa);
  const oldIsOwner = oldEoa !== undefined && isOwnerOf(oldEoa);

  if (newIsOwner && oldIsOwner) return 'collision';
  // Neither key is an owner: the old one left the list without the swap
  // putting the new one there, so waiting is not a plan — the caller says so.
  if (!newIsOwner && !oldIsOwner) return 'collision';
  if (oldIsOwner) return 'pending';

  // The row becomes an ordinary owned row: marker gone, everything else kept.
  const settled: AuthorRecord = {
    privateKey: chasing.privateKey,
    safe: chasing.safe,
    ...(chasing.safeSource === undefined ? {} : { safeSource: chasing.safeSource }),
    ...(chasing.unreadableSafeSource === undefined
      ? {}
      : { unreadableSafeSource: chasing.unreadableSafeSource }),
    ...(chasing.contracts === undefined ? {} : { contracts: chasing.contracts }),
  };
  // Both of the rotation's rows leave the file: the one being replaced, and the
  // filed one under the name it was filed with. The settled row takes the name
  // `settledAuthorName` decides, which may be either of them or the operator's.
  const name = settledAuthorName(chasing.name, chasing.replaces);
  const authors: Record<string, AuthorRecord> = {};
  for (const [author, record] of Object.entries(store.authors)) {
    if (author === oldRow?.name || author === chasing.name) continue;
    authors[author] = record;
  }
  authors[name] = settled;
  writeAuthors({ active: name, authors }, path);
  return 'settled';
}

/**
 * Why `name` must not leave the store yet, or undefined when it may.
 *
 * A rotation puts two rows in the file and only one of them is a key for the
 * Safe at a time: the row being replaced still holds the key that owns the Safe
 * until the swap executes, and the pending row holds the only copy of the key
 * that swap puts there. Removing either before the chain answers cannot be
 * undone — and nothing in the store can say whether the swap executed — so
 * `author rm` refuses both and names where the answer comes from.
 */
export function removalHoldIn(data: AuthorsStore, name: string): string | undefined {
  const row = findAuthor(data, name);
  if (!row) return undefined;
  const settle =
    'finish it with `s2s signer confirm <hash>` when the swap is queued, or re-run `s2s signer rotate` on that Safe when it never reached the service';
  if (row.replaces !== undefined) {
    return `author '${row.name}' is the pending replacement for '${row.replaces}' and holds the only copy of the key that swap puts on the Safe — ${settle}, and remove the row after that; \`--force\` drops it and abandons the rotation`;
  }
  const chaser = chaserOf(data, row.name);
  if (chaser) {
    return `author '${row.name}' still holds a key that owns that Safe, and '${chaser.name}' is filed to replace it — ${settle}, and remove the row after that; \`--force\` drops it and abandons the rotation`;
  }
  return undefined;
}

/**
 * Remove an author. When it was the active one, `active` moves to the first
 * remaining author (insertion order), or null when the store is now empty.
 */
export function removeAuthor(data: AuthorsStore, name: string): AuthorsStore {
  const key = findAuthorName(data, name) ?? name;
  const authors: Record<string, AuthorRecord> = {};
  for (const [candidate, record] of Object.entries(data.authors)) {
    if (candidate !== key) authors[candidate] = record;
  }
  const active = data.active === key ? (Object.keys(authors)[0] ?? null) : data.active;
  return { active, authors };
}

/**
 * The EOA a stored key signs as. `readAuthors` is tolerant, so a hand-edited
 * file can hold a non-key; callers get undefined instead of an exception.
 */
export function authorEoa(privateKey: string): Address | undefined {
  try {
    return privateKeyToAccount(privateKey as Hex).address;
  } catch {
    return undefined;
  }
}

/**
 * Record a Safe derived for `name` (write-back from `author address` / `init`).
 * Returns true when the file changed; a no-op when the stored Safe already
 * matches, so the idempotent paths stay idempotent.
 */
export function writeBackAuthorSafe(
  name: string,
  safe: string,
  path: string = authorsFilePath(),
): boolean {
  const store = readAuthors(path);
  const record = store.authors[name];
  if (!record || record.safe === safe) return false;
  // A given Safe is the fact the record exists to name. A derived address for
  // the same key is a different Safe, one the key was never an owner of, so a
  // write-back would replace the identity rather than refresh it. A row whose
  // provenance cannot be read gets the same treatment for the same reason.
  if (isGivenSafe(record) || record.unreadableSafeSource !== undefined) return false;
  writeAuthors({ ...store, authors: { ...store.authors, [name]: { ...record, safe } } }, path);
  return true;
}

/**
 * Write-back for a command: only when the signing key came from the store, and
 * never fatal — a read-only config dir must not fail an `address`/`init` run
 * that already succeeded. A `given` record is left as it is (see
 * `writeBackAuthorSafe`).
 */
export function rememberAuthorSafe(
  author: { readonly name: string | undefined; readonly source: AuthorKeySource } | undefined,
  safe: string,
  warn: (message: string) => void,
): void {
  if (author?.source !== 'store' || !author.name) return;
  try {
    writeBackAuthorSafe(author.name, safe);
  } catch (err) {
    warn(
      `could not record the author Safe in the authors file: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Record the author-contracts addresses installed on `name`'s Safe. Returns
 * true when the file changed; a no-op when every recorded address already
 * matches, so a re-run of an idempotent install writes nothing.
 *
 * Same shape as `writeBackAuthorSafe`: tolerant read, atomic 0600 write, and
 * the caller's `warn` for a failure — losing the record is a convenience lost,
 * not the install lost (the chain is the truth; the store only saves a read).
 */
export function writeBackAuthorContracts(
  name: string,
  contracts: AuthorContractsRecord,
  path: string = authorsFilePath(),
): boolean {
  const store = readAuthors(path);
  const record = store.authors[name];
  if (!record) return false;
  const current = record.contracts;
  if (current !== undefined) {
    const unchanged =
      current.drafts === contracts.drafts &&
      current.ownerHistory === contracts.ownerHistory &&
      current.guard === contracts.guard;
    if (unchanged) return false;
  }
  writeAuthors({ ...store, authors: { ...store.authors, [name]: { ...record, contracts } } }, path);
  return true;
}

/**
 * `rememberAuthorContracts` for a command: tolerant write-back of the
 * install record, never fatal — a read-only config dir must not fail an
 * install that already succeeded on chain.
 *
 * `name` is the pet name the command knows (`ctx.config.author?.name`); an
 * unknown name writes nothing (`writeBackAuthorContracts` returns false), so a
 * key from the env or a file is simply not recorded.
 */
export function rememberAuthorContracts(
  name: string | undefined,
  contracts: AuthorContractsRecord,
  file: string = authorsFilePath(),
  warn: (message: string) => void = () => undefined,
): boolean {
  if (!name) return false;
  try {
    return writeBackAuthorContracts(name, contracts, file);
  } catch (err) {
    warn(
      `could not record the author contracts in the authors file: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}
