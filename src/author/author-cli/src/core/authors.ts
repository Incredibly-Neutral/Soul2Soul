// ============================================================================
// The author store — several author identities in one CLI install.
//
//   ~/.config/s2s/authors.json   (XDG_CONFIG_HOME honored), mode 0600
//   { "active": "zomi" | null,
//     "authors": { "<pet name>": { "privateKey": "0x…", "safe": "0x…" | null } } }
//
// The pet name is the key of an insertion-ordered map, so `author list` and the
// active-reassignment in `author rm` follow the order authors were added. One
// private key belongs to exactly one pet name (the same identity under two
// names would be two rows that can never diverge).
//
// The store sits in the key-precedence chain between the project config and the
// user config (see core/config.ts), which is what makes `author switch` a
// one-command identity switch: no env var, no file edit.
//
// Reads are tolerant (missing/corrupt → empty store) because every command
// calls them; a broken file must not brick the CLI. Writes are atomic
// (tmp + rename) and 0600 — the file holds private keys.
// ============================================================================

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** One stored author: the signing key and its (predicted) author Safe. */
export interface AuthorRecord {
  privateKey: string;
  /** The author id (counterfactual Safe), once predicted; null when never derived. */
  safe: string | null;
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

function parseRecord(value: unknown): AuthorRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const privateKey = record.privateKey;
  if (typeof privateKey !== 'string' || privateKey.trim().length === 0) return undefined;
  const safe = record.safe;
  return {
    privateKey: normalizeKey(privateKey),
    safe: typeof safe === 'string' && safe.length > 0 ? safe : null,
  };
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
      // fatal: the rest of the store still works.
      if (record !== undefined && isValidPetName(name)) authors[name] = record;
    }
  }

  const rawActive = raw.active;
  const active =
    typeof rawActive === 'string' && Object.hasOwn(authors, rawActive) ? rawActive : null;
  return { active, authors };
}

/** Write the store atomically (tmp + rename) at mode 0600. Returns the path. */
export function writeAuthors(data: AuthorsStore, path: string = authorsFilePath()): string {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const next = { active: data.active, authors: data.authors };
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // perms are best-effort (e.g. some filesystems)
  }
  return path;
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

/** Add an author and make it active (a new author is the one you want next). */
export function addAuthor(
  data: AuthorsStore,
  name: string,
  privateKey: string,
  safe: string | null,
): AuthorsStore {
  return {
    active: name,
    authors: { ...data.authors, [name]: { privateKey: normalizeKey(privateKey), safe } },
  };
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
  writeAuthors({ ...store, authors: { ...store.authors, [name]: { ...record, safe } } }, path);
  return true;
}

/**
 * Write-back for a command: only when the signing key came from the store, and
 * never fatal — a read-only config dir must not fail an `address`/`init` run
 * that already succeeded.
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
