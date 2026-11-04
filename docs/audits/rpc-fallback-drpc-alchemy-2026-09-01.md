# RPC Fallback: DRPC-first + Alchemy-second — How It Works

**Date:** 2026-09-01
**Scope:** READ-ONLY audit — how the repo switched from a single RPC provider (Alchemy) to an **array** of providers (DRPC first, Alchemy fallback), so the pattern can be replicated in the `s3ntiment` repo. **No source modified.**

**Head:** `a1c6433` (main).

---

## TL;DR

There is **no single "provider array" module and no ethers `FallbackProvider`** anywhere in the repo. The DRPC-first / Alchemy-second array exists only as a **data shape** — a per-chain ordered list of full RPC URL strings — that is:

1. **Built** by callers (neutralpress `buildRpcEndpoints`, or the old hardcoded `RPC_URLS` map),
2. **Validated & threaded** through the Lit action `endpoints.rpcs` input (`{ L1: string[]; L2: string[] }`), and
3. **Consumed** by a **per-call failover loop** in `evmRead()` (`protocol/actions/src/libs/evm.ts`) that tries each URL exactly once and falls through on failure.

The fallback is **NOT** a swap-on-failure wrapper around a single provider, **NOT** an ethers v6 `FallbackProvider`, and **NOT** a custom provider class. It is plain in-function iteration over a string array, re-constructing a fresh `StaticJsonRpcProvider` per URL.

The write path (`evmWrite`) deliberately does **not** fail over — it takes a **single** `rpc: string` (writes shouldn't be retried against another provider).

---

## 1. Where the "provider array" is defined

Because the array is just an ordered list of URL strings, it appears in a few places depending on layer. The **canonical / authoritative shape** today is threaded through the shared Lit-action input (`endpoints.rpcs`).

### 1a. Source of the array in the caller (neutralpress) — the live producer
`neutralpress/src/render/render.helper.ts:33-46` — `buildRpcEndpoints()`:

```ts
export function buildRpcEndpoints(
	main: IMainController,
): { L1: string[]; L2: string[] } {
	const rpcKey = main.oxo.ctrlr.plugin.settings.rpc_key;
	const alchemyKey = 'NFOkRqUo2swIC9g5tRJ7c';
	return {
		L1: [
			`https://lb.drpc.live/ethereum/${rpcKey}`,
			`https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`,
		],
		L2: [
			`https://lb.drpc.live/base/${rpcKey}`,
			`https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`,
		],
	};
}
```

- Order confirmed: **`[drpc, alchemy]`** for both L1 (Ethereum mainnet) and L2 (Base).
- DRPC key comes from `main.oxo.ctrlr.plugin.settings.rpc_key` (user setting loaded from the Obsidian plugin settings).
- Alchemy key is **hardcoded** here (`'NFOkRqUo2swIC9g5tRJ7c'`) — matches `VITE_ALCHEMY_KEY` in `.env`.

### 1b. The old in-action source (historical, pre-extraction)
Before the constants extraction, the array was baked into `protocol/actions/src/libs/evm.ts` itself via `import { ALCHEMY_KEY, DRPC_API_KEY } from "./constants"` + a static `RPC_URLS: Record<chain, string[]>` map. See §6 for the before/after.

### 1c. Validation of the shape (the type contract)
`shared/src/rendering/action-io.ts:96-98, 168-170, 251-253, 322-324` — every action input schema (prep / single / evm-update / maintain-cache) validates:

```ts
rpcs: z.object({
  L1: z.array(z.string()).min(1, 'L1 rpcs required'),
  L2: z.array(z.string()).min(1, 'L2 rpcs required'),
}),
```

So the contract is: `endpoints.rpcs = { L1: string[], L2: string[] }`, each entry a **full URL including the key**, ordered (element 0 tried first → later elements are fallbacks). It is deliberately **agnostic** to what's in the array — "[drpc, alchemy] today, anything tomorrow" (see §7).

### 1d. Not the module you were pointed at
- **`0xobsidian/src/eth/provider.factory.js` does NOT exist.** The `0xobsidian/src/eth/` dir has `chains.factory.ts` but no provider factory. `chains.factory.ts:88-104` `getRPCUrl()` returns a **single** DRPC URL per chain (`https://lb.drpc.live/<chain>/<api_key>`), no array, no Alchemy fallback.
- **`shared/.../eth-rpc`**: no such source file; only a compiled artifact at `shared/dist/eth-rpc`.
- **`ccip_gateway/src/main.ts:14`** has a hardcoded Alchemy demo URL (`https://base-mainnet.g.alchemy.com/v2/demo`) — unrelated to the fallback array.

