# Trace: `eth_call` to `0x75cf1146...` with selector `0xa3f4df7e` during render+update (Bun runner)

Date: 2026-08-31 · Mode: READ-ONLY trace · No code changes, no PR.
Source of the observed log: user's preview run in the bun lit-action runner, 18:09 UTC.

---

## 1. Resolved call site (file:line)

The call is issued from the **action bundle** `protocol/actions/src/libs/ens.factory.ts`, inside the
`NAME()` probe loop, called by `getDomainOwnerAndModules` / `getProtocolControllerAndModules`.

- `protocol/actions/src/libs/ens.factory.ts:84` — `['function NAME() view returns (string)']` (in `getProtocolControllerAndModules`)
- `protocol/actions/src/libs/ens.factory.ts:152` — `evmRead('L2', addr, ['function NAME() view returns (string)'], 'NAME', [], rpcs?.L2)` (in `getDomainOwnerAndModules`, the exact line that produces the observed call)

Flow:
1. `getDomainOwnerAndModules(publication, rpcs)` calls `getModulesPaginated` on the publication Safe/multisig
   (`protocol/actions/src/libs/ens.factory.ts:118-131`), returning the list of enabled Safe modules.
2. It then probes **each** module address with `NAME()` to discover which are the S2S Records / Publication
   modules (`ens.factory.ts:134-156`, via `mapWithLimit` with `MAX_CONCURRENT_NAME_PROBES = 3`, line 17).
3. One of the enabled modules is the **Safe 4337 Module** at `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226`
   (the canonical `SAFE_4337_MODULE_ADDRESS`). Probing it with `NAME()` produces `eth_call` data `0xa3f4df7e`.

This is **NOT** in the host plugin (0xobsidian / neutralpress / safe-4337 account-prep / filecoin). It is in
the **action bundle**, which runs inside the Bun runner via `executeAction → main(params)`.

### Who calls it during this run (action flow)
The same function is invoked by every protocol action that resolves publication modules:
- `protocol/actions/src/render/main.ts:149` — render
- `protocol/actions/src/update/main.ts:63` — update
- `protocol/actions/src/prep/main.ts:52`
- `protocol/actions/src/maintain-cache/main.ts:74`
- `protocol/actions/src/render-dev/main.ts`

The observed run is render + update, so the probe fires in both actions. The confirmation that this runs in
the bun-runner action-execution path (Q4) is: `/app/server.ts` is `protocol/serverless/server.ts`
(`Lit.Actions` shim with `getPrivateKey` throwing at `server.ts:18`, `executeAction` at `server.ts:122`,
`app.post("/run")` handler at `server.ts:167`), which matches the stack trace excerpt
(`at getPrivateKey (/app/server.ts:18:44) … at async executeAction (/app/server.ts:122:24)`).

---

## 2. Selector resolution

`0xa3f4df7e` = **`NAME()`** — the legacy uppercase ERC-20 `name()` selector.

Verified against the live 4byte directory and OpenChain signature database:
- 4byte.directory `hex_signature=0xa3f4df7e` → `text_signature: "NAME()"`
- `api.openchain.xyz/lookup?function=0xa3f4df7e` → `"NAME()"`, `hasVerifiedContract: true`

It is **not** any function of the Safe4337Module or Safe core ABI — I enumerated every function in
`safe-4337-module.json` (v0.3.0) and `safe_implementation.abi.ts` and none produces `0xa3f4df7e`. The
target contract is identified by address, not by ABI; the app only supplies the 4-byte selector for the
generic `NAME()` string probe.

Why `0x75cf1146...` is on the module list: it is the canonical `SAFE_4337_MODULE_ADDRESS` for Safe 1.4.1 +
EntryPoint 0.7 (see `permissionless/accounts/safe/toSafeSmartAccount.ts:490,509` and
`@safe-global/safe-modules-deployments` `safe-4337-module/v0.3.0/safe-4337-module.json`, which lists chain
`8453` = Base). Because the publication Safe has the 4337 module enabled (for account abstraction), it is
returned by `getModulesPaginated` and swept up by the `NAME()` probe.

---

## 3. Why it reverts on both RPCs — and is it caught/benign?

**Why it reverts:** `NAME()` is not implemented by the Safe4337Module contract. The module (a Safe) has no
`NAME()` view and no fallback handler configured, so its guarded fallback reverts. Every `eth_call` returns
a revert, reported by the RPC wrapper as `missing revert data … code=CALL_EXCEPTION` (ethers v5 phrasing).

**Why you see both endpoints:** `evmRead` in `protocol/actions/src/libs/evm.ts` iterates the L2 RPC URL list
(drpc then alchemy) with failover, logging one line per URL on failure:
- `evm.ts:248` — `const msg = 'RPC call to ' + url + ' failed: ' + …; console.log(msg);`

So **one** reverting module produces **2** log lines (1 per RPC endpoint). The 4 logged lines =
2 probe passes (render + update, or render + retry) × 2 endpoints. This fully explains the repeated
drpc+alchemy pair in the excerpt.

