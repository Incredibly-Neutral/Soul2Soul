/// <reference path="../action_globals.ts" />

import { ensRecordsAbi, S2SJob } from "@s2s/soul2soul-shared/lit-actions";
import { evmRead, evmWrite, toHexString } from "../libs/evm";
import { contenthashToIPFS, getDag, uploadFile, putDag, updateDagItem, removeDagItem, createMetadata } from "../libs/ipfs.factory";
import { getProtocolInfo } from "../libs/protocol.factory";


const RECORDS_CONTRACT_ABI = [
  "function getText(bytes32 node, string key) view returns (string)"
];

const ENSRECORDSONL2 = "0x5D42f9b016B4251FC6407d5e8154DA887F394900"

declare global {

    const jobs: S2SJob[]
}

const main = async () => {

    const { authorSafeAddress, publication, jobs, dev } = jsParams;

    const protocolInfo = await getProtocolInfo(authorSafeAddress, false);
    if (!protocolInfo || protocolInfo.pkp == undefined) throw "Failed to fetch protocol info"

    const node = ethers.utils.namehash(publication);        
    const currentRoot = await evmRead(
        "BASE",
        ENSRECORDSONL2,
        RECORDS_CONTRACT_ABI,
        "getText",
        [node, "contenthash_wrapped_cbor"]
    );

    // console.log("r", currentRoot)

    const currentRootCid = contenthashToIPFS(currentRoot);   
    let currentDag = await getDag(currentRootCid);

    // const idMap = {
    //     "/" : "90702956949807758490707192938082902644913592275082356361549260928213339228489",
    //     "posts/just-another-post-iii/" : "59202694839858501982032451281166171443326879085047062827697846029760040763950",
    //     "posts/lets-rock/" : "75638992216077013008613067376195577183339131651652982187315265075736966632415",
    //     "posts/maecenas-nec-odio-et-ante/" : "87119185787620437889240302547756526407722694952350143032371926081755117621597"
    // }

    // let currentDag = createMetadata(idMap)

    for (const job of jobs) {

        if (job.revoked) {

            // console.log("revoke dag item")

            currentDag = removeDagItem(currentDag, job.id)

        } else {

            // console.log("update dag item")

            currentDag = updateDagItem(
                currentDag,
                job.id!,
                job.path!,
                job.html!
            );      
        }              
    }

    let cid = await LitActions.runOnce({
        waitForResponse: true,
        name: `dagmangle-${authorSafeAddress}`
    }, async () => {  
        return await putDag(currentDag);
    });

    console.log("cbor", cid)
    
    if (!dev) {

        const result = await evmWrite(
            "BASE",
            protocolInfo.pkp,
            protocolInfo.ens_records,
            ensRecordsAbi,
            "setText",
            [ node , 'contenthash_wrapped_cbor', toHexString(cid)],
            true
        );
        
        console.log(result);
    }

    LitActions.setResponse({
        response: JSON.stringify({
            success: true,
            cbor: cid
        })
    });

}
main();