---

## 2. Exact array shape + config / env loading

- **Shape:** `{ L1: string[], L2: string[] }`, each chain ordered `[drpc, alchemy]`.
  - `L1` (Ethereum mainnet): `https://lb.drpc.live/ethereum/<rpc_key>` then `https://eth-mainnet.g.alchemy.com/v2/<alchemy_key>`
  - `L2` (Base): `https://lb.drpc.live/base/<rpc_key>` then `https://base-mainnet.g.alchemy.com/v2/<alchemy_key>`
- **DRPC default URLs** (`0xobsidian/src/eth/chains.factory.ts:88-104`, `setup-session-key.ts`, etc.):
  - `ethereum`, `sepolia`, `base`, `base-sepolia`, plus `https://lb.drpc.live/filecoin/<key>` for Filecoin.
- **Env vars (`.env`):** there are **no** `DRPC_*` or `ALCHEMY_*` RPC *URL* vars. The `.env` only carries **keys**:
  - `VITE_DRPC_API_KEY=AouQTyDbwExLrOsOS2mMBR_2kteqUQMR8az6tiKh6MJI`
  - `VITE_ALCHEMY_KEY=NFOkRqUo2swIC9g5tRJ7c`
  - Chain-RPC test endpoints: `MAINNET_RPC_URL=https://lb.drpc.live/eth/<key>` and `BASE_RPC_URL=https://lb.drpc.live/base/<key>` (used only for chain-ready tests `sequence.test.ts`).
- `safe-app/src/vite-env.d.ts:7` declares `VITE_DRPC_API_KEY: string`.
- A **single** DRPC URL is composed imperatively in many places from `VITE_DRPC_API_KEY`, e.g. `safe-app/src/lib/evm.ts:10-17`, `safe-app/src/components/s2s-app.ts:53`, `s2s-website-tree-tab.ts:346-349`, `s2s-deals-tab.ts:288-291`. These build **single-element** arrays (`L1: [drpc]`, `L2: [drpc]`) — no Alchemy fallback in safe-app.

---

## 3. The fallback mechanism (the actual wiring)

Implemented **per-call** as a fail-over loop in `protocol/actions/src/libs/evm.ts` — `evmRead()` (lines ~219-255). There is **no** ethers `FallbackProvider` / `FallbackJsonRpcProvider` anywhere (verified: zero matches in `protocol`, `shared`, `neutralpress`, `0xobsidian`, `safe-app`).

`neutralpress/src/render/render.helper.ts` → `renderwithLitActions(...)` threads `rpcs` into the action input (`shared/src/rendering/sequence.ts:146-190`, `endpoints.rpcs` built at ~186-192). The action `main.ts` reads `endpoints.rpcs` and passes the per-chain array `rpcs?.L2` into `evmRead`. Then:

```ts
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
```

