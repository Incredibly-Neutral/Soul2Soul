// ============================================================================
// The config schema — one nested file shape shared by every config layer, plus
// the flat field registry that maps a dotted path to the env names and the
// default that feed it.
//
// Three layers use this shape with the SAME keys, differing only in precedence:
//   defaults.json (ships with the CLI) < legacy config.json (read-only) <
//   custom.json (written by `s2s setup` / `config set`) < .s2sconfig.json
//   (project) < env.
//
// Why nested: the CLI is configured by a person who is asked, per service,
// "bring your own, or accept the provided default". A service is a section
// (`pinning`, `ipfs`, `rpc`, `paymaster`, `filecoin`, `lit`, `ens`, `github`),
// not a flat key. `pinning` and `ipfs` are label maps, because an operator may
// pin to several providers and read through several gateways at once.
//
// `privateKey` is deliberately NOT a key here. A signing key has exactly one
// on-disk home (`authors.json`, see core/authors.ts) and one override surface
// (the env). A key in a committed `.s2sconfig.json`, or a second copy in the
// custom file, is a leak waiting for a `git add`.
//
// `entryPoint` is registered but has no file home: it selects the Safe4337Module
// inside the Safe initializer, so it is part of the counterfactual author
// address and is not a preference. Env + builtin only.
//
// This module is types + schema knowledge (validation, path plumbing). It never
// touches the filesystem and never decides precedence — see core/configfile.ts
// (IO) and core/config.ts (resolution).
// ============================================================================

/** Protocol deployment the CLI talks to. */
export type Environment = 'prod' | 'dev';

/** Filecoin network for the durability leg. */
export type FilecoinChain = 'mainnet' | 'calibration';

/**
 * One pinning provider. `key: ''` means "labelled but no credential" — a
 * gateway-only entry is legal, and the empty key is what tells the adapters to
 * skip the pin.
 */
export interface PinningEntry {
  provider: string;
  key: string;
  url?: string;
}

/** One IPFS read/write endpoint. `url` is the gateway host (no scheme needed). */
export interface IpfsEntry {
  provider: string;
  url: string;
  key?: string;
}

/**
 * The on-disk config shape — identical for defaults / custom / project.
 * Every section is optional: a layer only carries what it sets.
 */
export interface FileConfig {
  environment?: Environment;
  pinning?: Record<string, PinningEntry>;
  ipfs?: Record<string, IpfsEntry>;
  rpc?: {
    drpc?: { key?: string };
    alchemy?: { key?: string };
    infura?: { key?: string };
    /** Explicit endpoints; they replace the derived chain when non-empty. */
    custom?: { l1?: string[]; l2?: string[] };
  };
  paymaster?: { key?: string; url?: string };
  filecoin?: { sessionKeyFile?: string; chain?: FilecoinChain; rpcUrl?: string };
  lit?: { accountKey?: string; usageKey?: string };
  ens?: { registry?: string };
  github?: { token?: string };
}

/** One settable leaf. `path` uses `*` for "one map label" (e.g. `pinning.*.key`). */
export interface ConfigFieldSpec {
  path: string;
  /** Env names in precedence order; the first non-empty one wins. */
  env: readonly string[];
  /** Masked in `config get`/`list`, and warned about in a project file. */
  secret?: boolean;
  /** Comma-separated on the command line / in env, a JSON array in the file. */
  list?: boolean;
  /** Builtin fallback (never a secret). */
  default?: string;
  enumValues?: readonly string[];
}

/**
 * The field registry — the full set of settable leaves, nothing else.
 *
 * Order is the order `config list` prints, so it reads like the file does.
 */
export const CONFIG_FIELDS: readonly ConfigFieldSpec[] = [
  { path: 'environment', env: ['S2S_ENV'], default: 'prod', enumValues: ['prod', 'dev'] },
  // Env-only: see the header. Kept in the registry so `config get entryPoint`
  // and the enum check still have one source of truth.
  { path: 'entryPoint', env: ['S2S_ENTRY_POINT'], default: '0.7', enumValues: ['0.6', '0.7'] },
  { path: 'pinning.*.provider', env: [] },
  { path: 'pinning.*.key', env: [], secret: true },
  { path: 'pinning.*.url', env: [] },
  { path: 'ipfs.*.provider', env: [] },
  { path: 'ipfs.*.url', env: [] },
  { path: 'ipfs.*.key', env: [], secret: true },
  { path: 'rpc.drpc.key', env: ['S2S_DRPC_KEY', 'VITE_DRPC_API_KEY'], secret: true },
  { path: 'rpc.alchemy.key', env: ['S2S_ALCHEMY_KEY', 'VITE_ALCHEMY_KEY'], secret: true },
  { path: 'rpc.infura.key', env: ['S2S_INFURA_KEY', 'VITE_INFURA_KEY', 'INFURA_KEY'], secret: true },
  { path: 'rpc.custom.l1', env: ['S2S_RPC_L1', 'MAINNET_RPC_URL'], list: true },
  { path: 'rpc.custom.l2', env: ['S2S_RPC_L2', 'BASE_RPC_URL'], list: true },
  {
    path: 'paymaster.key',
    env: ['S2S_PIMLICO_KEY', 'PIMLICO_KEY', 'PIMLICO_API_KEY'],
    secret: true,
  },
  { path: 'paymaster.url', env: ['S2S_PAYMASTER_URL', 'S2S_BUNDLER_URL'] },
  { path: 'filecoin.sessionKeyFile', env: ['S2S_FILECOIN_SESSION_KEY'] },
  {
    path: 'filecoin.chain',
    env: ['S2S_FILECOIN_CHAIN'],
    default: 'mainnet',
    enumValues: ['mainnet', 'calibration'],
  },
  {
    path: 'filecoin.rpcUrl',
    env: ['S2S_FILECOIN_RPC'],
    default: 'https://api.node.glif.io/rpc/v1',
  },
  { path: 'lit.accountKey', env: ['LIT_ACCOUNT_KEY'], secret: true },
  { path: 'lit.usageKey', env: ['LIT_USAGE_KEY'], secret: true },
  { path: 'ens.registry', env: ['S2S_ENS_REGISTRY'] },
  { path: 'github.token', env: ['GITHUB_TOKEN', 'S2S_GITHUB_TOKEN'], secret: true },
];

