import { S2SProtocolInfo } from '../protocol';
import * as ethers from 'ethers';
(global as any).ethers = ethers;

import { LitService } from '../lit';
import {
  validateEvmUpdateInput,
  validateEvmUpdateOutput,
  validateMaintainCacheInput,
  validatePrepInput,
  validatePrepOutput,
  validateSingleInput,
  validateSingleOutput,
} from './action-io';
import { S2SJob } from './types';
import { runAction } from './helpers';

// ===========================================================================
// Render-action retry (LIVE path only) — DISABLED (2026-10)
// ===========================================================================
// This used to retry the whole live render action RENDER_RETRY_ATTEMPTS times
// to tolerate a flaky Base RPC. That is now OFF (operator directive, 2026-10):
// every retry re-fires the Lit action, re-opening a fresh session and re-
// draining the per-session 50-request budget / compute charge. With the
// runAction timeouts in place the correct behavior is to fail fast and let the
// orchestrator mark the job failed — one attempt, no re-fire.
//
// The deterministic session-budget fast-fail and the envelope/throw
// normalization below are kept so a single failure still surfaces a clean,
// actionable error.
const RENDER_RETRY_ATTEMPTS = 1; // single attempt: live renders are NOT retried
const RENDER_RETRY_BACKOFF_MS = 1500; // unused while attempts === 1 (kept for re-enable)

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Matches Lit's DETERMINISTIC session-budget error, e.g.
 * 'You may not send more than 50 HTTP requests per session and you have
 * attempted to exceed that limit.'
 *
 * A job whose per-session request count exceeds Lit's budget will determin-
 * istically blow on EVERY retry: each retry opens a fresh session with a
 * fresh 50-request budget and re-runs the same budget-blowing work — pure
 * cost with zero chance of success. So when this error surfaces we fast-fail
 * the retry loop instead of wasting the remaining attempts.
 *
 * Matched on the stable substring 'HTTP requests per session', which is
 * robust to the request-count ('50') changing. Deliberately NOT matched on
 * the generic 'Decryption error for item' prefix — that class mixes transient
 * and budget failures; we match the budget substring wherever it is embedded.
 */
export function isDeterministicBudgetError(msg: string): boolean {
  return /HTTP requests per session/i.test(msg);
}

/**
 * Execute a render action on the live path, single attempt (retries disabled
 * 2026-10 — see RENDER_RETRY_ATTEMPTS). Kept as a wrapper so the failure
 * envelope/throw normalization is in one place.
 *
 * Exported so the logic is unit-testable in isolation (mocking `runAction`);
 * the orchestrator (`renderwithLitActions`) is the only other consumer.
 */
export async function runRenderActionWithRetry(
  preview: boolean,
  lit: LitService,
  cid: string,
  job: any,
  inputs: Record<string, unknown>,
  litUsageKey?: string,
): Promise<any> {
  const attempts = preview ? 1 : RENDER_RETRY_ATTEMPTS;
  let lastFailure: any;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleepMs(RENDER_RETRY_BACKOFF_MS);
    try {
      const actionResult: any = await runAction(preview, lit, cid, inputs, litUsageKey, 'render');
      // Envelope success (render action returns { ok: ... }). A non-ok result
      // can be a transient transport failure surfaced by the action, so on the
      // live path we re-run the (read-only) render action rather than giving up.
      if (actionResult?.ok || actionResult?.success) return actionResult;
      lastFailure = actionResult;
      // Deterministic session-budget overflow ("more than 50 HTTP requests per
      // session") will recur on every retry — each retry re-opens a budget and
      // re-runs the same budget-blowing work. Fast-fail to skip wasted retries.
      const nonOkMsg = String(actionResult?.error ?? '');
      if (isDeterministicBudgetError(nonOkMsg)) {
        console.error(
          `[render job ${job?.id}] attempt ${attempt}/${attempts} deterministic session-budget error; NOT retrying — ${nonOkMsg}`,
        );
        break;
      }
      if (attempt < attempts)
        console.error(
          `[render job ${job?.id}] attempt ${attempt}/${attempts} returned non-ok; retrying in ${RENDER_RETRY_BACKOFF_MS}ms — ${JSON.stringify(actionResult?.error ?? actionResult)}`,
        );
    } catch (err: any) {
      lastFailure = err;
      // Same deterministic budget class on the thrown path — fast-fail the loop.
      const thrownMsg = err?.message ?? '';
      if (isDeterministicBudgetError(thrownMsg)) {
        console.error(
          `[render job ${job?.id}] attempt ${attempt}/${attempts} deterministic session-budget error; NOT retrying — ${thrownMsg}`,
        );
        break;
      }
      if (attempt < attempts)
        console.error(
          `[render job ${job?.id}] attempt ${attempt}/${attempts} threw; retrying in ${RENDER_RETRY_BACKOFF_MS}ms — ${err?.message ?? String(err)}`,
        );
    }
  }

  // Exhausted retries — surface the last failure as a throw so the caller's
  // existing catch marks this job failed (and it is filtered from the update).
  //
  // Preserve the REAL failure detail: a non-ok render envelope is an object of
  // shape { ok:false, action:'render', error:'msg', trace:[...] }, and
  // String(envelope) would yield '[object Object]', losing the message. Unwrap
  // the human-readable detail (error ?? message ?? toString-of-last-resort) and
  // attach the original failure object so callers/logs can still inspect it.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentional || to catch empty string
  const err =
    lastFailure instanceof Error
      ? (lastFailure.message ? lastFailure : new Error(JSON.stringify(lastFailure) || 'render action failed'))
      : new Error(
          lastFailure?.error ||
            lastFailure?.message ||
            (typeof lastFailure === 'string' ? lastFailure : JSON.stringify(lastFailure)) ||
            // Runner returned a non-ok/empty envelope with no error field (e.g. an
            // HTTP 504 whose JSON body lacked success===false, so runAction resolved
            // to undefined). `new Error(undefined)` yields an EMPTY message that would
            // hide the real failure from the caller — give it something actionable.
            'render action returned no result (runner returned a non-ok/empty envelope)',
        );
  (err as any).failure = lastFailure;
  throw err;
}

