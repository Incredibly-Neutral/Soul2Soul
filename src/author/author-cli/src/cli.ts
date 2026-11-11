// ============================================================================
// s2s — Soul2Soul headless authoring CLI.
//
// Top-level dispatch: `s2s <group> <action> [flags]`.
// Groups: `author` (author identities + content actions), `publication`
// (publication lifecycle), and `config` (CLI settings — dispatched without a
// context build).
// Flags parse anywhere; `--json` switches stdout to a machine-readable JSON
// envelope (Neovim plugin contract). Human progress always goes to stderr.
//
// Parsing happens twice on purpose: a lenient pass finds the group and action
// (nothing else is known yet), then the resolved command's own flag spec drives
// a strict pass that rejects unknown flags. `--help` renders from that same spec.
// ============================================================================

import { commandHelp, flagBool, parseArgs, parseCommandArgs } from './lib/args';
import { CliError, UsageError, ActionError, describeError } from './lib/errors';
import { loadEnvFiles } from './lib/env';
import { createOut, SCHEMA_VERSION } from './lib/out';
import { loadConfig } from './core/config';
import { buildContext } from './core/context';
import {
  authorHelpEntries,
  findAuthorCommand,
  findAuthorStoreCommand,
  findPublicationCommand,
  findSignerCommand,
  publicationCommands,
  signerHelpEntries,
} from './commands';
import { findConfigCommand, runConfigGroup } from './commands/config';
import { setup, setupHelp } from './commands/setup';

const VERSION = '0.1.0';

const TOP_HELP = `s2s — Soul2Soul headless authoring CLI (v${VERSION})

Usage:
  s2s <group> <action> [flags]
  s2s setup [flags]

Groups:
  author        Author identities + content actions (new/switch/list/rm, upload, publish)
  signer        Add a key as a Safe owner, list the queue, confirm a proposal
  publication   Create publications
  config        Manage CLI settings (bring-your-own RPC, Kubo, keys)

Commands:
  setup         Configure this machine: accept the provided defaults or paste your own keys

Global flags:
  --json        emit the result as JSON on stdout (machine-readable)
  -h, --help    show help for the current level
  --version     print the CLI version

Run "s2s author --help", "s2s signer --help" or "s2s publication --help" for the actions.`;

/** Set in `main`; the failure handler prints in the same mode the run chose. */
let jsonMode = false;

/** The fields `--help` needs from any command, context-free or not. */
interface HelpEntry {
  name: string;
  summary: string;
  params?: string;
}

function groupHelp(commands: readonly HelpEntry[], group: string, tagline: string): string {
  const labels = commands.map((c) => [c.name, c.params].filter(Boolean).join(' '));
  const width = Math.max(...labels.map((label) => label.length));
  const rows = commands
    .map((c, i) => `  ${(labels[i] ?? c.name).padEnd(width)}  ${c.summary}`)
    .join('\n');
  return `s2s ${group} — ${tagline}

Usage:
  s2s ${group} <action> [flags]

Actions:
${rows}

Run "s2s ${group} <action> --help" for details on an action.`;
}

const authorHelp = (): string =>
  groupHelp(authorHelpEntries, 'author', 'author identities and content actions');
const signerHelp = (): string =>
  groupHelp(signerHelpEntries, 'signer', 'a key as one owner of a Safe that already exists');
const publicationHelp = (): string =>
  groupHelp(publicationCommands, 'publication', 'publication lifecycle');

