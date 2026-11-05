// ============================================================================
// s2s setup — the guided first-run configuration.
//
// New installs are configured by someone who is NOT the protocol author: per
// service they either accept the value the CLI ships with (defaults.json, later
// a REST API) or paste their own. So the questions are only the ones a machine
// owner can actually answer — pinning, ipfs, rpc, paymaster, filecoin.
//
// It NEVER asks about lit / ens / github / privateKey:
//   * lit and ens are fixed protocol values that ship in defaults.json;
//   * github is resolved at publish time;
//   * the signing identity is the author store's job (`s2s author new`).
//
// It writes ONE file, the custom layer (`~/.config/s2s/custom.json`, 0600) and
// never the project file — a project file is a deliberate override, not
// something a wizard drops in the current directory.
//
// Dispatched by cli.ts before buildContext, like `config`: setup must work on a
// machine where no key, RPC or bundler exists yet.
// ============================================================================

import { flagBool, flagRows, GLOBAL_FLAGS, type ParsedArgs } from '../lib/args';
import type { StoreCommandSpec } from '../lib/command';
import { isInteractive, prompt } from '../lib/prompt';
import type { CliOut } from '../lib/out';
import { configKeyValue, configValueSource } from '../core/config';
import { configFilePaths, maskSecret, maskUrlCredential, writeConfigValue } from '../core/configfile';
import { matchField, type ConfigFieldSpec } from '../core/configschema';

type Section = 'pinning' | 'ipfs' | 'rpc' | 'paymaster' | 'filecoin';

/** Order the contract fixes: pinning, ipfs, rpc, paymaster, filecoin. */
const SECTION_ORDER: readonly Section[] = ['pinning', 'ipfs', 'rpc', 'paymaster', 'filecoin'];

interface SetupPrompt {
  section: Section;
  /** Dotted registry path (concrete — no `*`). See CONFIG_FIELDS in configschema.ts. */
  path: string;
  /** What the person is being asked for, in plain words. */
  question: string;
  /**
   * Written alongside the value when the path lives under a map label, so the
   * entry the wizard creates names its provider explicitly instead of relying
   * on the label default. (The merge still fills siblings field by field, but a
   * written custom.json should read on its own.)
   */
  label?: { path: string; value: string };
}

const SETUP_PROMPTS: readonly SetupPrompt[] = [
  {
    section: 'pinning',
    path: 'pinning.pinata.key',
    question: 'Pinata JWT (backup pinning)',
    label: { path: 'pinning.pinata.provider', value: 'pinata' },
  },
  {
    section: 'pinning',
    path: 'pinning.pinata.url',
    question: 'Pinata gateway host',
    label: { path: 'pinning.pinata.provider', value: 'pinata' },
  },
  {
    section: 'pinning',
    path: 'pinning.filebase.key',
    question: 'Filebase token (backup pinning)',
    label: { path: 'pinning.filebase.provider', value: 'filebase' },
  },
  {
    section: 'ipfs',
    path: 'ipfs.kubo.url',
    question: 'Kubo gateway URL',
    label: { path: 'ipfs.kubo.provider', value: 'kubo' },
  },
  {
    section: 'ipfs',
    path: 'ipfs.kubo.key',
    question: 'Kubo token (token-gated writes)',
    label: { path: 'ipfs.kubo.provider', value: 'kubo' },
  },
  { section: 'rpc', path: 'rpc.drpc.key', question: 'dRPC key' },
  { section: 'rpc', path: 'rpc.alchemy.key', question: 'Alchemy key' },
  { section: 'rpc', path: 'rpc.infura.key', question: 'Infura key' },
  { section: 'paymaster', path: 'paymaster.key', question: 'Pimlico API key (bundler + gas)' },
  { section: 'filecoin', path: 'filecoin.sessionKeyFile', question: 'Filecoin session-key file' },
  {
    section: 'filecoin',
    path: 'filecoin.chain',
    question: 'Filecoin chain (mainnet | calibration)',
  },
  { section: 'filecoin', path: 'filecoin.rpcUrl', question: 'Filecoin RPC URL' },
];

/** Which layer a value would resolve from today — what `[custom: …]` reports. */
type ValueSource = NonNullable<ReturnType<typeof configValueSource>> | 'unset';

const ACCEPT_DEFAULTS_FLAG = {
  type: 'boolean',
  summary: 'ask nothing and write nothing — keep every provided default (the non-TTY path)',
} as const;

