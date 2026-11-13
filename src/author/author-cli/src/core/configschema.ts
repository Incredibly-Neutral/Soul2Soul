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
// (`pinning`, `ipfs`, `rpc`, `bundler`, `paymaster`, `filecoin`, `lit`, `ens`,
// `github`), not a flat key. `pinning` and `ipfs` are label maps, because an
// operator may pin to several providers and read through several gateways at
// once.
//
// `privateKey` is deliberately NOT a key here. A signing key has exactly one
// on-disk home (`authors.json`, see core/authors.ts) and one override surface
// (the env). A key in a committed `.s2sconfig.json`, or a second copy in the
// custom file, is a leak waiting for a `git add`.
//
// `entryPoint` has no file home: it selects the Safe4337Module inside the Safe
// initializer, so it is part of the counterfactual author address and is not a
// preference. Env + builtin only, and therefore NOT in the settable registry —
// a value in a file would be written and never read. `ENV_ONLY_FIELDS` keeps its
// spec so `config get entryPoint` and the enum check have one source of truth.
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
 * One pinning provider. Every field but `provider` is optional and, exactly as
 * in the `ipfs` map, an absent field is omitted rather than blanked: a layer
 * that names only a gateway must not overwrite the credential the layer below
 * supplies. A provider with no key at all is a gateway-only label, and the
 * adapters skip its pin.
 */
export interface PinningEntry {
  provider: string;
  key?: string;
  url?: string;
}

/**
 * One IPFS read/write endpoint. `url` is the gateway host (no scheme needed).
 *
 * `url` is optional because a layer may carry the credential alone
 * (`s2s config set ipfs.kubo.key …`): the gateway then comes from a lower layer
 * with the same provider. Only entries with a url are endpoints — see
 * `CliConfig.ipfs`.
 */
export interface IpfsEntry {
  provider: string;
  url?: string;
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
  /** Explicit bundler endpoint (a non-Pimlico bundler); keyless by design. */
  bundler?: { url?: string };
  rpc?: {
    drpc?: { key?: string };
    alchemy?: { key?: string };
    infura?: { key?: string };
    /**
     * Explicit endpoints. Both lists set ⇒ they replace the derived chains;
     * one alone ⇒ it heads its own chain and the fallbacks stay behind it.
     */
    custom?: { l1?: string[]; l2?: string[] };
  };
  paymaster?: { key?: string; url?: string };
  /**
   * Safe Transaction Service. Base URL and an optional API key: the public host
   * serves unauthenticated requests at a rate the queue commands can exceed.
   */
  safeTx?: { url?: string; key?: string };
  filecoin?: { sessionKeyFile?: string; chain?: FilecoinChain; rpcUrl?: string };
  /**
   * Lit: the account key (a Lit master key), the per-run usage key, and the CID
   * of the encrypt action bundle. The CID is not a credential: it names the code
   * `/lit_action` executes, which is fetched from IPFS and hashed against this
   * value before it runs. There is no `decrypt` CID here until the CLI has a
   * caller for it.
   */
  lit?: { accountKey?: string; usageKey?: string; encryptActionCid?: string };
  ens?: { registry?: string };
  github?: { token?: string };
  /**
   * Protocol contracts this CLI installs through, per environment. Only the
   * `AuthorContractsFactory` for now: the two implementations and the factory
   * are deployed once and shared, and every author Safe is installed through
   * the same factory.
   */
  contracts?: { authorFactory?: string };
}

