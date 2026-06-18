import { S2SProtocolInfo } from '../protocol';
export * from './types';
import * as ethers from 'ethers';
(global as any).ethers = ethers;

import { NumberAttributeSchema } from '@lens-protocol/metadata';
import { LitService } from '../lit';
import { validatePrepInput, validatePrepOutput } from './action-io';

const gateway = 'https://ipfs.transport-union.dev';

export const renderwithLitActions =
  async (
    dev: boolean,
    lit: LitService,
    signature: string, // move outside
    litUsageKey: string,
    protocolInfo: S2SProtocolInfo,
    notice: any,
    authorSafeAddress: string,
    publication: string,
    contentIds: string[],
    configCid?: string,
    
  ) => {


    // ====================== Prep (local, no Lit cost) ======================
    if (notice) notice.setMessage('prepping render ...');
    else console.log('prepping render, Dev is ', dev);

    // Build inputs once, validate before any network call
    const prepInputs = {
      publication:'kip',
      configCid: configCid ?? undefined,
      contentIds,
    };
    validatePrepInput(prepInputs);

    const prepResult: any = await fetch(
      `https://run.transport-union.dev/run`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cid: protocolInfo.litActionPrep,
          inputs: prepInputs,
        }),
      },
    ).then(async r => {
      
      const text = await r.text();
      console.log(text)
      try {

        return JSON.parse(text);
      } catch {
        return { ok: false, action: 'prep', error: `Server returned ${r.status}: ${text.slice(0,200)}` };
      }
    });

    if (!prepResult.success) throw new Error(`runner: ${prepResult.error ?? 'transport failure'}`);
    if (!prepResult.response.ok) throw new Error(`[${prepResult.response.action}] ${prepResult.response.error}`);

    // Validate prep output shape before consuming jobs
    const validated = validatePrepOutput(prepResult.response);
    if (!validated.ok) throw new Error(`[${validated.action}] ${validated.error}`);
    let jobs = validated.data.jobs;
    console.log(jobs);

    // ====================== Single actions (Lit) ======================
    if (notice) notice.setMessage('rendering ...');

    let results = await Promise.all(
      jobs.map(async (job: any, index: number) => {
        // Stagger to avoid rate limits
        // await new Promise(r => setTimeout(r, index * 1000));

        let capturedLogs: string[] = [];
        const inputs = {
          signature,
          authorSafeAddress,
          configCid,
          publication,
          job
        };

        try {
          let result: any;

          if (dev) {
            // Preview: run via serverless container
            const resp = await fetch(
              `https://run.transport-union.dev/run`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  cid: protocolInfo.litActionSingle,
                  inputs,
                }),
              },
            ).then(r => r.json());

            result = resp;

          } else {
            // Production: Lit actions on-chain
            const singleResp = await fetch(
              `https://neutralpress.mypinata.cloud/ipfs/${protocolInfo.litActionSingle}`,
            );
            const singleCode = await singleResp.text();

            result = await lit.executeAction(
              singleCode,
              inputs,
              litUsageKey,
            );
          }

          console.log(result)

          return { success: true, index, response: result.response, logs: capturedLogs };
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

    const successful = results.filter((r: any) => r.response?.success);
    const failed = results.filter((r: any) => !r.response?.success);
    console.log(`Rendered: ${successful.length}/${jobs.length}`);
    failed.forEach(
      (f: any) =>
        console.error(
          `Job ${f.index} failed:`,
          f.response?.errors,
          f.error,
        ),
    );

    const renderedJobs = successful
      .map((r: any) => r.response?.job)
      .filter((j: any) => j?.path);
    console.log('renderedJobs:', renderedJobs);

    // ====================== Merged action (Lit) ======================
    // Replaces cbor + root-update: builds UnixFS root, pins to Pinata,
    // writes contenthash_wrapped on-chain (all in one PKP-signed action).
    if (notice) notice.setMessage('merging ...');

    console.log("JS", renderedJobs.map ( (j:any) => j.html))

    const updateInputs = {
      signature,
      authorSafeAddress,
      publication,
      jobs: renderedJobs,
      dev
    };

    let updateResult: any;

    if (dev) {
      // Preview: run via serverless container
      const updateResp = await fetch(
        `https://run.transport-union.dev/run`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cid: protocolInfo.litActionRootUpdate,
            inputs: updateInputs,
          }),
        },
      ).then(r => r.json());

      // Normalize raw action response to production return shape
      updateResult = { response: { ...updateResp.response, success: updateResp.success } };
    } else {
      // Production: Lit actions on-chain

      if (notice) notice.setMessage('publishing ...');
      
      const updateCode = await fetch(
        `https://neutralpress.mypinata.cloud/ipfs/${protocolInfo.litActionRootUpdate}`,
      ).then(r => r.text());

      const raw: any = await lit.executeAction(
        updateCode,
        updateInputs,
        litUsageKey,
      );
      updateResult = { response: { ...raw.response, success: raw.success } };
    }

    console.log('UR', updateResult);

    return {
      success: true,
      cid: updateResult.response.cid,
      path: renderedJobs[0] ? renderedJobs[0].path || "" : "",
      jobs: renderedJobs,
    };
  };