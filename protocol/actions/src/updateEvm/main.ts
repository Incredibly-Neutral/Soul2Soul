/// <reference path="../action_globals.ts" />


import { evmRead, evmWrite, toHexString } from "../libs/evm";
import { getProtocolInfo } from "../libs/protocol.factory";
import { getDomainOwnerAndModules } from "../libs/ens.factory";
import { contenthashToIPFS, createUnixFSFromCbor, getDag } from "../libs/ipfs.factory";
import { ensRecordsAbi, S2SProtocolInfo, canPublish } from "@s2s/soul2soul-shared/lit-actions";

export interface ILitActionContext {
  authSig: any;
  ipfsId: string;
  pkp: {
    tokenId: string;
  };
}

const main = async () => {

  const { authorSafeAddress, publication, node, dev } = jsParams;

  const { multisig, configModule, publicationModule } = await getDomainOwnerAndModules(publication);
  if(multisig == null || configModule == null || publicationModule == null ) return;


  try {
    const resp = await Lit.Actions.checkConditions({
      conditions: canPublish(authorSafeAddress, publicationModule),
      authSig: null,
      chain: "base",
    });

    if (resp == false) {
      throw new Error("Not authorized to publish");
    }

    const protocolInfo: S2SProtocolInfo = await getProtocolInfo(authorSafeAddress, false);

    if(protocolInfo.pkp == undefined) {
      throw new Error("couldnt fetch protocol info");
    }

    // is dit niet te snel? 
    const currentDagRoot = await evmRead("BASE", protocolInfo.ensRecords, ensRecordsAbi,"getText",[node, "contenthash_wrapped_cbor"]);

    const cid = contenthashToIPFS(currentDagRoot);

    const dag = await getDag(cid);

    const newRootCidUnixFs = await createUnixFSFromCbor(
      dag,
      protocolInfo.dataGateway
    );

    console.log("cid", newRootCidUnixFs)
    console.log("node", node)
  
    const res = await evmWrite(
      "BASE",
      protocolInfo.pkp,
      protocolInfo.ensRecords,
      ensRecordsAbi,
      "setText",
      [ node , 'contenthash_wrapped', toHexString(newRootCidUnixFs)]
    );

    LitActions.setResponse({
      response: JSON.stringify({ success: true, cid: newRootCidUnixFs, tx: res.hash}),
    });

  } catch (error) {
    console.log("Error updating root:", error);
    LitActions.setResponse({
      response: JSON.stringify({ success: false, response: error }),
    });
  }
};
main();