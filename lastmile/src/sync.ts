// lastmile — the fail-closed per-magazine sync loop.
//
// One poll of one magazine: resolve the ENS contenthash against all RPCs,
// and only when there is no doubt (ok + a non-null CID) do we pin it, rewrite
// the nginx include, validate + reload nginx, and only then persist the new
// state. Any doubt — resolution error, disagreement, a vanished contenthash,
// a failed pin, a rejected nginx include — keeps the last good CID in place
// and raises an alert. A CID is only ever recorded as served AFTER it is
// actually pinned AND the nginx include passed validation.
//
// Everything is injectable (see {@link SyncServices}) so tests run without
// any network, Kubo, or nginx; the real wiring lives in
// {@link makeDefaultServices}.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { exec, execFile } from "node:child_process";

import type { AppConfig, MagazineConfig } from "./config.js";
import type { ResolveOutcome } from "./ens.js";
import { resolveContenthash } from "./ens.js";
import type { PinAddResult } from "./kubo.js";
import { KuboClient } from "./kubo.js";
import type { NginxModuleDeps, NginxWriteResult, WriteNginxIncludeArgs } from "./nginx.js";
import { writeNginxInclude } from "./nginx.js";
import type { MagazineState } from "./state.js";
import { applyNewCid, loadState, writeS2sJson, writeState } from "./state.js";
import { logError, logWarn } from "./logger.js";

/** Everything syncMagazine touches, injectable for tests. */
export interface SyncServices {
  /** Multi-RPC ENS contenthash resolution (fail-closed agreement). */
  resolve: (ensName: string, rpcUrls: string[]) => Promise<ResolveOutcome>;
  /** Pin a CID in Kubo; throws on failure. */
  pinAdd: (cid: string) => Promise<PinAddResult>;
  /** Unpin a CID (best-effort; "not pinned" is a no-op). */
  unpin: (cid: string) => Promise<void>;
  /** Rewrite + validate + reload the nginx include; result.wrote tells success. */
  writeNginx: (args: WriteNginxIncludeArgs) => Promise<NginxWriteResult>;
  /** Fire an alert (best-effort, never throws). */
  alert: (msg: string) => void;
  /** Injectable clock (defaults to real time). */
  now: () => Date;
}

export type SyncStatus = "updated" | "unchanged" | "stalled" | "error";

export interface SyncResult {
  domain: string;
  status: SyncStatus;
  /** CID now being served (last good on any failure). */
  cid: string | null;
  blockNumber: string | null;
  detail?: string;
  durationMs: number;
}

/** A generic failure helper: always reports the last good CID, never advances. */
function failResult(
  domain: string,
  state: MagazineState,
  detail: string,
  startedMs: number,
): SyncResult {
  return {
    domain,
    status: "error",
    cid: state.cid,
    blockNumber: state.blockNumber,
    detail,
    durationMs: Date.now() - startedMs,
  };
}

/** A stalled (transient, recoverable) failure: same fail-closed shape, error status. */
function stalledResult(
  domain: string,
  state: MagazineState,
  detail: string,
  startedMs: number,
): SyncResult {
  return {
    domain,
    status: "stalled",
    cid: state.cid,
    blockNumber: state.blockNumber,
    detail,
    durationMs: Date.now() - startedMs,
  };
}

/**
 * Run one poll of one magazine.
 *
 * Load-bearing, fail-closed order:
 *   a. load + reconcile persisted state against config;
 *   b. resolve the contenthash (any throw => error);
 *   c. error / disagreement / null contenthash => "error", no repoint, no
 *      state write, no pin, alert;
 *   d. ok && cid === state.cid => "unchanged", nothing happens;
 *   e. ok && cid !== state.cid => pin FIRST; only if pin ok AND the nginx
 *      include was written (wrote === true) do we persist state + s2s.json
 *      and then best-effort unpin trimmed CIDs. Otherwise "stalled".
 */