Key semantics:
- **Fail-fast, single pass, NO in-session retry.** Each URL is tried **exactly once**; on failure the loop moves to the next URL. On total failure it throws one **aggregated** `Error` with `.failures[]` attached. (The header comment at evm.ts:1-33 explains this is deliberately NOT a retry loop, because each `eth_call` runs inside the Lit session where every HTTP request counts against Lit's hard 50-requests-per-session cap — in-session retries would multiply that spend.)
- `evmSetup` (evm.ts:101-115) constructs a fresh `new ethers.providers.StaticJsonRpcProvider({ url, timeout: READ_TIMEOUT_MS }, network)` per URL, with `READ_TIMEOUT_MS = 8000` (evm.ts:~35) so a hung socket fails fast (ethers v5 default ~120s) and failover proceeds.
- The catch-all `continue`-style failover is **intentional**: a GAP-15 attempt to distinguish transport errors from contract reverts (throwing immediately on `CALL_EXCEPTION`) was tried and **reverted**, because ethers v5 wraps transport `SERVER_ERROR` as `CALL_EXCEPTION` with `data="0x"`, which made the first URL failure throw without ever trying the second URL. See `brain/handoffs/handoff-actions-fixes-and-remove.md` §1 (GAP-15 co-fix reverted).

### Writes do NOT fail over
`evmWrite()` (evm.ts:117-201) takes a **single** `rpc: string` (evm.ts:125; throws `"evmWrite: rpc is required"` if absent) and calls `evmSetup(..., rpc)` — a single provider, no array, no failover (a write must not be re-issued against another provider). The write path does have a separate **receipt-wait** retry-with-backoff (`waitForReceipt`, evm.ts:56-98) — that's confirmation polling (null receipt or transient transport error = "not ready yet"), not provider failover.

### Orchestrator-level retry (the counterpart)
Because the in-session read is fail-fast (no retry), the **orchestrator** re-runs the whole render in a fresh Lit session on failure — `shared/src/rendering/sequence.ts` (RENDER_RETRY_ATTEMPTS=3, backoff 1500ms; fast-fails on the deterministic session-budget string `HTTP requests per session`). This is explicitly documented as "the counterpart to the in-session fail-fast evmRead" (sequence.ts:7-55).

---

## 4. How the layers consume providers

### Lit actions (prepare / render / update / maintain-cache) — pass the **array**
- Input `endpoints.rpcs` → action `main.ts` reads it and passes the **per-chain array** to `evmRead`:
  - `protocol/actions/src/render/main.ts:97` `const rpcs = endpoints.rpcs;` then `rpcs?.L2` into `evmRead` (lines 49, 121, 160, 179, 239, 267), `getProtocolInfo(false, rpcs)` (104), `getConfig(..., rpcs?.L2, ...)` (166).
  - `protocol/actions/src/update/main.ts:55` `const rpcs = endpoints.rpcs;` then `rpcs?.L2` (79, 82, 105, 180), `evmWrite(..., rpc)` with a single URL (line ~99-105 region; write uses single `rpc`).
  - The layer helpers all take `rpcs: string[]` / `rpcs?: string[]` and forward it: `ens.factory.ts`, `protocol.factory.ts`, `module.factory.ts`, `gates.ts`, `config.ctrl.ts`.
- So consumers pass the **array**; the failover loop lives inside `evmRead`. No consumer sees a provider object — they pass URL strings.

### neutralpress (orchestrator) — builds the array, hands it to shared
`buildRpcEndpoints(main)` → passed as `_rpcs` to `renderwithLitActions` (render.helper.ts:101-113). `shared/src/rendering/sequence.ts` validates + embeds into `endpoints.rpcs`.

### Filecoin scripts — single DRPC URL, NO array/fallback
`protocol/scripts/filecoin/{retrieve-test,setup-session-key,check-status,fund-account,setup-payment}.ts` each build a **single** URL:
```ts
const RPC_URL =
  process.env.FILECOIN_RPC_URL ||
  (process.env.VITE_DRPC_API_KEY
    ? `https://lb.drpc.live/filecoin/${process.env.VITE_DRPC_API_KEY}`
    : 'https://api.node.glif.io/rpc/v1');
```
No Alchemy fallback here — Filecoin uses one DRPC endpoint (or the public Glif fallback when no key). Same single-URL pattern in `0xobsidian/src/main.ctrlr.ts:108-111`, `protocol/contracts/scripts/update-impl.ts:105-106`, `deploy-publication-factory.ts:70-71`, `protocol/scripts/lit/update-protocol.ts:87`. **These are separate from the L1/L2 drpc+alchemy array** — replicate only if the s3ntiment target is the L1/L2 Lit-action path.

### safe-app — single-URL DRPC arrays (no Alchemy)
`safe-app/src/lib/evm.ts` and the tabs build `L1: [drpc]`, `L2: [drpc]` single-element arrays. `safe-app/src/lib/safe-integration.ts:380` context has its own `evmRead` signature (single URL).

---

## 5. Env vars used (`.env`)

| Var | Value | Used by |
|---|---|---|
| `VITE_DRPC_API_KEY` | `AouQTyDbwExLrOsOS2mMBR_2kteqUQMR8az6tiKh6MJI` | DRPC URLs everywhere (safe-app, scripts, plugin settings) |
| `VITE_ALCHEMY_KEY` | `NFOkRqUo2swIC9g5tRJ7c` | neutralpress hardcoded `alchemyKey` (match), old in-action constants |
| `FILECOIN_RPC_URL` | (optional override) | filecoin scripts, else DRPC filecoin URL, else public Glif |
| `MAINNET_RPC_URL` | `https://lb.drpc.live/eth/<key>` | chain-ready tests (sequence.test.ts) |
| `BASE_RPC_URL` | `https://lb.drpc.live/base/<key>` | chain-ready tests (sequence.test.ts) |

