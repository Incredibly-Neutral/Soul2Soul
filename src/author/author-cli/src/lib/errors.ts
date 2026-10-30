// ============================================================================
// Error types with process exit codes. The CLI contract:
//   0 = ok, 1 = runtime failure, 2 = usage error.
// ============================================================================

/** Base CLI error carrying a process exit code. */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/** Invalid usage — unknown command, missing argument, bad flag (exit code 2). */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'UsageError';
  }
}

/**
 * Flatten an error and its `cause` chain into one line.
 *
 * Node's `fetch` reports every transport failure — DNS, TLS, socket reset, and
 * also an ABORT from our own timeout — as the same useless `TypeError: fetch
 * failed`. The real reason lives one or two levels down in `cause`
 * (`UND_ERR_SOCKET`, `UND_ERR_ABORTED`, `ECONNRESET`, …), so print it instead of
 * letting "fetch failed" be the whole story.
 */
export function describeError(err: unknown, depth = 0): string {
  if (!(err instanceof Error)) return String(err);
  const head = err.name === 'Error' ? err.message : `${err.name}: ${err.message}`;
  const parts: string[] = [head];
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code && !head.includes(code)) parts.push(`[${code}]`);

  const cause = (err as { cause?: unknown }).cause;
  if (cause && depth < 4) {
    parts.push(`← ${describeError(cause, depth + 1)}`);
  }
  return parts.join(' ');
}
