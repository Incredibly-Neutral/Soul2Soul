// ============================================================================
// Environment configuration for the CLI. Single source of the effective config
// surface; every adapter reads its settings from a CliConfig.
//
// Precedence (git-style): env vars > project config (.s2sconfig.json in cwd) >
// user config (~/.config/s2s/config.json) > built-in defaults. The env surface
// (S2S_*, LIT_*, GITHUB_TOKEN) is the top override layer; the config files are
// managed by `s2s config set/get/unset` — see src/core/configfile.ts for the
// field registry shared by both.
//
// A `.env` in the current working directory is loaded by the CLI entrypoint
// before `loadConfig()` runs, so it participates at the env layer.
// ============================================================================

import {
  CONFIG_FIELD,
  configFilePaths,
  configFileValue,
  readConfigFile,
  type ConfigField,
  type ConfigKey,
} from './configfile';

export type EntryPointVersion = '0.6' | '0.7';
export type FilecoinChain = 'mainnet' | 'calibration';

export interface FilecoinConfig {
  chain: FilecoinChain;
  /** Filecoin RPC (Synapse transport for the session signer). Defaults to a public GLIF endpoint. */
  rpcUrl: string;
  /** Path to a session-key.json (protocol-payer path). Mutually exclusive with privateKey. */
  sessionKeyPath: string | undefined;
  /** Filecoin signer private key (direct path). Mutually exclusive with sessionKeyPath. */
  privateKey: string | undefined;
}

export interface BundlerConfig {
  /** Pimlico/ERC-4337 bundler RPC URL (required for `new`). */
  baseUrl: string | undefined;
  /** Pimlico paymaster RPC URL (optional — gas sponsorship). */
  paymasterUrl: string | undefined;
  /** EntryPoint version the bundler serves. */
  entryPoint: EntryPointVersion;
}

export interface CliConfig {
  /** 'dev' → dev protocol gateways/factories + dev Lit; 'prod' → live (default). */
  environment: 'dev' | 'prod';
  /** EOA private key that signs author flows (Safe owner). Required for authoring. */
  privateKey: string | undefined;
  /** Lit master/network key (LitService account). Required for authoring. */
  litAccountKey: string | undefined;
  /** Lit usage key for action runs. Required for render paths. */
  litUsageKey: string | undefined;
  /** GitHub token used by the `new` command's assets/config build. */
  githubToken: string | undefined;
  /** Kubo RPC gateway. */
  kuboGateway: string;
  /** Kubo RPC bearer token (token-gated writes). */
  kuboToken: string | undefined;
  /** Pinata JWT for backup pinning. */
  pinataJwt: string | undefined;
  /** Pinata gateway. */
  pinataGateway: string | undefined;
  /** Filebase token for backup pinning. */
  filebaseToken: string | undefined;
  /** Lit-action runner URL (preview renders use the Bun runner). */
  runnerUrl: string;
  /** Explicit L1/L2 RPC URL lists (comma-separated), when overrides are wanted. */
  rpc: { L1: string[]; L2: string[] };
  /** Explicit ENS registry contract address, when the protocolInfo fallback must be overridden. */
  ensRegistry: string | undefined;
  filecoin: FilecoinConfig;
  bundler: BundlerConfig;
}

/** Override the config-file locations (used by tests). */
export interface LoadConfigOptions {
  userConfigPath?: string;
  projectConfigPath?: string;
}

/** Explicit paths when provided, else the standard user/project locations. */
function pathsFor(opts: LoadConfigOptions): { user: string; project: string } {
  if (opts.userConfigPath || opts.projectConfigPath) {
    return { user: opts.userConfigPath ?? '', project: opts.projectConfigPath ?? '' };
  }
  return configFilePaths();
}

/** Typed registry lookup — every key in CONFIG_FIELDS is guaranteed present (guarded, no assertion). */
function field(key: ConfigKey): ConfigField {
  const found = CONFIG_FIELD[key];
  if (!found) {
    throw new Error(`config registry is missing key: ${key}`);
  }
  return found;
}

