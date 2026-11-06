/**
 * Structured call logging: exactly one JSON line per proxied call.
 *
 * The entry type is deliberately narrow. It has no slot for the upstream URL,
 * the Pimlico API key, or the user operation itself, so a caller cannot leak
 * any of them into a log line by accident.
 */

export type CallLogEntry = {
  method: string;
  chainId: number;
  userId: string | null;
  outcome: 'ok' | 'rpc_error' | 'http_error';
  status: number;
  code?: number;
  latencyMs: number;
  ip?: string;
};

export type LogSink = (line: string) => void;

const defaultSink: LogSink = (line: string): void => {
  process.stdout.write(line + '\n');
};

/**
 * Build a logger writing one line per call. Key order is fixed; absent
 * `code` and `ip` are omitted rather than serialised as null.
 */
export function createLogger(sink: LogSink = defaultSink): (entry: CallLogEntry) => void {
  return (entry: CallLogEntry): void => {
    try {
      const fields: Record<string, unknown> = {
        method: entry.method,
        chainId: entry.chainId,
        userId: entry.userId,
        outcome: entry.outcome,
        status: entry.status,
      };

      if (entry.code !== undefined) {
        fields.code = entry.code;
      }

      fields.latencyMs = Math.round(entry.latencyMs);

      if (entry.ip !== undefined) {
        fields.ip = entry.ip;
      }

      sink(JSON.stringify(fields));
    } catch {
      // A broken log sink must never break the request it is logging.
    }
  };
}
