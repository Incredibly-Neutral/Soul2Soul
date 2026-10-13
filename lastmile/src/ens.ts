// lastmile — multi-RPC, fail-closed ENS contenthash resolution.
//
// Trust chain: magazine Safe -> owns *.eth -> ENS contenthash -> IPFS CID -> bytes.
// This module resolves the contenthash independently via >= 2 RPCs and fails
// closed: on any RPC error or CID disagreement it reports an error /
// disagreement outcome instead of guessing.

import { createPublicClient, http, namehash } from "viem";
import { mainnet } from "viem/chains";
import { getEnsResolver } from "viem/ens";

import { contenthashToCid } from "./cid.js";

export interface ContenthashResult {
  ensName: string;
  /** null = resolver has NO contenthash (a unanimous VALUE, not an error). */
  contenthashHex: string | null;
  /** Decoded CID; null iff contenthashHex is null. */
  cid: string | null;
  /** Block the read happened at (best-effort), null if unavailable. */
  blockNumber: bigint | null;
  rpcUrl: string;
  /** Epoch ms. */
  timestamp: number;
}

export type ResolveOutcome =
  | { status: "ok"; result: ContenthashResult }
  | { status: "disagreement"; results: ContenthashResult[]; detail: string }
  | { status: "error"; results: ContenthashResult[]; detail: string };

const DEFAULT_TIMEOUT_MS = 15_000;

// EIP-137 public resolver `contenthash(bytes32 node)` view. viem 2.57 removed
// the `getEnsContenthash` action, so we read the resolver's contenthash via
// getEnsResolver (viem/ens) + a manual readContract against the minimal ABI.
const RESOLVER_ABI = [
  {
    type: "function",
    name: "contenthash",
    stateMutability: "view",
    inputs: [{ type: "bytes32", name: "node" }],
    outputs: [{ type: "bytes", name: "" }],
  },
] as const;

/** Normalize a raw contenthash: null / "0x" / "" -> null. */
function normalizeContenthash(raw: string | null): string | null {
  if (raw === null || raw === "" || raw === "0x") return null;
  return raw;
}

/**
 * Resolve an ENS name's contenthash independently via every rpcUrl.
 *
 * Fail-closed semantics (load-bearing):
 *  - each rpcUrl gets its own client; every rpc is queried;
 *  - if ANY rpc read (resolver lookup or contenthash read) throws ->
 *    status "error" immediately, no vote;
 *  - if all succeed but the normalized CIDs differ -> status "disagreement";
 *  - only if all CIDs are identical -> status "ok" with the first result.
 * A unanimous `contenthash: null` (no resolver, or resolver without a
 * contenthash record) is a VALUE (ok, cid null), not an error.
 * blockNumber is best-effort metadata: a getBlockNumber failure keeps null
 * and does NOT fail closed.
 */
export async function resolveContenthash(
  ensName: string,
  rpcUrls: string[],
  opts?: { timeoutMs?: number },
): Promise<ResolveOutcome> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results: ContenthashResult[] = [];

  for (const rpcUrl of rpcUrls) {
    const timestamp = Date.now();
    try {
      const client = createPublicClient({
        chain: mainnet,
        transport: http(rpcUrl, { timeout: timeoutMs }),
      });
      const resolver = await getEnsResolver(client, { name: ensName });

      let contenthashHex: string | null = null;
      let blockNumber: bigint | null = null;
      if (resolver) {
        const bytes = await client.readContract({
          address: resolver,
          abi: RESOLVER_ABI,
          functionName: "contenthash",
          args: [namehash(ensName)],
        });
        contenthashHex = normalizeContenthash(bytes);
        if (contenthashHex !== null) {
          try {
            blockNumber = await client.getBlockNumber();
          } catch {
            blockNumber = null; // best-effort metadata; do NOT fail closed on it
          }
        }
      }

      const cid = contenthashHex === null ? null : contenthashToCid(contenthashHex);
      results.push({
        ensName,
        contenthashHex,
        cid,
        blockNumber,
        rpcUrl,
        timestamp,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "error", results, detail: `${rpcUrl}: ${message}` };
    }
  }

  const distinctCids = [...new Set(results.map((r) => r.cid))];
  if (distinctCids.length === 1) {
    return { status: "ok", result: results[0] };
  }
  return {
    status: "disagreement",
    results,
    detail: `CID disagreement across RPCs: ${distinctCids.join(", ")}`,
  };
}