/** Default for a field that always declares one (kuboGateway, runnerUrl, filecoinRpc). */
function def(key: ConfigKey): string {
  const value = field(key).default;
  if (value === undefined) {
    throw new Error(`config registry is missing a default for: ${key}`);
  }
  return value;
}

/**
 * Resolve one field's effective value given the env layer + both config files.
 * Env vars win, then project file, then user file, then the built-in default.
 */
function resolveFieldValue(
  field: ConfigField,
  env: NodeJS.ProcessEnv,
  projectFile: Record<string, unknown>,
  userFile: Record<string, unknown>,
): string | undefined {
  for (const name of field.env) {
    const value = env[name];
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  const fromProject = configFileValue(projectFile[field.key], field);
  if (fromProject !== undefined) return fromProject;
  const fromUser = configFileValue(userFile[field.key], field);
  if (fromUser !== undefined) return fromUser;
  return field.default;
}

function listValue(value: string | undefined): string[] {
  return value
    ? value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    : [];
}

/** Enum fields fall back to the default when given an unrecognized value. */
function enumValue<T extends string>(field: ConfigField, fallback: T, value: string | undefined): T {
  if (value !== undefined && field.enumValues?.includes(value)) {
    return value as T;
  }
  return fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: LoadConfigOptions = {}): CliConfig {
  const paths = pathsFor(opts);
  const projectFile = readConfigFile(paths.project);
  const userFile = readConfigFile(paths.user);

  const resolve = (f: ConfigField): string | undefined => resolveFieldValue(f, env, projectFile, userFile);

  return {
    environment: enumValue(field('environment'), 'prod', resolve(field('environment'))),
    privateKey: resolve(field('privateKey')),
    litAccountKey: resolve(field('litAccountKey')),
    litUsageKey: resolve(field('litUsageKey')),
    githubToken: resolve(field('githubToken')),
    kuboGateway: resolve(field('kuboGateway')) ?? def('kuboGateway'),
    kuboToken: resolve(field('kuboToken')),
    pinataJwt: resolve(field('pinataJwt')),
    pinataGateway: resolve(field('pinataGateway')),
    filebaseToken: resolve(field('filebaseToken')),
    runnerUrl: resolve(field('runnerUrl')) ?? def('runnerUrl'),
    rpc: {
      L1: listValue(resolve(field('rpcL1'))),
      L2: listValue(resolve(field('rpcL2'))),
    },
    ensRegistry: resolve(field('ensRegistry')),
    filecoin: {
      chain: enumValue(field('filecoinChain'), 'mainnet', resolve(field('filecoinChain'))),
      rpcUrl: resolve(field('filecoinRpc')) ?? def('filecoinRpc'),
      sessionKeyPath: resolve(field('filecoinSessionKey')),
      privateKey: resolve(field('filecoinPrivateKey')),
    },
    bundler: {
      baseUrl: resolve(field('bundlerUrl')),
      paymasterUrl: resolve(field('paymasterUrl')),
      entryPoint: enumValue(field('entryPoint'), '0.6', resolve(field('entryPoint'))),
    },
  };
}

/** Effective value for a single config key (used by `s2s config get/list`). */
export function configKeyValue(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: LoadConfigOptions = {},
): string | undefined {
  const field = CONFIG_FIELD[key];
  if (!field) return undefined;
  const paths = pathsFor(opts);
  return resolveFieldValue(field, env, readConfigFile(paths.project), readConfigFile(paths.user));
}

/** Required-setting helper — throws a clear, actionable error for a missing key. */
export function requireSetting<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(
      `Missing required setting \`${name}\`. Set it in the environment, a .env file, or run \`s2s config set\`.`,
    );
  }
  return value;
}

// Re-export the field registry so the config commands and tests share one source.
export { CONFIG_FIELDS, CONFIG_FIELD, configFilePaths, maskSecret, type ConfigField } from './configfile';
