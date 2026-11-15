import { evmRead } from "./evm";
import { getProtocolControllerAndModules } from "./ens.factory";
import { Abi_S2SRecordsModule } from '@s2s/publication-contracts/abis/S2SRecordsModule'

// The protocol's records module on Base: `configModule` for soul2soul.eth, the
// address update-protocol.ts and repoint-record.ts write to. Held here so the
// one record the module prediction needs costs one call — discovering the same
// module through ENS would cost the five-request walk getProtocolInfo pays.
// A redeploy of the records module makes this constant stale without error: the
// read answers empty on the old address and the prediction degrades to the
// probes. See SPEC-protocol-actions.md, Gotchas.
const PROTOCOL_RECORDS_MODULE = '0xBB0BBd828c19502a8fCFbF07f5ACEcd8E8641D29';

const RECORD_ABI = ['function getRecord(string key) view returns (string)'];

/**
 * The `publication_factory` record on its own: one eth_call, no ENS walk.
 *
 * Read before an action's authorization gate so module discovery can use the
 * factory's CREATE2 prediction, and cheap enough that a call the gate then
 * rejects has spent one request rather than the protocol walk. null when the
 * record is absent or unreadable; callers pass that on and get the probe path
 * they ran before, unchanged.
 */
export const getPublicationFactory = async (rpcs?: { L1: string[]; L2: string[] }): Promise<string | null> => {
  try {
    const factory = await evmRead('L2', PROTOCOL_RECORDS_MODULE, RECORD_ABI, 'getRecord', ['publication_factory'], rpcs?.L2);
    return typeof factory === 'string' && factory.length > 0 ? factory : null;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log('publication_factory record unreadable:', errorMsg);
    return null;
  }
};

export const getProtocolInfo = async (dev: boolean, rpcs?: { L1: string[]; L2: string[] }) => {

  try {

  const { multisig, configModule } = await getProtocolControllerAndModules(rpcs);

  console.log(multisig, configModule)

    if (multisig == null || configModule == null ) {
        throw new Error("Failed to get multisig or configModule from ENS");
    }

    const [dataGateway, ensRecords, ensRegistry, publicationFactory, recordsFactory, pkpEthAddress, litActionPrep, litActionRender, litActionUpdate ] = await evmRead("L2", configModule, Abi_S2SRecordsModule, "getRecords", [["data_gateway","ens_records","ens_registry","publication_factory","records_factory","pkp_ethAddress", "lit_action_prep", "lit_action_render", "lit_action_update"]], rpcs?.L2);

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
