// ============================================================================
// s2s config — manage the CLI's own settings (bring-your-own RPC, Kubo node,
// keys, …). Git-style surface: set / get / unset / list / path.
//
// Keys are DOTTED PATHS into the nested config schema, matching the registry in
// core/configschema.ts one-for-one:
//
//   s2s config set pinning.pinata.key <jwt>
//   s2s config set rpc.custom.l1 https://a,https://b
//   s2s config get ipfs.kubo.url
//   s2s config unset paymaster.key --local
//
// Layers, highest first (see core/config.ts — it is the only merger):
//
//   env  >  project (./.s2sconfig.json)  |  custom (~/.config/s2s/custom.js)
//        >  legacy (~/.config/s2s/config.json, read-only)
//        >  defaults (<dist>/defaults.json)
//
// `set`/`unset` write the CUSTOM file by default (~/.config/s2s/custom.json),
// or the project file with `--local`. Secrets are masked in get/list output and
// warned about when they land in a project file (risk of committing them).
//
// `privateKey` is deliberately NOT a settable key of this surface any more:
// the signing identity lives in the author store (authors.json), reached
// through `s2s author new` / `s2s author switch`. Setting it here would
// silently lose to the active stored author, so it is refused with a pointer
// instead. `unset privateKey` is the exception, and has to be: core/config.ts
// still honours a `privateKey` left in a config file (the deprecated fallback
// for installs that predate the store), so the same tool has to be able to take
// that stranded secret back out of the file.
//
// This group never touches buildContext — configuring the CLI must work
// without a private key or any RPC endpoint.
// ============================================================================

import { existsSync } from 'node:fs';

import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

import { commandHelp, flagRows, GLOBAL_FLAGS, type FlagSpec, type ParsedArgs } from '../lib/args';
import { projectEnvPath, userEnvPath } from '../lib/env';
import { UsageError } from '../lib/errors';
import type { CliOut } from '../lib/out';
import {
  configFilePaths,
  maskSecret,
  maskUrlCredential,
  readConfigFile,
  readConfigRaw,
  urlHasCredential,
  writeConfigValue,
} from '../core/configfile';
import { configKeyValue, configSections, loadConfig, type LoadConfigOptions } from '../core/config';
import {
  CONFIG_FIELDS,
  fieldByPath,
  matchField,
  readPath,
  type ConfigFieldSpec,
} from '../core/configschema';

/**
 * Read-only pseudo-keys derived from the config — never stored, never written.
 *
 * `eoa` is the signing account derived from `privateKey` locally (no RPC). It is
 * NOT the author id: the author id is the Safe (see `s2s author address`,
 * which is counterfactual and needs an L2 read).
 *
 * `author` is the active stored author's pet name and `safe` its recorded Safe;
 * both are null when the signing key came from the env/project layers (or
 * when no Safe has been predicted for that author yet).
 */
export const DERIVED_KEYS = ['eoa', 'author', 'safe'] as const;

export function isDerivedKey(key: string): boolean {
  return (DERIVED_KEYS as readonly string[]).includes(key);
}

export function derivedConfigValue(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: LoadConfigOptions = {},
): string | null {
  if (!isDerivedKey(key)) return null;
  const config = loadConfig(env, opts);
  if (key === 'author') return config.author?.name ?? null;
  if (key === 'safe') return config.author?.safe ?? null;

  const privateKey = config.privateKey;
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) return null;
  try {
    return privateKeyToAccount(privateKey as Hex).address;
  } catch {
    return null;
  }
}

/** Human fallback for a derived key that has no value. */
function derivedFallback(key: string): string {
  if (key === 'eoa') return '(unset — needs a signing key)';
  return '(none)';
}

export interface ConfigCommandSpec {
  name: string;
  summary: string;
  /** Positional signature for usage/help, e.g. `<key> <value>`. */
  params?: string;
  flags: Record<string, FlagSpec>;
  run(out: CliOut, args: ParsedArgs): void;
}