async function main(argv: string[]): Promise<number> {
  // Discovery pass — lenient, because the command that owns the flag spec has
  // not been identified yet. Anything it mis-reads is re-read strictly below.
  const discovery = parseArgs(argv);
  jsonMode = flagBool(discovery.flags, 'json');
  const out = createOut(jsonMode);
  const wantHelp = (['help', 'h', 'version'] as const).some((k) => flagBool(discovery.flags, k));

  const group = discovery.positionals[0];
  const action = discovery.positionals[1];

  // Top level: version or help or bare invocation.
  if (flagBool(discovery.flags, 'version') || (argv.length === 0 && !group)) {
    out.result(
      { name: 's2s', version: VERSION },
      `s2s v${VERSION} — Soul2Soul headless authoring CLI`,
    );
    return 0;
  }

  if (!group) {
    out.result({ help: TOP_HELP }, TOP_HELP);
    return 0;
  }

  // `config` is dispatched without building a context (no private key / RPC
  // needed) so the CLI can be configured before anything else is set up.
  if (group === 'config') {
    const configCommand = action ? findConfigCommand(action) : undefined;
    // An unknown action is reported by runConfigGroup with the list of actions,
    // so skip the strict pass rather than blaming the flags first.
    const parsed = configCommand
      ? parseCommandArgs(argv, configCommand.flags)
      : { flags: {}, positionals: [] };
    runConfigGroup(out, wantHelp, action, configCommand, {
      flags: parsed.flags,
      positionals: parsed.positionals.slice(2),
    });
    return 0;
  }

  // `setup` is a top-level command (not a member of `author`/`publication`) and
  // is dispatched before buildContext for the same reason `config` is: it is
  // how a machine gets configured in the first place.
  if (group === 'setup') {
    if (wantHelp) {
      const text = setupHelp();
      out.result({ help: text }, text);
      return 0;
    }
    const parsed = parseCommandArgs(argv, setup.flags);
    await setup.run(out, { flags: parsed.flags, positionals: parsed.positionals.slice(1) });
    return 0;
  }

  // `signer` is a group of store commands: adding a key to an existing Safe,
  // reading its queue and signing a hash need no context, no bundler and no
  // userOp. Dispatched before buildContext for the same reason `author new` is:
  // it files the key that every later command would otherwise require.
  if (group === 'signer') {
    const help = signerHelp();
    if (!action) {
      out.result({ help }, help);
      return 0;
    }
    const signerCommand = findSignerCommand(action);
    if (!signerCommand) {
      throw new UsageError(`unknown signer action '${action}'`);
    }
    const text = commandHelp(
      'signer',
      signerCommand.name,
      signerCommand.summary,
      signerCommand.flags,
      signerCommand.params,
    );
    if (wantHelp) {
      out.result({ help: text }, text);
      return 0;
    }
    const parsed = parseCommandArgs(argv, signerCommand.flags);
    await signerCommand.run(out, {
      flags: parsed.flags,
      positionals: parsed.positionals.slice(2),
    });
    return 0;
  }

  if (group !== 'author' && group !== 'publication') {
    throw new UsageError(
      `unknown command group '${group}' — expected 'author', 'signer', 'publication', 'config', or 'setup'`,
    );
  }

  const findCommand = group === 'author' ? findAuthorCommand : findPublicationCommand;
  const help = group === 'author' ? authorHelp() : publicationHelp();

  if (!action) {
    out.result({ help }, help);
    return 0;
  }

  // The author-store actions (new / switch / list / rm) are dispatched before
  // buildContext, like `config`: they manage identities, so requiring one to
  // already be configured would be circular.
  if (group === 'author') {
    const storeCommand = findAuthorStoreCommand(action);
    if (storeCommand) {
      const text = commandHelp(
        'author',
        storeCommand.name,
        storeCommand.summary,
        storeCommand.flags,
        storeCommand.params,
      );
      if (wantHelp) {
        out.result({ help: text }, text);
        return 0;
      }
      const parsed = parseCommandArgs(argv, storeCommand.flags);
      await storeCommand.run(out, {
        flags: parsed.flags,
        positionals: parsed.positionals.slice(2),
      });
      return 0;
    }
  }

  const command = findCommand(action);
  if (!command) {
    throw new UsageError(`unknown ${group} action '${action}'`);
  }

  if (wantHelp) {
    const text = commandHelp(group, command.name, command.summary, command.flags, command.params);
    out.result({ help: text }, text);
    return 0;
  }

  const parsed = parseCommandArgs(argv, command.flags);
  const context = await buildContext(out, loadConfig());
  await command.run(context, { flags: parsed.flags, positionals: parsed.positionals.slice(2) });
  return 0;
}

/** One shape for every `--json` failure, so consumers read `code`, not prose. */
function failureEnvelope(err: unknown): string {
  if (err instanceof ActionError) {
    return JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      ok: false,
      code: err.code,
      error: err.message,
      trace: err.trace,
    });
  }
  if (err instanceof CliError) {
    return JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      ok: false,
      code: err.code,
      error: err.message,
    });
  }
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    code: 'internal',
    error: describeError(err),
  });
}

// Layer the env files before anything reads the environment: the user's own
// ~/.config/s2s/.env is the primary surface (end users have no repo .env), an
// optional cwd .env refines it, and the real environment beats both.
loadEnvFiles();

void main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (jsonMode) {
      process.stdout.write(`${failureEnvelope(err)}\n`);
    } else if (err instanceof ActionError) {
      // The action's own trace, not a re-worded summary: the failure point is
      // (almost always) the LAST line before the error, and the root-CID write
      // is the last step of the update action.
      process.stderr.write(`error: ${err.message}\n`);
      for (const line of err.trace) {
        process.stderr.write(`  ${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
      }
    } else if (err instanceof CliError) {
      process.stderr.write(`error: ${err.message}\n`);
    } else {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
    process.exitCode = err instanceof CliError ? err.exitCode : 1;
  });
