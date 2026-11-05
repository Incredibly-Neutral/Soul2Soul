// ============================================================================
// The effective config — the only place layers are merged.
//
// Precedence, highest first:
//
//   env (S2S_*, LIT_*, GITHUB_TOKEN, VITE_*)
//   project  ./.s2sconfig.json
//   custom   ~/.config/s2s/custom.json     (`s2s setup`, `config set`)
//   legacy   ~/.config/s2s/config.json     (old flat keys, read-only)
//   defaults <dist>/defaults.json          (ships with the CLI)
//   builtin  constants compiled in         (core/configschema.ts)
//
// Merge rules (they differ per section on purpose):
//   - `pinning` / `ipfs` are label maps: a higher layer's entry replaces that
//     label WHOLE, never field by field. A custom `pinata` that only names a
//     gateway must not silently inherit the default JWT.
//   - `rpc` is per provider key; `rpc.custom.l1`/`l2` are lists that replace the
//     derived chain when present.
//   - singletons (`paymaster`, `filecoin`, `lit`, `ens`, `github`,
//     `environment`) are field by field, highest defined value wins.
//   - the env layer is FLAT (core/configschema.ts names every env var), so it
//     sets individual leaves — including the label shorthands such as
//     `S2S_PINATA_JWT` → `pinning.pinata.key`.
//
// The signing key comes from `S2S_PRIVATE_KEY`, the active author in
// `authors.json`, or — as a deprecated fallback for installs that predate the
// author store — a `privateKey` left in a config file. `CliConfig.author`
// reports which layer won, so `buildContext` can warn when the env shadows a
// deliberate `s2s author switch`, and `loadConfig` warns once when the key came
// out of a file.
// ============================================================================

import { buildFallbackRpcs } from '@s2s/soul2soul-shared';

import {
  activeAuthorRecord,
  readAuthors,
  type AuthorKeySource,
  type AuthorsStore,
} from './authors';
import {
  configFilePaths,
  readConfigFile,
  readFileConfig,
  readLegacyFileConfig,
  type ConfigFilePaths,
} from './configfile';
import {
  BUILTIN_FILE_CONFIG,
  CONFIG_FIELDS,
  LABEL_ENV_SHORTHANDS,
  defaultForPath,
  matchField,
  normalizeFileConfig,
  parseList,
  readPath,
  textValue,
  writePath,
  type Environment,
  type FilecoinChain,
  type FileConfig,
  type IpfsEntry,
  type PinningEntry,
} from './configschema';
import { loadDefaults } from './defaults';

export type EntryPointVersion = '0.6' | '0.7';

/** Where the signing key came from, and — for the store layer — whose it is. */
export interface CliAuthor {
  /** Pet name of the active stored author; only set when `source` is `store`. */
  name: string | undefined;
  /** That author's recorded Safe; only set when `source` is `store`. */
  safe: string | undefined;
  source: AuthorKeySource;
}

export interface CliConfig {
  /** 'dev' → dev protocol gateways/factories + dev Lit; 'prod' → live (default). */
  environment: Environment;
  /** ERC-4337 EntryPoint version the bundler serves (part of the Safe address). */
  entryPoint: EntryPointVersion;
  /** EOA private key that signs author flows (Safe owner). Required for authoring. */
  privateKey: string | undefined;
  /**
   * Provenance of `privateKey`. Undefined only when no key resolved at all
   * (`privateKey` is then undefined too).
   */
  author: CliAuthor | undefined;
  /** Lit master/network key (LitService account) + the action-run usage key. */
  lit: { accountKey: string | undefined; usageKey: string | undefined };
  /** ENS registry override; `protocolInfo.ensRegistry` is the fallback. */
  ens: { registry: string | undefined };
  /** GitHub token for the `new` command's assets/config build. */
  github: { token: string | undefined };
  /** Pinning providers, in the order they were added (custom labels first). */
  pinning: PinningEntry[];
  /** IPFS endpoints, primary first. */
  ipfs: { entries: IpfsEntry[]; primary: IpfsEntry | undefined };
  /** Fully resolved L1/L2 chains, in failover order. */
  rpc: { l1: string[]; l2: string[] };
  /** ERC-4337 bundler/paymaster credentials; one Pimlico key serves both. */
  paymaster: { key: string | undefined; url: string | undefined };
  filecoin: {
    chain: FilecoinChain;
    rpcUrl: string;
    /** Session-key file (protocol-payer path). Env/config only. */
    sessionKeyFile: string | undefined;
    /**
     * Direct-signer key (the other Filecoin path). Env only, never a file key —
     * it is a secret, and secrets do not live in a committable JSON file.
     */
    privateKey: string | undefined;
  };
  /** Lit-action runner URL (preview renders use the Bun runner). */
  runnerUrl: string;
}

