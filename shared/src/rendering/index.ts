import { S2SProtocolInfo } from '../protocol';
export * from './types';
import * as ethers from 'ethers';
(global as any).ethers = ethers;

import { NumberAttributeSchema } from '@lens-protocol/metadata';

const gateway = 'https://ipfs.transport-union.dev';

export const renderwithLitActions =
  async (
    oxoCtrlr: any,
    litUsageKey: string,
    protocolInfo: S2SProtocolInfo,
    notice: any,
    authorSafeAddress: string,
    publication: string,
    contentIds: string[],
    update: boolean,
    dev: boolean,
    debug: boolean,
    configCid?: string,
  ) => {
    const signature = await oxoCtrlr.account['BASE'].signMessage(
      'lit actions auth',
    );

    // ====================== Prep (local, no Lit cost) ======================
    if (notice) notice.setMessage('prepping render ...');
    else console.log('prepping render');

    // Fetch compiled prep from IPFS and eval at global scope.
    // In Obsidian (ESM), eval() is module-scoped, so var won't leak.
    // setTimeout forces call stack unwinding so eval runs at top-level scope.
    const prepResp = await fetch(
      `https://neutralpress.mypinata.cloud/ipfs/${protocolInfo.litActionPrep}`,
    );
    const prepCode = await prepResp.text();

    const prepResult: any  = await new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          (0, eval)(prepCode);
          const prepMain = (globalThis as any).main;
          if (typeof prepMain !== 'function')
            throw new TypeError('prep action did not expose main()');
          resolve(prepMain({
            protocolInfo,
            authorSafeAddress,
            publication,
            configCid: configCid || undefined,
            contentIds,
            dev,
          }));
        } catch (err) {
          reject(err);
        }
      }, 0);
    });

    let jobs = prepResult.jobs;
    console.log(jobs);

    // ====================== Single actions (Lit) ======================
    if (notice) notice.setMessage('rendering ...');


    const singleResp = await fetch(
      `https://neutralpress.mypinata.cloud/ipfs/${protocolInfo.litActionSingle}`,
    );
    const singleCode = await singleResp.text();

    const results = await Promise.all(
      jobs.map(async (job: any, index: number) => {
        // Stagger to avoid rate limits
        await new Promise(r => setTimeout(r, index * 1000));

        let capturedLogs: string[] = [];
        try {
          const result = await oxoCtrlr.lit.executeAction(
            singleCode,
            {
              signature,
              authorSafeAddress,
              configCid,
              publication,
              job,
              debug,
              dev,
            },
            litUsageKey,
          );
          return { success: true, index, result };
        } catch (error: any) {
          return {
            success: false,
            index,
            error,
            logs:
              error?.logs ||
              error?.response?.logs ||
              error?.details?.logs ||
              capturedLogs,
          };
        }
      }),
    );

    const successful = results.filter((r: any) => r.result?.response?.success);
    const failed = results.filter((r: any) => !r.result?.response?.success);
    console.log(`Rendered: ${successful.length}/${jobs.length}`);
    failed.forEach(
      (f: any) =>
        console.error(
          `Job ${f.index} failed:`,
          f.result?.response?.errors,
          f.error,
        ),
    );

    const renderedJobs = successful
      .map((r: any) => r.result.response.job)
      .filter((j: any) => j.path);
    console.log('renderedJobs:', renderedJobs);

    // ====================== Merged action (Lit) ======================
    // Replaces cbor + root-update: builds UnixFS root, pins to Pinata,
    // writes contenthash_wrapped on-chain (all in one PKP-signed action).
    if (notice) notice.setMessage('merging ...');

    const updateCode = await fetch(
      `https://neutralpress.mypinata.cloud/ipfs/${protocolInfo.litActionRootUpdate}`,
    ).then(r => r.text());

    const updateResult = await oxoCtrlr.lit.executeAction(
      updateCode,
      {
        signature,
        authorSafeAddress,
        publication,
        jobs: renderedJobs,
        dev,
      },
      litUsageKey,
    );

    if (!updateResult?.response?.success) {
      throw new Error(
        `Merged action failed: ${JSON.stringify(updateResult?.response)}`,
      );
    }

    if (notice) notice.setMessage('publishing ...');

    return {
      success: true,
      cid: updateResult.response.cid,
      path: renderedJobs[0].path,
      jobs: renderedJobs,
    };
  };
