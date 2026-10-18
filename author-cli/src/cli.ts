// ============================================================================
// s2s — Soul2Soul headless authoring CLI.
//
// Top-level dispatch: `s2s <group> <action> [flags]`.
// Only group today is `author` (SPEC-hosts AD-4 command structure).
// Flags parse anywhere; `--json` switches stdout to a machine-readable JSON
// result (Neovim plugin contract). Human progress always goes to stderr.
// ============================================================================

import 'dotenv/config';

import { parseArgs } from './lib/args';
import { CliError, UsageError } from './lib/errors';
import { createOut } from './lib/out';
import { loadConfig } from './core/config';
import { buildContext } from './core/context';
import { authorCommands, findAuthorCommand } from './commands';
import type { CommandSpec } from './lib/command';

const VERSION = '0.1.0';

const TOP_HELP = `s2s — Soul2Soul headless authoring CLI (v${VERSION})

Usage:
  s2s <group> <action> [flags]

Groups:
  author   Upload, preview, publish, revoke, or create publications

Global flags:
  --json        emit the result as JSON on stdout (machine-readable)
  -h, --help    show help for the current level

Run "s2s author --help" for the author actions.`;

function authorHelp(): string {
  const rows = authorCommands.map((c) => `  ${c.name.padEnd(8)} ${c.summary}`).join('\n');
  return `s2s author — publication authoring

Usage:
  s2s author <action> [flags]

Actions:
${rows}

Run "s2s author <action> --help" for details on an action.`;
}

function actionHelp(command: CommandSpec): string {
  return `${command.usage}\n\n${command.summary}`;
}

async function main(argv: string[]): Promise<number> {
  const { flags, positionals } = parseArgs(argv, { booleanFlags: ['json', 'help', 'h', 'version'] });
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

  if (group !== 'author') {
    throw new UsageError(`unknown command group '${group}' — expected 'author'`);
  }

  if (!action) {
    if (wantHelp) {
      out.result({ help: authorHelp() }, authorHelp());
      return 0;
    }
    out.result({ help: authorHelp() }, authorHelp());
    return 0;
  }

  if (wantHelp) {
    const command = findAuthorCommand(action);
    if (!command) {
      throw new UsageError(`unknown author action '${action}'`);
    }
    out.result({ help: actionHelp(command) }, actionHelp(command));
    return 0;
  }

  const command = findAuthorCommand(action);
  if (!command) {
    throw new UsageError(`unknown author action '${action}'`);
  }

  const context = await buildContext(out, loadConfig());
  await command.run(context, { flags, positionals: positionals.slice(2) });
  return 0;
}

void main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const isJson = process.argv.slice(2).includes('--json');
    if (err instanceof CliError) {
      if (isJson) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
      } else {
        process.stderr.write(`error: ${err.message}\n`);
      }
      process.exitCode = err.exitCode;
    } else {
      const text = err instanceof Error ? err.message : String(err);
      if (isJson) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: text })}\n`);
      } else {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        process.stderr.write(`${message}\n`);
      }
      process.exitCode = 1;
    }
  });