/**
 * `pinning.pinata.key [custom: pi…abcd]` — source plus a safe rendering.
 *
 * Both kinds of credential are masked here, exactly as `config get`/`list` do
 * it: a secret between its hint, and a URL's query-string credential replaced
 * per value with the endpoint left readable (`filecoin.rpcUrl` carries a GLIF
 * key that way). A value the registry does not mark is shown as it is.
 */
function describe(
  spec: ConfigFieldSpec | undefined,
  source: ValueSource,
  value: string | undefined,
): string {
  if (source === 'unset' || value === undefined) return 'unset';
  const shown =
    value.length === 0
      ? ''
      : spec?.secret === true
        ? maskSecret(value)
        : spec?.url === true
          ? maskUrlCredential(value)
          : value;
  return `${source}: ${shown}`;
}

function summary(written: string[], kept: string[], file: string): string {
  const head =
    written.length === 0
      ? `Nothing written — every provided default kept (${kept.length} setting${kept.length === 1 ? '' : 's'}).`
      : [
          `Wrote ${written.length} value${written.length === 1 ? '' : 's'} to ${file}:`,
          ...written.map((path) => `  ${path}`),
          `Kept ${kept.length} provided default${kept.length === 1 ? '' : 's'}.`,
        ].join('\n');
  return `${head}\n\nChange a value later with: s2s config set <path> <value>\nSee what is in effect with: s2s config list`;
}

async function runSetup(out: CliOut, args: ParsedArgs): Promise<void> {
  const acceptDefaults = flagBool(args.flags, 'accept-defaults');
  const paths = configFilePaths();
  const env = process.env;
  const written: string[] = [];
  const kept: string[] = [];

  out.log(`s2s setup — pasted values are written to ${paths.user}`);
  out.log('Press enter to accept the value shown; nothing is written unless you paste.');
  if (!acceptDefaults && !isInteractive()) {
    out.warn(
      'stdin is not a terminal, so nothing is asked — every default kept (pass --accept-defaults to skip this run silently)',
    );
  }

  for (const section of SECTION_ORDER) {
    out.log(`\n${section}`);
    for (const step of SETUP_PROMPTS.filter((candidate) => candidate.section === section)) {
      const spec = matchField(step.path)?.spec;
      // Ask the merger, not a second opinion: legacy and label shorthands are
      // only labelled correctly when the answer comes from real resolution.
      const current = configKeyValue(step.path, env) ?? spec?.default;
      const source = configValueSource(step.path, env) ?? 'unset';
      const shown = describe(spec, source, current);

      if (acceptDefaults) {
        kept.push(step.path);
        out.log(`  ${step.path}: kept (${shown})`);
        continue;
      }

      const answer = await prompt(`  ${step.question} [${shown}] — enter keeps, paste replaces: `, {
        secret: spec?.secret === true,
      });
      const value = answer?.trim() ?? '';
      if (value.length === 0) {
        kept.push(step.path);
        continue;
      }
      if (spec?.enumValues && !spec.enumValues.includes(value)) {
        out.warn(
          `'${value}' is not one of ${spec.enumValues.join(', ')} for ${step.path} — kept the current value`,
        );
        kept.push(step.path);
        continue;
      }

      const stored: unknown = spec?.list
        ? value
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
        : value;
      writeConfigValue(paths.user, step.path, stored);
      // The label's provider is implied by the map key, not a separate answer
      // — it is written so the custom entry is self-describing.
      if (step.label) writeConfigValue(paths.user, step.label.path, step.label.value);
      written.push(step.path);
      out.log(`  wrote ${step.path}`);
    }
  }

  out.result({ action: 'setup', written, kept }, summary(written, kept, paths.user));
}

/** `s2s setup --help`, rendered from the same flag table the parser uses. */
export function setupHelp(): string {
  return [
    's2s setup [flags]',
    '',
    'Configure this machine: accept the values the CLI ships with, or paste your own.',
    'Asks about pinning, ipfs, rpc, paymaster and filecoin only — in that order.',
    'Pasted values are written to the custom config file; defaults are never copied.',
    '',
    `Flags:\n${flagRows({ 'accept-defaults': ACCEPT_DEFAULTS_FLAG })}`,
    '',
    `Global flags:\n${flagRows({}, GLOBAL_FLAGS)}`,
  ].join('\n');
}

export const setup: StoreCommandSpec = {
  name: 'setup',
  summary: 'configure this machine — accept the provided defaults or paste your own keys',
  flags: { 'accept-defaults': ACCEPT_DEFAULTS_FLAG },
  run: runSetup,
};
