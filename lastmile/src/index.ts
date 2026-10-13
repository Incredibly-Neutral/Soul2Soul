// lastmile — CLI entrypoint.
//
//   lastmile --config /etc/lastmile/config.toml            # daemon (default)
//   lastmile --config ... --once                           # single pass, exit code reflects health
//   lastmile --config ... --once --magazine s3ntiment.com  # single magazine
//   lastmile --help
//
// Daemon mode: runs every magazine once immediately, then polls each on
// `poll_interval_ms` (sequential per magazine, guarded against overlap).
// --once: exit code 0 iff every selected magazine reported updated/unchanged,
// non-zero if any errored or stalled. Graceful shutdown on SIGINT/SIGTERM.

import type { AppConfig, MagazineConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { makeDefaultServices, syncMagazine, type SyncResult } from "./sync.js";
import { logError, logInfo, logWarn } from "./logger.js";

const DEFAULT_CONFIG = "/etc/lastmile/config.toml";

const HELP = `lastmile — ENS-verified .com serving daemon (Phase 1)

Usage:
  lastmile [flags]

Flags:
  --config <path>   config.toml path (default ${DEFAULT_CONFIG})
  --once            run every selected magazine once, then exit (exit code 0
                    iff all updated/unchanged)
  --magazine <domain>  run only this magazine (must exist in the config)
  --help            show this help

Without --once the daemon polls every magazine every poll_interval_ms.
`;

interface CliOptions {
  config: string;
  once: boolean;
  magazine?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { config: DEFAULT_CONFIG, once: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--config":
      case "-c": {
        const value = argv[++i];
        if (value === undefined) throw new Error("--config requires a path");
        opts.config = value;
        break;
      }
      case "--once":
        opts.once = true;
        break;
      case "--magazine":
      case "-m": {
        const value = argv[++i];
        if (value === undefined) throw new Error("--magazine requires a domain");
        opts.magazine = value;
        break;
      }
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }
  return opts;
}

function logResult(r: SyncResult): void {
  const fields: Record<string, unknown> = {
    domain: r.domain,
    cid: r.cid,
    blockNumber: r.blockNumber,
    durationMs: r.durationMs,
  };
  if (r.detail !== undefined) fields.detail = r.detail;
  if (r.status === "error") logError(`sync ${r.status}`, fields);
  else if (r.status === "stalled") logWarn(`sync ${r.status}`, fields);
  else logInfo(`sync ${r.status}`, fields);
}

async function syncMagazineLogged(mag: MagazineConfig, app: AppConfig): Promise<SyncResult> {
  const services = makeDefaultServices(app, mag);
  const result = await syncMagazine(mag, app, services);
  logResult(result);
  return result;
}

/** Daemon poll loop for one magazine: immediate tick, then interval, no overlap. */
function startMagazineLoop(mag: MagazineConfig, app: AppConfig): NodeJS.Timeout {
  const services = makeDefaultServices(app, mag);
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) {
      logWarn("skipping poll (previous still in flight)", { domain: mag.domain });
      return;
    }
    inFlight = true;
    try {
      await syncMagazine(mag, app, services).then(logResult);
    } catch (err) {
      logError("sync loop error", {
        domain: mag.domain,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inFlight = false;
    }
  };

  // Fire once immediately, then on the poll interval.
  void tick();
  return setInterval(() => void tick(), app.pollIntervalMs);
}

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    logError("bad arguments", { error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  // Config load + validation.
  let app: AppConfig;
  try {
    app = loadConfig(opts.config);
  } catch (err) {
    logError("config load failed", {
      path: opts.config,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
    return;
  }
  if (app.magazines.length === 0) {
    logError("no magazines configured", { path: opts.config });
    process.exitCode = 1;
    return;
  }

  // --magazine filter (error out when the domain is not in the config).
  let magazines: MagazineConfig[];
  if (opts.magazine !== undefined) {
    magazines = app.magazines.filter((m) => m.domain === opts.magazine);
    if (magazines.length === 0) {
      logError("magazine not found in config", { magazine: opts.magazine, path: opts.config });
      process.exitCode = 1;
      return;
    }
  } else {
    magazines = app.magazines;
  }

  // --once: run each selected magazine once, exit 0 iff all good.
  if (opts.once) {
    let allGood = true;
    for (const mag of magazines) {
      try {
        const result = await syncMagazineLogged(mag, app);
        if (result.status === "error" || result.status === "stalled") allGood = false;
      } catch (err) {
        allGood = false;
        logError("sync error", {
          domain: mag.domain,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    process.exitCode = allGood ? 0 : 1;
    return;
  }

  // Daemon mode.
  const timers: NodeJS.Timeout[] = [];
  for (const mag of magazines) {
    timers.push(startMagazineLoop(mag, app));
  }
  logInfo("daemon started", { magazines: magazines.map((m) => m.domain), pollIntervalMs: app.pollIntervalMs });

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      logInfo("shutting down");
      for (const t of timers) clearInterval(t);
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

main().catch((err) => {
  logError("fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
