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
import { S2SJob } from '../protocol/types';
import { runAction } from './helpers';

// ===========================================================================
// Render-action retry (LIVE path only)
// ===========================================================================
// A transient transport failure on the live Lit path (flaky Base RPC) makes an
// individual render action fail. We retry the WHOLE render action execution
// HERE, at the orchestrator level, OUTSIDE the Lit session — so the re-issued
// eth_calls do NOT count against Lit's per-session 50-request budget. This is
// the counterpart to the in-session fail-fast evmRead (see protocol/actions
// src/libs/evm.ts); together they keep a multi-collection render well under the
// 50-request cap while still tolerating a flaky transport.
//
// Deliberately NOT retried here:
//   - preview — runs on the free Bun runner (no 50-request cap) and has no
//     need for this resilience;
//   - the EVM-update action — it has on-chain side effects, so a retried
//     update could double-write. Only the read-only render action is retried.
const RENDER_RETRY_ATTEMPTS = 3;
const RENDER_RETRY_BACKOFF_MS = 1500;

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
 * Retry a render-action execution on the live path as described above.
 *
 * Exported so the retry logic is unit-testable in isolation (mocking `runAction`);
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
      const actionResult: any = await runAction(preview, lit, cid, inputs, litUsageKey);
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
  const err =
    lastFailure instanceof Error
      ? lastFailure
      : new Error(
          lastFailure?.error ??
            lastFailure?.message ??
            (typeof lastFailure === 'string' ? lastFailure : JSON.stringify(lastFailure)),
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
    rpcs:
      _rpcs ??
      (() => {
        throw new Error('endpoints.rpcs not wired — see handoff-actions-extract-constants §6');
      })(),
  };

  // ---------------- Preperation Stage ------------------------------------

  if (!resetOnly) {
    if (notice) notice.setMessage('prepping render ...');
    else console.log('preview:', preview);

    console.log('pub1', publication);
    const prepInputs = validatePrepInput({ publication, configCid, contentIds, endpoints });
    const prepAction = await runAction(
      true,
      lit,
      protocolInfo.litActions.prep,
      prepInputs,
      litUsageKey,
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
      if (failed)
        console.error(`[single ${r.index}]`, JSON.stringify(r.data ?? { error: r.error }, null, 2));
    }

    const successful = (allResults as any[]).filter((r: any) => r.success && r.data?.ok);

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
      );
    } catch (err: any) {
      console.error(`[maintain-cache] dedicated action threw: ${err?.message ?? String(err)}`);
      maintainCacheResult = { ok: false, error: err?.message ?? String(err) };
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
      : ((validated as any)?.error ?? (evmAction as any)?.error ?? 'update action failed'),
    // Result of the dedicated maintain-cache action (null when not fired). Kept
    // on the envelope so callers/observers can see the cache write outcome.
    maintainCache: maintainCacheResult,
  };
};
