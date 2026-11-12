// ============================================================================
// Argument parsing — one declaration per command.
//
// Two entry points, deliberately:
//
//   parseArgs        LENIENT. Only for the discovery pass in cli.ts, which runs
//                    before the command (and therefore before its flag spec) is
//                    known. Unknown flags survive verbatim.
//   parseCommandArgs STRICT. Reads the command's declared `flags`, so
//                    `--flag value` consumes a value only when the spec says
//                    string, an unknown flag is a usage error (a typo used to
//                    fall through and silently change behaviour), a repeatable
//                    flag accumulates instead of overwriting, and `--no-<flag>`
//                    negates a boolean.
//
// `flagRows` renders help from the same table, so help and parsing cannot drift
// the way a hand-written usage string and a global BOOLEAN_FLAGS list did.
// ============================================================================

import { UsageError } from './errors';

export type FlagType = 'boolean' | 'string';

export interface FlagSpec {
  type: FlagType;
  /** One line for `--help`. */
  summary: string;
  /** Help placeholder for a string flag, e.g. `<ens>`. */
  value?: string;
  /** Accept the flag more than once; values accumulate comma-separated. */
  repeatable?: boolean;
  /** Single-letter alias (`h` → `-h`). */
  alias?: string;
}

export type FlagSpecs = Record<string, FlagSpec>;

export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positionals: string[];
}

/** Flags every command accepts. Declared once, merged into every command. */
export const GLOBAL_FLAGS: FlagSpecs = {
  json: { type: 'boolean', summary: 'emit the result as JSON on stdout (machine-readable)' },
  help: { type: 'boolean', alias: 'h', summary: 'show help for this command' },
  version: { type: 'boolean', summary: 'print the CLI version' },
};

const GLOBAL_BOOLEANS = ['json', 'help', 'h', 'version'];

/**
 * Lenient parse for the discovery pass only: it has to find `group` and
 * `action` before a command spec exists, so it cannot reject anything.
 */
export function parseArgs(
  argv: string[],
  options: { booleanFlags?: readonly string[] } = {},
): ParsedArgs {
  const booleanFlags = new Set(options.booleanFlags ?? GLOBAL_BOOLEANS);
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

/**
 * Strict parse against a command's declared flags. Throws `UsageError` (exit 2)
 * for an unknown flag, a string flag with no value, or `--no-` on a string flag.
 */
export function parseCommandArgs(
  argv: string[],
  specs: FlagSpecs,
  globals: FlagSpecs = GLOBAL_FLAGS,
): ParsedArgs {
  const known: FlagSpecs = {};
  const canonical: Record<string, string> = {};
  for (const [name, spec] of Object.entries({ ...globals, ...specs })) {
    known[name] = spec;
    canonical[name] = name;
    if (spec.alias) {
      known[spec.alias] = spec;
      canonical[spec.alias] = name;
    }
  }

  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const unknown: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    // `-` is a positional (stdin convention), not a flag.
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    let name = (eq === -1 ? arg : arg.slice(0, eq)).replace(/^--?/, '');
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    // `--no-<flag>` negates a declared boolean.
    let negated = false;
    if (name.startsWith('no-') && known[name.slice(3)]?.type === 'boolean') {
      negated = true;
      name = name.slice(3);
    }

    // A `--no-x` stays unknown unless `x` is a declared boolean, which the
    // negation branch above already resolved.
    const spec = known[name];
    if (!spec) {
      unknown.push(arg);
      continue;
    }

    const key = canonical[name] ?? name;

    if (spec.type === 'boolean') {
      if (negated && inline !== undefined) {
        throw new UsageError(`--no-${name} does not take a value`);
      }
      flags[key] = negated ? false : inline === undefined ? true : inline !== 'false';
      continue;
    }

    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        throw new UsageError(
          `--${key} requires a value${spec.value ? ` (${spec.value})` : ''}`,
        );
      }
      value = next;
      i += 1;
    }

    if (spec.repeatable) {
      const previous = typeof flags[key] === 'string' ? flags[key] : '';
      flags[key] = previous ? `${previous},${value}` : value;
    } else {
      flags[key] = value;
    }
  }

  if (unknown.length > 0) {
    const allowed = Object.keys({ ...specs, ...globals }).map((f) => `--${f}`);
    const reported = unknown.map((flag) => {
      const bare = flag.replace(/^--?/, '').split('=')[0] ?? flag;
      const hit = nearestFlag(bare, Object.keys(known));
      return hit ? `${flag} (did you mean --${hit}?)` : flag;
    });
    throw new UsageError(
      `unknown flag ${reported.join(', ')} — this command accepts: ${allowed.join(', ')}`,
    );
  }

  return { flags, positionals };
}

/** Closest declared flag by edit distance, when it is close enough to be a typo. */
function nearestFlag(name: string, known: string[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const candidate of known) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (!best || distance < best.distance) best = { name: candidate, distance };
  }
  if (!best) return undefined;
  const limit = Math.max(2, Math.floor(name.length / 3));
  return best.distance <= limit ? best.name : undefined;
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i += 1) {
    const current = [i];
    for (let j = 1; j < cols; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution);
    }
    previous = current;
  }
  return previous[cols - 1] ?? 0;
}

/** Aligned `--flag <value>  summary` rows, rendered from the same specs. */
export function flagRows(specs: FlagSpecs, globals: FlagSpecs = {}): string {
  const rows = Object.entries({ ...specs, ...globals })
    .filter(([name]) => name !== 'h')
    .map(([name, spec]) => {
      const label = spec.type === 'boolean' ? `--${name}` : `--${name} ${spec.value ?? '<value>'}`;
      return [spec.alias ? `-${spec.alias}, ${label}` : label, spec.summary] as const;
    });
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, summary]) => `  ${label.padEnd(width)}  ${summary}`).join('\n');
}

/**
 * Full help for one action, derived from its spec. `params` is the positional
 * signature (`<note>`), so the usage line cannot disagree with the parser, and
 * `detail` is the optional second paragraph: the reason the command is shaped
 * this way, which would make a one-line group listing unreadable.
 */
export function commandHelp(
  group: string,
  name: string,
  summary: string,
  flags: FlagSpecs,
  params?: string,
  detail?: string,
): string {
  const usage = `s2s ${group} ${name}${params ? ` ${params}` : ''} [flags]`;
  const own = flagRows(flags);
  const globals = flagRows({}, GLOBAL_FLAGS);
  return [
    usage,
    '',
    detail ? `${summary}\n${detail}` : summary,
    '',
    own ? `Flags:\n${own}` : 'Flags: (none)',
    '',
    `Global flags:\n${globals}`,
  ].join('\n');
}

/** Read a string flag, validating presence when required. */
export function flagString(
  flags: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** Read a boolean flag (`--flag` → true; absent or `--no-flag` → false). */
export function flagBool(
  flags: Record<string, string | boolean>,
  name: string,
): boolean {
  const value = flags[name];
  if (typeof value === 'boolean') return value;
  return value === 'true';
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
