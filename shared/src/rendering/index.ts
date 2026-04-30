import { S2SProtocolInfo } from '../protocol';
export * from './types';

export const renderwithLitActions =  async (litNodeClient: any, authContext: any, protocolInfo: S2SProtocolInfo, notice: any, authorSafeAddress: string, publication: string, contentIds: string[], update: boolean, dev: boolean, debug: boolean, configCid?: string | undefined ) : Promise<any> => {

  if (notice) { notice.setMessage("prepping render ... ") } else  { console.log('prepping render')}

  console.log("authContext", authContext)

  let prep: any = await litNodeClient.executeJs({
      authContext,
      ipfsId: protocolInfo.litActionPrep,
      jsParams: {
          authorSafeAddress,
          publication,
          configCid: configCid || undefined,
          contentIds: contentIds,
          dev 
      },
  });

  console.log(prep);

  const responseStr = typeof prep.response === 'string' 
  ? prep.response 
  : JSON.stringify(prep.response);

  let jobs = JSON.parse(responseStr).jobs;   

  console.log(jobs)

  if (notice) notice.setMessage("rendering ...")

  const results = await Promise.all(
    jobs.map( async (job: any, index: number) =>  {
        const jsParams = { authorSafeAddress, config_cid: configCid, publication, job, debug, dev }
        return await singleRender(litNodeClient, authContext, protocolInfo, jsParams, index, 40000)
    })
  );

  console.log(results)

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  console.log(`Completed: ${successful.length}/${jobs.length}`);
  failed.forEach(f => console.error(`Job ${f.index} failed:`, f.error.message, f.error))

  const renderedJobs = successful.map( r => 
      JSON.parse(r.result.response).job
  ).filter( j => j.path != undefined)

  // html here has the collections
  console.log("renderedJobs", renderedJobs);

  // if (notice) notice.setMessage("creating new website tree...")

//   const cbor: ExecuteJsResponse = await litNodeClient.executeJs({
//       sessionSigs: sessionSignatures,
//       ipfsId: protocolInfo.litActionCbor,
//       jsParams: {
//           authorSafeAddress,
//           publication,
//           jobs: renderedJobs,
//           dev 
//       }
//   });

//   console.log(cbor.logs)
//   console.log("cbor", cbor.response)

//   let cid;

//   if (update) {

//     if (notice) notice.setMessage("updating domain name")

//     const jsp = {
//         authorSafeAddress,
//         publication,
//         dev
//     }

//     const root = await rootUpdate(litNodeClient, sessionSignatures, protocolInfo, jsp, 3);
//     console.log(root)
//     cid = JSON.parse(root.response).cid;
//   }

//   return {
//     cbor: cbor.response,
//     cid: cid,
//     path : renderedJobs[0].path,
//     jobs: renderedJobs
//   };
}

const singleRender = async (litNodeClient: any, authContext: any, protocolInfo: S2SProtocolInfo, jsParams: any, index: number, timeoutMs = 30000) => {

    await new Promise(resolve => setTimeout(resolve, index * 1000));

    let capturedLogs: string[] = [];
        
    try {
        const result = await litNodeClient.executeJs({
              authContext,
              ipfsId: protocolInfo.litActionSingle,
              jsParams,
        });
        
        return { success: true, index, result };
        
      } catch (error) {

        console.log(error)
        // Try to extract any logs from the error object
        const logs = (error as any)?.logs || 
                    (error as any)?.response?.logs || 
                    (error as any)?.details?.logs || 
                    capturedLogs;
        
        return { 
            success: false, 
            index, 
            error,
            logs // Preserve whatever logs we got
        };
    }
};

const rootUpdate = async (litNodeClient: any, authContext: any, protocolInfo: S2SProtocolInfo, jsParams: any, maxAttempts = 3) => {

    let lastError: any;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`Attempting root update (attempt ${attempt}/${maxAttempts})...`);
        
        const rootUpdate: any = await litNodeClient.executeJs({
          authContext,
          ipfsId: protocolInfo.litActionRootUpdate,
          jsParams
        });
        
        console.log(`Root update succeeded on attempt ${attempt}`);
        return rootUpdate;
        
      } catch (error: any) {
        lastError = error;
        console.error(`Root update failed on attempt ${attempt}:`, {
          message: error.message,
          code: error.code,
          logs: error.logs || error.response?.logs || []
        });
        
        // Don't retry if it's the last attempt
        if (attempt < maxAttempts) {
          const delayMs = 2000 * attempt; // Exponential backoff: 2s, 4s, 6s
          console.log(`Retrying in ${delayMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }
  
    // All attempts failed
    throw new Error(`Root update failed after ${maxAttempts} attempts. Last error: ${lastError.message}`);
  };

