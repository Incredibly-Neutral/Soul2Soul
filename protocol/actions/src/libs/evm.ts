const NETWORK_CONFIG: Record<string, { chainId: number; name: string }> = {
    L1:           { chainId: 1,     name: "homestead" },
    L2:           { chainId: 8453,  name: "base" },
    L2_SEPOLIA:   { chainId: 84532, name: "base-sepolia" },
};

// ---------------------------------------------------------------------------
// Transport handling for eth_call — FAIL FAST, do NOT retry in-session.
//
// eth_call is executed INSIDE the Lit action session, and every HTTP request it
// makes counts against Lit's hard cap of 50 requests per session. A recent
// regression (302223c) added an in-session retry loop here (MAX_ATTEMPTS=3 x
// the 2 RPC URLs = up to 6 HTTP requests per single eth_call on transport
// failure, with backoff) so a flaky/slow Base transport multiplied the request
// spend (up to 3x) for every eth_call in the render. On a multi-collection home
// render (many ETH reads across gates, ENS walks + NAME probes, module.getLatest
// / getDeals, protocol.getRecords) that pushed a ~33-38 request render over the
// 50-request-session cap.
//
// These reads are NOT retry-until-success calls: if one fails, the render
// cannot proceed correctly, so re-issuing it in-session just burns the budget.
// The correct resilience is FAIL-FAST here (single pass over the RPC URL list,
// fail over to the next URL, and on total transport failure throw so the render
// fails) and then let the ORCHESTRATOR re-run the whole render in a fresh Lit
// session — a fresh 50-request budget — instead of multiplying requests inside
// one session (see shared/src/rendering/sequence.ts).
//
// The per-request timeout below is NOT a retry: it bounds one request so a hung
// socket fails fast (ethers v5's default is ~120s) and failover can move to the
// next URL. It never issues an extra request by itself.
// ---------------------------------------------------------------------------

// Per-request timeout (ms) applied to the provider's connection. Generous
// enough for normal reads but well under ethers v5's ~120s default so a hung
// socket fails fast and failover proceeds.
const READ_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Provider setup
// ---------------------------------------------------------------------------

const evmSetup = (contractAddress: string, abi: any, chain: string, rpcUrl?: string) => {

    const url = rpcUrl;
    const network = NETWORK_CONFIG[chain];

    // Pass an explicit per-request timeout (ms) so a hung connection fails fast
    // instead of ethers v5's ~120s default. The timeout must be part of the
    // ConnectionInfo passed at construction — ethers v5 freezes `provider.connection`,
    // so it can't be set afterwards.
    const provider = new ethers.providers.StaticJsonRpcProvider({ url, timeout: READ_TIMEOUT_MS }, network);

    const contract = new ethers.Contract(contractAddress, abi, provider);

    return { provider, contract };
};

export const evmWrite = async (
    chain: string,
    pkp: string,
    contractAddress: string,
    abi: any,
    method: string,
    args: any[],
    confirm: boolean = false,
    rpc?: string,
) => {
    if (!rpc) throw "evmWrite: rpc is required";
    const { provider, contract } = evmSetup(contractAddress, abi, chain, rpc);

    const pendingNonce = await provider.getTransactionCount(pkp, "pending");
    const txData = contract.interface.encodeFunctionData(method, args);

    const estimatedGas = await provider.estimateGas({
        to: contractAddress,
        data: txData,
        from: pkp,
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

    const wallet = new ethers.Wallet(await Lit.Actions.getPrivateKey({ pkpId: pkp }));
    const signedTx = await wallet.signTransaction(tx);

    try {
        const txResponse = await provider.sendTransaction(signedTx);
        console.log("Transaction sent! Hash:", JSON.stringify(txResponse));

        if (confirm) {
            console.log("Waiting for confirmation...");
            const receipt = await txResponse.wait(1);
            console.log("Transaction confirmed! Block:", receipt.blockNumber);
            // A mined-but-REVERTED tx (receipt.status === 0) is a FAILURE: the
            // write did not land on-chain even though a receipt exists. Report
            // it as success:false so callers (update/main.ts) fail loudly
            // instead of silently reporting success with the new root CID.
            if (receipt.status === 0) {
                return {
                    success: false,
                    error:
                        'transaction reverted (status 0)' +
                        (receipt.transactionHash ? ' hash ' + receipt.transactionHash : ''),
                    hash: receipt.transactionHash,
                };
            }
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

/**
 * Read a view function, FAILING FAST: try each RPC URL once (failover to the
 * next URL) and, on total transport failure, throw an aggregated error so the
 * render fails.
 *
 * Deliberately NO in-session retry loop: this runs inside the Lit action
 * session where every HTTP request counts against Lit's 50-request-per-session
 * cap. In-session retries multiply that spend and can blow the budget for any
 * render that issues many eth_calls (e.g. the multi-collection home template).
 * A single labile transport failure is better handled by re-running the whole
 * render outside the session (a fresh 50-request budget) — see
 * shared/src/rendering/sequence.ts. These reads are not retry-until-success;
 * fail fast and let the orchestrator decide whether to re-run.
 */
export const evmRead = async (
    chain: string,
    contractAddress: string,
    abi: any,
    method: string,
    args: any[],
    rpcs?: string[],
) => {
    const urls = rpcs || [];
    if (urls.length === 0) throw "evmRead: rpcs array is empty or missing";
    const failures: string[] = [];
    let lastError: any;

    for (const url of urls) {
        try {
            const { contract } = evmSetup(contractAddress, abi, chain, url);
            return await contract[method](...args);
        } catch (error: any) {
            const msg = `RPC call to ${url} failed: ${error?.message || String(error)}`;
            failures.push(msg);
            console.log(msg);
            lastError = error;
        }
    }

    const aggregated = new Error(failures.join(" | "));
    (aggregated as any).failures = failures;
    throw aggregated;
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
