import Safe from "@safe-global/protocol-kit";
import SafeApiKit from "@safe-global/api-kit";
import { encodeFunctionData, getAddress } from "viem";
// @ts-ignore
import { OperationType } from "@safe-global/types-kit";

import * as dotenv from 'dotenv';
import fs from 'fs';                                                                                              
import { fileURLToPath } from 'url';                                                                              
import path from 'path';                                                                                          
import { privateKeyToAccount } from "viem/accounts";
                                                                                                                    
// Emulate __dirname in ES modules                                                                                
const __filename = fileURLToPath(import.meta.url);                                                                
const __dirname = path.dirname(__filename);       
 
dotenv.config({ path: '../.env'});

const recordsModuleAbi = [
{
    name: "setRecord",
    type: "function",
    inputs: [
    { name: "key", type: "string" },
    { name: "value", type: "string" },
    ],
},
] as const;

const ensRecordsAbi = [
{
    name: "authorizeCaller",
    type: "function",
    inputs: [
    { name: "caller", type: "address" },
    { name: "authorized", type: "bool" },
    ],
},
] as const;

const RECORDS_MODULE_ADDRESS = "0xBB0BBd828c19502a8fCFbF07f5ACEcd8E8641D29";
const ENS_RECORDS_ADDRESS = "0x5D42f9b016B4251FC6407d5e8154DA887F394900";

export const updateProtocol = async (account: any, pkpInfo: any, prepActionCid: any, singleActionCid: any, cborActionCid: any, rootUpdateActionCid: any) => {

    const transactions = [
    // {
    //     to: RECORDS_MODULE_ADDRESS,
    //     data: encodeFunctionData({
    //     abi: recordsModuleAbi,
    //     functionName: "setRecord",
    //     args: ["pkp_tokenId", pkpInfo.tokenId],
    //     }),
    //     value: "0",
    // },
    // {
    //     to: RECORDS_MODULE_ADDRESS,
    //     data: encodeFunctionData({
    //     abi: recordsModuleAbi,
    //     functionName: "setRecord",
    //     args: ["pkp_publicKey", pkpInfo.pubkey],
    //     }),
    //     value: "0",
    // },
    {
        to: RECORDS_MODULE_ADDRESS,
        data: encodeFunctionData({
        abi: recordsModuleAbi,
        functionName: "setRecord",
        args: ["pkp_ethAddress", pkpInfo.ethAddress],
        }),
        value: "0",
    },
    {
        to: RECORDS_MODULE_ADDRESS,
        data: encodeFunctionData({
        abi: recordsModuleAbi,
        functionName: "setRecord",
        args: ["lit_action_prep", prepActionCid],
        }),
        value: "0",
    },
    {
        to: RECORDS_MODULE_ADDRESS,
        data: encodeFunctionData({
        abi: recordsModuleAbi,
        functionName: "setRecord",
        args: ["lit_action_single", singleActionCid],
        }),
        value: "0",
    },
    {
        to: RECORDS_MODULE_ADDRESS,
        data: encodeFunctionData({
        abi: recordsModuleAbi,
        functionName: "setRecord",
        args: ["lit_action_cbor", cborActionCid],
        }),
        value: "0",
    },
    {
        to: RECORDS_MODULE_ADDRESS,
        data: encodeFunctionData({
        abi: recordsModuleAbi,
        functionName: "setRecord",
        args: ["lit_action_root_update", rootUpdateActionCid],
        }),
        value: "0",
    },
    {
        to: ENS_RECORDS_ADDRESS,
        data: encodeFunctionData({
        abi: ensRecordsAbi,
        functionName: "authorizeCaller",
        args: [getAddress(pkpInfo.ethAddress), true],
        }),
        value: "0",
    },
    ];

    // Safe SDK (still uses ethers internally, but isolated)
    const protocolKit = await Safe.init({
    provider: process.env.BASE_RPC_URL!,
    signer: process.env.PRIVATE_KEY!,
    safeAddress: process.env.PROTOCOL_SAFE_ADDRESS!,
    });

    const apiKit = new SafeApiKit({
    chainId: 8453n,
    });

    // Create + sign + propose
    const safeTransaction = await protocolKit.createTransaction({
    transactions: transactions.map((tx) => ({
        ...tx,
        operation: OperationType.Call,
    })),
    });

    const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);
    const senderSignature = await protocolKit.signHash(safeTxHash);

    await apiKit.proposeTransaction({
        safeAddress: process.env.PROTOCOL_SAFE_ADDRESS!,
        safeTransactionData: safeTransaction.data,
        safeTxHash,
        senderAddress: account.address, // from viem account
        senderSignature: senderSignature.data,
    });

    console.log("✅ Transaction proposed to Safe");
    console.log("Safe Tx Hash:", safeTxHash);

}

