// ============================================================================
// .env file loading — layered, user-first.
//
// The CLI ships to people who do NOT have this repo and therefore do NOT have
// a project `.env`. Their credentials live in their own home directory:
//
//   ~/.config/s2s/.env        (or $XDG_CONFIG_HOME/s2s/.env)   ← the user surface
//   <cwd>/.env                                                 ← optional project override
//
// Resolution order, most specific first:
//   1. the real process environment        (never overwritten)
//   2. <cwd>/.env                           (a project may pin its own values)
//   3. ~/.config/s2s/.env                   (the user's own settings)
//
// Files are parsed and applied in that order, and only keys that are not
// already set are filled — so nothing below can shadow anything above it.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'dotenv';

/** Where the user's own env file lives: `$XDG_CONFIG_HOME/s2s/.env`. */
export function userEnvPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : join(home, '.config');
  return join(base, 's2s', '.env');
}

/** Where an optional project-level env file lives: `<cwd>/.env`. */
export function projectEnvPath(cwd: string = process.cwd()): string {
  return join(cwd, '.env');
}

export interface EnvFileLoadResult {
  /** Absolute path of the cwd env file, or null when absent. */
  project: string | null;
  /** Absolute path of the user env file, or null when absent. */
  user: string | null;
}

/** Apply one env file's values, without overriding anything already set. */
function applyEnvFile(path: string, env: NodeJS.ProcessEnv): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return; // unreadable file is not fatal — treat it as absent
  }
  let parsed: Record<string, string>;
  try {
    parsed = parse(raw);
  } catch {
    return; // malformed file must not crash every command
  }
  for (const [key, value] of Object.entries(parsed)) {
    // A blank value is treated as unset — `loadConfig` ignores empty env vars
    // anyway, so letting the file fill them is what the user expects.
    const current = env[key];
    if (current === undefined || current.trim().length === 0) env[key] = value;
  }
}

/**
 * Load the layered env files into `env` (defaults to `process.env`).
 * Idempotent and side-effect-free apart from filling unset keys.
 */
export function loadEnvFiles(
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; home?: string } = {},
): EnvFileLoadResult {
  const env = opts.env ?? process.env;
  const project = projectEnvPath(opts.cwd ?? process.cwd());
  const user = userEnvPath(env, opts.home ?? homedir());

  const projectExists = existsSync(project);
  if (projectExists) applyEnvFile(project, env);

  const userExists = existsSync(user) && user !== project;
  if (userExists) applyEnvFile(user, env);

  return {
    project: projectExists ? project : null,
    user: userExists ? user : null,
  };
}