/** One settable leaf. `path` uses `*` for "one map label" (e.g. `pinning.*.key`). */
export interface ConfigFieldSpec {
  path: string;
  /** Env names in precedence order; the first non-empty one wins. */
  env: readonly string[];
  /** Masked in `config get`/`list`, and warned about in a project file. */
  secret?: boolean;
  /**
   * A URL that may carry a credential in its query string. Masking is per
   * value (the whole URL stays useful), and a project-file write that carries
   * one is warned about even though the leaf itself is not a secret.
   */
  url?: boolean;
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
  { path: 'pinning.*.provider', env: [] },
  { path: 'pinning.*.key', env: [], secret: true },
  { path: 'pinning.*.url', env: [], url: true },
  { path: 'ipfs.*.provider', env: [] },
  { path: 'ipfs.*.url', env: [], url: true },
  { path: 'ipfs.*.key', env: [], secret: true },
  { path: 'rpc.drpc.key', env: ['S2S_DRPC_KEY', 'VITE_DRPC_API_KEY'], secret: true },
  { path: 'rpc.alchemy.key', env: ['S2S_ALCHEMY_KEY', 'VITE_ALCHEMY_KEY'], secret: true },
  { path: 'rpc.infura.key', env: ['S2S_INFURA_KEY', 'VITE_INFURA_KEY', 'INFURA_KEY'], secret: true },
  // MAINNET_RPC_URL / BASE_RPC_URL are deliberately NOT aliases here: they head
  // the derived chain (shared `buildFallbackRpcs`) instead of replacing it, so a
  // single explicit endpoint never costs the failover. See `resolveRpcs`.
  { path: 'rpc.custom.l1', env: ['S2S_RPC_L1'], list: true, url: true },
  { path: 'rpc.custom.l2', env: ['S2S_RPC_L2'], list: true, url: true },
  {
    path: 'paymaster.key',
    env: ['S2S_PIMLICO_KEY', 'PIMLICO_KEY', 'PIMLICO_API_KEY'],
    secret: true,
  },
  // The two endpoints are independent escape hatches, not one setting: an
  // explicit bundler with no Pimlico key means NO sponsorship (see
  // `bundlerEndpoints`), and a paymaster URL never moves the bundler.
  { path: 'bundler.url', env: ['S2S_BUNDLER_URL'], url: true },
  { path: 'paymaster.url', env: ['S2S_PAYMASTER_URL'], url: true },
  // The Safe Transaction Service, the one place a multisig proposal exists
  // before it is executed. The key is optional: the public host answers
  // unauthenticated requests, it just rate-limits them.
  {
    path: 'safeTx.url',
    env: ['S2S_SAFE_TX_URL'],
    default: 'https://safe-transaction-base.safe.global',
    url: true,
  },
  { path: 'safeTx.key', env: ['S2S_SAFE_TX_API_KEY'], secret: true },
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
    url: true,
  },
  { path: 'lit.accountKey', env: ['LIT_ACCOUNT_KEY'], secret: true },
  { path: 'lit.usageKey', env: ['LIT_USAGE_KEY'], secret: true },
  // The action bundles are executed by CID; the CID is the identity of the code.
  // Not a secret — it is a hash, and it is what makes a dishonest gateway unable
  // to choose what runs next to the PKP.
  { path: 'lit.encryptActionCid', env: ['LIT_ENCRYPT_ACTION_CID'] },
  { path: 'ens.registry', env: ['S2S_ENS_REGISTRY'] },
  { path: 'github.token', env: ['GITHUB_TOKEN', 'S2S_GITHUB_TOKEN'], secret: true },
  // The deployed `AuthorContractsFactory` on Base. A protocol constant with a
  // shipped default, not a preference — overridable so a dev deployment (or a
  // redeploy) does not need a new CLI build.
  {
    path: 'contracts.authorFactory',
    env: ['S2S_AUTHOR_CONTRACTS_FACTORY'],
    default: '0xC70eEA1E873DDa4D260f080e3b1698fBC8BD9f2E',
  },
];

/**
 * Fields with no file home: env + builtin only.
 *
 * They are not settable (`matchField` does not see them) and are not written by
 * `config set` / `setup`. They stay in one table so the dot-path readers
 * (`config get`, the enum check, `defaultForPath`) still resolve them.
 */
export const ENV_ONLY_FIELDS: readonly ConfigFieldSpec[] = [
  { path: 'entryPoint', env: ['S2S_ENTRY_POINT'], default: '0.7', enumValues: ['0.6', '0.7'] },
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
  // The public Safe Transaction Service on Base. Typed here as well as in the
  // field registry: a missing or replaced defaults file must not leave the
  // signer commands without a transport.
  safeTx: { url: 'https://safe-transaction-base.safe.global' },
  // The deployed `AuthorContractsFactory` (Base). Typed here as well as in
  // `defaults.json` and the field registry, exactly as the gateway and the
  // Filecoin RPC are: a missing or replaced defaults file must not leave the
  // author contracts uninstallable.
  contracts: { authorFactory: '0xC70eEA1E873DDa4D260f080e3b1698fBC8BD9f2E' },
};

// ===========================================================================
// Path plumbing
// ===========================================================================