/**
 * Env shorthands for the label maps. The env layer is flat and a `pinning`
 * entry is nested, so a generic `pinning.*.key` has no env name of its own; the
 * shorthands name the labels an operator is actually likely to export
 * (`S2S_PINATA_JWT` sets `pinning.pinata.key`). They stay separate from
 * CONFIG_FIELDS because a field spec's `env` is per-path, not per-label.
 */
export const LABEL_ENV_SHORTHANDS: readonly {
  /** Concrete dotted path, label already filled in. */
  path: string;
  env: readonly string[];
}[] = [
  { path: 'pinning.pinata.key', env: ['S2S_PINATA_JWT'] },
  { path: 'pinning.pinata.url', env: ['S2S_PINATA_GATEWAY'] },
  { path: 'pinning.filebase.key', env: ['S2S_FILEBASE_TOKEN'] },
  { path: 'ipfs.kubo.url', env: ['S2S_KUBO_GATEWAY'] },
  { path: 'ipfs.kubo.key', env: ['S2S_KUBO_TOKEN'] },
];

/**
 * The bottom layer: constants compiled into the CLI, below `defaults.json`.
 *
 * They exist so a missing, unreadable or replaced defaults file still yields a
 * usable config (the shipped KV gateway and the public Filecoin RPC are what
 * "no configuration at all" has always meant). `defaults.json` restates them —
 * the file is the layer an operator can edit; this is the floor under it.
 */
export const BUILTIN_FILE_CONFIG: FileConfig = {
  environment: 'prod',
  ipfs: { kubo: { provider: 'kubo', url: 'ipfs.transport-union.dev' } },
  filecoin: { chain: 'mainnet', rpcUrl: 'https://api.node.glif.io/rpc/v1' },
};

// ===========================================================================
// Path plumbing
// ===========================================================================

/** Split a dotted path, rejecting empty segments (a bug, not a user error). */
function splitPath(dotted: string): string[] {
  const parts = dotted.split('.').map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    throw new Error(`invalid config path '${dotted}'`);
  }
  return parts;
}

/** Exact or `*`-aware match, returning the spec plus the concrete path. */
export function matchField(key: string): { spec: ConfigFieldSpec; path: string } | undefined {
  const exact = CONFIG_FIELDS.find((spec) => spec.path === key);
  if (exact) return { spec: exact, path: key };

  const keyParts = key.split('.');
  for (const spec of CONFIG_FIELDS) {
    if (!spec.path.includes('*')) continue;
    const specParts = spec.path.split('.');
    if (specParts.length !== keyParts.length) continue;
    if (specParts.every((part, i) => part === '*' || part === keyParts[i])) {
      return { spec, path: key };
    }
  }
  return undefined;
}

/** The spec registered for exactly this path (wildcards included). */
export function fieldByPath(path: string): ConfigFieldSpec | undefined {
  return CONFIG_FIELDS.find((spec) => spec.path === path);
}

/** The registry default for a path, or undefined when it has none. */
export function defaultForPath(path: string): string | undefined {
  return fieldByPath(path)?.default;
}

/** Read one leaf out of a nested object; undefined when the path is absent. */
export function readPath(root: Record<string, unknown>, dotted: string): unknown {
  let node: unknown = root;
  for (const part of splitPath(dotted)) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Set one leaf, creating intermediate objects (never arrays). */
export function writePath(root: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = splitPath(dotted);
  let node = root;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      const created: Record<string, unknown> = {};
      node[part] = created;
      node = created;
    } else {
      node = next as Record<string, unknown>;
    }
  }
  node[parts[parts.length - 1] as string] = value;
}

/**
 * Remove one leaf and prune the objects that fall empty behind it, so an
 * unset leaves no `{"pinning": {}}` litter in the file.
 */
