import { ALCHEMY_KEY, DRPC_API_KEY } from "./constants";
import { PKP } from "@s2s/soul2soul-shared/lit-actions";

const RPC_URLS: Record<string, string[]> = {
    ETHEREUM: [
        `https://lb.drpc.live/ethereum/${DRPC_API_KEY}`,
        `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
    ],
    BASE: [
        `https://lb.drpc.live/base/${DRPC_API_KEY}`,
        `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
    ],
    BASE_SEPOLIA: [
        `https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}`,
    ]
};

const NETWORK_CONFIG: Record<string, { chainId: number; name: string }> = {
    ETHEREUM:     { chainId: 1,     name: "homestead" },
    BASE:         { chainId: 8453,  name: "base" },
    BASE_SEPOLIA: { chainId: 84532, name: "base-sepolia" },
};

const evmSetup = (contractAddress: string, abi: any, chain: string, rpcUrl?: string) => {

    const url = rpcUrl || RPC_URLS[chain]?.[0];
    const network = NETWORK_CONFIG[chain];

    const provider = new ethers.providers.StaticJsonRpcProvider(url, network);
    const contract = new ethers.Contract(contractAddress, abi, provider);

    return { provider, contract };
};

export const evmWrite = async (
    chain: string,
    pkp: PKP,
    contractAddress: string,
    abi: any,
    method: string,
    args: any[],
    confirm: boolean = false
) => {
    const { provider, contract } = evmSetup(contractAddress, abi, chain);

    const pendingNonce = await provider.getTransactionCount(pkp.ethAddress, "pending");
    const txData = contract.interface.encodeFunctionData(method, args);

    const estimatedGas = await provider.estimateGas({
        to: contractAddress,
        data: txData,
        from: pkp.ethAddress,
    }).catch((err: any) => {
        console.log("Gas estimation failed:", err.message);
        return ethers.BigNumber.from(60000);
    });

    console.log("Estimated gas:", estimatedGas.toString());

    const gasLimit = estimatedGas.mul(120).div(100);
    console.log("Gas limit (with 20% buffer):", gasLimit.toString());

    const tx = {
        to: contractAddress,
        data: txData,
        nonce: pendingNonce,
        gasLimit: gasLimit,
        maxFeePerGas: ethers.utils.parseUnits("0.15", "gwei"),
        maxPriorityFeePerGas: ethers.utils.parseUnits("0.015", "gwei"),
        chainId: 8453,
        value: 0,
        type: 2,
    };

    const wallet = new ethers.Wallet(await Lit.Actions.getPrivateKey({ pkpId: pkp.ethAddress }));
    const signedTx = await wallet.signTransaction(tx);

    try {
        const txResponse = await provider.sendTransaction(signedTx);
        console.log("Transaction sent! Hash:", JSON.stringify(txResponse));

        if (confirm) {
            console.log("Waiting for confirmation...");
            const receipt = await txResponse.wait(1);
            console.log("Transaction confirmed! Block:", receipt.blockNumber);
            return { success: true, hash: txResponse.hash, receipt };
        }

        return { success: true, hash: txResponse.hash };

    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);

        if (errMsg.includes("already known") || errMsg.includes("replacement transaction underpriced")) {
            console.log("Transaction already submitted or pending");
            return {
                success: true,
                message: "already_submitted",
                hash: "A transaction with this content is already in the mempool"
            };
        }

        console.error("Error sending transaction:", errMsg);
        return { success: false, error: errMsg, hash: undefined };
    }
};

export const evmRead = async (
    chain: string,
    contractAddress: string,
    abi: any,
    method: string,
    args: any[]
) => {
    const urls = RPC_URLS[chain] || [];
    let lastError;

    for (const url of urls) {
        try {
            const { contract } = evmSetup(contractAddress, abi, chain, url);
            return await contract[method](...args);
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError;
};

export const toHexString = (_cid: string) => {
    const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

    let num = BigInt(0);
    for (const char of _cid) {
        num = num * 58n + BigInt(BASE58_ALPHABET.indexOf(char));
    }

    let hex = num.toString(16);
    if (hex.length % 2) hex = "0" + hex;

    return '0x' + 'e301' + hex;
};