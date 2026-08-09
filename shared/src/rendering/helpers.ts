import { LitService } from "../lit";

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
    const code = await fetch(`https://neutralpress.mypinata.cloud/ipfs/${cid}`).then(r => r.text());
    const raw = await lit.executeAction(code, inputs as any, litUsageKey!);
    // failure is logged in lit service
    return raw.response;      // ActionBarResult<T> — same shape
  }
}