/** `--local` — the one flag of the config group (declared once). */
const LOCAL_FLAG: FlagSpec = {
  type: 'boolean',
  summary: 'target the project config file (.s2sconfig.json in cwd) instead of the custom config',
};

/** One settable leaf: the registry spec plus the concrete dotted path it matched. */
interface ResolvedField {
  spec: ConfigFieldSpec;
  path: string;
}

function knownKeys(): string {
  return [
    ...CONFIG_FIELDS.map((field) => field.path),
    'entryPoint (env-only)',
    ...DERIVED_KEYS.map((k) => `${k} (derived)`),
  ].join(' ');
}

/**
 * The signing key is not a config-file key any more. Point at the author store
 * instead of a generic "unknown key" — everyone who tries this needs the same
 * two commands.
 */
const PRIVATE_KEY_REDIRECT =
  'privateKey is not a config key — the signing identity lives in the author store. Create one with `s2s author new`, or pick an existing one with `s2s author switch <name>`';

function rejectPrivateKey(key: string): void {
  if (key === 'privateKey') throw new UsageError(PRIVATE_KEY_REDIRECT);
}

/** Where the signing key may still be sitting, for `unset privateKey`. */
function fileKeyPresent(path: string): boolean {
  return path !== '' && readConfigFile(path).privateKey !== undefined;
}

function requireField(args: ParsedArgs, action: 'read' | 'write' = 'read'): ResolvedField {
  const key = args.positionals[0];
  if (!key) {
    throw new UsageError('missing required argument: <key>');
  }
  rejectPrivateKey(key);
  const found = matchField(key);
  if (!found) {
    const envOnly = fieldByPath(key);
    if (envOnly) {
      // `entryPoint` has no file home: only the env is read. `get` can still
      // report it, but a write would sit in a file doing nothing.
      if (action === 'read') return { spec: envOnly, path: key };
      throw new UsageError(
        `'${key}' is env-only — set it with ${envOnly.env.join(' or ')} (a file value would never be read)`,
      );
    }
    throw new UsageError(`unknown config key '${key}' — known keys: ${knownKeys()}`);
  }
  return { spec: found.spec, path: found.path };
}

/** Resolve the write target (custom by default, project with --local). */
function writeTarget(args: ParsedArgs): { file: string; local: boolean; label: string } {
  const local = args.flags.local === true;
  const paths = configFilePaths();
  return local
    ? { file: paths.project, local: true, label: 'project' }
    : { file: paths.user, local: false, label: 'custom' };
}

/** Masks the leaves the registry marks secret (or carries a URL credential). */
function maskDeep(value: unknown, path = ''): unknown {
  const spec = path.length > 0 ? matchField(path)?.spec : undefined;
  if (Array.isArray(value)) {
    return spec?.url
      ? value.map((item) => (typeof item === 'string' ? maskUrlCredential(item) : item))
      : value;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        maskDeep(child, path ? `${path}.${key}` : key),
      ]),
    );
  }
  if (typeof value === 'string') {
    if (spec?.secret) return maskSecret(value);
    if (spec?.url) return maskUrlCredential(value);
  }
  return value;
}

/** Mask one resolved leaf for `get` (a list is masked entry by entry). */
function maskedValue(spec: ConfigFieldSpec, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (spec.secret) return maskSecret(value);
  if (spec.url) {
    return value
      .split(',')
      .map((part) => maskUrlCredential(part.trim()))
      .join(',');
  }
  return value;
}

/** Leaf rendering — config leaves are strings, numbers or booleans only. */
function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return value.toString();
  return '';
}

/** Flatten the effective nested config into `dotted.path: value` rows. */
function flattenRows(value: unknown, prefix = ''): [string, string][] {
  if (Array.isArray(value)) {
    const list = (value as unknown[]).map((item) => scalarText(item)).join(', ');
    return prefix ? [[prefix, list]] : [];
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      flattenRows(child, prefix ? `${prefix}.${key}` : key),
    );
  }
  if (prefix.length === 0) return [];
  const text = scalarText(value);
  return text.length === 0 ? [] : [[prefix, text]];
}

