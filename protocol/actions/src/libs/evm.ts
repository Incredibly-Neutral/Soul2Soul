const NETWORK_CONFIG: Record<string, { chainId: number; name: string }> = {
    L1:           { chainId: 1,     name: "homestead" },
    L2:           { chainId: 8453,  name: "base" },
    L2_SEPOLIA:   { chainId: 84532, name: "base-sepolia" },
};

// ---------------------------------------------------------------------------
// Transport failure handling for eth_call.
//
// ethers v5's JsonRpcProvider only retries 429/redirect HTTP responses; a
// connection-level failure (ECONNRESET, socket closed, dropped response) is
// NOT retried by ethers. Worse, when an eth_call's HTTP response is dropped
// mid-flight ethers v5 occasionally MISLABELS the failure as an on-chain
// revert (CALL_EXCEPTION 'missing revert data', data=0x) whose inner
// `error.error` is actually a SERVER_ERROR reason 'missing response' with
// serverError ECONNRESET. That turns a transient socket drop into a hard
// "revert" that aborts the whole action.
//
// The fix is twofold (see predictablyRevert / retry helpers below):
//   1. Classify errors into GENUINE on-chain reverts (no retry) vs
//      TRANSPORT/connection failures (retry with backoff + jitter).
//   2. Give the eth_call provider a short per-request timeout so a hung
//      connection fails fast instead of hanging on ethers v5's ~120s default.
// ---------------------------------------------------------------------------

// Per-request timeout (ms) applied to the provider's connection. Generous
// enough for normal reads but well under ethers v5's ~120s default so a hung
// socket fails fast.
const READ_TIMEOUT_MS = 8000;

// Retry budget for connection-level failures: up to this many attempts with
// exponential backoff + jitter (approx 250ms / 500ms / 1000ms + jitter) before
// giving up and surfacing an aggregated transport error.
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const backoffMs = (attempt: number) => {
    const base = BASE_BACKOFF_MS * Math.pow(2, attempt); // ~250, ~500, ~1000
    const jitter = Math.random() * base * 0.5; // up to +50% jitter
    return base + jitter;
};

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export type EvmErrorKind = 'revert' | 'transport' | 'unknown';

// Substrings that unambiguously indicate a connection/transport-level failure.
const TRANSPORT_HINTS = [
    'missing response',
    'missing result',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EPIPE',
    'socket closed',
    'socket hang up',
    'connection reset',
    'connection closed',
    'network error',
    'fetch failed',
    'timed out',
    'timeout exceeded',
];

// Yield each node in the nested `error.error` chain exactly once. ethers v5
// wraps a transport failure in a CALL_EXCEPTION whose `.error` is the SERVER_ERROR,
// so we must walk the chain to find the real cause.
function* walkErrorChain(err: any): IterableIterator<any> {
    const seen = new Set<any>();
    let current = err;
    while (current && typeof current === 'object' && !seen.has(current)) {
        seen.add(current);
        yield current;
        current = current.error;
    }
}

function hasTransportSignal(err: any): boolean {
    for (const node of walkErrorChain(err)) {
        if (!node || typeof node !== 'object') continue;

        if (node.code === 'SERVER_ERROR') return true;

        const reason = typeof node.reason === 'string' ? node.reason : '';
        if (/missing response|missing result|timed? ?out|timeout/i.test(reason)) return true;

        const serverError = node.serverError;
        if (serverError && typeof serverError === 'object') {
            if (typeof serverError.code === 'string' && TRANSPORT_HINTS.indexOf(serverError.code.toUpperCase()) !== -1) {
                return true;
            }
            const sm = typeof serverError.message === 'string' ? serverError.message : '';
            if (TRANSPORT_HINTS.some((h) => sm.toLowerCase().includes(h.toLowerCase()))) return true;
        }

        const msg = typeof node.message === 'string' ? node.message : '';
        if (TRANSPORT_HINTS.some((h) => msg.toLowerCase().includes(h.toLowerCase()))) return true;
    }
    return false;
}

function hasRevertSignal(err: any): boolean {
    for (const node of walkErrorChain(err)) {
        if (!node || typeof node !== 'object') continue;

        // Raw JSON-RPC error object: code 3 = "execution reverted".
        if (node.code === 3 || node.code === '3') return true;

        // ethers v5 CALL_EXCEPTION: a genuine revert carries either a real
        // revert payload (data != 0x) or a 'revert'/'reverted' reason.
        if (node.code === 'CALL_EXCEPTION') {
            const data = node.data;
            if (typeof data === 'string' && data.startsWith('0x') && data !== '0x') return true;
            const reason = typeof node.reason === 'string' ? node.reason : '';
            if (/\breverted\b|revert|execution reverted/i.test(reason)) return true;
        }

        const msg = typeof node.message === 'string' ? node.message : '';
        if (/\breverted\b|execution reverted/i.test(msg)) return true;
    }
    return false;
}

/**
 * Classify an ethers v5 call error as a genuine on-chain revert (never retry),
 * a transport/connection failure (retry with backoff), or unknown.
 *
 * Priority: a transport signal anywhere in the nested error chain wins, because
 * ethers v5 can mislabel a socket drop as a `CALL_EXCEPTION 'missing revert data'`
 * (data=0x) whose true cause lives in `error.error` (SERVER_ERROR / ECONNRESET).
 */
export const classifyEvmError = (err: any): EvmErrorKind => {
    if (hasTransportSignal(err)) return 'transport';
    if (hasRevertSignal(err)) return 'revert';
    return 'unknown';
};

export const isTransportError = (err: any): boolean => classifyEvmError(err) === 'transport';

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
 * Read a view function, retrying ONLY on connection-level (transport) failures.
 *
 * - Genuine on-chain reverts (and unclassifiable errors) are propagated as-is
 *   with NO retry — a deterministic revert would never succeed on a retry.
 * - Transport failures (ECONNRESET / socket closed / dropped response /
 *   ethers v5's mislabelled CALL_EXCEPTION wrapping a SERVER_ERROR) are retried
 *   with exponential backoff + jitter across the given rpc URLs, up to
 *   MAX_ATTEMPTS, before giving up with an aggregated error.
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

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        for (const url of urls) {
            try {
                const { contract } = evmSetup(contractAddress, abi, chain, url);
                return await contract[method](...args);
            } catch (error: any) {
                lastError = error;
                const kind = classifyEvmError(error);
                const msg = `RPC call to ${url} failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}, ${kind}): ${error?.message || String(error)}`;
                failures.push(msg);
                console.log(msg);

                // Genuine on-chain revert (or unknown): propagate as-is, no retry.
                if (kind !== 'transport') {
                    throw error;
                }
            }
        }

        // Every URL on this attempt hit a transport error. Back off before retrying.
        if (attempt < MAX_ATTEMPTS - 1) {
            const wait = backoffMs(attempt);
            console.log(
                `evmRead: all ${urls.length} rpc url(s) transport-failed on attempt ${attempt + 1}/${MAX_ATTEMPTS}; retrying in ${Math.round(wait)}ms`,
            );
            await sleep(wait);
        }
    }

    const aggregated = new Error(failures.join(" | "));
    (aggregated as any).failures = failures;
    (aggregated as any).code = "TRANSPORT";
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
