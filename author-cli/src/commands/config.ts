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

import type { ParsedArgs } from '../lib/args';
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
import { configKeyValue } from '../core/config';

export interface ConfigCommandSpec {
  name: string;
  summary: string;
  usage: string;
  run(out: CliOut, args: ParsedArgs): void;
}

function knownKeys(): string {
  return CONFIG_FIELDS.map((f) => f.key).join(' ');
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
  const userEnv = userEnvPath();
  const projectEnv = projectEnvPath();
  const envNotes = [
    `user env: ${userEnv}${existsSync(userEnv) ? '' : ' [not found]'}`,
    `project env: ${projectEnv}${existsSync(projectEnv) ? '' : ' [not found]'}`,
  ].join('\n');
  out.result(
    { config: Object.fromEntries(entries) },
    `Effective configuration (env > project > user > defaults):\n\n${table}\n\n${envNotes}\n\nManage with: s2s config set <key> <value> [--local]`,
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
    usage: 's2s config set <key> <value> [--local] [--json]',
    run: setCommand,
  },
  {
    name: 'get',
    summary: 'print the effective value for a key',
    usage: 's2s config get <key> [--json]',
    run: getCommand,
  },
  {
    name: 'unset',
    summary: 'remove a key from the config file',
    usage: 's2s config unset <key> [--local] [--json]',
    run: unsetCommand,
  },
  {
    name: 'list',
    summary: 'print all effective config values',
    usage: 's2s config list [--json]',
    run: listCommand,
  },
  {
    name: 'path',
    summary: 'print the config file path',
    usage: 's2s config path [--local] [--json]',
    run: pathCommand,
  },
];

function configHelp(): string {
  const rows = configCommands.map((c) => `  ${c.name.padEnd(6)} ${c.summary}`).join('\n');
  return `s2s config — manage the CLI's own settings (bring-your-own RPC, Kubo, keys)

Usage:
  s2s config <action> [flags]

Actions:
${rows}

Flags:
  --local   target the project config file (.s2sconfig.json in cwd)
            instead of the user config (~/.config/s2s/config.json)
  --json    emit the result as JSON on stdout (machine-readable)

Precedence: environment vars > project config > user config > defaults.
Env file:   $XDG_CONFIG_HOME/s2s/.env (default ~/.config/s2s/.env), then ./.env.
Known keys: ${knownKeys()}

Run "s2s config <action> --help" for details on an action.`;
}

/**
 * Dispatch `s2s config …` — called directly by cli.ts before any context is
 * built, so configuration works without a private key or RPC endpoint.
 */
export function runConfigGroup(
  out: CliOut,
  wantHelp: boolean,
  flags: Record<string, string | boolean>,
  action: string | undefined,
  positionals: string[],
): void {
  if (!action) {
    out.result({ help: configHelp() }, configHelp());
    return;
  }
  const command = configCommands.find((c) => c.name === action);
  if (!command) {
    throw new UsageError(
      `unknown config action '${action}' — expected one of: ${configCommands.map((c) => c.name).join(', ')}`,
    );
  }
  const usage = `${command.usage}\n\n${command.summary}`;
  if (wantHelp) {
    out.result({ help: usage }, usage);
    return;
  }
  command.run(out, { flags, positionals });
}