Notes: no `DRPC_*` / `ALCHEMY_*` *URL* env vars exist; keys are the only secrets and URLs are composed `https://lb.drpc.live/<chain>/<key>` and `https://<chain>-mainnet.g.alchemy.com/v2/<key>`. The plugin-side DRPC key is also editable in Obsidian settings (`plugin.settings.rpc_key`).

---

## 6. Relevant git history

### The array mechanism (hardcoded → input-threaded): `7cc1468` "full circle" (2026-08-07)
This is the commit that moved the `[drpc, alchemy]` array from a hardcoded in-action map into the caller-supplied `endpoints.rpcs` input. `git show 7cc1468 -- protocol/actions/src/libs/evm.ts` before/after:

**Before:**
```ts
import { ALCHEMY_KEY, DRPC_API_KEY } from "./constants";
const RPC_URLS: Record<string, string[]> = {
    ETHEREUM: [
        `https://lb.drpc.live/ethereum/${DRPC_API_KEY}`,
        `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
    ],
    BASE: [
        `https://lb.drpc.live/base/${DRPC_API_KEY}`,
        `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
    ],
    BASE_SEPOLIA: [ `https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}` ],
};
...
const url = rpcUrl || RPC_URLS[chain]?.[0];          // evmSetup
...
const urls = RPC_URLS[chain] || [];                  // evmRead
```
(Note the pre-existing array was already `[drpc, alchemy]` and was iterated in the failover loop; `BASE_SEPOLIA` had no drpc entry — only Alchemy.)

**After:**
```ts
// constants import + RPC_URLS map deleted
const NETWORK_CONFIG: Record<string, { chainId: number; name: string }> = {
    L1: { chainId: 1, name: "homestead" },
    L2: { chainId: 8453, name: "base" },
    L2_SEPOLIA: { chainId: 84532, name: "base-sepolia" },
};
const evmSetup = (contractAddress, abi, chain, rpcUrl?) => { const url = rpcUrl; ... };
// evmWrite gains rpc?: string  (throws if missing; singles, no failover)
// evmRead  gains rpcs?: string[];  const urls = rpcs || [];  if empty throw;
```
So `7cc1468` **removed the hardcoded array entirely** — the array now comes from the caller via `endpoints.rpcs`, and `evmRead` iterates the supplied array. This is the exact mechanism to replicate.