export function deletePath(root: Record<string, unknown>, dotted: string): void {
  const parts = splitPath(dotted);
  const chain: Record<string, unknown>[] = [root];
  for (const part of parts.slice(0, -1)) {
    const next = chain[chain.length - 1]?.[part];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) return;
    chain.push(next as Record<string, unknown>);
  }
  delete chain[chain.length - 1]?.[parts[parts.length - 1] as string];
  for (let i = chain.length - 1; i > 0; i--) {
    const child = chain[i] as Record<string, unknown>;
    if (Object.keys(child).length > 0) break;
    delete (chain[i - 1] as Record<string, unknown>)[parts[i - 1] as string];
  }
}

// ===========================================================================
// Validation
// ===========================================================================

/** A trimmed, non-empty string; anything else is absent. */
export function textValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** A plain JSON object, or undefined for arrays / scalars / null. */
function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * A list value in either spelling: a JSON array (how the file stores it) or a
 * comma-separated string (how env and the command line speak it).
 */
export function parseList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const parts = Array.isArray(value)
    ? value.map((item) => (typeof item === 'string' ? item.trim() : ''))
    : typeof value === 'string'
      ? value.split(',').map((part) => part.trim())
      : typeof value === 'number' || typeof value === 'boolean'
        ? [String(value)]
        : [];
  const cleaned = parts.filter((part) => part.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Drop undefined members; undefined when nothing is left. */
function compact<T extends object>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

/**
 * Turn raw JSON into a FileConfig, tolerantly: unknown keys, wrong types and
 * empty strings are dropped, a missing `provider` falls back to the label, and
 * an unusable `ipfs` entry (no url) is discarded rather than kept as a dead
 * primary gateway. Nothing throws — every caller runs on a file a human can
 * edit by hand.
 */
export function normalizeFileConfig(raw: Record<string, unknown> | undefined): FileConfig {
  const out: FileConfig = {};
  if (!raw) return out;

  const environment = textValue(raw.environment);
  if (environment === 'prod' || environment === 'dev') out.environment = environment;

  const pinning: Record<string, PinningEntry> = {};
  for (const [label, value] of Object.entries(objectValue(raw.pinning) ?? {})) {
    const entry = objectValue(value);
    if (!entry) continue;
    const url = textValue(entry.url);
    pinning[label] = {
      provider: textValue(entry.provider) ?? label,
      key: textValue(entry.key) ?? '',
      ...(url === undefined ? {} : { url }),
    };
  }
  if (Object.keys(pinning).length > 0) out.pinning = pinning;

  const ipfs: Record<string, IpfsEntry> = {};
  for (const [label, value] of Object.entries(objectValue(raw.ipfs) ?? {})) {
    const entry = objectValue(value);
    if (!entry) continue;
    const url = textValue(entry.url);
    if (url === undefined) continue;
    const key = textValue(entry.key);
    ipfs[label] = { provider: textValue(entry.provider) ?? label, url, ...(key === undefined ? {} : { key }) };
  }
  if (Object.keys(ipfs).length > 0) out.ipfs = ipfs;

  const rpcRaw = objectValue(raw.rpc);
  const rpc: NonNullable<FileConfig['rpc']> = {};
  for (const provider of ['drpc', 'alchemy', 'infura'] as const) {
    const key = textValue(objectValue(rpcRaw?.[provider])?.key);
    if (key !== undefined) rpc[provider] = { key };
  }
  const customRaw = objectValue(rpcRaw?.custom);
  const l1 = parseList(customRaw?.l1);
  const l2 = parseList(customRaw?.l2);
  if (l1 !== undefined || l2 !== undefined) {
    rpc.custom = { ...(l1 === undefined ? {} : { l1 }), ...(l2 === undefined ? {} : { l2 }) };
  }
  if (Object.keys(rpc).length > 0) out.rpc = rpc;

  const paymaster = compact({
    key: textValue(objectValue(raw.paymaster)?.key),
    url: textValue(objectValue(raw.paymaster)?.url),
  });
  if (paymaster) out.paymaster = paymaster;

  const filecoinRaw = objectValue(raw.filecoin);
  const filecoin: NonNullable<FileConfig['filecoin']> = {};
  const sessionKeyFile = textValue(filecoinRaw?.sessionKeyFile);
  if (sessionKeyFile !== undefined) filecoin.sessionKeyFile = sessionKeyFile;
  const chain = textValue(filecoinRaw?.chain);
  if (chain === 'mainnet' || chain === 'calibration') filecoin.chain = chain;
  const filecoinRpc = textValue(filecoinRaw?.rpcUrl);
  if (filecoinRpc !== undefined) filecoin.rpcUrl = filecoinRpc;
  if (Object.keys(filecoin).length > 0) out.filecoin = filecoin;

  const lit = compact({
    accountKey: textValue(objectValue(raw.lit)?.accountKey),
    usageKey: textValue(objectValue(raw.lit)?.usageKey),
  });
  if (lit) out.lit = lit;

  const ens = compact({ registry: textValue(objectValue(raw.ens)?.registry) });
  if (ens) out.ens = ens;

  const github = compact({ token: textValue(objectValue(raw.github)?.token) });
  if (github) out.github = github;

  return out;
}
