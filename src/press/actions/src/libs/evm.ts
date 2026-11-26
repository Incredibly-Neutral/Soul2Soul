import { parseCID, encodeContenthashWrapped } from '@s2s/soul2soul-shared/lit-actions';
import { fetchWithTimeout } from './helpers';

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
// / getAgreements, protocol.getRecords) that pushed a ~33-38 request render over the
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
// transport error as "not ready yet": sleep + exponential backoff (1s floor
// growing to a ~10s ceiling, matching ethers' own scaling) up to a bounded total
// budget before giving up. We only fail hard once that budget is exhausted — or
// later when the mined receipt confirms status === 0 (reverted).
//
// The first poll waits one block (2s) before asking at all. ethers' own poll
// starts at 0ms and backs off 0/250/750ms: on Base a transaction cannot be in a
// block that fast, so those first polls could never see a receipt — they only
// spent HTTP requests from the Lit session budget to be told the same null.
// ---------------------------------------------------------------------------
const RECEIPT_FIRST_POLL_MS = 2000;    // wait one block before the first ask
const RECEIPT_POLL_INITIAL_MS = 1000;  // backoff floor after a not-ready poll
const RECEIPT_POLL_MAX_MS = 10_000;    // ceiling — in line with ethers' growth
const RECEIPT_RETRY_BUDGET_MS = 90_000; // ~90s total budget before we give up

// ---------------------------------------------------------------------------
// Per-invocation read cache.
//
// One Lit Action invocation is one session, one block window, one 50-request
// budget. The gates re-derive the same ground truth for every item they judge:
// `canRead` per encrypted collection item resolves the author Safe's modules
// from `getModulesPaginated` plus two `supportsInterface` probes per enabled
// module, and asks `isOwnerAt` for the same Safe and signer. None of that
// changes between items of one render.
//
// The cache holds the PROMISE, not the settled value, because the collection
// loop runs its items concurrently: four `canRead` calls start before the first
// module page resolves, and only a shared in-flight promise collapses them into
// one request. A failed read is dropped so it is not remembered as an answer.
// The cache does not outlive the invocation: a fresh action bundle starts with
// none, so a stale module answer cannot outlive its session.
// ---------------------------------------------------------------------------
let readCache: Map<string, Promise<unknown>> | undefined;

/** Share identical reads for the rest of this action invocation. */
export const enableReadCache = (): void => {
    readCache = new Map();
};

/** Stop sharing: every read goes to the node again. */
export const disableReadCache = (): void => {
    readCache = undefined;
};

const cached = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    if (!readCache) return run();
    const hit = readCache.get(key);
    if (hit) return hit as Promise<T>;
    const p = run();
    readCache.set(key, p);
    // A failed read is not an answer: drop it so a later identical read retries.
    p.catch(() => readCache?.delete(key));
    return p;
};

const waitForReceipt = async (provider: any, txHash: string): Promise<any> => {
    const start = Date.now();
    const deadline = start + RECEIPT_RETRY_BUDGET_MS;
    let delay = RECEIPT_POLL_INITIAL_MS;

    // One block has to pass before a receipt can exist at all.
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_FIRST_POLL_MS));

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

// ---------------------------------------------------------------------------
// JSON-RPC batching.
//
// Every RPC read costs one of Lit's 50 requests per session, so independent
// reads made in the same tick share one HTTP request. Calls are queued per RPC
// URL list and flushed on the next tick: a queue holding more than one call is
// sent as one JSON-RPC batch (split at RPC_BATCH_MAX), and a queue holding one
// call rejects it with RPC_SOLO so the caller runs the original per-URL loop
// instead — a lone call gains nothing from a batch envelope.
//
// Batching must never change what a caller sees on failure: a batch that is
// refused, answers with a non-array body, or fails in transport rejects every
// call in it, and each caller falls through to the per-URL loop, which keeps
// the error strings and the failover order exactly as they were. A single
// error entry inside an otherwise successful batch rejects only that call, with
// the node's message, and marks it `rpcAnswered` so a caller can tell a node
// that refused from a node that never answered.
// ---------------------------------------------------------------------------
const RPC_BATCH_MAX = 20;
const RPC_SOLO = Symbol('rpc-solo');

