import { LitService } from "../lit";
import { callWithTimeout } from "../helpers/index.js";

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
    // failure is logged in lit service
    return raw.response;      // ActionBarResult<T> — same shape
  }
}