/** Override the config-file locations (used by tests). */
export interface LoadConfigOptions {
  /** custom.json */
  userConfigPath?: string;
  /** .s2sconfig.json */
  projectConfigPath?: string;
  /** the old flat config.json */
  legacyConfigPath?: string;
  /** defaults.json */
  defaultsPath?: string;
  /** The author store (`core/authors.ts`) — test seam, like the config files. */
  authorsPath?: string;
}

/** Builtin, not a file key: the Lit-action runner is infrastructure, not taste. */
const RUNNER_URL = 'https://run.transport-union.dev/run';

/**
 * Explicit paths when any is given, else the standard locations.
 *
 * Any override pins the WHOLE set: a caller that supplies one path (a test, a
 * harness) must not silently pick up the developer's real `~/.config/s2s`.
 */
function pathsFor(opts: LoadConfigOptions): ConfigFilePaths {
  const explicit =
    opts.userConfigPath !== undefined ||
    opts.projectConfigPath !== undefined ||
    opts.legacyConfigPath !== undefined ||
    opts.defaultsPath !== undefined;
  if (!explicit) return configFilePaths();
  return {
    user: opts.userConfigPath ?? '',
    project: opts.projectConfigPath ?? '',
    legacy: opts.legacyConfigPath ?? '',
    defaults: opts.defaultsPath ?? '',
  };
}

// ===========================================================================
// Merging
// ===========================================================================

