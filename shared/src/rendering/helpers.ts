import { LitService } from "../lit";
import { callWithTimeout } from "../helpers/timeout";

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
    });
    const wrapped = await r.json();
    // console.log("RUNNER RESPONSE:", JSON.stringify(wrapped, null, 2));
    if (wrapped.success === false) console.log(`bun serverless call failed: ${wrapped.error}`);
    return wrapped.response; // ActiedonBarResult<T>
  } else {
    // =====================================================================
    // [RENDER-DEBUG] TEMPORARY diagnostic instrumentation — root-causing the
    // live 'silent stop after Jobs dispatched with no Lit charge' bug.
    // LOG-ONLY: keys/tokens are NEVER printed — only presence/length.
    // Remove after diagnosis by grepping for [RENDER-DEBUG]. The code-CID
    // fetch below is guarded with callWithTimeout (30s) so a stalled gateway
    // becomes a thrown error instead of a silent infinite hang.
    // =====================================================================
    const t0 = Date.now();
    const hasKey = typeof litUsageKey === 'string' && litUsageKey.length > 0;
    console.log(
      `[RENDER-DEBUG] runAction live begin cid=${cid} preview=${String(preview)} t0=${String(t0)} litUsageKey=${String(hasKey)}` +
        (typeof litUsageKey === 'string' ? ` len=${String(litUsageKey.length)}` : ''),
    );

    let code: string;
    try {
      const codeResp = await callWithTimeout(
        (signal) => fetch(`https://neutralpress.mypinata.cloud/ipfs/${cid}`, { signal }),
        30_000,
      );
      if (!codeResp.ok) {
        throw new Error(
          `render action code fetch failed for cid=${cid}: HTTP ${String(codeResp.status)} ${codeResp.statusText}`,
        );
      }
      console.log(
        `[RENDER-DEBUG] cid code fetch done cid=${cid} status=${String(codeResp.status)} elapsed=${String(Date.now() - t0)}ms`,
      );
      code = await codeResp.text();
    } catch (err: unknown) {
      const errType = err instanceof Error ? err.name : typeof err;
      console.log(`[RENDER-DEBUG] cid code fetch THREW cid=${cid} elapsed=${String(Date.now() - t0)}ms errType=${errType}`);
      throw err;
    }

    console.log(`[RENDER-DEBUG] executing lit action for cid=${cid} hasKey=${String(hasKey)}`);
    const t1 = Date.now();
    let raw: { response: unknown; logs: string[]; has_error: boolean } | undefined;
    try {
      raw = await lit.executeAction(code, inputs, litUsageKey);
      console.log(`[RENDER-DEBUG] lit executeAction returned cid=${cid} elapsed=${String(Date.now() - t1)}ms`);
    } catch (err: unknown) {
      const errType = err instanceof Error ? err.name : typeof err;
      console.log(`[RENDER-DEBUG] lit executeAction THREW cid=${cid} elapsed=${String(Date.now() - t1)}ms errType=${errType}`);
      throw err;
    }
    // failure is logged in lit service
    return raw.response;      // ActionBarResult<T> — same shape
  }
}
