import { S2SManifest } from '../protocol';
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
import { S2SJob, RenderMode } from './types';
import type { RevokeTarget } from '../lit/actions/types';
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
  mode: RenderMode,
  lit: LitService,
  cid: string,
  job: any,
  inputs: Record<string, unknown>,
  litUsageKey?: string,
): Promise<any> {
  const attempts = mode === 'publish' ? RENDER_RETRY_ATTEMPTS : 1;
  const transport = mode === 'dev' ? 'runner' : 'lit';
  let lastFailure: any;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleepMs(RENDER_RETRY_BACKOFF_MS);
    try {
      const actionResult: any = await runAction(transport, lit, cid, inputs, litUsageKey, 'render');
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
  mode: RenderMode,
  lit: LitService,
  signature: string,
  litUsageKey: string,
  protocolInfo: S2SManifest,
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
  /** Ids the caller is revoking: prep derives each page path and removes it. */
  revokeIds?: RevokeTarget[],
) => {
  let jobs: S2SJob[] = [];
  let cid: string | null = null;

  // The action inputs still read one boolean: `preview` is true for dev and
  // preview, false for publish. Deployed action CIDs read it, so it keeps its
  // meaning even where the stage transport changed. `unsigned` is the new
  // input the render action reads to decide whether to sign.
  const preview = mode !== 'publish';
  const unsigned = mode !== 'publish';

  // Preview renders on Lit and asks the render action to run unsigned. A
  // render action that predates the `unsigned` input ignores it and signs the
  // page, so refuse the run unless the manifest advertises that its pinned
  // action reads it. This is the only way to keep a decrypting preview off a
  // deployment that would sign.
  if (mode === 'preview' && protocolInfo.capabilities?.unsignedRender !== true) {
    throw new Error(
      "preview requires an unsigned render: this publication's manifest does not " +
        'advertise capabilities.unsignedRender, so its pinned render action predates ' +
        'the `unsigned` input and a Lit render would sign the page. ' +
        'Release the render action that reads `unsigned` and pin it to this publication.',
    );
  }

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

  /**
   * Fire the dedicated maintain-cache action in its own fresh session and
   * report the outcome in one line. Called when a render flagged drift and when
   * the render stage failed outright: in both cases the archive the pointer
   * names is the thing that has to be brought up to date and pinned.
   *
   * Runs AFTER the update action (never concurrently): both write through the
   * same PKP, and two broadcasts drawn from the same pending nonce would drop
   * one. A failure is logged loudly and never thrown — it must not mask the
   * publish or the render failure it tails.
   */
  const fireMaintainCache = async (): Promise<any | null> => {
    if (preview || !protocolInfo.litActions.maintainCache) return null;
    let result: any = null;
    try {
      const maintainInputs = validateMaintainCacheInput({
        signature,
        authorSafeAddress,
        publication,
        preview,
        endpoints,
      });
      result = await runAction(
        'lit',
        lit,
        protocolInfo.litActions.maintainCache,
        maintainInputs,
        litUsageKey,
        'maintain-cache',
      );
    } catch (err: any) {
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      result = { ok: false, error: err?.message || String(err) || 'maintain-cache action failed' };
    }
    // One line, never swallowed — the pointer write must be observable, not
    // silently dropped the way the old fire-and-forget write-back was. A
    // success without a CID is the steady state (no drift to merge): say
    // nothing rather than print an empty write.
    if (result?.ok) {
      const cacheCid = result?.data?.cid;
      if (cacheCid) console.log(`✓ cache updated ${cacheCid}`);
    } else {
      console.error(`✗ cache update failed: ${result?.error ?? 'unknown error'}`);
    }
    return result;
  };

  // ---------------- Preperation Stage ------------------------------------

  if (!resetOnly) {
    if (notice) notice.setMessage('prepping render ...');
    const prepInputs = validatePrepInput({
      publication,
      configCid,
      contentIds,
      endpoints,
      revoke: revokeIds,
    });
    const prepAction = await runAction(
      'runner',
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

    // A caller-named revoke is answered by prep, or by nothing. Say which: a
    // prep action that predates revoke targets ignores the field, and the run
    // then reports a removal it never asked for and never gets.
    if (revokeIds?.length) {
      const prepTrace = ((validatedPrep as any)?.trace ?? []).filter(
        (line: unknown) => typeof line === 'string' && line.startsWith('revoke'),
      );
      if (prepTrace.length > 0) prepTrace.forEach((line: string) => console.log(line));
      else
        console.warn(
          'prep answered no revoke path: the prep action at ' +
            `${protocolInfo.litActions.prep} does not accept revoke targets — add and release the rebuilt action, then re-run`,
        );
    }

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
            unsigned,
            maintainCache: index === jobs.length - 1,
            // The id(s the caller rendered — the render action scopes its on-chain
            // hasAgreement revoke check to these ids ONLY (a revoke is always about
            // the id the caller rendered). A cascade/ripple destination (e.g. home)
            // is re-rendered as a consequence of the trigger and must NEVER be
            // hasAgreement-checked: a destination pinned via query.genesis may never
            // have been under an agreement, so hasAgreement=false there would
            // falsely revoke-and-remove a live page (publish-path regression,
            // acceptance 4).
            triggeredContentIds: contentIds,
            endpoints,
          });
          const actionResult = await runRenderActionWithRetry(
            mode,
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
    //
    // A revoked job re-renders from a stored body that has lost its slug, so its
    // path can come back as the template itself (`/posts/{slug}/`). That names
    // no directory: dropping it here leaves prep's own entry, which it derived
    // with the slug the caller supplied, as the removal.
    allRemove = [...(prepRemove ?? []), ...revokedRemove, ...(remove ?? [])].filter((entry) => {
      if (!/\{[a-z_]+\}/i.test(entry.path)) return true;
      console.warn(`drop remove ${entry.path}: unresolved template placeholder`);
      return false;
    });

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
      // A failed page render still leaves the item archive stale: the pointer
      // on chain keeps naming a snapshot that no render has refreshed or
      // mirrored since. Fire the dedicated action anyway — it derives the
      // archive from chain + IPFS, not from this render — and hang the result
      // on the error so the caller can mirror the CID the pointer now names.
      const cacheResult = jobs.length > 0 ? await fireMaintainCache() : null;
      const failure = new Error(`render jobs failed: ${summary}`) as Error & {
        maintainCache?: unknown;
      };
      if (cacheResult) failure.maintainCache = cacheResult;
      throw failure;
    }
  }

  // ---------------- EVM Root Update Stage ---------------------------------

  if (notice) notice.setMessage('merging EVM update ...');
  else console.log('preparing evm update...');

  // One update session writes every page it is given, and each page costs six
  // IPFS requests: read the page already there, cat the new one, hasAgreement,
  // remove, copy, and one `files/ls`. The listing is per page, not per
  // collection: the path handed to it is the page file (`/index.html` inside
  // the page's own directory), so two pages under `/posts` still list twice.
  //
  // On top of that the call spends a fixed 25 to 30: 13-15 in the prologue
  // (manifest, owner and modules, canPublish, config, previous contenthash,
  // aliases, root copy) and 12-15 in the tail (assets stat/rm/cp, two txt
  // listings, root stat, pin/add, cleanup, and the on-chain write's nonce, gas
  // estimate, send and receipt polling). Two pages therefore costs 37-42, and
  // the rest of the fifty is not spare room: after the first batch the previous
  // root copy has already put the mirrored root txt files in place, so robots.txt
  // and llms.txt cost three requests each (stat, the rm that clears the copy,
  // then the copy that cannot overwrite), which takes the session to 43-48.
  //
  // A revoke costs up to four more — hasAgreement, its retries, then the rm —
  // so it rides a batch of its own that holds a single page: 42 at worst plus
  // its four is 46, under the cap. A bulk render therefore splits its pages
  // into batches and runs the update once per batch, sequentially: each call
  // writes a contenthash at its end and the next one copies that tree forward.
  const UPDATE_BATCH_SIZE = 2;
  const updateJobs = resetOnly ? [] : activeJobs;
  const batches: any[][] = [];
  if (reset || updateJobs.length <= UPDATE_BATCH_SIZE) {
    // A reset is never batched: it starts from an empty tree, so a second batch
    // would delete the pages the first one wrote.
    batches.push(updateJobs);
  } else {
    for (let i = 0; i < updateJobs.length; i += UPDATE_BATCH_SIZE) {
      batches.push(updateJobs.slice(i, i + UPDATE_BATCH_SIZE));
    }
  }

  // The revoke rides the last batch, so that batch must hold one page. This is
  // checked after the batches exist rather than inside the loop, because the
  // small case is the one it matters most for: two pages and a revoke would
  // otherwise be a single call of two pages, and the revoke's four requests on
  // top of 43-48 reaches 52. A reset is one call by design and is never split.
  if (!reset) {
    const last = batches[batches.length - 1];
    if (last && last.length > 1 && allRemove.some((entry) => !entry.replacedBy)) {
      batches.pop();
      for (const job of last) batches.push([job]);
    }
  }

  // A removal only lands when the genesis that replaced the page is among the
  // jobs of the same call — otherwise the update skips it and the old page stays
  // live. Send each removal with the batch carrying its replacement; a revoke
  // (no replacement) goes with the last batch.
  //
  // A removal whose replacement is in NO batch (prep named a genesis this render
  // did not produce) must still be sent, or it vanishes with no trace at all.
  // It rides the last batch, where the update's own `replacedBy ... not in job
  // set` line records the skip — the costs are zero requests and an honest
  // trace instead of a silent drop.
  const replacementIds = new Set<string>();
  for (const j of updateJobs as any[]) {
    if (j?.id) replacementIds.add(j.id);
    if (j?.sourceId) replacementIds.add(j.sourceId);
  }
  const removeForBatch = (batchJobs: any[], isLast: boolean) =>
    allRemove.filter((entry) => {
      if (!entry.replacedBy) return isLast;
      if (!replacementIds.has(entry.replacedBy)) return isLast;
      return batchJobs.some((j) => j.id === entry.replacedBy || j.sourceId === entry.replacedBy);
    });

  let validated: any = { ok: false, error: 'update action was not run' };
  let lastEvmAction: any = null;
  const updateTrace: unknown[] = [];
  for (let i = 0; i < batches.length; i++) {
    const batchJobs = batches[i];
    const batchRemove = removeForBatch(batchJobs, i === batches.length - 1);
    const evmInputs = validateEvmUpdateInput({
      signature,
      authorSafeAddress,
      publication,
      jobs: resetOnly ? [] : batchJobs,
      preview,
      endpoints,
      remove: batchRemove.length > 0 ? batchRemove : undefined,
      reset: reset ? true : undefined,
    });
    if (notice && batches.length > 1) {
      notice.setMessage(`merging EVM update ${i + 1}/${batches.length} ...`);
    } else if (batches.length > 1) {
      console.log(`update batch ${i + 1}/${batches.length}: ${batchJobs.length} page(s)`);
    }
    lastEvmAction = await runAction(
      mode === 'publish' ? 'lit' : 'runner',
      lit,
      protocolInfo.litActions.update,
      evmInputs,
      litUsageKey,
      'update',
    );
    validated = validateEvmUpdateOutput(lastEvmAction);
    updateTrace.push(...((lastEvmAction as any)?.trace ?? []));
    if (!validated.ok) {
      console.log(JSON.stringify(validated, null, 2));
      // Earlier batches wrote their roots, but the tree the caller would pin is
      // only whole once the last batch landed. Drop the partial root so a reader
      // that takes `cid` off a failed envelope cannot pin a half-written site.
      cid = null;
      break;
    }
    cid = (validated as any).data.cid;
  }

  // ── Parallel per-publication cache maintenance ─────────────────────────┐
  // A successful render flagged pending archive drift (data.maintainCache).
  // Fire the dedicated action (see fireMaintainCache) after the update call
  // completes, on a fresh session, rather than in the render's tail.
  const maintainCacheResult: any = maintainCachePending ? await fireMaintainCache() : null;

  return {
    success: validated.ok ? true : false,
    cid,
    path: primaryPath,
    // The remove entries the update action was given (prep's slug-change and
    // caller-named revocations, plus any the render flagged). It carries them
    // on the envelope because the removal is a separate step from the tree
    // write: the trace says whether each one landed, and a caller that asked
    // for a removal needs to name what it asked for.
    remove: allRemove,
    trace: updateTrace,
    // Surface the REAL failure cause so callers (e.g. the website-tree reset
    // tab) can display it instead of a generic "did not report success".
    // `validated` is the schema-checked envelope (error present when ok:false);
    // fall back to the raw action envelope, then a generic message.
    error: validated.ok
      ? undefined
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      : ((validated as any)?.error ||
        (lastEvmAction as any)?.error ||
        'update action failed'),
    // Result of the dedicated maintain-cache action (null when not fired). Kept
    // on the envelope so callers/observers can see the cache write outcome.
    maintainCache: maintainCacheResult,
  };
};