/** The last defined value — `layers` is ordered low → high. */
function highest<T>(values: readonly (T | undefined)[]): T | undefined {
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Label maps: the highest layer that names a label owns that entry whole.
 *
 * Iterating high → low (and skipping labels already taken) does both jobs at
 * once: it implements whole-entry replacement and it keeps insertion order
 * "custom labels first", which is the order `config list` should read in.
 */
function mergeLabels<T extends object>(
  layers: readonly (Record<string, T> | undefined)[],
): Record<string, T> | undefined {
  const out: Record<string, T> = {};
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (!layer) continue;
    for (const [label, entry] of Object.entries(layer)) {
      // Copied, never aliased: the env layer writes leaves into this map
      // (`applyEnv`), and the bottom layers are module constants — the
      // builtin entry and the cached defaults file would otherwise carry one
      // process's `S2S_KUBO_GATEWAY` into every later `loadConfig`.
      if (!Object.hasOwn(out, label)) out[label] = { ...entry };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Singletons: field by field, `layers` ordered low → high. */
function mergeFields<T extends object>(layers: readonly (T | undefined)[]): T | undefined {
  const out: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? (out as T) : undefined;
}

/** `rpc`: per provider key, plus the two custom lists that replace the chain. */
function mergeRpc(layers: readonly FileConfig[]): FileConfig['rpc'] {
  const out: NonNullable<FileConfig['rpc']> = {};
  for (const provider of ['drpc', 'alchemy', 'infura'] as const) {
    const key = highest(layers.map((layer) => layer.rpc?.[provider]?.key));
    if (key !== undefined) out[provider] = { key };
  }
  const l1 = highest(layers.map((layer) => layer.rpc?.custom?.l1));
  const l2 = highest(layers.map((layer) => layer.rpc?.custom?.l2));
  if (l1 !== undefined || l2 !== undefined) {
    out.custom = { ...(l1 === undefined ? {} : { l1 }), ...(l2 === undefined ? {} : { l2 }) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Merge every layer, `layers` ordered low → high. */
function mergeLayers(layers: readonly FileConfig[]): FileConfig {
  const out: FileConfig = {};

  const environment = highest(layers.map((layer) => layer.environment));
  if (environment !== undefined) out.environment = environment;

  const pinning = mergeLabels(layers.map((layer) => layer.pinning));
  if (pinning) out.pinning = pinning;

  const ipfs = mergeLabels(layers.map((layer) => layer.ipfs));
  if (ipfs) out.ipfs = ipfs;

  const rpc = mergeRpc(layers);
  if (rpc) out.rpc = rpc;

  const paymaster = mergeFields(layers.map((layer) => layer.paymaster));
  if (paymaster) out.paymaster = paymaster;

  const filecoin = mergeFields(layers.map((layer) => layer.filecoin));
  if (filecoin) out.filecoin = filecoin;

  const lit = mergeFields(layers.map((layer) => layer.lit));
  if (lit) out.lit = lit;

  const ens = mergeFields(layers.map((layer) => layer.ens));
  if (ens) out.ens = ens;

  const github = mergeFields(layers.map((layer) => layer.github));
  if (github) out.github = github;

  return out;
}

/** First non-blank value among `names`, in precedence order. */
function envValue(names: readonly string[], env: NodeJS.ProcessEnv): string | undefined {
  for (const name of names) {
    const value = textValue(env[name]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Apply the env layer onto the merged file config, leaf by leaf. The env is flat
 * and the file is nested, so this is expressed as schema paths — including the
 * label shorthands (`S2S_PINATA_JWT` → `pinning.pinata.key`).
 */
function applyEnv(target: Record<string, unknown>, env: NodeJS.ProcessEnv): void {
  for (const spec of CONFIG_FIELDS) {
    if (spec.path.includes('*')) continue;
    const value = envValue(spec.env, env);
    if (value === undefined) continue;
    const stored = spec.list ? parseList(value) : value;
    if (stored === undefined) continue;
    writePath(target, spec.path, stored);
  }
  for (const shorthand of LABEL_ENV_SHORTHANDS) {
    const value = envValue(shorthand.env, env);
    if (value !== undefined) writePath(target, shorthand.path, value);
  }
}

/**
 * The effective file config for this process: merged layers, env applied, then
 * normalized once more (the env can create an entry — a Pimlico key with no
 * `pinning` section — that needs the same validation the files get).
 */
function resolvedFileConfig(env: NodeJS.ProcessEnv, opts: LoadConfigOptions): FileConfig {
  const paths = pathsFor(opts);
  const defaults =
    opts.defaultsPath !== undefined ? readFileConfig(paths.defaults) : loadDefaults(env);

  const merged = mergeLayers([
    BUILTIN_FILE_CONFIG,
    defaults,
    readLegacyFileConfig(paths.legacy),
    readFileConfig(paths.user),
    readFileConfig(paths.project),
  ]);
  applyEnv(merged as Record<string, unknown>, env);
  return normalizeFileConfig(merged as Record<string, unknown>);
}

// ===========================================================================
// Resolution
// ===========================================================================

/** Enum-valued leaves fall back to the builtin default on an unknown value. */
function enumOrDefault<T extends string>(value: string | undefined, path: string): T | undefined {
  const allowed = matchField(path)?.spec.enumValues;
  if (value === undefined) return undefined;
  if (allowed?.includes(value) === true) return value as T;
  return undefined;
}

function resolveEntryPoint(env: NodeJS.ProcessEnv): EntryPointVersion {
  const chosen = enumOrDefault<EntryPointVersion>(envValue(['S2S_ENTRY_POINT'], env), 'entryPoint');
  return chosen ?? (defaultForPath('entryPoint') as EntryPointVersion | undefined) ?? '0.7';
}

/**
 * L1/L2 chains, fully resolved and ordered. Custom lists win; otherwise the
 * shared fallback chain (DRPC → public → Alchemy → Infura) is built from the
 * keys that resolved, so a key in `custom.json` behaves like one in the env.
 */
function resolveRpcs(file: FileConfig): { l1: string[]; l2: string[] } {
  const keys: NodeJS.ProcessEnv = {};
  const drpc = file.rpc?.drpc?.key;
  const alchemy = file.rpc?.alchemy?.key;
  const infura = file.rpc?.infura?.key;
  if (drpc !== undefined) keys.VITE_DRPC_API_KEY = drpc;
  if (alchemy !== undefined) keys.VITE_ALCHEMY_KEY = alchemy;
  if (infura !== undefined) keys.VITE_INFURA_KEY = infura;

  const fallback = buildFallbackRpcs(keys);
  const l1 = file.rpc?.custom?.l1 ?? [];
  const l2 = file.rpc?.custom?.l2 ?? [];
  return {
    l1: l1.length > 0 ? l1 : fallback.L1,
    l2: l2.length > 0 ? l2 : fallback.L2,
  };
}

/** The signing key plus where it came from. */
interface PrivateKeyResolution {
  value: string | undefined;
  source: AuthorKeySource | undefined;
  name: string | undefined;
  safe: string | undefined;
}

const UNRESOLVED_KEY: PrivateKeyResolution = {
  value: undefined,
  source: undefined,
  name: undefined,
  safe: undefined,
};

/** A `privateKey` leaf read straight out of one raw config file. */
function filePrivateKey(path: string): string | undefined {
  return textValue(readConfigFile(path).privateKey);
}

/**
 * Config files that already printed the deprecation warning in this process.
 *
 * One warning per offending file, not per `loadConfig` call: the CLI loads the
 * config several times per run (`setup` asks a question per prompt), and a
 * wall of identical warnings teaches nobody anything. Keyed by path, so two
 * different stranded keys both get named.
 */
const warnedKeyFiles = new Set<string>();

/**
 * Say — once, on stderr — that the winning signing key came out of a file, and
 * how to get it into the author store and out of the file.
 *
 * stderr only: stdout carries the one result document (`--json` parsed by the
 * editor plugins), so a deprecation notice must not land there.
 */
function warnDeprecatedFileKey(layer: 'project' | 'custom' | 'legacy', path: string): void {
  if (warnedKeyFiles.has(path)) return;
  warnedKeyFiles.add(path);
  const removal =
    layer === 'project'
      ? '`s2s config unset privateKey --local`'
      : layer === 'custom'
        ? '`s2s config unset privateKey`'
        : 'delete the `privateKey` line from that file by hand — the CLI never writes it';
  process.stderr.write(
    `warning: the signing key was read from the ${layer} config file (${path}). A \`privateKey\` in a config file is deprecated: file it once with \`s2s author new\`, then remove it with ${removal}.\n`,
  );
}

/**
 * `S2S_PRIVATE_KEY` > project file > active stored author > custom file >
 * legacy file.
 *
 * The store is the supported on-disk home for a key. The file layers below it
 * are the DEPRECATED fallback for installs that predate `authors.json` (or that
 * kept a key next to the rest of their settings): they still resolve, so an
 * existing install keeps signing, but they are read-only here and every winner
 * from a file says so once on stderr. Without the fallback a legacy user would
 * upgrade into "Missing required setting" — and without `config unset
 * privateKey` they could not get the secret back out of the file either.
 */
function resolvePrivateKey(
  env: NodeJS.ProcessEnv,
  authors: AuthorsStore,
  paths: ConfigFilePaths,
): PrivateKeyResolution {
  const fromEnv = textValue(env.S2S_PRIVATE_KEY);
  if (fromEnv !== undefined) {
    return { value: hexKey(fromEnv), source: 'env', name: undefined, safe: undefined };
  }

  // Project file: a deliberate per-repository identity, so it outranks even the
  // active stored author (as it did before the reorganisation).
  const fromProject = filePrivateKey(paths.project);
  if (fromProject !== undefined) {
    warnDeprecatedFileKey('project', paths.project);
    return { value: hexKey(fromProject), source: 'project', name: undefined, safe: undefined };
  }

  const active = activeAuthorRecord(authors);
  if (active) {
    return {
      value: hexKey(active.privateKey),
      source: 'store',
      name: active.name,
      safe: active.safe ?? undefined,
    };
  }

  // Both user-owned files report `source: 'user'`: they are the same layer
  // ("a file in ~/.config/s2s") as far as an author is concerned, and the old
  // flat config.json *was* the user file before `custom.json` replaced it.
  const fromCustom = filePrivateKey(paths.user);
  if (fromCustom !== undefined) {
    warnDeprecatedFileKey('custom', paths.user);
    return { value: hexKey(fromCustom), source: 'user', name: undefined, safe: undefined };
  }

  const fromLegacy = filePrivateKey(paths.legacy);
  if (fromLegacy !== undefined) {
    warnDeprecatedFileKey('legacy', paths.legacy);
    return { value: hexKey(fromLegacy), source: 'user', name: undefined, safe: undefined };
  }

  return UNRESOLVED_KEY;
}

/**
 * Normalize an secp256k1 private key to the 0x-prefixed form viem requires.
 * Keys pasted from `.env` files and wallets are routinely 64 bare hex chars;
 * viem's `privateKeyToAccount` rejects those ("expected hex or 32 bytes, got
 * string"), so the prefix is added here rather than at every consumer.
 */
export function hexKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return /^[0-9a-fA-F]{64}$/.test(trimmed) ? `0x${trimmed}` : trimmed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: LoadConfigOptions = {}): CliConfig {
  const paths = pathsFor(opts);
  const file = resolvedFileConfig(env, opts);
  const privateKey = resolvePrivateKey(env, readAuthors(opts.authorsPath), paths);

  const pinning = Object.values(file.pinning ?? {});
  const entries = Object.values(file.ipfs ?? {});

  return {
    environment: file.environment ?? 'prod',
    entryPoint: resolveEntryPoint(env),
    privateKey: privateKey.value,
    author:
      privateKey.source === undefined
        ? undefined
        : { name: privateKey.name, safe: privateKey.safe, source: privateKey.source },
    lit: {
      accountKey: hexKey(file.lit?.accountKey),
      usageKey: file.lit?.usageKey,
    },
    ens: { registry: file.ens?.registry },
    github: { token: file.github?.token },
    pinning,
    ipfs: { entries, primary: entries[0] },
    rpc: resolveRpcs(file),
    paymaster: { key: file.paymaster?.key, url: file.paymaster?.url },
    filecoin: {
      chain: file.filecoin?.chain ?? 'mainnet',
      rpcUrl: file.filecoin?.rpcUrl ?? defaultForPath('filecoin.rpcUrl') ?? '',
      sessionKeyFile: file.filecoin?.sessionKeyFile,
      privateKey: textValue(env.S2S_FILECOIN_PRIVATE_KEY),
    },
    runnerUrl: envValue(['S2S_RUNNER_URL'], env) ?? RUNNER_URL,
  };
}

/** A leaf rendered as the single string `config get` prints. */
function displayValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    const parts = value.filter((part): part is string => typeof part === 'string');
    return parts.length > 0 ? parts.join(',') : undefined;
  }
  if (typeof value === 'string') return textValue(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * Effective value for one dotted key (used by `config get`).
 *
 * Everything is read back out of `configSections`, so `config get` and
 * `config list` can never disagree. Unknown keys (including the retired
 * `privateKey`) return undefined, which is how the config command recognizes
 * them.
 */
export function configKeyValue(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: LoadConfigOptions = {},
): string | undefined {
  if (!matchField(key)) return undefined;
  return displayValue(readPath(configSections(env, opts), key));
}

/**
 * The effective config as the nested object `config list --json` prints:
 * every value resolved (env included), secrets NOT masked (masking is the
 * command's job, via the `secret` flag in the registry).
 *
 * `entryPoint` rides along even though no file holds it: it is a registered
 * key, and a `config list` that silently omitted it would be lying about what
 * the CLI runs with.
 */
export function configSections(
  env: NodeJS.ProcessEnv = process.env,
  opts: LoadConfigOptions = {},
): Record<string, unknown> {
  return { ...resolvedFileConfig(env, opts), entryPoint: resolveEntryPoint(env) };
}

/** Required-setting helper — throws a clear, actionable error for a missing key. */
export function requireSetting<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(
      `Missing required setting \`${name}\`. Set it in the environment, a .env file, or run \`s2s setup\` (or \`s2s config set <key> <value>\`).`,
    );
  }
  return value;
}

// ===========================================================================
// ERC-4337 endpoints
// ===========================================================================

/** Pimlico's ERC-4337 endpoint for a chain — bundler and paymaster in one URL. */
export function pimlicoRpcUrl(apiKey: string, chainId: number): string {
  return `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${apiKey}`;
}

export interface BundlerEndpoints {
  bundlerUrl: string;
  paymasterUrl: string | undefined;
}

/**
 * Resolve the ERC-4337 endpoints for one chain. Endpoints are per-chain, so a
 * bare Pimlico key yields a different URL for mainnet and Base.
 *
 * `paymaster.url` is the explicit endpoint (a non-Pimlico bundler, or a
 * paymaster-only service) and wins over the derived Pimlico URL; the same URL
 * serves both roles, which is how Pimlico exposes them and how the one
 * remaining knob is documented. No endpoint configured → undefined, and the
 * caller says which env var to set.
 */
export function bundlerEndpoints(
  config: CliConfig,
  chainId: number,
): BundlerEndpoints | undefined {
  const key = config.paymaster.key;
  const derived = key ? pimlicoRpcUrl(key, chainId) : undefined;
  const endpoint = config.paymaster.url ?? derived;
  if (!endpoint) return undefined;
  return { bundlerUrl: endpoint, paymasterUrl: endpoint };
}

// The schema is shared with the config commands and the tests; re-exported so
// callers do not have to know which module of the pair owns it.
export {
  CONFIG_FIELDS,
  matchField,
  fieldByPath,
  type ConfigFieldSpec,
  type FileConfig,
  type IpfsEntry,
  type PinningEntry,
} from './configschema';
export { configFilePaths, maskSecret, loadDefaults } from './configfile';