### Related commits (chronological / by topic)
- `a73d1af` "created monorepo" — introduced the original hardcoded `g.alchemy` + `lb.drpc` `RPC_URLS` in evm.ts / constants.
- `cdddec2` "swapped rpc to drpc .. and using vite + dotenv" (2026-06-08) — the original switch **to** DRPC (safe-app side: `lib/evm.ts`, `lib/protocol-integration.ts`; added `vite.config.ts` env loading).
- `302223c` "fix(actions): retry eth_call on transport failures and cap NAME() fan-out concurrency" (worktree `s2s-evm-rpc-retry`) — **added** an in-session retry loop (MAX_ATTEMPTS=3 × 2 URLs, backoff) + per-request 8s timeout + error classifier.
- `92d19b3` "fix(actions): remove in-session eth_call retry loop that blows Lit's 50-request budget" (2026-08-18) — **reverted** the retry portion of `302223c`; `evmRead` is back to a single fail-fast pass over the URL list, with the aggregated error. Kept the ~8s timeout. Removed the classifier + its tests.
- `ea73ccc` "fix(actions): retry-with-backoff on contenthash write receipt wait" (worktree `s2s-contenthash-receipt-fix`) — replaced `txResponse.wait(1)` with `waitForReceipt` polling (receipt-wait resilience, not provider failover).
- `39e0316` (merge PR #47) / `8e64d95` "fix(safe-app): wire endpoints.rpcs into bulkRender renderwithLitActions" (worktree `s2s-bulkrender-wire-rpcs`) — safe-app now builds `endpoints.rpcs` (single DRPC URL per chain) because `renderwithLitActions` throws `'endpoints.rpcs not wired'` otherwise (see `sequence.ts:~187`). `8e64d95` commit message details: "Build a single-URL-per-chain DRPC endpoints object from VITE_DRPC_API_KEY (same scheme as getRpcUrl in lib/evm.ts) and pass it as the 11th positional arg".

### Worktree COMMIT_EDITMSG files (rpcs-relevant)
- **`s2s-bulkrender-wire-rpcs`** (`8e64d95`): full message quoted above — documents that `renderwithLitActions` requires `_rpcs` and safe-app must supply `endpoints.rpcs` to avoid the throw.
- **`s2s-contenthash-receipt-fix`** (`ea73ccc`): documents the receipt-wait retry (single DRPC URL write path; `waitForReceipt` on null + transient transport error).
- **`s2s-evm-rpc-retry`** (`302223c`): full before/after of the now-reverted in-session retry — worth reading for how it *used* to retry before being replaced by the current fail-fast single pass.
- (Other RPC-related worktrees: `s2s-evm-update-null-provider` `a40dfbe`, `s2s-fix-null-provider-verify` `dbd0deb` — provider null-deref fixes on the write path; `s2s-fix-shim-rpc-hang-v2/v3` — Filecoin shim RPC hang handling, unrelated to the L1/L2 array.)

---

## 7. Tests validating the fallback

`protocol/actions/src/libs/evm.test.ts` — `describe('evmRead fail-fast (single pass, no in-session retry)')` (lines ~260-330). Uses fake ethers + per-URL contract classes to assert:
- **Fails over to the next URL within the single pass** (`'https://a.example'` throws → returns `'ok'` from `'https://b.example'`); asserts each URL attempted **exactly once** (`seenPerUrl` counts = 1 each) — i.e. no retry round.
- **Succeeds on the first URL** (single request, `contractCalls() === 1`).
- **Does NOT retry a single failure** — throws after exactly one attempt per URL (`contractCalls() === 1`).
- **Throws an aggregated error when EVERY URL fails** — `err.failures.length === 2` (one per URL), message contains both URLs.

Other coverage:
- `shared/src/rendering/sequence.test.ts` — orchestrator-level render retry / `renderwithLitActions` (validates `endpoints.rpcs`-wiring behavior; live tests need `MAINNET_RPC_URL`/`BASE_RPC_URL` → `chainReady`).
- `shared/src/rendering/action-io.test.ts` — schema validation of `endpoints.rpcs` (`z.array().min(1)`).
- `shared/src/rendering/fixtures/inputs.ts:29-32` — canonical fixtures: `L1: ['https://lb.drpc.live/ethereum/key']`, `L2: ['https://lb.drpc.live/base/key']`.
- `evm.test.ts:160-180` also covers the receipt-wait path using a DRPC transport error string (`missing response ... url="https://lb.drpc.live/base/<key>" ... SERVER_ERROR`).

---

## 8. Brain docs describing the drpc+alchemy decision (quotes)

### `brain/handoffs/handoff-actions-extract-constants.md` (2026-08-06) — the design rationale
> §1 Why: "Lit Actions are content-addressed and **public on IPFS**. `protocol/actions/src/libs/constants.ts` bakes live RPC keys (DRPC, Alchemy) ... **Correction to SPEC-00 GAP-9 (joera, 2026-08-06):** the spec's claim that *'Alchemy is dead (app deactivated, 403)'* is **no longer true.** Alchemy is live again and is a valid fallback. The fix is **not** to delete Alchemy — it is to stop hardcoding *either* key and instead accept an **array of RPC endpoints, agnostic to what's in it.** Current behaviour must reproduce with `[drpc, alchemy]`."

> §2: "`endpoints.rpcs: { L1: string[]; L2: string[] }` — per-chain ordered endpoint list (was `RPC_URLS`). Each entry is the **full endpoint URL including the key**, as a plain string ... **Array, agnostic** — `[drpc, alchemy]` today, anything tomorrow. `L1` = Ethereum mainnet, `L2` = Base (matches neutralpress `L1`/`L2` aliasing)."

> §3b: "`evm.ts` builds a static `RPC_URLS: Record<chain, string[]>` from the two imported keys and iterates it in `evmRead` (failover loop) / uses `[0]` in `evmWrite`."

> §4: "`evmRead(chain, ..., rpcs)` — add a final `rpcs: string[]` param ... Iterate **that** array in the failover loop instead of `RPC_URLS[chain]`." / "`evmWrite(..., rpc)` — add a `rpc: string` (single URL; writes don't failover). Use it instead of `RPC_URLS[chain]?.[0]`." / "(Co-fix GAP-15 ... distinguish transport/RPC failures → continue failover, from contract reverts → throw immediately ... Surface the real revert string, not a wrapped transport error.)"

### `brain/handoffs/handoff-actions-fixes-and-remove.md` (2026-08-06) — GAP-15 co-fix reverted
> §1 Symptom: "`getDeals` ... fails with `'missing response'` (empty HTTP body) from **both DRPC and Alchemy simultaneously**, but only when called 3+ times."
> §1 GAP-15 co-fix reverted: "The original catch-all (`continue` on any error) was temporarily replaced with a check that threw on `CALL_EXCEPTION`. Ethers v5 wraps transport `SERVER_ERROR` as `CALL_EXCEPTION` with `data="0x"`, so the first RPC failure immediately threw — never trying the second URL. Reverted to pure catch-all + continue. ... `evmRead` failover loop now collects all failures in `failures: string[]` and throws an aggregated Error with all URLs joined."

### `brain/specs/SPEC-protocol-actions.md`
- Line 58: "`libs/constants.ts` ... **gone** — extracted to action input `endpoints` 2026-08-07 (GAP-9 action-side resolved ...). `rpcs`/`gateway` now threaded through `evm.ts` / `ipfs.factory.ts` / etc."
- Line 506 (`evmRead` row): "catch-all failover: tries each URL in `rpcs[]`, collects every failure in `failures[]`, throws one aggregated `Error` (`.failures` attached) on total failure. No transport-vs-revert distinction (attempted & reverted — ethers v5 wraps `SERVER_ERROR` as `CALL_EXCEPTION`; see GAP-15)."
- Line 560: "`getDeals` (dynamic `tuple[]`) called 3+ times returned `'missing response'` (empty body) from both DRPC and Alchemy."
- Lines 599, 615-625: live `sequence.test.ts` is chain-ready-gated on `MAINNET_RPC_URL`/`BASE_RPC_URL` (add them to `.env` or tests silently skip).

---

## 9. How to replicate in s3ntiment (concrete pattern)

1. **Define the array as plain URL strings** per chain: `{ L1: string[], L2: string[] }`, ordered `[drpc, alchemy]`, each entry the full `https://lb.drpc.live/<chain>/<key>` / `https://<chain>-mainnet.g.alchemy.com/v2/<key>`.
2. **Build it at the caller boundary** from env/settings (keys only in env: `DRPC_API_KEY`, `ALCHEMY_KEY`; compose URLs — don't hardcode full auth URLs; the action-side bundle must be public-safe).
3. **Thread the array through the action/function input** as required (`endpoints.rpcs`), validated with `z.object({ L1: z.array(z.string()).min(1), L2: z.array(z.string()).min(1) })`.
4. **Fallback = per-call failover loop** over the array: for each URL build a fresh client (with a short per-request timeout ~8s), call, `return` on success, collect the failure, and on total failure throw one aggregated error with `.failures`. **Do NOT** in-session retry the same call (budget-request-sensitive) — if the environment counts HTTP requests (Lit's 50/session), prefer fail-fast + orchestrator re-run in a fresh budget.
5. **Writes**: single URL, no failover (never re-issue a tx against another provider). Add receipt-wait backoff separately if needed.
6. Replicate the GAP-15 gotcha: catching `CALL_EXCEPTION` "data=0x" / `SERVER_ERROR` and *throwing* breaks failover — use pure catch-all + continue so the next URL is tried.

---
*Audit by DeepSeek V4 Flash 0731 · read-only · no files modified (only wrote this report to `brain/audits/`).*
