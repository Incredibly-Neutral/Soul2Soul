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