function setCommand(out: CliOut, args: ParsedArgs): void {
  const { spec, path } = requireField(args, 'write');
  const value = args.positionals[1];
  if (value === undefined) {
    throw new UsageError(`missing required argument: <value> for '${path}'`);
  }
  if (spec.enumValues && !spec.enumValues.includes(value)) {
    throw new UsageError(
      `invalid value '${value}' for '${path}' — expected one of: ${spec.enumValues.join(', ')}`,
    );
  }
  const target = writeTarget(args);
  const stored: unknown = spec.list
    ? value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    : value;
  writeConfigValue(target.file, path, stored);
  // A project file is the one that gets committed. A secret is obvious; a URL
  // with `?apikey=` is the same leak wearing a different hat.
  const carriesCredential =
    spec.url === true &&
    (Array.isArray(stored)
      ? stored.some((part) => typeof part === 'string' && urlHasCredential(part))
      : typeof stored === 'string' && urlHasCredential(stored));
  if (target.local && (spec.secret || carriesCredential)) {
    const kind = spec.secret ? 'secret' : 'credential';
    out.warn(
      `storing a ${kind} in the project config file (${target.file}) — make sure .s2sconfig.json is gitignored`,
    );
  }
  out.result(
    { action: 'config.set', key: path, file: target.file, local: target.local },
    `set ${path} in ${target.label} config (${target.file})`,
  );
}

function getCommand(out: CliOut, args: ParsedArgs): void {
  const requested = args.positionals[0];
  if (requested !== undefined && isDerivedKey(requested)) {
    const value = derivedConfigValue(requested);
    out.result({ key: requested, value }, `${requested}: ${value ?? derivedFallback(requested)}`);
    return;
  }
  const { spec, path } = requireField(args);
  const value = configKeyValue(path);
  const shown = maskedValue(spec, value);
  out.result({ key: path, value: shown ?? null }, `${path}: ${shown ?? '(unset)'}`);
}

function unsetCommand(out: CliOut, args: ParsedArgs): void {
  const key = args.positionals[0];
  if (!key) {
    throw new UsageError('missing required argument: <key>');
  }
  // The retired key is the one exception on this action: it can no longer be
  // set, but a copy left behind by an older install still resolves, so it must
  // be removable from here or the secret is stranded in the file.
  if (key === 'privateKey') {
    unsetPrivateKey(out, args);
    return;
  }
  const { path } = requireField(args, 'write');
  const target = writeTarget(args);
  // A plain delete only works when the target file actually holds the value
  // and nothing else supplies it. If a lower layer would answer after the
  // delete (legacy, defaults, builtin), write a null tombstone: the merge reads
  // it as "unset", so the value really stops resolving. The same is true when
  // the target holds a copy and a lower layer holds another.
  const raw = readPath(readConfigRaw(target.file), path);
  const paths = configFilePaths();
  const withoutTarget = target.local
    ? {
        userConfigPath: paths.user,
        projectConfigPath: '',
        legacyConfigPath: paths.legacy,
        defaultsPath: paths.defaults,
      }
    : {
        userConfigPath: '',
        projectConfigPath: paths.project,
        legacyConfigPath: paths.legacy,
        defaultsPath: paths.defaults,
      };
  const stillSupplied = configKeyValue(path, process.env, withoutTarget) !== undefined;
  const tombstone = raw === null || stillSupplied;
  writeConfigValue(target.file, path, tombstone ? null : undefined);
  out.result(
    {
      action: 'config.unset',
      key: path,
      file: target.file,
      local: target.local,
      ...(tombstone ? { tombstone: true } : {}),
    },
    `unset ${path} in ${target.label} config (${target.file})${tombstone ? ' (wrote an explicit null so a lower layer stops supplying it)' : ''}`,
  );
}

