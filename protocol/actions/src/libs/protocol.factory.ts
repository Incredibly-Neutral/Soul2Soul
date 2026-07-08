

import { evmRead } from "./evm";
import { getProtocolControllerAndModules } from "./ens.factory";
import { Abi_S2SRecordsModule } from '../../../contracts/generated/abis/S2SRecordsModule.ts'


export const getProtocolInfo = async (dev: boolean) => {

  try {

  const { multisig, configModule } = await getProtocolControllerAndModules();

  console.log(multisig, configModule)

    if (multisig == null || configModule == null ) {
        throw new Error("Failed to get multisig or configModule from ENS");
    }

    const [dataGateway, ensRecords, ensRegistry, publicationFactory, recordsFactory, pkpEthAddress, litActionPrep, litActionRender, litActionUpdate ] = await evmRead("BASE", configModule, Abi_S2SRecordsModule, "getRecords", [["data_gateway","ens_records","ens_registry","publication_factory","records_factory","pkp_ethAddress", "lit_action_prep", "lit_action_render", "lit_action_update"]]);

    return {
      gateway: dataGateway,
      ensRegistry: ensRegistry,
      ensRecords,
      publicationFactory,
      recordsFactory,
      pkp: pkpEthAddress,
      litActions: {
        prep: litActionPrep,
        render: litActionRender,
        update: litActionUpdate,
      },
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log("Protocol info fetch error:", errorMsg);
    throw error;
  }
};
