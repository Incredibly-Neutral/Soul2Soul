// ============================================================================
// s2s — Soul2Soul headless authoring CLI.
//
// Top-level dispatch: `s2s <group> <action> [flags]`.
// Groups: `author` (content actions), `publication` (publication lifecycle),
// and `config` (CLI settings — dispatched without a context build).
// Flags parse anywhere; `--json` switches stdout to a machine-readable JSON
// result (Neovim plugin contract). Human progress always goes to stderr.
// ============================================================================

import { BOOLEAN_FLAGS, parseArgs } from './lib/args';
import { CliError, UsageError, ActionError, describeError } from './lib/errors';
import { loadEnvFiles } from './lib/env';
import { createOut } from './lib/out';
import { loadConfig } from './core/config';
import { buildContext } from './core/context';
import {
  authorHelpEntries,
  findAuthorCommand,
  findAuthorStoreCommand,
  findPublicationCommand,
  publicationCommands,
} from './commands';
import { runConfigGroup } from './commands/config';

const VERSION = '0.1.0';

const TOP_HELP = `s2s — Soul2Soul headless authoring CLI (v${VERSION})

Usage:
  s2s <group> <action> [flags]

Groups:
  author        Author identities + content actions (new/switch/list/rm, upload, publish)
  publication   Create publications
  config        Manage CLI settings (bring-your-own RPC, Kubo, keys)

Global flags:
  --json        emit the result as JSON on stdout (machine-readable)
  -h, --help    show help for the current level

Run "s2s author --help" or "s2s publication --help" for the actions.`;

function groupHelp(
  commands: readonly { name: string; summary: string }[],
  group: string,
  tagline: string,
): string {
  const rows = commands.map((c) => `  ${c.name.padEnd(8)} ${c.summary}`).join('\n');
  return `s2s ${group} — ${tagline}

Usage:
  s2s ${group} <action> [flags]

Actions:
${rows}

Run "s2s ${group} <action> --help" for details on an action.`;
}

const authorHelp = (): string =>
  groupHelp(authorHelpEntries, 'author', 'author identities and content actions');
const publicationHelp = (): string =>
  groupHelp(publicationCommands, 'publication', 'publication lifecycle');

function actionHelp(command: { usage: string; summary: string }): string {
  return `${command.usage}\n\n${command.summary}`;
}

async function main(argv: string[]): Promise<number> {
  const { flags, positionals } = parseArgs(argv, { booleanFlags: BOOLEAN_FLAGS });
  const json = flags.json !== undefined;
  const out = createOut(json);
  const wantHelp = (['help', 'h', 'version'] as const).some((k) => flags[k] === true);

  const group = positionals[0];
  const action = positionals[1];

  // Top level: version or help or bare invocation.
  if (flags.version === true || (argv.length === 0 && !group)) {
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
    runConfigGroup(out, wantHelp, flags, action, positionals.slice(2));
    return 0;
  }

  if (group !== 'author' && group !== 'publication') {
    throw new UsageError(
      `unknown command group '${group}' — expected 'author', 'publication', or 'config'`,
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
      const usage = actionHelp(storeCommand);
      if (wantHelp) {
        out.result({ help: usage }, usage);
        return 0;
      }
      await storeCommand.run(out, { flags, positionals: positionals.slice(2) });
      return 0;
    }
  }

  if (wantHelp) {
    const command = findCommand(action);
    if (!command) {
      throw new UsageError(`unknown ${group} action '${action}'`);
    }
    out.result({ help: actionHelp(command) }, actionHelp(command));
    return 0;
  }

  const command = findCommand(action);
  if (!command) {
    throw new UsageError(`unknown ${group} action '${action}'`);
  }

  const context = await buildContext(out, loadConfig());
  await command.run(context, { flags, positionals: positionals.slice(2) });
  return 0;
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
    const isJson = process.argv.slice(2).includes('--json');
    if (err instanceof ActionError) {
      // The action's own trace, not a re-worded summary: the failure point is
      // (almost always) the LAST line before the error, and the root-CID write
      // is the last step of the update action.
      if (isJson) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: err.message, trace: err.trace })}\n`,
        );
      } else {
        process.stderr.write(`error: ${err.message}\n`);
        for (const line of err.trace) {
          process.stderr.write(`  ${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
        }
      }
      process.exitCode = err.exitCode;
    } else if (err instanceof CliError) {
      if (isJson) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
      } else {
        process.stderr.write(`error: ${err.message}\n`);
      }
      process.exitCode = err.exitCode;
    } else {
      const text = describeError(err);
      if (isJson) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: text })}\n`);
      } else {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        process.stderr.write(`${message}\n`);
      }
      process.exitCode = 1;
    }
  });
