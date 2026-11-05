// ============================================================================
// Config file layer — IO only, no precedence policy.
//
//   custom   ~/.config/s2s/custom.json   (XDG_CONFIG_HOME honored), 0600
//   project  ./.s2sconfig.json           (cwd)
//   legacy   ~/.config/s2s/config.json   READ-ONLY fallback: the old flat file
//   defaults <dist>/defaults.json        ships with the CLI (core/defaults.ts)
//
// `s2s setup` and `s2s config set` write the custom file by default, or the
// project file with --local. The legacy file is never written by this CLI: it
// is translated on read, so an install that predates the nested schema keeps
// working and a fresh install has exactly one file it owns.
//
// Writer contract: mkdir -p, atomic (tmp + rename), 0600. The files hold
// tokens, so the permission is not advisory.
// ============================================================================

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  deletePath,
  isUnsafeSegment,
  matchField,
  normalizeFileConfig,
  parseList,
  textValue,
  writePath,
  type FileConfig,
} from './configschema';
import { defaultsFilePath } from './defaults';

export interface ConfigFilePaths {
  /** ~/.config/s2s/custom.json — what `s2s setup` / `config set` writes. */
  user: string;
  /** .s2sconfig.json in the current working directory (`config set --local`). */
  project: string;
  /** ~/.config/s2s/config.json — the old flat file, read-only here. */
  legacy: string;
  /** The `defaults.json` that ships with the CLI (see core/defaults.ts). */
  defaults: string;
}

