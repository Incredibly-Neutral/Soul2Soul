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
) => {

  let jobs: S2SJob[] = [];
  let cid: string | null = null;

  // ---------------- Preperation Stage ------------------------------------
  
  if (notice) notice.setMessage('prepping render ...'); else console.log('preview:', preview);

  console.log("pub1", publication)
  const prepInputs = validatePrepInput({ publication, configCid, contentIds });
  const prepAction = await runAction( true, lit, protocolInfo.litActionPrep, prepInputs, litUsageKey );
  const validatedPrep = validatePrepOutput(prepAction);
  if (!validatedPrep.ok) console.log(JSON.stringify(validatedPrep, null, 2)); 
  if (validatedPrep.ok) {
    jobs = validatedPrep.data?.jobs;
    console.log('Jobs dispatched:', jobs.length);
  }

  // ---------------- Single Actions Stage ----------------------------------
  
  if (notice) notice.setMessage('rendering single actions ...'); else console.log('dispatching single actions...');

  const allResults = await Promise.all(
    jobs.map(async (job: any, index: number) => {
      try {
        const singleInputs = validateSingleInput({ signature, authorSafeAddress, configCid, publication, job, preview });
        const actionResult = await runAction(preview, lit, protocolInfo.litActionSingle, singleInputs, litUsageKey);
        return { success: true, index, data: actionResult };
      } catch (err: any) {
        return { success: false, index, error: err?.message ?? String(err) };
      }
    }),
  );

  // log every job that didn't cleanly succeed — both failure kinds, full object
  for (const r of allResults) {
    const failed = !r.success || !(r.data as any)?.ok;
    if (failed) console.error(`[single ${r.index}]`, JSON.stringify(r.data ?? { error: r.error }, null, 2));
  }

  const successful = allResults.filter((r: any) => r.success && r.data?.ok);
  // Map the rendered job data out for the merged update
  const renderedJobs = successful.map((r: any) => r.data.data.job).filter((j: any) => j?.path);

  // ---------------- EVM Root Update Stage ---------------------------------
  
  if (notice) notice.setMessage('merging EVM update ...'); else console.log('preparing evm update...');

  console.log("pub2", publication)
  const evmInputs = validateEvmUpdateInput({ signature, authorSafeAddress, publication, jobs: renderedJobs, preview });

  const evmAction = await runAction( preview, lit, protocolInfo.litActionRootUpdate, evmInputs, litUsageKey);
  console.log(evmAction)
  const validated = validateEvmUpdateOutput(evmAction);
  if (!validated.ok) console.log(JSON.stringify(validated, null, 2));
  if (validated.ok) cid = validated.data.cid

  return {
    success: validated.ok ? true : false,
    cid,
    path: ''
  };
};