export async function syncMagazine(
  mag: MagazineConfig,
  app: AppConfig,
  services: SyncServices,
  opts?: { now?: Date },
): Promise<SyncResult> {
  const started = Date.now();

  // a. Load + reconcile. loadState never throws (corrupt/missing falls back to
  //    emptyState("","")); applyNewCid copies domain/ensName from the previous
  //    state, so reconciliation MUST happen before applyNewCid or we would
  //    persist empty strings.
  const loaded = loadState(mag.stateDir);
  const state: MagazineState =
    loaded.domain === mag.domain && loaded.ensName === mag.ensName
      ? loaded
      : { ...loaded, domain: mag.domain, ensName: mag.ensName };

  // b. Resolve (any throw => error, fail closed).
  let outcome: ResolveOutcome;
  try {
    outcome = await services.resolve(mag.ensName, app.rpcUrls);
  } catch (err) {
    const detail = `resolve threw for ${mag.ensName}: ${err instanceof Error ? err.message : String(err)}`;
    services.alert(detail);
    return failResult(mag.domain, state, detail, started);
  }

  // c. Resolution failures => error, fail closed: no repoint, no state write, no pin.
  if (outcome.status === "error") {
    services.alert(outcome.detail);
    return failResult(mag.domain, state, outcome.detail, started);
  }
  if (outcome.status === "disagreement") {
    services.alert(outcome.detail);
    return failResult(mag.domain, state, outcome.detail, started);
  }
  if (outcome.result.cid === null) {
    // A vanishing ENS contenthash is a red flag, not a value to serve.
    const detail = `no contenthash on ${mag.ensName}`;
    services.alert(detail);
    return failResult(mag.domain, state, detail, started);
  }
  const cid = outcome.result.cid;

  // d. Unchanged: the ENS record still points where we already serve.
  if (cid === state.cid) {
    return {
      domain: mag.domain,
      status: "unchanged",
      cid: state.cid,
      blockNumber: state.blockNumber,
      durationMs: Date.now() - started,
    };
  }

  // e. New CID: pin FIRST. A failed pin => stalled, no repoint, no state write.
  try {
    await services.pinAdd(cid);
  } catch (err) {
    const detail = `pin failed for ${cid}: ${err instanceof Error ? err.message : String(err)}`;
    services.alert(detail);
    return stalledResult(mag.domain, state, detail, started);
  }

  // Then rewrite the nginx include. Only a written + validated include
  // (wrote === true) lets us record the CID as served.
  let writeResult: NginxWriteResult;
  try {
    writeResult = await services.writeNginx({
      includePath: mag.nginxInclude,
      domain: mag.domain,
      ensName: mag.ensName,
      cid,
      s2sJsonPath: path.join(mag.stateDir, "s2s.json"),
      gatewayBase: mag.kuboGatewayUrl,
    });
  } catch (err) {
    const detail = `nginx include failed for ${mag.domain}: ${err instanceof Error ? err.message : String(err)}`;
    services.alert(detail);
    return stalledResult(mag.domain, state, detail, started);
  }
  if (writeResult.wrote !== true) {
    const detail = `nginx include rejected for ${mag.domain}: wrote=false (nginx -t failed)`;
    services.alert(detail);
    return stalledResult(mag.domain, state, detail, started);
  }

  // Pin ok AND include written => only now record the CID as served.
  const { state: newState, unpin } = applyNewCid(state, {
    cid,
    blockNumber: outcome.result.blockNumber === null ? null : String(outcome.result.blockNumber),
    rpcs: app.rpcUrls,
    rollbackDepth: app.rollbackDepth,
    now: opts?.now ?? services.now(),
  });
  writeState(mag.stateDir, newState);
  writeS2sJson(mag.stateDir, {
    name: mag.ensName,
    cid,
    blockNumber: newState.blockNumber,
    timestamp: newState.updatedAt,
    rpcs: newState.rpcs,
  });

  // Best-effort unpin of trimmed CIDs: failures are logged, never fatal.
  for (const old of unpin) {
    try {
      await services.unpin(old);
    } catch (err) {
      logWarn("unpin failed (not fatal)", {
        domain: mag.domain,
        cid: old,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    domain: mag.domain,
    status: "updated",
    cid: newState.cid,
    blockNumber: newState.blockNumber,
    durationMs: Date.now() - started,
  };
}

/** Real fs/process deps for {@link writeNginxInclude}. */
const defaultNginxDeps: NginxModuleDeps = {
  readFile: async (p) => {
    try {
      return await fs.readFile(p, "utf8");
    } catch {
      return null;
    }
  },
  writeFile: (p, content) => fs.writeFile(p, content, "utf8"),
  rename: (from, to) => fs.rename(from, to),
  rm: (p) => fs.rm(p, { force: true }),
  run: (cmd) =>
    new Promise((resolve) => {
      exec(cmd, (error, stdout, stderr) => {
        resolve({ ok: error === null, stdout: stdout ?? "", stderr: stderr ?? "" });
      });
    }),
};

/**
 * Best-effort alert delivery: runs `alertCmd` (a shell string) via execFile
 * with the shell, piping the message to stdin. No-op when alertCmd is null.
 * Never throws — failures are logged.
 */
function runAlert(alertCmd: string | null, msg: string): void {
  if (alertCmd === null || alertCmd === "") return;
  try {
    const child = execFile(alertCmd, [], { shell: true }, (err) => {
      if (err) {
        logError("alert command failed", {
          cmd: alertCmd,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    child.stdin?.end(`${msg}\n`);
  } catch (err) {
    logError("alert command failed", {
      cmd: alertCmd,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Wire the real modules into a {@link SyncServices}.
 *
 * `mag` is optional: when given, the Kubo client uses the per-magazine
 * `mag.kuboApiUrl` override, falling back to `app.kuboApiUrl`. Pass it from
 * the CLI when building per-magazine services.
 */
export function makeDefaultServices(app: AppConfig, mag?: MagazineConfig): SyncServices {
  const kubo = new KuboClient(mag?.kuboApiUrl ?? app.kuboApiUrl);
  return {
    resolve: (ensName, rpcUrls) => resolveContenthash(ensName, rpcUrls),
    pinAdd: (cid) => kubo.pinAdd(cid),
    unpin: (cid) => kubo.unpin(cid),
    writeNginx: (args) =>
      writeNginxInclude(
        args,
        defaultNginxDeps,
        { testCmd: app.nginxTestCmd, reloadCmd: app.nginxReloadCmd },
      ),
    alert: (msg) => runAlert(app.alertCmd, msg),
    now: () => new Date(),
  };
}