export const updateActions = async (account: any, prepActionCid: any, singleActionCid: any, cborActionCid: any, rootUpdateActionCid: any) => {

    const transactions = [
    {
        to: RECORDS_MODULE_ADDRESS,
        data: encodeFunctionData({
        abi: recordsModuleAbi,
        functionName: "setRecord",
        args: ["lit_action_prep", prepActionCid],
        }),
        value: "0",
    },
    {
        to: RECORDS_MODULE_ADDRESS,
        data: encodeFunctionData({
        abi: recordsModuleAbi,
        functionName: "setRecord",
        args: ["lit_action_single", singleActionCid],
        }),
        value: "0",
    },
    {
        to: RECORDS_MODULE_ADDRESS,
        data: encodeFunctionData({
        abi: recordsModuleAbi,
        functionName: "setRecord",
        args: ["lit_action_cbor", cborActionCid],
        }),
        value: "0",
    },
    {
        to: RECORDS_MODULE_ADDRESS,
        data: encodeFunctionData({
        abi: recordsModuleAbi,
        functionName: "setRecord",
        args: ["lit_action_root_update", rootUpdateActionCid],
        }),
        value: "0",
    }
    ];

    // Safe SDK (still uses ethers internally, but isolated)
    const protocolKit = await Safe.init({
        provider: process.env.BASE_RPC_URL!,
        signer: process.env.PRIVATE_KEY!,
        safeAddress: process.env.PROTOCOL_SAFE_ADDRESS!,
    });

    const apiKit = new SafeApiKit({
    chainId: 8453n,
    });

    // Create + sign + propose
    const safeTransaction = await protocolKit.createTransaction({
    transactions: transactions.map((tx) => ({
        ...tx,
        operation: OperationType.Call,
    })),
    });

    const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);
    const senderSignature = await protocolKit.signHash(safeTxHash);

    await apiKit.proposeTransaction({
        safeAddress: process.env.PROTOCOL_SAFE_ADDRESS!,
        safeTransactionData: safeTransaction.data,
        safeTxHash,
        senderAddress: account.address, // from viem account
        senderSignature: senderSignature.data,
    });

    console.log("✅ Transaction proposed to Safe");
    console.log("Safe Tx Hash:", safeTxHash);

}

const main = async () => {

    const config = fs.readFileSync('./protocol/scripts/lit/config.json','utf-8');

    const group = JSON.parse(config).groups.find( (g:any) => g.name = 's2s' )

    const pkpInfo = {
        tokenId: "",
        pubKey: "",
        ethAddress: group.pkps[0]
    }

    console.log(pkpInfo);

    const account = await privateKeyToAccount('0x' + process.env.PRIVATE_KEY! as `0x${string}`)
    const prep = group.actions.find( (a: any) => a.name == 'prep');
    const single = group.actions.find( (a: any) => a.name == 'single');
    const cbor = group.actions.find( (a: any) => a.name == 'cbor');
    const updateEvm = group.actions.find( (a: any) => a.name == 'updateEvm');

    console.log([prep,single, cbor, updateEvm]);

    const r = await updateProtocol(account, pkpInfo, prep.cid, single.cid, cbor.cid, updateEvm.cid)
}


main()
  .catch((error: any ) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(0);
  });
