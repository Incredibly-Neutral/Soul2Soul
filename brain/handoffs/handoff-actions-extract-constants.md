# Handoff: extract constants out of the Lit Actions (`protocol/actions/src`)

**Date:** 2026-08-06
**Scope:** Make the three Lit Actions (prep / render / update) **parameterized** — accept IPFS gateway + RPC endpoints as action **input** instead of importing them from `constants.ts`. **Investigation only — no code touched.** Ready for implementation.
**Status:** Design agreed with joera. The *source* of these values (caller vs. on-chain records) is **deliberately deferred** — this handoff only extracts them from the open-source bundle and threads them through input. Source wiring is a separate, later piece.

---

## 1. Why

Lit Actions are content-addressed and **public on IPFS**. `protocol/actions/src/libs/constants.ts` bakes live RPC keys (DRPC, Alchemy) and a Kubo gateway URL into that public bundle. Secrets in public immutable source is the leak (SPEC-00 GAP-9); the gateway URL is a single-source violation (SPEC-00 §0 — three+ copies of the same `IPFS_URL`).

**Correction to SPEC-00 GAP-9 (joera, 2026-08-06):** the spec's claim that *"Alchemy is dead (app deactivated, 403)"* is **no longer true.** Alchemy is live again and is a valid fallback. The fix is **not** to delete Alchemy — it is to stop hardcoding *either* key and instead accept an **array of RPC endpoints, agnostic to what's in it.** Current behaviour must reproduce with `[drpc, alchemy]`. Update GAP-9 + GAP-15 wording accordingly when the specs are next touched.

## 2. Design principle (source-agnostic)

The action does not care **where** the gateway/RPCs come from. It only requires them in its input. This unblocks the extraction immediately and leaves the source decision (caller session vs. protocol records vs. publication records — the thread from 2026-08-06) as a later wiring change on the **caller/orchestrator side**, with no further action-side edit.

Two input fields are added to every action input:
- `endpoints.ipfsGateway: string` — the Kubo gateway URL (was `IPFS_URL`).
- `endpoints.rpcs: { L1: string[]; L2: string[] }` — per-chain ordered endpoint list (was `RPC_URLS`). Each entry is the **full endpoint URL including the key**, as a plain string (e.g. `"https://lb.drpc.live/base/<key>"`); the action is agnostic to what's in it. **Array, agnostic** — `[drpc, alchemy]` today, anything tomorrow. `L1` = Ethereum mainnet, `L2` = Base (matches neutralpress `L1`/`L2` aliasing).

`ipfsGateway` is **optional with fallback** to `protocolInfo.gateway` (the on-chain `data_gateway` record, INV-2 — already resolved in-action by `getProtocolInfo`). This gives the future publication-records override a hook without forcing every caller to pass it today. `rpcs` has no on-chain fallback yet → **required** (until a protocol `rpc_base` record exists).

## 3. The constant surface (enumerated — what to remove/replace)

### 3a. `IPFS_URL` — FOUR declaration sites (single-source violation)

| # | File | Form | Consumers |
|---|---|---|---|
| 1 | `libs/constants.ts` | `export const IPFS_URL = "https://ipfs.transport-union.dev"` | imported by `libs/ipfs.factory.ts` |
| 2 | `renderer/constants.ts` | same string, redeclared | imported by `renderer/html.ctrlr.ts` |
| 3 | `update/main.ts` | `const IPFS_URL = "..."` local redeclare | ~15 MFS ops in `main()` |
| 4 | `renderer/handlebars.factory.ts` | **hardcoded inline** in `processPartials`: `fetch(\`https://ipfs.transport-union.dev/api/v0/cat?arg=${partial.cid}\`)` | partial-content fetch |

All four become the same input-supplied `gateway` string.

### 3b. RPC keys — `ALCHEMY_KEY` + `DRPC_API_KEY` → `RPC_URLS` in `libs/evm.ts`

`evm.ts` builds a static `RPC_URLS: Record<chain, string[]>` from the two imported keys and iterates it in `evmRead` (failover loop) / uses `[0]` in `evmWrite`. Both keys come from `constants.ts`. Replaced by the input-supplied `rpcs` map.

### 3c. Pinata keys — **DEAD in the action path. Delete, no parameter.**

