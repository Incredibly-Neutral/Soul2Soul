import { LitService } from "../lit";
import { callWithTimeout } from "../helpers/index.js";

// ===========================================================================
// Missing-response diagnostics
// ===========================================================================

/**
 * Stages whose action logs are operator diagnostics and may be printed.
 * Prep logs `endpoints` (a gateway auth token can ride along) but never any
 * rendered plaintext; the render/update logs can, so they stay summarised.
 * S2S_DEBUG_ACTION_LOGS=1 overrides for both.
 */
const LOGS_VISIBLE_STAGES = new Set(['prep']);

const logsVisible = (label: string | undefined): boolean =>
  process.env.S2S_DEBUG_ACTION_LOGS === '1' ||
  (label !== undefined && LOGS_VISIBLE_STAGES.has(label));

/**
 * Describe an envelope that carried no `response`, including the action's own
 * logs for the stages where that is safe.
 *
 * Without this, `undefined` flows into the caller's schema validation and the
 * only thing the operator sees is `Prep action output validation failed:\n:
 * Required` — a valid parse of nothing, naming neither the stage nor the logs
 * the action printed (2026-11 publish failure spent its detail on exactly
 * that).
 */
const describeMissingResponse = (
  label: string | undefined,
  envelope: Record<string, unknown> | undefined,
): string => {
  const stage = label ?? 'action';
  if (envelope === undefined) return `${stage}: no envelope returned`;

  const keys = Object.keys(envelope);
  const logs = Array.isArray(envelope.logs) ? (envelope.logs as unknown[]) : undefined;
  // A body of exactly `{error: "..."}` is the node answering at HTTP 200 with
  // its own error envelope instead of a result — that string is the whole
  // diagnosis, so it is printed (truncated), not summarised.
  const rawError = envelope.error;
  const errorText =
    rawError === undefined || rawError === null
      ? ''
      : `: ${String(typeof rawError === 'string' ? rawError : JSON.stringify(rawError)).slice(0, 800)}`;
  const head =
    `${stage}: envelope has no \`response\` ` +
    `(keys {${keys.join(',')}}, has_error=${String(envelope.has_error ?? false)}, ` +
    `${logs ? `${logs.length} log lines` : 'no logs'})${errorText}`;

  if (!logs || logs.length === 0) return head;
  if (!logsVisible(label)) {
    return `${head}\n(action logs withheld — render logs can carry rendered content; set S2S_DEBUG_ACTION_LOGS=1 to print them)`;
  }
  return `${head}\n--- ${stage} action logs ---\n${logs.map((line) => String(line)).join('\n')}`;
};

// ===========================================================================
// runAction — single source of truth for dev/prod transport
// ===========================================================================

/**
 * Executes a Lit Action on either the Bun runner (preview) or Lit nodes
 * (production). Returns ActionBarResult<T> uniformally.
 */


export async function runAction(
  preview: boolean,
  lit: LitService,
  cid: string,
  inputs: Record<string, unknown>,
  litUsageKey?: string,
  /** Stage name ('prep', 'render', 'update', ...) used for diagnostics. */
  label?: string,
): Promise<unknown> {

  if (preview) {
    const runnerUrl = process.env.S2S_RUNNER_URL || 'https://run.transport-union.dev/run';
    const r = await fetch(runnerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cid, inputs }),
      // Mirror the runner's own 10s IPFS fetch timeout so a hung runner
      // aborts client-side instead of hanging the render PREP stage.
      signal: AbortSignal.timeout(10000),
    });
    const text = await r.text();
    let wrapped: { success?: boolean; error?: string; response: unknown };
    try {
      wrapped = JSON.parse(text) as { success?: boolean; error?: string; response: unknown };
    } catch {
      // Runner returns plain-text bodies on HTTP 500 (Hono default 'Internal
      // Server Error'); surface that as an actionable message instead of a raw
      // SyntaxError from the unwrapped r.json().
      throw new Error(`runner ${String(r.status)} returned non-JSON: ${text.slice(0, 200)}`);
    }
    // console.log("RUNNER RESPONSE:", JSON.stringify(wrapped, null, 2));
    if (wrapped.success === false) console.log(`bun serverless call failed: ${wrapped.error}`);
    if (wrapped.response === undefined) {
      throw new Error(
        describeMissingResponse(label, wrapped as unknown as Record<string, unknown>),
      );
    }
    return wrapped.response; // ActiedonBarResult<T>
  } else {
    let code: string | undefined;
    let codeErr: unknown;
    // Fetch the action bundle from a gateway with a per-attempt timeout. The
    // Pinata gateway has been 403ing/hanging (2026-10), so transport-union is
    // primary with Pinata as fallback — never let a dead gateway hang the
    // action (this was the live-publish hang: stuck on the code fetch).
    const FETCH_TIMEOUT_MS = Number(process.env.ACTION_CODE_FETCH_TIMEOUT_MS ?? 10_000);
    const gateways = [
      (process.env.IPFS_URL || 'https://ipfs.transport-union.dev').replace(/\/$/, ''),
      (process.env.PINATA_GATEWAY || 'https://neutralpress.mypinata.cloud').replace(/\/$/, ''),
    ];
    for (const gw of gateways) {
      try {
        const codeResp = await fetch(`${gw}/ipfs/${cid}`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!codeResp.ok) {
          continue;
        }
        code = await codeResp.text();
        break;
      } catch (err: unknown) {
        codeErr = err;
      }
    }
    if (!code) {
      throw new Error(`action code fetch failed for ${cid}: ${codeErr instanceof Error ? codeErr.message : String(codeErr)}`);
    }

    const EXEC_TIMEOUT_MS = Number(process.env.LIT_EXEC_TIMEOUT_MS ?? 120_000);
    // Bound the whole live execution so a hung Lit action can't hang the
    // orchestrator (or silently drain Lit compute). The signal is threaded
    // through executeAction → call → fetch; on timeout callWithTimeout
    // converts the AbortError into a clear error.
    const raw = await callWithTimeout(
      (signal) => lit.executeAction(code, inputs, litUsageKey, signal),
      EXEC_TIMEOUT_MS,
    );
    // failure is logged in lit service — but a body that carries no `response`
    // at all (has_error false, logs present) used to reach the caller as
    // `undefined` and die in schema validation with no usable detail.
    const envelope = raw as Record<string, unknown> | undefined;
    if (envelope === undefined || envelope.response === undefined) {
      throw new Error(describeMissingResponse(label, envelope));
    }
    return envelope.response;      // ActionBarResult<T> — same shape
  }
}
