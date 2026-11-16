// ============================================================================
// The runtime floor.
//
// The bundle is built for node20 (`esbuild.config.mjs` `target`), so the
// manifest declares `engines.node >= 20` and the CLI checks it before anything
// else. Without the check an older node parses the bundle and then fails deep
// inside a dependency: the operator gets a viem stack where one sentence about
// their node would do.
//
// The check cannot catch a bundle that will not parse — no code inside a file
// runs before that file parses. It covers the case that actually happens: a
// node new enough for the syntax and too old for the APIs.
// ============================================================================

/** Lowest node the bundle is built for. Keep in step with esbuild's `target`. */
export const MIN_NODE_MAJOR = 20;

/**
 * The message for an unsupported runtime, or `null` when `version` is new
 * enough. Pure, so the test does not need a node it does not have.
 */
export function nodeVersionError(version: string, min: number = MIN_NODE_MAJOR): string | null {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  // An unreadable version is not evidence of an old node: stay quiet rather
  // than refuse to start on a runtime that may be fine.
  if (!Number.isFinite(major) || major >= min) return null;
  return `s2s needs node ${min} or newer (this is ${version}); the bundle is built for node${min}`;
}
