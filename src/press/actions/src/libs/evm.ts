import { parseCID, encodeContenthashWrapped } from '@s2s/soul2soul-shared/lit-actions';

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
// Receipt-wait retry policy (WRITE-CONFIRMATION path only).
//
// ethers v5's txResponse.wait() -> waitForTransaction -> poll() already retries
// with backoff while the receipt is still null (pending/indexing), but on a
// transient RPC transport error (SERVER_ERROR / 'missing response' / network —
// @ethersproject/web index.js:395-399) it REJECTS IMMEDIATELY with no retry.
// The evm-update write path has a single RPC URL and no retry, so one DRPC
// load-balancer hiccup during the receipt wait fails the whole write even
// though the tx is legitimately still indexing.
//
// So we poll getTransactionReceipt ourselves with a bounded retry-with-backoff
// loop that treats BOTH a null receipt (still indexing) AND a transient
// transport error as "not ready yet": sleep + exponential backoff (250ms floor
// growing to a ~10s ceiling, matching ethers' own scaling) up to a bounded total
// budget before giving up. We only fail hard once that budget is exhausted — or
// later when the mined receipt confirms status === 0 (reverted).
// ---------------------------------------------------------------------------
const RECEIPT_POLL_INITIAL_MS = 250;   // floor — matches ethers' own poll start
const RECEIPT_POLL_MAX_MS = 10_000;    // ceiling — in line with ethers' growth
const RECEIPT_RETRY_BUDGET_MS = 90_000; // ~90s total budget before we give up

const waitForReceipt = async (provider: any, txHash: string): Promise<any> => {
    const start = Date.now();
    const deadline = start + RECEIPT_RETRY_BUDGET_MS;
    let delay = RECEIPT_POLL_INITIAL_MS;

    for (let attempt = 0; ; attempt++) {
        let receipt: any = null;
        try {
            receipt = await provider.getTransactionReceipt(txHash);
        } catch (err) {
            // Transient RPC transport error — NOT a failure. The tx may be
            // legitimately still indexing (or already mined) while the RPC
            // hiccups; ethers v5's wait() would reject immediately here. Log
            // and retry within the bounded budget instead.
            const msg = err instanceof Error ? err.message : String(err);
            console.log(
                `getTransactionReceipt transport error (attempt ${attempt}): ${msg} — retrying with backoff`,
            );
        }

        // A mined receipt (non-null with a block number) means the wait is over.
        if (receipt && receipt.blockNumber !== undefined && receipt.blockNumber !== null) {
            return receipt;
        }

        // Not ready yet (null or still indexing) or we hit a transient error;
        // give up only once the bounded budget is exhausted.
        if (Date.now() >= deadline) {
            throw new Error(
                `receipt for ${txHash} not confirmed within ${RECEIPT_RETRY_BUDGET_MS}ms ` +
                    `(last receipt: ${receipt ? 'still indexing' : 'null'})`,
            );
        }

        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, RECEIPT_POLL_MAX_MS);
    }
};

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
            // Retry-with-backoff receipt polling (see waitForReceipt)
            // instead of the single-shot ethers wait(), which rejects
            // immediately on a transient RPC transport error.
            const receipt = await waitForReceipt(provider, txResponse.hash);
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
 *
 * `blockTag` pins the read to that block (eth_call overrides). One caller needs
 * it: the decrypt action reads the draft entry at the block the ownership gate
 * judged it at, so the ciphertext opened and the owner set it was judged under
 * are the same version. A tag of 0 is not passed — the node reads genesis
 * state for it, and block 0 is this protocol's "no block was recorded" marker,
 * not a height to read at.
 */
export const evmRead = async (
    chain: string,
    contractAddress: string,
    abi: any,
    method: string,
    args: any[],
    rpcs?: string[],
    blockTag?: number,
) => {
    const urls = rpcs || [];
    if (urls.length === 0) throw "evmRead: rpcs array is empty or missing";
    const failures: string[] = [];
    let lastError: any;
    const overrides =
        typeof blockTag === "number" && Number.isFinite(blockTag) && blockTag > 0
            ? { blockTag }
            : undefined;

    for (const url of urls) {
        try {
            const { contract } = evmSetup(contractAddress, abi, chain, url);
            return overrides
                ? await contract[method](...args, overrides)
                : await contract[method](...args);
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
    // Parse the CID string (CIDv0 Qm... or CIDv1 bafy...) into its raw bytes
    // (version varint + codec varint + multihash) and wrap them in the EIP-1577
    // ipfs-ns contenthash envelope (0xe3 0x01 + CID bytes). This is the same
    // encoding decodeContenthashWrapped expects, so the value round-trips back
    // to the identical CID. The old implementation base58-decoded the CID
    // string as a big number (CIDv0-only), which turned a CIDv1 root into
    // garbage on-chain.
    return encodeContenthashWrapped(parseCID(_cid));
};
