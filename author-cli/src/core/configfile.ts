// ============================================================================
// Config file layer — the field registry (single source of truth for BOTH the
// env surface and the `s2s config` file), config-file read/write, and secret
// masking.
//
// Model (git-style): env vars > project config (.s2sconfig.json in cwd) >
// user config (~/.config/s2s/config.json) > defaults. `s2s config set` writes
// the user file by default, or the project file with --local.
// ============================================================================

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** One settable setting: env-var names, default, and write/display behavior. */
export interface ConfigField {
  /** Friendly key used by `s2s config` and the config file (e.g. `rpcL1`). */
  key: string;
  /** Env-var names in precedence order (first non-empty wins). */
  env: readonly string[];
  /** Fallback when neither env nor any config file sets it. */
  default?: string;
  /** Secret — masked in `get`/`list`, warned about in project files. */
  secret?: boolean;
  /** Comma-separated list (stored as a JSON array in the file). */
  list?: boolean;
  /** Allowed values (enum validation on `set` + normalization on read). */
  enumValues?: readonly string[];
}

export const CONFIG_FIELDS: readonly ConfigField[] = [
  { key: 'environment', env: ['S2S_ENV'], default: 'prod', enumValues: ['dev', 'prod'] },
  { key: 'privateKey', env: ['S2S_PRIVATE_KEY'], secret: true },
  { key: 'litAccountKey', env: ['LIT_ACCOUNT_KEY'], secret: true },
  { key: 'litUsageKey', env: ['LIT_USAGE_KEY'], secret: true },
  { key: 'githubToken', env: ['GITHUB_TOKEN', 'S2S_GITHUB_TOKEN'], secret: true },
  { key: 'kuboGateway', env: ['S2S_KUBO_GATEWAY'], default: 'ipfs.transport-union.dev' },
  { key: 'kuboToken', env: ['S2S_KUBO_TOKEN'], secret: true },
  { key: 'pinataJwt', env: ['S2S_PINATA_JWT'], secret: true },
  { key: 'pinataGateway', env: ['S2S_PINATA_GATEWAY'] },
  { key: 'filebaseToken', env: ['S2S_FILEBASE_TOKEN'], secret: true },
  { key: 'runnerUrl', env: ['S2S_RUNNER_URL'], default: 'https://run.transport-union.dev/run' },
  { key: 'rpcL1', env: ['S2S_RPC_L1', 'MAINNET_RPC_URL'], list: true },
  { key: 'rpcL2', env: ['S2S_RPC_L2', 'BASE_RPC_URL'], list: true },
  { key: 'ensRegistry', env: ['S2S_ENS_REGISTRY'] },
  {
    key: 'filecoinChain',
    env: ['S2S_FILECOIN_CHAIN'],
    default: 'mainnet',
    enumValues: ['mainnet', 'calibration'],
  },
  { key: 'filecoinRpc', env: ['S2S_FILECOIN_RPC'], default: 'https://api.node.glif.io/rpc/v1' },
  { key: 'filecoinSessionKey', env: ['S2S_FILECOIN_SESSION_KEY'] },
  { key: 'filecoinPrivateKey', env: ['S2S_FILECOIN_PRIVATE_KEY'], secret: true },
  { key: 'bundlerUrl', env: ['S2S_BUNDLER_URL'] },
  { key: 'paymasterUrl', env: ['S2S_PAYMASTER_URL'] },
  { key: 'entryPoint', env: ['S2S_ENTRY_POINT'], default: '0.6', enumValues: ['0.6', '0.7'] },
];

/** Typed key→field lookup (property access is non-optional — built from the array). */
export type ConfigKey = (typeof CONFIG_FIELDS)[number]['key'];
export const CONFIG_FIELD: Record<ConfigKey, ConfigField> = Object.fromEntries(
  CONFIG_FIELDS.map((f) => [f.key, f]),
);

export interface ConfigFilePaths {
  /** ~/.config/s2s/config.json (XDG_CONFIG_HOME honored). */
  user: string;
  /** .s2sconfig.json in the current working directory. */
  project: string;
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
    user: join(base, 's2s', 'config.json'),
    project: join(cwd, '.s2sconfig.json'),
  };
}

/** Read a config file tolerantly — missing/unparsable → empty object. */
export function readConfigFile(path: string): Record<string, unknown> {
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

/**
 * Merge one value into a config file (mkdir -p, atomic write, 0600 perms).
 * Passing `undefined` as value removes the key. Also returns the file path.
 */
export function writeConfigValue(path: string, key: string, value: unknown): void {
  const data = readConfigFile(path);
  const next =
    value === undefined
      ? Object.fromEntries(Object.entries(data).filter(([k]) => k !== key))
      : { ...data, [key]: value };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // perms are best-effort (e.g. some filesystems)
  }
}

/**
 * Normalize a stored config-file value (string | string[] | number…) to the
 * comma-joined string form used internally. Returns undefined for empty/absent.
 */
export function configFileValue(value: unknown, field: ConfigField): string | undefined {
  if (value === undefined || value === null) return undefined;

  // List/array-aware part extraction; non-string scalars stringify for numbers
  // and booleans, anything else (objects) is treated as empty.
  const asParts = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map((item: unknown) => (typeof item === 'string' ? item.trim() : ''));
    if (typeof v === 'string') return v.split(',').map((s) => s.trim());
    if (typeof v === 'number' || typeof v === 'boolean') return [String(v)];
    return [];
  };

  if (field.list) {
    const cleaned = asParts(value).filter((s) => s.length > 0);
    return cleaned.length > 0 ? cleaned.join(',') : undefined;
  }

  const first = asParts(value)[0] ?? '';
  return first.length > 0 ? first : undefined;
}

/** Mask a secret for display — keeps the shape, hides the body. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '********';
  return `${value.slice(0, 2)}…${value.slice(-4)}`;
}
