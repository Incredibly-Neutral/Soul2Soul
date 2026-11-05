// ============================================================================
// s2s config — manage the CLI's own settings (bring-your-own RPC, Kubo node,
// keys, …). Git-style surface: set / get / unset / list / path.
//
//   default file  ~/.config/s2s/config.json   (user config, 0600)
//   --local       ./.s2sconfig.json           (project config, cwd)
//
// Precedence: environment vars > project config > user config > defaults.
// Secrets (private keys, tokens) are masked in get/list output and warned
// about when stored in a project file (risk of committing them).
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
  CONFIG_FIELD,
  CONFIG_FIELDS,
  configFilePaths,
  maskSecret,
  writeConfigValue,
  type ConfigField,
} from '../core/configfile';
import { configKeyValue, loadConfig, type LoadConfigOptions } from '../core/config';

/**
 * Read-only pseudo-keys derived from the config — never stored, never written.
 *
 * `eoa` is the signing account derived from `privateKey` locally (no RPC). It is
 * NOT the author id: the author id is the Safe (see `s2s author address`,
 * which is counterfactual and needs an L2 read).
 *
 * `author` is the active stored author's pet name and `safe` its recorded Safe;
 * both are null when the signing key came from the env/project/user layers (or
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
  if (key === 'eoa') return '(unset — needs privateKey)';
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
  summary: 'target the project config file (.s2sconfig.json in cwd) instead of the user config',
};

function knownKeys(): string {
  return [...CONFIG_FIELDS.map((f) => f.key), `${DERIVED_KEYS.join(' ')} (derived)`].join(' ');
}

function requireField(args: ParsedArgs): ConfigField {
  const key = args.positionals[0];
  if (!key) {
    throw new UsageError('missing required argument: <key>');
  }
  const field = CONFIG_FIELD[key];
  if (!field) {
    throw new UsageError(`unknown config key '${key}' — known keys: ${knownKeys()}`);
  }
  return field;
}

/** Resolve the write target (user by default, project with --local). */
function writeTarget(args: ParsedArgs): { file: string; local: boolean; label: string } {
  const local = args.flags.local === true;
  const paths = configFilePaths();
  return local
    ? { file: paths.project, local: true, label: 'project' }
    : { file: paths.user, local: false, label: 'user' };
}

/**
 * `config set/unset privateKey` is a no-op while a stored author is active,
 * because the store outranks the user file. Say so instead of pretending the
 * write took effect.
 */
function warnIfAuthorStoreShadows(out: CliOut, field: ConfigField): void {
  if (field.key !== 'privateKey') return;
  const author = loadConfig().author;
  if (author?.source !== 'store' || !author.name) return;
  out.warn(
    `author '${author.name}' is active, so the stored key still signs — run \`s2s author switch <name>\` to pick another, or \`s2s author rm ${author.name}\` to fall back to this setting`,
  );
}

function setCommand(out: CliOut, args: ParsedArgs): void {
  const field = requireField(args);
  const value = args.positionals[1];
  if (value === undefined) {
    throw new UsageError(`missing required argument: <value> for '${field.key}'`);
  }
  if (field.enumValues && !field.enumValues.includes(value)) {
    throw new UsageError(
      `invalid value '${value}' for '${field.key}' — expected one of: ${field.enumValues.join(', ')}`,
    );
  }
  const target = writeTarget(args);
  const stored: unknown = field.list
    ? value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    : value;
  writeConfigValue(target.file, field.key, stored);
  warnIfAuthorStoreShadows(out, field);
  if (target.local && field.secret) {
    out.warn(
      `storing a secret in the project config file (${target.file}) — make sure .s2sconfig.json is gitignored`,
    );
  }
  out.result(
    { action: 'config.set', key: field.key, file: target.file, local: target.local },
    `set ${field.key} in ${target.label} config (${target.file})`,
  );
}

function getCommand(out: CliOut, args: ParsedArgs): void {
  const requested = args.positionals[0];
  if (requested !== undefined && isDerivedKey(requested)) {
    const value = derivedConfigValue(requested);
    out.result({ key: requested, value }, `${requested}: ${value ?? derivedFallback(requested)}`);
    return;
  }
  const field = requireField(args);
  const value = configKeyValue(field.key);
  const shown = field.secret && value !== undefined ? maskSecret(value) : value;
  out.result(
    { key: field.key, value: shown ?? null },
    `${field.key}: ${shown ?? '(unset)'}`,
  );
}

function unsetCommand(out: CliOut, args: ParsedArgs): void {
  const field = requireField(args);
  const target = writeTarget(args);
  writeConfigValue(target.file, field.key, undefined);
  warnIfAuthorStoreShadows(out, field);
  out.result(
    { action: 'config.unset', key: field.key, file: target.file, local: target.local },
    `unset ${field.key} in ${target.label} config (${target.file})`,
  );
}

function listCommand(out: CliOut): void {
  const entries = CONFIG_FIELDS.flatMap((f) => {
    const value = configKeyValue(f.key);
    if (value === undefined) return [];
    return [[f.key, f.secret ? maskSecret(value) : value] as const];
  });
  const table = entries.map(([key, value]) => `${key}: ${value}`).join('\n');
  const derivedValues = DERIVED_KEYS.map((key) => [key, derivedConfigValue(key)] as const);
  const derived = derivedValues
    .map(([key, value]) => `${key}: ${value ?? derivedFallback(key)}`)
    .join('\n');
  const userEnv = userEnvPath();
  const projectEnv = projectEnvPath();
  const envNotes = [
    `user env: ${userEnv}${existsSync(userEnv) ? '' : ' [not found]'}`,
    `project env: ${projectEnv}${existsSync(projectEnv) ? '' : ' [not found]'}`,
  ].join('\n');
  out.result(
    {
      config: Object.fromEntries(
        [...entries, ...derivedValues].filter(([, value]) => value !== null),
      ),
    },
    `Effective configuration (env > project > author store > user > defaults):\n\n${table}\n\n${derived}\n\n${envNotes}\n\nManage with: s2s config set <key> <value> [--local]`,
  );
}

function pathCommand(out: CliOut, args: ParsedArgs): void {
  const target = writeTarget(args);
  const userEnv = userEnvPath();
  const projectEnv = projectEnvPath();
  const userEnvExists = existsSync(userEnv);
  const projectEnvExists = existsSync(projectEnv);
  const env = {
    user: userEnv,
    userExists: userEnvExists,
    project: projectEnvExists ? projectEnv : null,
  };
  out.result(
    { path: target.file, env },
    [
      `${target.label} config: ${target.file}`,
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
    summary: 'print all effective config values',
    flags: {},
    run: listCommand,
  },
  {
    name: 'path',
    summary: 'print the config file path',
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

Precedence: environment vars > project config > author store > user config > defaults.
Env file:   $XDG_CONFIG_HOME/s2s/.env (default ~/.config/s2s/.env), then ./.env.
Known keys: ${knownKeys()}

Authors: 's2s author new/switch/list/rm' manage the stored identities the
'privateKey' fallback comes from.

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
    const text = commandHelp('config', command.name, command.summary, command.flags, command.params);
    out.result({ help: text }, text);
    return;
  }
  command.run(out, args);
}
