// ============================================================================
// The defaults layer — the read-only config file that ships with the CLI.
//
//   <dist>/defaults.json          (esbuild copies defaults.json beside the bundle)
//   S2S_DEFAULTS_FILE             override, used verbatim
//
// It is the "accept the provided default" half of every setup question: the
// provided entries live here and the user's own answers go to custom.json.
// Shipping it as a file rather than compiled-in constants keeps the seam where a
// later version swaps it for a REST fetch of the operator's defaults — same
// shape, different source.
//
// Reads are tolerant (missing/corrupt → empty, so BUILTIN_FILE_CONFIG in
// core/configschema.ts takes over) and the parsed file is cached per process:
// every `loadConfig` call reads it, and it cannot change under a running CLI.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeFileConfig, type FileConfig } from './configschema';

/** Parsed defaults, keyed by path (an override can legitimately differ per call). */
const cache = new Map<string, FileConfig>();

/**
 * Where the defaults file may be. Bundled CJS (`dist/cli.cjs`) has `__dirname`
 * pointing at the dist directory, which is where esbuild puts the copy; running
 * from source (`tsx`, vitest) it sits at the package root, i.e. the cwd of every
 * package script.
 */
function candidatePaths(): string[] {
  const candidates: string[] = [];
  if (typeof __dirname === 'string') candidates.push(join(__dirname, 'defaults.json'));
  candidates.push(join(process.cwd(), 'defaults.json'));
  return candidates;
}

/**
 * The defaults file to read: `S2S_DEFAULTS_FILE` when set, else the first
 * candidate that exists, else the first candidate (so the path stays reportable
 * even when the file is missing).
 */
export function defaultsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.S2S_DEFAULTS_FILE?.trim();
  if (override) return override;
  const candidates = candidatePaths();
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? '';
}

/** Read the defaults layer (cached). Missing/unparsable → empty config. */
export function loadDefaults(env: NodeJS.ProcessEnv = process.env): FileConfig {
  const path = defaultsFilePath(env);
  if (!path) return {};
  const cached = cache.get(path);
  if (cached) return cached;

  let loaded: FileConfig = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      loaded = normalizeFileConfig(parsed as Record<string, unknown>);
    }
  } catch {
    loaded = {};
  }
  cache.set(path, loaded);
  return loaded;
}

/** Drop the cache — a test seam, and a hook for a future live-reload path. */
export function resetDefaultsCache(): void {
  cache.clear();
}