`PINATA_API_KEY` / `PINATA_SECRET_API_KEY` are declared in `constants.ts` but **never imported anywhere in `actions/src/`** (verified: zero references in the action region; all Pinata usage is in neutralpress / shared / safe-app, client-side). SPEC-00 §3.2 confirms *"Lit actions are Kubo-only."* Just delete the two lines. No input field, no threading.

### 3d. Other `constants.ts` lines

The commented-out Lens/PKP-era constants at the top of `constants.ts` are already dead (GAP-10/GAP-11). The whole file can be **deleted** once 3a/3b/3c are extracted.

## 4. Exact change points (action-side)

### `libs/evm.ts` (RPC)
- Remove `import { ALCHEMY_KEY, DRPC_API_KEY } from "./constants"`.
- Remove the static `RPC_URLS` map. Rename `NETWORK_CONFIG` keys: `ETHEREUM`→`L1`, `BASE`→`L2` (drop or rename `BASE_SEPOLIA`→`L2_SEPOLIA` if kept).
- **Chain-label sweep (mechanical, in lockstep with the input keys):** every `evmRead("BASE", …)` / `evmRead('ETHEREUM', …)` / `evmWrite("BASE", …)` call site becomes `"L2"` / `"L1"`. Touches `gates.ts`, `ens.factory.ts`, `protocol.factory.ts`, `module.factory.ts`, `config.ctrl.ts`, `update/main.ts` (~12 sites).
- `evmSetup` already accepts an optional `rpcUrl` — keep.
- `evmRead(chain, contractAddress, abi, method, args, rpcs)` — add a final `rpcs: string[]` param (the per-chain array, already keyed out by the caller). Iterate **that** array in the failover loop instead of `RPC_URLS[chain]`. `chain` now only indexes `NETWORK_CONFIG`.
- `evmWrite(chain, pkp, contractAddress, abi, method, args, confirm, rpc)` — add a `rpc: string` (single URL; writes don't failover). Use it instead of `RPC_URLS[chain]?.[0]`.
- **Co-fix GAP-15 (recommended, same edit):** in the `evmRead` failover loop, tag each error with its provider and distinguish **transport/RPC failures** (`error.code === "SERVER_ERROR"` / `error.status` / HTTP-level) → continue failover, from **contract reverts** (`error.reason` present / `CALL_EXCEPTION`) → throw immediately (every provider reverts identically; failover is pointless and currently masks the real reason). Surface the real revert string, not a wrapped transport error.

### `libs/ipfs.factory.ts` (gateway)
- Remove `import { IPFS_URL } from "./constants"`.
- `catFile(gateway, cid)`, `uploadFile(gateway, output)`, `getDag(gateway, cid)`, `putDag(gateway, dag)` — add `gateway: string` as the **first** param, replace `${IPFS_URL}` with `${gateway}`. (`createUnixFSFromCbor(dag, gateway)` already takes `gateway` — no change there.)
- `getPublicationConfig(gateway, configCid)` — same.
- `contenthashToIPFS` — pure, no change.

### `renderer/html.ctrlr.ts` (gateway)
- Remove `import { IPFS_URL } from "./constants"` (the `renderer/constants` one).
- `renderHTML(config, templateConfig, templateData, gateway)` — add `gateway: string` param; use it in the two `fetch` calls (dag/get + cat).
- Delete `renderer/constants.ts` (its only export was `IPFS_URL`).

### `renderer/handlebars.factory.ts` (gateway)
- `processPartials` currently hardcodes `https://ipfs.transport-union.dev` inline for the partial-content fetch. Thread `gateway` through `processPartials(... , gateway)` and `processTemplate(... , gateway)` (whichever call path reaches the fetch). Replace the inline URL.

### `update/main.ts` (gateway + RPC)
- Remove the local `const IPFS_URL = "..."`.
- Read `input.endpoints.ipfsGateway` (fallback `protocolInfo.gateway`) and `input.endpoints.rpcs` at the top of `main()`.
- Replace every `${IPFS_URL}` with the resolved `gateway` local. (~15 MFS ops: cp, mkdir, stat, rm, pin/add, ls.)
- Thread `rpcs`/`rpc` into every `evmRead`/`evmWrite` call: `canPublish` (via gates), `getProtocolInfo` (via protocol.factory), `getDomainOwnerAndModules` (via ens.factory), `getConfig` (via config.ctrl), the `getText` prev-contenthash read, the `setText` write.

### `render/main.ts` (gateway + RPC)
- Read `input.endpoints` at the top.
- Thread `gateway` into `fetchById`/`fetchByPublication` (module.factory → catFile), `getConfig` (catFile), `fetchCollections` (catFile), `renderHTML` (html.ctrlr), `initTemplateData` (no fetch, but receives gateway for templateData — already sets `templateData.gateway = protocolInfo.gateway`; reconcile with the input field).
- Thread `rpcs` into `getProtocolInfo`, `getDomainOwnerAndModules`, `getConfig` (evmRead fallback), `canPublish`/`canRead` (gates), `decrypt` (gates via canRead).

### `prep/main.ts` (gateway + RPC)
- Read `input.endpoints`.
- Thread `gateway` into `getConfig` (catFile), `fetchById`/`fetchByPublication` (catFile).
- Thread `rpcs` into `getDomainOwnerAndModules`, `getConfig` (evmRead fallback).

### Threading helpers that gain a `rpcs`/`gateway` param
These currently call `evmRead`/`catFile` internally and must forward the new param:
- `libs/gates.ts` — `canRead(..., rpcs)`, `canPublish(..., rpcs)`, `extractSignerAddress` (pure, no change).
- `libs/ens.factory.ts` — `getProtocolControllerAndModules(rpcs)`, `getDomainOwnerAndModules(publication, rpcs)`.
- `libs/protocol.factory.ts` — `getProtocolInfo(dev, rpcs)`.
- `libs/module.factory.ts` — `getLatestEntry(..., rpcs, gateway)`, `getDeals(..., rpcs, gateway)`, `fetchById(..., rpcs, gateway)`, `fetchByPublication(..., rpcs, gateway)`. (Note `catFile` now needs `gateway`, so the `fetchById`/`fetchByPublication` wrappers must receive and forward it.)
- `libs/decrypt.ts` — `decrypt(..., rpcs)` (forwards to `canRead`).
- `render/config.ctrl.ts` — `getConfig(configCid, configModule, rpcs, gateway)` (forwards to `evmRead` fallback + `catFile`). `getTaskConfig` is pure.
- `render/data.ctrlr.ts` — `initTemplateData(..., gateway)`, `fetchCollections(..., rpcs, gateway)`, `pathsForCollections` (pure). `mergeDecrypted` (pure).

Parameter order convention: put `rpcs` / `gateway` **last** in helper signatures to minimize churn, OR first for visibility — pick one and stay consistent. (Recommendation: last; matches `createUnixFSFromCbor(dag, gateway)` precedent.)

## 5. Input shape changes (shared — `@s2s/soul2soul-shared`)

### `shared/src/lit/actions/types.ts`
Add to **all three** input interfaces (`PrepInput`, `SingleInput`, `EvmUpdateInput`):
```ts
endpoints: {
  ipfsGateway?: string;                    // optional; falls back to protocolInfo.gateway
  rpcs: { L1: string[]; L2: string[] };    // required; full URLs incl key, ordered, agnostic
};
```
(`L1` = Ethereum mainnet, `L2` = Base. Chain labels are `L1`/`L2`, not the old `ETHEREUM`/`BASE` — see §4 chain-label sweep.)

### `shared/src/rendering/action-io.ts` (zod schemas)
Mirror the above in `PrepActionInputSchema`, `SingleActionInputSchema`, `EvmUpdateActionInputSchema`. Keep the compile-time sentinels (`_AssertSingleInputMatches` etc.) green — they force interface↔schema sync, so editing one flags the other.

### In-action backstop
Each `main.ts`'s `requireFields(input, [...])` call: add `'endpoints'` to the required list. `requireFields<T>` is generic over keys, so this just works. (Keep this tiny dependency-free assert as the INV-7 backstop; zod stays client-side only.)

## 6. Orchestrator wiring — **source deferred (marked TODO)**

`shared/src/rendering/sequence.ts :: renderwithLitActions` must populate `endpoints` and pass it into the prep / single / update inputs it builds. **Where it gets the values is out of scope for this handoff** (joera's call: 2026-08-06 thread leans toward publication records, deferred). For now:
- `ipfsGateway`: pass `undefined` (let the action fall back to `protocolInfo.gateway`, which the orchestrator already has).
- `rpcs`: **TODO — wire from the agreed source.** Leave a clearly-marked placeholder + a throw if unset, so it can't silently ship empty. The orchestrator has access to the oxo session (`main.oxo.ctrlr` / `S2SSignerSecrets.rpc`) and will later read from records; either way it must produce a non-empty `rpcs` before dispatch.

The preview path (Bun runner, `protocol/serverless`) already parameterizes `IPFS_URL` via `process.env.IPFS_URL` — confirm the shim passes `endpoints` through identically to real Lit (INV-7 parity).

## 7. Invariants to preserve (do NOT break)

- **INV-7 (runtime-agnostic + zod-free bundle):** the new fields live in `action-io.ts` (zod, client-side) + `types.ts` (interface, bundled). The in-action backstop is `requireFields` only. **Verify no import path from `@s2s/soul2soul-shared/lit-actions` reaches zod, even transitively** through the new schema (OPEN-TASK-3 caveat). Build the bundle (`protocol/scripts/lit/build-actions.cjs`) and grep the output for `zod` before declaring done.
- **INV-1 / INV-9 are invariants, not constants:** `"lit actions auth"` (INV-1) and `8453` / `did:pkh:eip155:8453` (INV-9) stay hardcoded where they are. Do **not** sweep them into `endpoints`. They are not transport.
- **INV-2 (record keys):** unchanged by this. The fallback `protocolInfo.gateway` reads the existing `data_gateway` record — no new record needed for the IPFS side. (A future protocol `rpc_base` record would let `rpcs` become optional too, but that's the deferred source work, not this handoff.)
- **INV-8 (action redeploy):** this change **does** change action source → requires the full `build-actions` → `swap-action` (Lit group) → `update-protocol` (records) sequence. The whole point is that it's the **last** time secrets force a redeploy — afterwards, key rotation is caller/records-side, no CID churn.

## 8. Verification checklist

- [ ] `grep -rn "transport-union.dev\|drpc\|alchemy\|PINATA" protocol/actions/src` returns **zero** hits in shipped (non-comment) code.
- [ ] `grep -rn "from.*constants" protocol/actions/src` returns zero (file deleted).
- [ ] `renderer/constants.ts` deleted; `libs/constants.ts` deleted.
- [ ] Built bundle (`protocol/actions/dist/*/main.js`) contains no literal gateway URL or RPC key.
- [ ] `requireFields` in all three `main.ts` requires `endpoints`.
- [ ] `_AssertSingleInputMatches` / `_AssertEvmUpdateInputMatches` sentinels compile.
- [ ] Preview (Bun runner) and prod (Lit) both receive `endpoints` — INV-7 parity.
- [ ] Live render with `rpcs = { L1: [drpc, alchemy], L2: [drpc, alchemy] }` reproduces current behaviour (GAP-9 correction: both live).
- [ ] A deliberately-bad first RPC fails over to the second (GAP-15 co-fix); a real contract revert surfaces its reason string, not a wrapped transport error.
- [ ] Update SPEC-00 GAP-9 + GAP-15 wording: Alchemy is **not** deprecated; the fix is array-agnostic input, not deletion.

## 9. Out of scope (deferred — separate handoffs)

- **Source of `endpoints`** (caller session `S2SSignerSecrets.rpc` vs. protocol `rpc_base` record vs. publication records). The 2026-08-06 thread favours **publication records** (`getPublicationEndpoints` mirroring `getProtocolInfo`, with protocol fallback) — but that's a records-side + invariant (INV-2b) change, not an action-side one. The action is already source-agnostic after this handoff, so the source decision adds zero further action edits.
- **Gate-RPC trust rule:** if `rpcs` becomes publication-supplied in future, gates (`canPublish`/`canRead`/`hasDeal`) must read via a **trusted** (protocol) RPC, not the publication's, to prevent a lying RPC misleading the PKP's branching. Pin in the future INV-2b. Not actionable now (today `rpcs` is one caller-supplied set used everywhere).
- **Lit wrapped key** for true secret secrecy (on-chain records are public reads; caller session isn't secret either). Bigger lift; queued.
- **`Metered<T>` extension:** do **not** type `endpoints` as `Metered<...>`. `Metered<T>` is an author-session (BYOK↔subscription) concept; publication/protocol transport is owner-set by definition. Leave as plain fields.

---

*Investigation source: `repomix-output.xml` (2026-08-06) + SPEC-00 (audited 2026-08-03). No code modified.*
