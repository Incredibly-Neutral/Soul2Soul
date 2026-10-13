// lastmile — tiny structured logger.
//
// One line per record: `ISO time LEVEL [lastmile] msg fields...`.
// info goes to stdout; warn/error go to stderr. No dependencies.

export type LogLevel = "info" | "warn" | "error";

function write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  const line =
    fields && Object.keys(fields).length > 0
      ? `${new Date().toISOString()} ${level} [lastmile] ${msg} ${JSON.stringify(fields)}`
      : `${new Date().toISOString()} ${level} [lastmile] ${msg}`;
  if (level === "info") {
    process.stdout.write(`${line}\n`);
  } else {
    process.stderr.write(`${line}\n`);
  }
}

export function log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  write(level, msg, fields);
}

export function logInfo(msg: string, fields?: Record<string, unknown>): void {
  write("info", msg, fields);
}

export function logWarn(msg: string, fields?: Record<string, unknown>): void {
  write("warn", msg, fields);
}

export function logError(msg: string, fields?: Record<string, unknown>): void {
  write("error", msg, fields);
}
