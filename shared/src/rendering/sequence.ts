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
        const actionResult = await runAction(
          preview,
          lit,
          protocolInfo.litActions.render,
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
    remove: prepRemove,
  });

  const evmAction = await runAction(
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
  };
};
