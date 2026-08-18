import { S2SProtocolInfo } from '../protocol';
import * as ethers from 'ethers';
(global as any).ethers = ethers;

import { LitService } from '../lit';
import {
  validateEvmUpdateInput,
  validateEvmUpdateOutput,
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
      if (attempt < attempts)
        console.error(
          `[render job ${job?.id}] attempt ${attempt}/${attempts} returned non-ok; retrying in ${RENDER_RETRY_BACKOFF_MS}ms — ${JSON.stringify(actionResult?.error ?? actionResult)}`,
        );
    } catch (err: any) {
      lastFailure = err;
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
) => {
  let jobs: S2SJob[] = [];
  let cid: string | null = null;

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
  const prepRemove: { path: string; replacedBy?: string }[] | undefined = (validatedPrep as any).ok
    ? (validatedPrep as any).data?.remove
    : undefined;

  // Merge caller-supplied removals (revocations from neutralpress) with the
  // auto-detected slug-change removals. Caller removals are additive and
  // default to none, so existing callers (safe-app, render tests) are safe.
  const mergedRemove: { path: string; replacedBy?: string }[] = [
    ...(prepRemove ?? []),
    ...(remove ?? []),
  ];

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
  // Map the rendered job data out for the merged update
  const renderedJobs = successful.map((r: any) => r.data.data.job).filter((j: any) => j?.path);

  // Primary job path (first in the rendered list = the content the user triggered)
  const primaryPath = renderedJobs[0]?.path ?? '';

  // ---------------- EVM Root Update Stage ---------------------------------

  if (notice) notice.setMessage('merging EVM update ...');
  else console.log('preparing evm update...');

  const evmInputs = validateEvmUpdateInput({
    signature,
    authorSafeAddress,
    publication,
    jobs: renderedJobs,
    preview,
    endpoints,
    remove: mergedRemove.length > 0 ? mergedRemove : undefined,
  });

  const evmAction: any  = await runAction(
    preview,
    lit,
    protocolInfo.litActions.update,
    evmInputs,
    litUsageKey,
  );
  const validated = validateEvmUpdateOutput(evmAction);
  if (!validated.ok) console.log(JSON.stringify(validated, null, 2));
  if (validated.ok) cid = (validated as any).data.cid;

  return {
    success: validated.ok ? true : false,
    cid,
    path: primaryPath,
    trace: evmAction.trace
  };
};
