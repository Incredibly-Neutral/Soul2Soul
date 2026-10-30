// ============================================================================
// Output helpers — the Neovim-plugin contract.
//
//   stdout   → ONLY the final machine-readable result (JSON when --json).
//   stderr   → human progress/warnings (never pollutes stdout).
//
// Without --json, `result()` prints a human summary to stdout instead of JSON.
// ============================================================================

export interface CliOut {
  json: boolean;
  /** Human progress — always stderr, never stdout. */
  log(msg: string): void;
  /** Human warning — always stderr. */
  warn(msg: string): void;
  /**
   * Final result. JSON mode → stdout JSON. Human mode → `human` text, or a
   * pretty-printed JSON when no human form was supplied.
   */
  result(data: unknown, human?: string): void;
}

export function createOut(json: boolean): CliOut {
  return {
    json,
    log(msg: string): void {
      process.stderr.write(`${msg}\n`);
    },
    warn(msg: string): void {
      process.stderr.write(`warning: ${msg}\n`);
    },
    result(data: unknown, human?: string): void {
      const text = json
        ? JSON.stringify(data, null, 2)
        : (human ?? JSON.stringify(data, null, 2));
      process.stdout.write(`${text}\n`);
    },
  };
}