**Is it caught / benign?** Yes — intentionally. The revert is swallowed at the call site:
- In `getProtocolControllerAndModules`: wrapped in try/catch, logs `Module <addr> has no NAME function` and skips (`ens.factory.ts:149-162`).
- In `getDomainOwnerAndModules`: `mapWithLimit` uses allSettled semantics; the rejected probe is skipped
  (`ens.factory.ts:134-156`). The S2S Records/Publication modules return `NAME()` successfully (e.g.
  `"S2S Records Module"`, `"S2S Publication Module V2"`), so the resolution is unaffected.

The `evmRead` per-URL "failed" logs are transport-level noise from the deliberately fail-fast reader
(`evm.ts:220-252`); they do not propagate up as a render/update failure.

**Verdict: NON-CONSEQUENTIAL.** The reverting `NAME()` probe of the Safe4337Module is expected, caught, and
has zero effect on module resolution, render output, or update. It is host/chain behavior, not a bug.

---

## 4. Confirm: these calls run inside the bun-runner action flow

Yes. They are part of the **action bundle** execution inside the Bun runner:
- `getDomainOwnerAndModules` is imported and awaited inside each action's `main()` (render/main.ts:149,
  update/main.ts:63, etc.).
- The Bun runner `protocol/serverless/server.ts` executes the action via `executeAction` (line ~122) → the
  bundle's `main()`, exactly the stack shown in the log.
- Not a browser-side process and not an unrelated background process — it is `evmRead` issued synchronously
  within `main()` while resolving publication modules.

---

## 5. Connection to cache / signing shim / preview

**Not connected.** Three independent facts:

1. **Reverting `NAME()` probe** (this trace) — benign, allSettled-skipped, unrelated to signing or cache.
2. **`Signing skipped (preview or shim)` / `error: signing disabled`** — emitted at
   `protocol/actions/src/render/metadata.ts:170` when `Lit.Actions.getPrivateKey(...)` throws. In the Bun
   runner, the shim at `protocol/serverless/server.ts:18` (`getPrivateKey: async () => { throw new Error("signing disabled") }`)
   makes this throw, so the render embeds the schema without a `proof`. This is preview/shim-only behavior —
   with a real Lit node it would sign. It is independent of the `NAME()` reverts.
3. **Cache maintenance not happening** — `maintain-cache/main.ts` and `update/main.ts` both call
   `getDomainOwnerAndModules` (which does the reverting probes) and are NOT blocked by them. The on-chain
   write that persists the cache pointer / `contenthash_wrapped` record is gated by `if (!preview)`:
   `update/main.ts:313` (`if (!preview) { … evmWrite … }`) and `maintain-cache/main.ts:~` (publish gate
   `if (!preview)`). In a preview/shim run the write path that requires the PKP signing key is skipped —
   that (not the `NAME()` revert) is why the cache pointer isn't advanced on-chain.

In short: none of the reverting `NAME()` calls touch signing or cache maintenance. The cache/pointer work
being skipped is explained by the preview/shim signing shim, which is a separate concern from these RPC
calls.

---

## Supporting evidence (address/selector provenance)

- Selector `0xa3f4df7e` = `NAME()` (4byte.directory id 9232; openchain confirmed, verified-contract).
- Address `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226` = `SAFE_4337_MODULE_ADDRESS`:
  - `node_modules/…/permissionless/accounts/safe/toSafeSmartAccount.ts:490,509`
  - `node_modules/…/@safe-global/safe-modules-deployments/…/safe-4337-module/v0.3.0/safe-4337-module.json` (includes chain 8453 / Base)
  - same constant also in `@safe-global/relay-kit` fixtures and `0xobsidian/out/main.js:182643,182655`
- Call site: `protocol/actions/src/libs/ens.factory.ts:152` (probe) / `:84` (first variant)
- Callers in action flow: `render/main.ts:149`, `update/main.ts:63`, `prep/main.ts:52`, `maintain-cache/main.ts:74`
- RPC failover + log format: `protocol/actions/src/libs/evm.ts:220-252` (`evmRead`, per-URL `console.log`)
- Bun runner / shim: `protocol/serverless/server.ts:18` (`getPrivateKey` throws), `:122` (`executeAction`), `:167` (`/run`)
- Signing skip: `protocol/actions/src/render/metadata.ts:170`
- Preview-gated on-chain write: `update/main.ts:313`, `maintain-cache/main.ts`
- The same probe/selector is present in the built bundles: `protocol/actions/dist/render/main.js`,
  `dist/update/main.js`, `dist/prep/main.js`, `dist/maintain-cache/main.js`, `dist/render-dev/main.js`
  (all contain the `NAME()` / `getModulesPaginated` probe), and `dist/render/main.js:6725` carries the
  "Signing skipped (preview or shim)" string.

---

## Bottom line

The `0xa3f4df7e` (`NAME()`) calls to `0x75cf1146...` (Safe 4337 Module) are **expected, benign,
action-bundle probe traffic** from `ens.factory.ts`'s module-discovery loop, running inside the Bun
runner's `executeAction → main()` path. They revert because the Safe4337Module implements no `NAME()`,
are allSettled/try-catch swallowed at the call site, and are **not connected** to the signing-skip shim or
to cache maintenance not running. No code change is warranted for this.
