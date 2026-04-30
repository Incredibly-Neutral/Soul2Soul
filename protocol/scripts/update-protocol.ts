import Safe from "@safe-global/protocol-kit";
import SafeApiKit from "@safe-global/api-kit";
import { Account, encodeFunctionData, getAddress } from "viem";
// @ts-ignore
import { OperationType } from "@safe-global/types-kit";

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

export const updateProtocol = async (account: Account, pkpInfo: any, prepActionCid: any, singleActionCid: any, cborActionCid: any, rootUpdateActionCid: any) => {

    const transactions = [
    {
        to: RECORDS_MODULE_ADDRESS,
        data: encodeFunctionData({
        abi: recordsModuleAbi,
        functionName: "setRecord",
        args: ["pkp_tokenId", pkpInfo.tokenId],
        }),
        value: "0",
    },
    {
        to: RECORDS_MODULE_ADDRESS,
        data: encodeFunctionData({
        abi: recordsModuleAbi,
        functionName: "setRecord",
        args: ["pkp_publicKey", pkpInfo.pubkey],
        }),
        value: "0",
    },
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

export const updateActions = async (account: Account, prepActionCid: any, singleActionCid: any, cborActionCid: any, rootUpdateActionCid: any) => {

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