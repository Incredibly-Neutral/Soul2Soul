// ============================================================================
// Minimal hand-rolled argument parser — no dependency, machine-friendly.
// Supports:
//   --flag value      (value consumed only when the next token isn't a flag)
//   --flag=value
//   --flag            (boolean true)
//   -h                (single-letter flag, boolean)
//   --                (everything after is positional)
// Unknown flags are kept verbatim in `flags` so commands can error clearly.
// ============================================================================

export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export interface ParseArgsOptions {
  /** Flag names that are always boolean (never consume a value token). */
  booleanFlags?: readonly string[];
}

export function parseArgs(argv: string[], options: ParseArgsOptions = {}): ParsedArgs {
  const booleanFlags = new Set(options.booleanFlags ?? []);
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const name = arg.slice(2);
        const next = argv[i + 1];
        if (booleanFlags.has(name)) {
          flags[name] = true;
        } else if (next !== undefined && !next.startsWith('-')) {
          flags[name] = next;
          i += 1;
        } else {
          flags[name] = true;
        }
      }
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      flags[arg.slice(1)] = true;
      continue;
    }

    positionals.push(arg);
  }

  return { flags, positionals };
}

/** Read a string flag, validating presence when required. */
export function flagString(
  flags: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** Split a comma-separated flag value into trimmed entries. */
export function flagList(
  flags: Record<string, string | boolean>,
  name: string,
): string[] {
  const value = flagString(flags, name);
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
