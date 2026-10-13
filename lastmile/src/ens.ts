// lastmile — multi-RPC, fail-closed ENS contenthash resolution.
//
// Trust chain: magazine Safe -> owns *.eth -> ENS contenthash -> IPFS CID -> bytes.
// This module resolves the contenthash independently via >= 2 RPCs and fails
// closed: on any RPC error or CID disagreement it reports an error /
// disagreement outcome instead of guessing.

import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

import { contenthashToCid } from "./cid.js";

export interface ContenthashResult {
  ensName: string;
  /** null = resolver has NO contenthash (a unanimous VALUE, not an error). */
  contenthashHex: string | null;
  /** Decoded CID; null iff contenthashHex is null. */
  cid: string | null;
  /** Block the read happened at (from viem getEnsContenthash), null if unavailable. */
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

// viem removed the `getEnsContenthash` action (it was deprecated) before
// 2.57, so the public-client type no longer carries it. We still read the
// resolver contenthash through that action's historical shape
// ({ contenthash, blockNumber, blockTag }) via a structural shim. If a runtime
// client does not provide the method, the call throws and resolveContenthash
// fails closed (status "error").
interface EnsContenthashReader {
  getEnsContenthash(args: { name: string }): Promise<{
    contenthash: string | null;
    blockNumber?: bigint | null;
    blockTag?: string;
  }>;
}

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
 *  - if ANY rpc call (or decode) throws -> status "error" immediately, no vote;
 *  - if all succeed but the normalized CIDs differ -> status "disagreement";
 *  - only if all CIDs are identical -> status "ok" with the first result.
 * A unanimous `contenthash: null` is a VALUE (ok, cid null), not an error.
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
      }) as unknown as EnsContenthashReader;
      const res = await client.getEnsContenthash({ name: ensName });

      const contenthashHex = normalizeContenthash(res.contenthash ?? null);
      const cid = contenthashHex === null ? null : contenthashToCid(contenthashHex);
      results.push({
        ensName,
        contenthashHex,
        cid,
        blockNumber: res.blockNumber ?? null,
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