type RpcCall = {
    method: string;
    params: any[];
    resolve: (value: any) => void;
    reject: (reason: any) => void;
};

const rpcQueues: Map<string, RpcCall[]> = new Map();

/** Queue one read; it goes out with the other calls made in the same tick. */
export const rpcEnqueue = (urls: string[], method: string, params: any[]) =>
    new Promise((resolve, reject) => {
        const qkey = urls.join('\n');
        let queue = rpcQueues.get(qkey);
        if (!queue) {
            queue = [];
            rpcQueues.set(qkey, queue);
            setTimeout(() => {
                rpcQueues.delete(qkey);
                if (queue!.length === 1) {
                    queue![0].reject(RPC_SOLO);
                    return;
                }
                for (let i = 0; i < queue!.length; i += RPC_BATCH_MAX) {
                    sendRpcBatch(urls[0], queue!.slice(i, i + RPC_BATCH_MAX));
                }
            }, 0);
        }
        queue.push({ method, params, resolve, reject });
    });

/** Send `calls` as one JSON-RPC batch to `url`, settling each by its id. */
export const sendRpcBatch = async (url: string, calls: RpcCall[]) => {
    try {
        const res = await fetchWithTimeout(
            url,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(
                    calls.map((c, id) => ({ jsonrpc: '2.0', id, method: c.method, params: c.params })),
                ),
            },
            READ_TIMEOUT_MS,
        );
        const body: any = await res.json();
        if (!Array.isArray(body)) throw new Error('RPC answered a batch with a non-array body');
        const byId = new Map(body.map((entry: any) => [entry?.id, entry]));
        calls.forEach((call, id) => {
            const entry = byId.get(id);
            if (entry && entry.error == null && entry.result !== undefined) call.resolve(entry.result);
            else {
                const err: any = new Error(entry?.error?.message ?? 'no entry in batch response');
                err.rpcAnswered = Boolean(entry?.error);
                call.reject(err);
            }
        });
    } catch (err) {
        for (const call of calls) call.reject(err);
    }
};

const batchedEthCall = async (
    urls: string[],
    contractAddress: string,
    abi: any,
    method: string,
    args: any[],
    blockTag?: number,
) => {
    const iface = new ethers.utils.Interface(abi);
    const fragment = iface.getFunction(method);
    const data = iface.encodeFunctionData(fragment, args);
    const tag = blockTag ? ethers.utils.hexValue(blockTag) : 'latest';
    const raw = await rpcEnqueue(urls, 'eth_call', [{ to: contractAddress, data }, tag]);
    const decoded = iface.decodeFunctionResult(fragment, raw);
    return fragment.outputs.length === 1 ? decoded[0] : decoded;
};

const evmProvider = (chain: string, rpcUrl?: string) => {

    const url = rpcUrl;
    const network = NETWORK_CONFIG[chain];

    // Pass an explicit per-request timeout (ms) so a hung connection fails fast
    // instead of ethers v5's ~120s default. The timeout must be part of the
    // ConnectionInfo passed at construction — ethers v5 freezes `provider.connection`,
    // so it can't be set afterwards.
    return new ethers.providers.StaticJsonRpcProvider({ url, timeout: READ_TIMEOUT_MS }, network);
};

