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
// `privateKey` is deliberately NOT a key of this surface any more: the signing
// identity lives in the author store (authors.json), reached through
// `s2s author new` / `s2s author switch`. Setting it here would silently lose
// to the active stored author, so it is refused with a pointer instead.
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
import { configFilePaths, maskSecret, writeConfigValue } from '../core/configfile';
import { configKeyValue, configSections, loadConfig, type LoadConfigOptions } from '../core/config';
import { CONFIG_FIELDS, matchField, type ConfigFieldSpec } from '../core/configschema';

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

function requireField(args: ParsedArgs): ResolvedField {
  const key = args.positionals[0];
  if (!key) {
    throw new UsageError('missing required argument: <key>');
  }
  rejectPrivateKey(key);
  const found = matchField(key);
  if (!found) {
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

/** Masks the leaves the registry marks secret, at any depth. Lists stay readable. */
function maskDeep(value: unknown, path = ''): unknown {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        maskDeep(child, path ? `${path}.${key}` : key),
      ]),
    );
  }
  if (typeof value === 'string' && matchField(path)?.spec.secret) return maskSecret(value);
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
  const { spec, path } = requireField(args);
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
  if (target.local && spec.secret) {
    out.warn(
      `storing a secret in the project config file (${target.file}) — make sure .s2sconfig.json is gitignored`,
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
  const shown = spec.secret && value !== undefined ? maskSecret(value) : value;
  out.result({ key: path, value: shown ?? null }, `${path}: ${shown ?? '(unset)'}`);
}

function unsetCommand(out: CliOut, args: ParsedArgs): void {
  const { path } = requireField(args);
  const target = writeTarget(args);
  writeConfigValue(target.file, path, undefined);
  out.result(
    { action: 'config.unset', key: path, file: target.file, local: target.local },
    `unset ${path} in ${target.label} config (${target.file})`,
  );
}

function listCommand(out: CliOut): void {
  const sections = configSections();
  const rows = flattenRows(sections).map(([path, value]) => {
    const secret = matchField(path)?.spec.secret === true;
    return [path, secret ? maskSecret(value) : value] as const;
  });
  const derived = Object.fromEntries(
    DERIVED_KEYS.map((key) => [key, derivedConfigValue(key)] as const),
  ) as Record<string, string | null>;

  if (out.json) {
    out.result({ action: 'config.list', config: maskDeep(sections), derived });
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
    { action: 'config.list', config: maskDeep(sections), derived },
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
  ens.registry           github.token           entryPoint

<label> is any name you choose (e.g. pinning.my-pinner); a higher layer replaces
that whole entry, it never inherits field-by-field.

Precedence: env > project > custom > legacy (read-only) > defaults.
Layers:     project = ./.s2sconfig.json, custom = ~/.config/s2s/custom.json.
Env file:   $XDG_CONFIG_HOME/s2s/.env (default ~/.config/s2s/.env), then ./.env.
Known keys: ${knownKeys()}

The signing key is not managed here: 's2s author new/switch/list/rm' own the
identities, and 's2s config get eoa' shows the address they sign with.

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