/**
 * Remove a stranded `privateKey` from the target config file.
 *
 * `--local` targets the project file, the default the custom file. The legacy
 * file (~/.config/s2s/config.json) is read-only here by design, so a copy
 * there is reported with its path and left for a human to delete — silently
 * skipping it would leave the user "unset" and still signing with it.
 */
function unsetPrivateKey(out: CliOut, args: ParsedArgs): void {
  const target = writeTarget(args);
  const existed = fileKeyPresent(target.file);
  // Only touch the file when there is something in it: an unset must not
  // create an empty custom.json for someone who never had one.
  if (existed) writeConfigValue(target.file, 'privateKey', undefined);

  const legacy = configFilePaths().legacy;
  const stranded = legacy !== target.file && fileKeyPresent(legacy);
  if (!existed) {
    out.warn(
      stranded
        ? `no privateKey in ${target.file} — but the legacy config file ${legacy} has one. The CLI never writes that file; delete the privateKey line from it by hand.`
        : `no privateKey in ${target.file} — nothing to remove`,
    );
  } else if (stranded && target.file !== legacy) {
    out.warn(
      `the legacy config file ${legacy} also holds a privateKey — delete that line by hand too (the CLI never writes it)`,
    );
  }

  out.result(
    { action: 'config.unset', key: 'privateKey', file: target.file, local: target.local },
    existed
      ? `removed privateKey from ${target.label} config (${target.file})\nThe signing key is the author store's job now: \`s2s author new\` files one, \`s2s author switch\` picks between them.`
      : `privateKey is not in the ${target.label} config (${target.file})`,
  );
}

function listCommand(out: CliOut): void {
  const sections = configSections();
  // Mask before flattening so the table and the JSON payload can never differ.
  const masked = maskDeep(sections);
  const rows = flattenRows(masked);
  const derived = Object.fromEntries(
    DERIVED_KEYS.map((key) => [key, derivedConfigValue(key)] as const),
  ) as Record<string, string | null>;

  if (out.json) {
    out.result({ action: 'config.list', config: masked, derived });
    return;
  }

  const table = rows.map(([path, value]) => `${path}: ${value}`).join('\n');
  const derivedRows = DERIVED_KEYS.map(
    (key) => `${key}: ${derived[key] ?? derivedFallback(key)}`,
  ).join('\n');
  const userEnv = userEnvPath();
  const projectEnv = projectEnvPath();
  const envNotes = [
    `user env: ${userEnv}${existsSync(userEnv) ? '' : ' [not found]'}`,
    `project env: ${projectEnv}${existsSync(projectEnv) ? '' : ' [not found]'}`,
  ].join('\n');

  out.result(
    { action: 'config.list', config: masked, derived },
    `Effective configuration (env > project > custom > legacy > defaults):\n\n${table || '(nothing set)'}\n\n${derivedRows}\n\n${envNotes}\n\nManage with: s2s config set <dotted.path> <value> [--local]`,
  );
}

function pathCommand(out: CliOut, args: ParsedArgs): void {
  const target = writeTarget(args);
  const paths = configFilePaths();
  const userEnv = userEnvPath();
  const projectEnv = projectEnvPath();
  const userEnvExists = existsSync(userEnv);
  const projectEnvExists = existsSync(projectEnv);
  const files = {
    custom: paths.user,
    project: paths.project,
    legacy: paths.legacy,
    defaults: paths.defaults,
  };
  const env = {
    user: userEnv,
    userExists: userEnvExists,
    project: projectEnvExists ? projectEnv : null,
  };
  out.result(
    { path: target.file, files, env, local: target.local },
    [
      `${target.label} config:  ${target.file}`,
      `custom config:  ${files.custom}`,
      `project config: ${files.project}`,
      `legacy config:  ${files.legacy} (read-only fallback)`,
      `defaults:       ${files.defaults}`,
      `env file (user):    ${userEnv}${userEnvExists ? '' : '  [not found]'}`,
      `env file (project): ${projectEnv}${projectEnvExists ? '' : '  [not found]'}`,
    ].join('\n'),
  );
}