const evmSetup = (contractAddress: string, abi: any, chain: string, rpcUrl?: string) => {

    const provider = evmProvider(chain, rpcUrl);

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

    const txData = contract.interface.encodeFunctionData(method, args);

    // The nonce and the gas estimate do not depend on each other: ask for both
    // in one batch instead of two sequential requests. Each falls back to the
    // provider call it replaced when the batch does not answer it.
    const [nonceAnswer, gasAnswer] = await Promise.allSettled([
        rpcEnqueue([rpc], "eth_getTransactionCount", [pkp, "pending"]),
        rpcEnqueue([rpc], "eth_estimateGas", [{ from: pkp, to: contractAddress, data: txData }]),
    ]);

    const pendingNonce = nonceAnswer.status === "fulfilled"
        ? ethers.BigNumber.from(nonceAnswer.value).toNumber()
        : await provider.getTransactionCount(pkp, "pending");

    const estimatedGas = gasAnswer.status === "fulfilled"
        ? ethers.BigNumber.from(gasAnswer.value)
        : gasAnswer.reason?.rpcAnswered
            ? (console.log("Gas estimation failed:", gasAnswer.reason.message), ethers.BigNumber.from(60000))
            : await provider.estimateGas({
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

const readBlockTag = (blockTag?: number) =>
    typeof blockTag === "number" && Number.isFinite(blockTag) && blockTag > 0
        ? { blockTag }
        : undefined;

const readThrough = async (
    chain: string,
    contractAddress: string,
    abi: any,
    method: string,
    args: any[],
    urls: string[],
    overrides: { blockTag: number } | undefined,
) => {
    // One batch entry, shared with every other read in this tick. A lone call
    // rejects with RPC_SOLO; a refused batch rejects too. Either way the
    // per-URL loop below is the answer, unchanged.
    try {
        return await batchedEthCall(urls, contractAddress, abi, method, args, overrides?.blockTag);
    } catch {}

    const failures: string[] = [];
    let lastError: any;

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
 *
 * One batch entry in the current tick, then the per-URL loop when the batch
 * does not answer it (see the batching block).
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
    const key = `read|${chain}|${contractAddress}|${method}|${JSON.stringify(args)}|${
        typeof blockTag === "number" && blockTag > 0 ? blockTag : ""
    }`;
    const overrides = readBlockTag(blockTag);
    return cached(key, () => readThrough(chain, contractAddress, abi, method, args, urls, overrides));
};

/**
 * The same read as `evmRead`, skipping this invocation's read cache.
 *
 * Narrow by design: a caller that has to know whether something changed on
 * chain (the `hasAgreement` retries) cannot be answered by a value the cache
 * remembered earlier in the same session. Every other read goes through
 * `evmRead` and keeps sharing.
 */
export const readFresh = async (
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
    return readThrough(chain, contractAddress, abi, method, args, urls, readBlockTag(blockTag));
};

/**
 * Read the code deployed at `address`, FAILING FAST in exactly the way evmRead
 * does: one request per RPC URL, failover to the next URL, no in-session retry,
 * and an aggregated error carrying `.failures` when every URL fails.
 *
 * One request per call, which matters because this is how a module answer is
 * checked for code inside the Lit session's 50-request cap. A zero address
 * answers `'0x'` — no code — so callers get one uniform test for "not deployed".
 */
export const evmGetCode = async (
    chain: string,
    address: string,
    rpcs?: string[],
): Promise<string> => {
    const urls = rpcs || [];
    if (urls.length === 0) throw "evmGetCode: rpcs array is empty or missing";
    return cached(`code|${chain}|${address}`, async () => {
    try {
        return ethers.utils.hexlify(await rpcEnqueue(urls, "eth_getCode", [address, "latest"]));
    } catch {}

    const failures: string[] = [];

    for (const url of urls) {
        try {
            const provider = evmProvider(chain, url);
            return await provider.getCode(address);
        } catch (error: any) {
            const msg = `RPC getCode to ${url} failed: ${error?.message || String(error)}`;
            failures.push(msg);
            console.log(msg);
        }
    }

    const aggregated = new Error(failures.join(" | "));
    (aggregated as any).failures = failures;
    throw aggregated;
    });
};

export const toHexString = (_cid: string) => {
    // Parse the CID string (CIDv0 Qm... or CIDv1 bafy...) and wrap it in the
    // EIP-1577 ipfs-ns contenthash envelope (0xe3 0x01 + CID bytes).
    //
    // The CID is converted to v1 first, and that is the record's invariant: a
    // CIDv0 root encoded as-is carries synthetic `00 70` version/codec bytes
    // (`0xe30100701220…`) that no standard parser accepts — eth.limo reads the
    // contenthash with stock multiformats, rejects the bytes, and refuses the
    // name, which the browser shows as ERR_SSL_PROTOCOL_ERROR. Re-encoding as
    // v1 keeps the multihash (and so the blocks) identical while producing the
    // `0xe30101…` form that eth.limo and decodeContenthashWrapped both accept.
    //
    // Two root versions still reach this function: copy-forward keeps the
    // previous root's version, and a reset / from-zero `files/mkdir` can come
    // back CIDv0. Normalising here makes the on-chain record independent of
    // which one ran.
    return encodeContenthashWrapped(parseCID(_cid).toV1());
};
