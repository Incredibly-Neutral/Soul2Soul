

import { evmRead } from "./evm";
import { getProtocolControllerAndModules } from "./ens.factory";
import {  validateProtocol } from "@s2s/soul2soul-shared/lit-actions";
import { Abi_S2SRecordsModule } from '../../../generated/abis/S2SRecordsModule.ts'


export const getProtocolInfo = async (dev: boolean) => {

    // const result = await LitActions.runOnce({
    //     waitForResponse: true,
    //     name: `protocol-${authorSafeAddress}`
    // }, async () => { 
        // try {
    let protocolInfo = await _getProtocolInfo(dev);
    validateProtocol(protocolInfo);
            // return JSON.stringify({ success: true, data: protocolInfo });
    //     } catch (error) {
    //         const errorMsg = error instanceof Error ? error.message : String(error);
    //         const errorStack = error instanceof Error ? error.stack : undefined;
    //         console.log("Protocol validation error:", errorMsg);
    //         if (errorStack) console.log("Stack:", errorStack);
    //         // Return error as valid JSON
    //         return JSON.stringify({ 
    //             success: false, 
    //             error: errorMsg,
    //             stack: errorStack 
    //         });
    //     }
    // });

    return protocolInfo;

    // const parsed = JSON.parse(result);
    
    // if (!parsed.success) {
    //     console.error("getProtocolInfo failed:", parsed.error);
    //     if (parsed.stack) console.error("Stack:", parsed.stack);
    //     throw new Error(`Protocol info fetch failed: ${parsed.error}`);
    // }
    
    // return parsed.data;
};

const _getProtocolInfo = async (dev: boolean) => {
  
  try {

    const { multisig, configModule } = await getProtocolControllerAndModules();

    if (multisig == null || configModule == null ) {
        throw new Error("Failed to get multisig or configModule from ENS");
    }

    const [assetsGateway, dataGateway, ensRecords, lensApp, pkpTokenId, pkpPublicKey, pkpEthAddress, litActionPrep, litActionSingle, litActionCbor, litActionRootUpdate ] = await evmRead("BASE", configModule, Abi_S2SRecordsModule, "getRecords", [["assets_gateway","data_gateway","ens_records","lens_app","pkp_tokenId","pkp_publicKey","pkp_ethAddress", "lit_action_prep", "lit_action_single", "lit_action_cbor","lit_action_root_update"]]);

    return {
      addr: multisig,
      recordsModule: configModule,
      dataGateway,
      assetsGateway,
      lensApp,
      ensRecords,
      pkp: {
        ethAddress: pkpEthAddress,
        publicKey: pkpPublicKey,
        tokenId: pkpTokenId
      },
      litActionPrep,
      litActionSingle,
      litActionCbor,
      litActionRootUpdate
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log("Protocol info fetch error:", errorMsg);
    throw error; // Re-throw instead of returning empty object
  }
};