export const configCommands: readonly ConfigCommandSpec[] = [
  {
    name: 'set',
    summary: 'set a config value (writes the config file)',
    params: '<key> <value>',
    flags: { local: LOCAL_FLAG },
    run: setCommand,
  },
  {
    name: 'get',
    summary: 'print the effective value for a key',
    params: '<key>',
    flags: {},
    run: getCommand,
  },
  {
    name: 'unset',
    summary: 'remove a key from the config file',
    params: '<key>',
    flags: { local: LOCAL_FLAG },
    run: unsetCommand,
  },
  {
    name: 'list',
    summary: 'print every effective value (secrets masked)',
    flags: {},
    run: listCommand,
  },
  {
    name: 'path',
    summary: 'print the config file paths',
    flags: { local: LOCAL_FLAG },
    run: pathCommand,
  },
];

export function findConfigCommand(name: string): ConfigCommandSpec | undefined {
  return configCommands.find((c) => c.name === name);
}

function configHelp(): string {
  const labels = configCommands.map((c) => [c.name, c.params].filter(Boolean).join(' '));
  const width = Math.max(...labels.map((label) => label.length));
  const rows = configCommands
    .map((c, i) => `  ${(labels[i] ?? c.name).padEnd(width)}  ${c.summary}`)
    .join('\n');
  return `s2s config — manage the CLI's own settings (bring-your-own RPC, Kubo, keys)

Usage:
  s2s config <action> [flags]

Actions:
${rows}

Flags:
${flagRows({ local: LOCAL_FLAG })}

Global flags:
${flagRows({}, GLOBAL_FLAGS)}

Keys are dotted paths into the service-grouped config:
  environment            dev | prod
  pinning.<label>.key    pinning.<label>.url    pinning.<label>.provider
  ipfs.<label>.url       ipfs.<label>.key       ipfs.<label>.provider
  rpc.drpc.key           rpc.alchemy.key        rpc.infura.key
  rpc.custom.l1          rpc.custom.l2          (comma-separated)
  paymaster.key          paymaster.url
  filecoin.sessionKeyFile  filecoin.chain       filecoin.rpcUrl
  lit.accountKey         lit.usageKey
  ens.registry           github.token           entryPoint (env-only)

<label> is any name you choose (e.g. pinning.my-pinner). The same provider is
merged field by field across layers; naming a different provider replaces the
entry whole. A URL may be written without its key, and the key without its URL.

Precedence: env > project > custom > legacy (read-only) > defaults.
Layers:     project = ./.s2sconfig.json, custom = ~/.config/s2s/custom.json.
Env file:   $XDG_CONFIG_HOME/s2s/.env (default ~/.config/s2s/.env), then ./.env.
Known keys: ${knownKeys()}

The signing key is not managed here: 's2s author new/switch/list/rm' own the
identities, and 's2s config get eoa' shows the address they sign with.
An older install's 'privateKey' in a config file still resolves (below the
store); take it out with 's2s config unset privateKey [--local]'.

Run "s2s config <action> --help" for details on an action.`;
}

/**
 * Dispatch `s2s config …` — called directly by cli.ts before any context is
 * built, so configuration works without a private key or RPC endpoint.
 */
export function runConfigGroup(
  out: CliOut,
  wantHelp: boolean,
  action: string | undefined,
  command: ConfigCommandSpec | undefined,
  args: ParsedArgs,
): void {
  if (!action) {
    out.result({ help: configHelp() }, configHelp());
    return;
  }
  if (!command) {
    throw new UsageError(
      `unknown config action '${action}' — expected one of: ${configCommands.map((c) => c.name).join(', ')}`,
    );
  }
  if (wantHelp) {
    const text = commandHelp(
      'config',
      command.name,
      command.summary,
      command.flags,
      command.params,
    );
    out.result({ help: text }, text);
    return;
  }
  command.run(out, args);
}