/**
 * Segments that would walk onto `Object.prototype` instead of the data.
 *
 * `config set ipfs.__proto__.url …` is argv, not a file a human wrote wrong:
 * without this the walker descends into the prototype and assigns a *global*
 * property. Rejected as a path segment wherever a path is split.
 */
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** Is this segment a prototype footgun rather than a label? */
export function isUnsafeSegment(segment: string): boolean {
  return UNSAFE_SEGMENTS.has(segment.trim());
}

/** Split a dotted path, rejecting empty or unsafe segments. */
function splitPath(dotted: string): string[] {
  const parts = dotted.split('.').map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    throw new Error(`invalid config path '${dotted}'`);
  }
  if (parts.some(isUnsafeSegment)) {
    throw new Error(`invalid config path '${dotted}': '__proto__', 'prototype' and 'constructor' are not labels`);
  }
  return parts;
}

/** Own-property read — an inherited name is not a value in this config. */
function own(node: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(node, key)
    ? (node as Record<string, unknown>)[key]
    : undefined;
}

/** Exact or `*`-aware match, returning the spec plus the concrete path. */
export function matchField(key: string): { spec: ConfigFieldSpec; path: string } | undefined {
  // An unsafe segment never matches: `matchField` is the gate `config set`
  // passes through, so rejecting here keeps the walkers unreachable.
  if (key.split('.').some(isUnsafeSegment)) return undefined;

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

/** The spec registered for exactly this path (wildcards included, env-only too). */
export function fieldByPath(path: string): ConfigFieldSpec | undefined {
  return (
    CONFIG_FIELDS.find((spec) => spec.path === path) ??
    ENV_ONLY_FIELDS.find((spec) => spec.path === path)
  );
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
    node = own(node, part);
  }
  return node;
}

/** Set one leaf, creating intermediate objects (never arrays). */
export function writePath(root: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = splitPath(dotted);
  let node = root;
  for (const part of parts.slice(0, -1)) {
    const next = own(node, part);
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      // Null-prototype: a created node cannot inherit (or be confused with) a
      // property of `Object.prototype`.
      const created: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
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
    const next = own(chain[chain.length - 1] as Record<string, unknown>, part);
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
 * empty strings are dropped, and a missing `provider` falls back to the label.
 * An `ipfs` entry survives with no url when it carries a key — that is a
 * credential waiting for its gateway in a lower layer, not a dead endpoint (the
 * resolved config drops url-less entries from `ipfs.entries`). Nothing throws —
 * every caller runs on a file a human can edit by hand.
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
    const key = textValue(entry.key);
    pinning[label] = {
      provider: textValue(entry.provider) ?? label,
      // Absent fields are OMITTED, never blanked: `mergeLabels` copies every
      // defined field, so a `key: ''` here would wipe the credential a lower
      // layer supplies for the same provider. Same rule as the `ipfs` map.
      ...(key === undefined ? {} : { key }),
      ...(url === undefined ? {} : { url }),
    };
  }
  if (Object.keys(pinning).length > 0) out.pinning = pinning;

  const ipfs: Record<string, IpfsEntry> = {};
  for (const [label, value] of Object.entries(objectValue(raw.ipfs) ?? {})) {
    const entry = objectValue(value);
    if (!entry) continue;
    const url = textValue(entry.url);
    const key = textValue(entry.key);
    if (url === undefined && key === undefined) continue;
    ipfs[label] = {
      provider: textValue(entry.provider) ?? label,
      ...(url === undefined ? {} : { url }),
      ...(key === undefined ? {} : { key }),
    };
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

  const bundler = compact({ url: textValue(objectValue(raw.bundler)?.url) });
  if (bundler) out.bundler = bundler;

  const safeTx = compact({
    url: textValue(objectValue(raw.safeTx)?.url),
    key: textValue(objectValue(raw.safeTx)?.key),
  });
  if (safeTx) out.safeTx = safeTx;

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
    encryptActionCid: textValue(objectValue(raw.lit)?.encryptActionCid),
  });
  if (lit) out.lit = lit;

  const ens = compact({ registry: textValue(objectValue(raw.ens)?.registry) });
  if (ens) out.ens = ens;

  const github = compact({ token: textValue(objectValue(raw.github)?.token) });
  if (github) out.github = github;

  const contracts = compact({ authorFactory: textValue(objectValue(raw.contracts)?.authorFactory) });
  if (contracts) out.contracts = contracts;

  return out;
}