// ===========================================================================
// renderWithLitActions
// ===========================================================================
//
// The endpoints field (ipfsGateway, rpcs) is populated here.
// Source of rpcs is deferred per handoff-actions-extract-constants §6 —
// the caller should provide endpoints once the source is decided.
// For now rpcs is a placeholder that throws — it must be wired before shipping.
// ===========================================================================

export const renderwithLitActions = async (
  preview: boolean,
  lit: LitService,
  signature: string,
  litUsageKey: string,
  protocolInfo: S2SProtocolInfo,
  notice: any,
  authorSafeAddress: string,
  publication: string,
  contentIds: string[],
  configCid?: string,
  _rpcs?: { L1: string[]; L2: string[] },
  _ipfsGateway?: string,
  remove?: { path: string; replacedBy?: string }[],
  reset?: boolean,
  /** Kubo RPC bearer token for the data gateway (token-gated writes). */
  _ipfsGatewayAuth?: string,
) => {
  let jobs: S2SJob[] = [];
  let cid: string | null = null;

  // A reset-only run (reset:true with zero contentIds) skips prep + render —
  // prep rejects empty contentIds (prep/main.ts) — and drives the update action
  // directly with jobs:[] + reset:true so the tree is rebuilt fresh. See
  // RFC-reset-tree-button.md.
  const resetOnly = reset === true && contentIds.length === 0;

  // Render-stage results — hoisted so the EVM update stage below can consume
  // them whether or not prep/render ran (a reset-only run leaves them empty).
  let prepRemove: { path: string; replacedBy?: string }[] | undefined;
  let activeJobs: any[] = [];
  let allRemove: { path: string; replacedBy?: string }[] = [];
  let primaryPath = '';
  // True when any successful render flagged pending cache drift (data.
  // maintainCache === true). Drives the parallel maintain-cache action below.
  let maintainCachePending = false;

  // ── Build endpoints ──────────────────────────────────────────────
  // _rpcs: caller-supplied RPC endpoints (L1 = Ethereum, L2 = Base)
  // _ipfsGateway: optional — falls back to protocolInfo.gateway
  const endpoints = {
    ipfsGateway: _ipfsGateway ?? protocolInfo.gateway,
    ipfsGatewayAuth: _ipfsGatewayAuth,
    rpcs:
      _rpcs ??
      (() => {
        throw new Error('endpoints.rpcs not wired — see handoff-actions-extract-constants §6');
      })(),
  };

  // ---------------- Preperation Stage ------------------------------------

  if (!resetOnly) {
    if (notice) notice.setMessage('prepping render ...');
    const prepInputs = validatePrepInput({ publication, configCid, contentIds, endpoints });
    const prepAction = await runAction(
      true,
      lit,
      protocolInfo.litActions.prep,
      prepInputs,
      litUsageKey,
      'prep',
    );
    const validatedPrep = validatePrepOutput(prepAction);
    if (!validatedPrep.ok) console.log(JSON.stringify(validatedPrep, null, 2));
    if (validatedPrep.ok) {
      jobs = (validatedPrep as any).data?.jobs;
      console.log('Jobs dispatched:', jobs.length, jobs);
    }

    // Read auto-detected slug-change removals from prep output
    prepRemove = (validatedPrep as any).ok ? (validatedPrep as any).data?.remove : undefined;

    // ---------------- Single Actions Stage ----------------------------------

    if (notice) notice.setMessage('ispatching render actions ...');
    else console.log('dispatching render actions...');

    const allResults = await Promise.all(
      jobs.map(async (job: any, index: number) => {
        try {
          const singleInputs = validateSingleInput({
            signature,
            authorSafeAddress,
            configCid,
            publication,
            job,
            preview,
            maintainCache: index === jobs.length - 1,
            // The id(s the caller rendered — the render action scopes its on-chain
            // hasDeal revoke check to these ids ONLY (a revoke is always about the
            // id the caller rendered). A cascade/ripple destination (e.g. home) is
            // re-rendered as a consequence of the trigger and must NEVER be
            // hasDeal-checked: a destination pinned via query.genesis may never
            // have been a deal, so hasDeal=false there would falsely revoke-and-
            // remove a live page (publish-path regression, acceptance 4).
            triggeredContentIds: contentIds,
            endpoints,
          });
          const actionResult = await runRenderActionWithRetry(
            preview,
            lit,
            protocolInfo.litActions.render,
            job,
            singleInputs,
            litUsageKey,
          );
          return { success: true, index, data: actionResult };
        } catch (err: any) {
          return { success: false, index, error: err?.message ?? String(err) };
        }
      }),
    );

    // log every job that didn't cleanly succeed — both failure kinds, full object
    for (const r of allResults) {
      const failed = !r.success || !(r.data as any)?.ok;
      if (failed) {
        const avail = (r.data as any)?.data?.availability ?? (r.data as any)?.trace?.find((t: any) => t?.availability)?.availability;
        const availSummary =
          avail && avail.length > 0
            ? ` | availability: ${avail.map((a: any) => `${a.kind}${a.genesis ? ' ' + a.genesis.slice(0, 12) + '…' : ''}${a.cid ? ' ' + a.cid.slice(0, 10) + '…' : ''}`).join(', ')}`
            : '';
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
        console.error(`[single ${r.index}]${availSummary}`, JSON.stringify(r.data ?? { error: r.error || 'render action failed' }, null, 2));
      }
    }

    const successful = (allResults as any[]).filter((r: any) => r.success && r.data?.ok);

    // Log availability reports from successful renders (non-fatal data-fetch skips).
    for (const r of successful) {
      const avail = (r.data?.data as any)?.availability;
      if (avail && avail.length > 0) {
        const index = (r as any).index;
        console.log(
          `[single ${index}] data-availability: ${avail.map((a: any) => `${a.kind} ${a.genesis ? a.genesis.slice(0, 12) + '…' : ''}${a.cid ? ' cid=' + a.cid.slice(0, 10) + '…' : ''}: ${a.reason}`).join('; ')}`,
        );
      }
    }

    console.log({ 'rendered jobs': successful });

    // Any successful render that surfaced cache drift flags the parallel
    // maintain-cache action for firing (see the EVM update stage below).
    maintainCachePending = successful.some(
      (r: any) => (r.data?.data as any)?.maintainCache === true,
    );

    // Separate active (non-revoked) jobs from revoked jobs.
    // Active jobs carry rendered HTML → copied to MFS by the update action.
    // Revoked jobs carry only a path → their path goes into the remove list
    // so the update action deletes it from the MFS tree (GAP-10 revoke ripples).
    activeJobs = successful
      .map((r: any) => r.data.data.job)
      .filter((j: any) => j?.path && !j?.revoked);

    const revokedRemove: { path: string; replacedBy?: string }[] = [];
    for (const r of successful) {
      const job = (r as any).data?.data?.job;
      if (job?.revoked && job?.path) {
        revokedRemove.push({ path: job.path });
      }
    }

    // Merge: auto-detected (slug-change) removals from prep + revoked-job
    // paths + caller-supplied removals (neutralpress revoke flow).
    allRemove = [...(prepRemove ?? []), ...revokedRemove, ...(remove ?? [])];

    // Primary job path (first active rendered job = the content the user triggered)
    primaryPath = activeJobs[0]?.path ?? '';

    // ── Render-failure guard ─────────────────────────────────────────────
    // Every render job failed (activeJobs empty), there is nothing to remove,
    // and this is not a reset-only run — the update action would be invoked
    // with jobs:[] and no remove/reset, which validateEvmUpdateInput rejects
    // with the cryptic 'jobs must have at least one item, or remove entries
    // must be provided (revoke path), or reset must be true (reset path)'
    // error. Skip the update call ENTIRELY and fail loudly with the real
    // per-job render failures (job index + error/status) instead, so callers
    // see what actually broke rather than an EvmUpdate validation message.
    if (activeJobs.length === 0 && allRemove.length === 0) {
      type RenderJobResult =
        | { success: true; index: number; data: { ok?: boolean } | undefined }
        | { success: false; index: number; error?: string };
      const results = allResults as RenderJobResult[];
      const failures: string[] = [];
      for (const result of results) {
        if (result.success) {
          if (Boolean(result.data?.ok)) continue;
          failures.push(`job ${String(result.index)}: ${JSON.stringify(result.data)}`);
        } else {
          failures.push(`job ${String(result.index)}: ${result.error ?? 'unknown error'}`);
        }
      }
      const summary = failures.length > 0 ? failures.join('; ') : 'no render jobs succeeded';
      throw new Error(`render jobs failed: ${summary}`);
    }
  }

  // ---------------- EVM Root Update Stage ---------------------------------

  if (notice) notice.setMessage('merging EVM update ...');
  else console.log('preparing evm update...');

  const evmInputs = validateEvmUpdateInput({
    signature,
    authorSafeAddress,
    publication,
    jobs: resetOnly ? [] : activeJobs,
    preview,
    endpoints,
    remove: allRemove.length > 0 ? allRemove : undefined,
    reset: reset ? true : undefined,
  });

  const evmAction: any = await runAction(
    preview,
    lit,
    protocolInfo.litActions.update,
    evmInputs,
    litUsageKey,
    'update',
  );
  const validated = validateEvmUpdateOutput(evmAction);
  if (!validated.ok) console.log(JSON.stringify(validated, null, 2));
  if (validated.ok) cid = (validated as any).data.cid;

  // ── Parallel per-publication cache maintenance ─────────────────────────┐
  // A successful render flagged pending archive drift (data.maintainCache) and
  // the maintain-cache action is deployed (litActions.maintainCache set). Fire
  // it in its OWN fresh session so the pointer's setText gets a young provider
  // + a dedicated 50-request budget — the conditions under which the update
  // action's setText is provably reliable — instead of the render's tail.
  //
  // Run AFTER the update action completes (not truly concurrent) to avoid a PKP
  // nonce collision: both the update and the maintain-cache write via the SAME
  // PKP, each drawing the same "pending" nonce from getTransactionCount — two
  // concurrent broadcasts with the same nonce would drop one. Sequencing keeps
  // the two writes on consecutive nonces. The render itself is already done;
  // this only tails the (separate) update call.
  //
  // Best-effort WRT the publish result: a failure here is logged LOUDLY (never
  // swallowed like the old fire-and-forget) but must not fail the already-
  // successful publish. The render's inline write-back remains the first-
  // attempt path.
  let maintainCacheResult: any = null;
  if (!preview && maintainCachePending && protocolInfo.litActions.maintainCache) {
    try {
      const maintainInputs = validateMaintainCacheInput({
        signature,
        authorSafeAddress,
        publication,
        preview,
        endpoints,
      });
      console.log(
        `[maintain-cache] firing dedicated action (${protocolInfo.litActions.maintainCache}) after render flagged drift`,
      );
      maintainCacheResult = await runAction(
        preview,
        lit,
        protocolInfo.litActions.maintainCache,
        maintainInputs,
        litUsageKey,
        'maintain-cache',
      );
    } catch (err: any) {
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      console.error(`[maintain-cache] dedicated action threw: ${err?.message || String(err)}`);
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      maintainCacheResult = { ok: false, error: err?.message || String(err) || 'maintain-cache action failed' };
    }
    // Log loudly, never swallow — the pointer write must be observable, not
    // silently dropped the way the old fire-and-forget write-back was.
    console.log(
      `[maintain-cache] result: ${JSON.stringify({
        ok: maintainCacheResult?.ok,
        action: maintainCacheResult?.action,
        error: maintainCacheResult?.error,
        wrote: maintainCacheResult?.data?.wrote,
        cid: maintainCacheResult?.data?.cid,
      })}`,
    );
  }

  return {
    success: validated.ok ? true : false,
    cid,
    path: primaryPath,
    trace: evmAction.trace,
    // Surface the REAL failure cause so callers (e.g. the website-tree reset
    // tab) can display it instead of a generic "did not report success".
    // `validated` is the schema-checked envelope (error present when ok:false);
    // fall back to the raw action envelope, then a generic message.
    error: validated.ok
      ? undefined
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      : ((validated as any)?.error || (evmAction as any)?.error || 'update action failed'),
    // Result of the dedicated maintain-cache action (null when not fired). Kept
    // on the envelope so callers/observers can see the cache write outcome.
    maintainCache: maintainCacheResult,
  };
};
