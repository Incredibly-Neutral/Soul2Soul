// ============================================================================
// Output helpers — the Neovim-plugin contract.
//
//   stdout   → ONLY the final machine-readable result (JSON when --json).
//   stderr   → human progress/warnings (never pollutes stdout).
//
// Without --json, `result()` prints a human summary to stdout instead of JSON.
//
// Every `--json` document is an envelope:
//
//   success  { "schemaVersion": 1, "ok": true,  "action": "publish", … }
//   failure  { "schemaVersion": 1, "ok": false, "code": "usage", "error": "…" }
//
// `schemaVersion` and `ok` are added here, never by a command, so there is one
// place to bump when the shape changes and one place a consumer checks to tell
// a result from an error. `code` values live on the error classes
// (`usage`, `action_failed`, `error`) — `internal` covers an uncaught throw.
// ============================================================================

/** Bump when the shape of a `--json` document changes. */
export const SCHEMA_VERSION = 1;

export interface CliOut {
  json: boolean;
  /** Human progress — always stderr, never stdout. */
  log(msg: string): void;
  /** Human warning — always stderr. */
  warn(msg: string): void;
  /**
   * Final result. JSON mode → stdout JSON envelope. Human mode → `human` text,
   * or a pretty-printed JSON when no human form was supplied.
   */
  result(data: unknown, human?: string): void;
}

/** Envelope a success payload, so the added keys can never be overridden. */
export function successEnvelope(data: unknown): Record<string, unknown> {
  const payload =
    typeof data === 'object' && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { result: data };
  return { schemaVersion: SCHEMA_VERSION, ok: true, ...payload };
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
        ? JSON.stringify(successEnvelope(data), null, 2)
        : (human ?? JSON.stringify(data, null, 2));
      process.stdout.write(`${text}\n`);
    },
  };
}
