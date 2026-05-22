

import { evmRead } from "./evm";
import { getProtocolControllerAndModules } from "./ens.factory";
import { Abi_S2SRecordsModule } from '../../../generated/abis/S2SRecordsModule.ts'


export const getProtocolInfo = async (dev: boolean) => {

  try {

  const { multisig, configModule } = await getProtocolControllerAndModules();

  console.log(multisig, configModule)

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
