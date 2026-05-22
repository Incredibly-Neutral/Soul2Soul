/// <reference path="../action_globals.ts" />

import { S2SJob } from "@s2s/soul2soul-shared/lit-actions";

import { evmRead, evmWrite, toHexString } from "../libs/evm";
import { contenthashToIPFS, getDag, putDag, updateDagItem, removeDagItem, DagNode } from "../libs/ipfs.factory";
import { getProtocolInfo } from "../libs/protocol.factory";
import { canPublish, extractSignerAddress } from "../libs/gates";
import { getDomainOwnerAndModules } from "../libs/ens.factory";


const RECORDS_CONTRACT_ABI = [
  "function getText(bytes32 node, string key) view returns (string)",
  "function setText(bytes32 node, string key, string value) nonpayable"
];


declare global {

    const jobs: S2SJob[]
}

async function main ({ signature, authorSafeAddress, publication, jobs, dev }: any)  {

    const logz: any[] = [];
    let cid: string = '';

    const signerAddress = extractSignerAddress(ethers.utils.hashMessage("lit actions auth"), signature);
    console.log("SIGNER",signerAddress);

    const protocolInfo = await getProtocolInfo(false);
    if (!protocolInfo || protocolInfo.pkp == undefined) throw "Failed to fetch protocol info"

    const { multisig, configModule, publicationModule } = await getDomainOwnerAndModules(publication);
    console.log(publication, multisig, configModule, publicationModule)
    if(multisig == null || configModule == null || publicationModule == null ) return;

    if (await canPublish(authorSafeAddress, publicationModule, signerAddress)) {

        const node = ethers.utils.namehash(publication);        
        const currentRoot = await evmRead(
            "BASE",
            protocolInfo.ensRecords,
            RECORDS_CONTRACT_ABI,
            "getText",
            [node, "contenthash_wrapped_cbor"]
        );

        logz.push(`old: ${currentRoot}`)

        let currentDag: DagNode = { Links: [], metadata: {} };

        if (currentRoot && currentRoot.length > 0) {
            const currentRootCid = contenthashToIPFS(currentRoot);
            currentDag = await getDag(currentRootCid);
        }

        for (const job of jobs) {

            if (job.revoked) {

                logz.push(`revoke dag item ${job.id}`)
                currentDag = removeDagItem(currentDag, job.id)

            } else {

                logz.push(`update dag item ${job.id}`)
                currentDag = updateDagItem(
                    currentDag,
                    job.id!,
                    job.path!,
                    job.html!
                );      
            }              
        }

        cid = await putDag(currentDag);

        logz.push(`new: ${cid}`);
    
        if (!dev) {

            const result = await evmWrite(
                "BASE",
                protocolInfo.pkp,
                protocolInfo.ensRecords,
                RECORDS_CONTRACT_ABI,
                "setText",
                [ node , 'contenthash_wrapped_cbor', toHexString(cid)],
                true
            );
            
            logz.push(result);
        }
    }

    return {
            success: true,
            cbor: cid,
            logz
        }

}