export interface ConfigPathsInput {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function configFilePaths(input: ConfigPathsInput = {}): ConfigFilePaths {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim().length > 0 ? xdg.trim() : join(homedir(), '.config');
  return {
    user: join(base, 's2s', 'custom.json'),
    project: join(cwd, '.s2sconfig.json'),
    legacy: join(base, 's2s', 'config.json'),
    defaults: defaultsFilePath(env),
  };
}

/**
 * Read a config file tolerantly as written — missing/unparsable → empty object.
 * Tombstones (`null` leaves) are preserved: only the writer and the tombstone
 * walk want them, and they need the file exactly as it is on disk.
 */
export function readConfigRaw(path: string): Record<string, unknown> {
  if (!path) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Drop the tombstones and the objects they leave empty, at any depth. */
function pruneTombstones(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      // `JSON.parse` keeps `"__proto__"` as an own key; assigning it here would
      // set the prototype instead. It is never a config label, so drop it.
      if (isUnsafeSegment(key)) continue;
      const kept = pruneTombstones(child);
      if (kept !== undefined) out[key] = kept;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return value;
}

/** A config file's values with the tombstones removed (see `readConfigFile`). */
export function stripTombstones(
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return pruneTombstones(value) as Record<string, unknown> | undefined;
}

/**
 * Read a config file as the values it carries — a tombstone is not a value, so
 * it is dropped here (with any object it empties). The merge never sees one;
 * the write path and the tombstone walk use `readConfigRaw` instead.
 */
export function readConfigFile(path: string): Record<string, unknown> {
  return stripTombstones(readConfigRaw(path)) ?? {};
}

/** Read a config file as a typed, normalized FileConfig (tolerant, never throws). */
export function readFileConfig(path: string): FileConfig {
  return normalizeFileConfig(readConfigFile(path));
}

/**
 * The pre-reorganisation flat keys, translated onto their nested paths.
 *
 * The two escape hatches land on two leaves: `bundlerUrl` is the bundler and
 * `paymasterUrl` the paymaster, independently, exactly as they were separate
 * settings before the reorganisation (folding them together silently dropped
 * one of the two, and made an explicit bundler imply sponsorship).
 *
 * Deliberately absent: `privateKey`, `filecoinPrivateKey`, `entryPoint`,
 * `runnerUrl`. The first two are secrets with another home (the env and
 * `authors.json`); the last two are not preferences (`entryPoint` is part of the
 * counterfactual Safe address, `runnerUrl` is a builtin).
 */
const LEGACY_KEY_PATHS: readonly (readonly [string, string])[] = [
  ['environment', 'environment'],
  ['kuboGateway', 'ipfs.kubo.url'],
  ['kuboToken', 'ipfs.kubo.key'],
  ['pinataJwt', 'pinning.pinata.key'],
  ['pinataGateway', 'pinning.pinata.url'],
  ['filebaseToken', 'pinning.filebase.key'],
  ['rpcL1', 'rpc.custom.l1'],
  ['rpcL2', 'rpc.custom.l2'],
  ['pimlicoKey', 'paymaster.key'],
  ['bundlerUrl', 'bundler.url'],
  ['paymasterUrl', 'paymaster.url'],
  ['filecoinChain', 'filecoin.chain'],
  ['filecoinRpc', 'filecoin.rpcUrl'],
  ['filecoinSessionKey', 'filecoin.sessionKeyFile'],
  ['litAccountKey', 'lit.accountKey'],
  ['litUsageKey', 'lit.usageKey'],
  ['ensRegistry', 'ens.registry'],
  ['githubToken', 'github.token'],
];

/**
 * Read the legacy flat file as a FileConfig. The file is only ever read: an
 * install that has one keeps working, and nothing here writes it back.
 */
export function readLegacyFileConfig(path: string): FileConfig {
  const raw = readConfigFile(path);
  const translated: Record<string, unknown> = {};
  for (const [flatKey, nestedPath] of LEGACY_KEY_PATHS) {
    const value = raw[flatKey];
    if (value === undefined || value === null) continue;
    const resolved = matchField(nestedPath)?.spec.list ? parseList(value) : value;
    if (resolved === undefined) continue;
    writePath(translated, nestedPath, resolved);
  }
  return normalizeFileConfig(translated);
}

/** A path may be written only when it is concrete: `*` is a schema placeholder. */
function assertWritablePath(dotted: string): void {
  if (dotted.split('.').includes('*')) {
    throw new Error(`cannot write '${dotted}': '*' is a schema placeholder, not a label`);
  }
}

/**
 * Write one leaf into a config file (mkdir -p, atomic, 0600).
 *
 * `dotted` is a schema path with the label filled in (`pinning.pinata.key`);
 * intermediate objects are created. `list` fields accept a comma-separated
 * string (the command-line spelling) and are stored as a JSON array. Passing
 * `undefined` removes the leaf and prunes whatever objects fall empty behind it;
 * passing `null` writes an explicit tombstone that the merge honours as
 * "unset" (how `config unset` reaches a value living in a lower layer).
 */
export function writeConfigValue(path: string, dotted: string, value: unknown): void {
  assertWritablePath(dotted);
  const data = readConfigRaw(path);

  if (value === undefined) {
    deletePath(data, dotted);
  } else if (value === null) {
    // A tombstone is a leaf value, not a scalar to normalize: keep the `null`.
    writePath(data, dotted, null);
  } else {
    const listy = matchField(dotted)?.spec.list === true;
    const stored = listy ? parseList(value) : storedScalar(value);
    if (stored === undefined) deletePath(data, dotted);
    else writePath(data, dotted, stored);
  }

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // perms are best-effort (e.g. some filesystems)
  }
}

/**
 * What a non-list value is stored as: a trimmed string when one was given (an
 * empty string is an unset, not a value), otherwise the value untouched.
 */
function storedScalar(value: unknown): unknown {
  return typeof value === 'string' ? textValue(value) : value;
}

/**
 * Mask a secret for display — keeps the shape, hides the body.
 *
 * An empty value is not a secret: returning `********` for it would show a
 * credential in `config list` for a leaf that has none.
 */
export function maskSecret(value: string): string {
  if (value.length === 0) return '';
  if (value.length <= 8) return '********';
  return `${value.slice(0, 2)}…${value.slice(-4)}`;
}

/** Query parameters whose value is a credential when it appears in a URL. */
const CREDENTIAL_PARAM = /[?&](?:api[-_]?key|key|token|secret|auth|jwt|password|passwd|signature|sig)=/i;

/** Does this URL carry a credential in its query string? */
export function urlHasCredential(value: string): boolean {
  return CREDENTIAL_PARAM.test(value);
}

/**
 * Hide query-string credentials while keeping the endpoint readable, so
 * `config get paymaster.url` can show which service is configured without
 * printing the key: `…?apikey=********`.
 */
export function maskUrlCredential(value: string): string {
  if (!urlHasCredential(value)) return value;
  return value.replace(/([?&][^=&#]+=)[^&#]*/g, '$1********');
}

// The defaults layer is a config file too; re-exported here so a caller that
// only wants IO has one import.
export { loadDefaults, defaultsFilePath, resetDefaultsCache } from './defaults';
