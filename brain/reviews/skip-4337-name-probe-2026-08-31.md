# Review: skip NAME() probe for known Safe 4337 module

- Date: 2026-08-31
- Branch: `fix/skip-4337-name-probe` (base `main`)
- Commit: `97ad7b1d1f776b7aecfd3517f8c20c0141b44553`
- PR: https://github.com/Joera/S2S-monorepo/pull/76 (base `main`, head `fix/skip-4337-name-probe`, NOT merged)

## Context / why

A read-only RPC trace (`brain/reviews/trace-rpc-0xa3f4df7e-2026-08-31.md`) established that
every protocol action (render, update, prep, maintain-cache, render-dev) issues `NAME()`
eth_call probes (selector `0xa3f4df7e`) against EVERY module returned by
`getModulesPaginated` on the publication Safe, to discover which are the S2S Records /
Publication modules. One of those enabled modules is the canonical Safe 4337 Module at
`0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226` (`SAFE_4337_MODULE_ADDRESS`, Safe 1.4.1 +
EntryPoint 0.7 on Base 8453).

That module never implements `NAME()`, so every probe reverts and the `evmRead` failover logs
it once per RPC URL (drpc + alchemy = 2 extra lines), burning 2 RPC requests per action
against Lit's hard 50-requests-per-session cap. Since this address can never be an S2S
module, probing it is pure waste. We skip the probe.

## What changed

File: `protocol/actions/src/libs/ens.factory.ts`

- Added `KNOWN_NON_S2S_MODULES: string[]` containing
  `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226`, with a provenance comment (canonical
  `SAFE_4337_MODULE_ADDRESS` per @safe-global/safe-modules-deployments safe-4337-module/v0.3.0
  and permissionless `toSafeSmartAccount.ts`).
- Added `isKnownNonS2SModule(address)` which compares canonically (lowercase) so a
  lower/checksum-case mismatch can't defeat the filter.
- `getProtocolControllerAndModules` (the `NAME()` probe loop): `continue`s for addresses in
  the known set — the probe is never issued for them.
- `getDomainOwnerAndModules` (the `mapWithLimit` `NAME()` loop,
  `MAX_CONCURRENT_NAME_PROBES = 3`): filters the module list into `probeableModules`
  (excluding the known address) before `mapWithLimit`, and iterates/assigns from
  `probeableModules` so the index mapping stays aligned.

The module is still treated as present in the Safe's module list conceptually; we just never
issue a `NAME()` evmRead for it. Behavior for all other modules is unchanged (still probed).

New test: `protocol/actions/src/libs/ens.factory.test.ts` (mocks `./evm`'s `evmRead`, records
every `NAME()`-targeted contract address, and asserts the 4337 module is never probed in both
discovery paths while other module addresses still are, including a lowercase variant to cover
canonical comparison).

## Test proof

`protocol/actions/src/libs/ens.factory.test.ts` — 4 tests, all passing:

- `getProtocolControllerAndModules — skips NAME() probe for the Safe 4337 module`
  - `never probes the 4337 module while still probing other modules`
  - `skips a lowercased 4337 address too (canonical comparison)`
- `getDomainOwnerAndModules — skips NAME() probe for the Safe 4337 module`
  - `never probes the 4337 module while still probing records, publication and no-NAME modules`
  - `skips the 4337 module when it is the only module (empty name probe set)`

These assert that `state.nameProbes` contains exactly the non-4337 modules (and not the 4337
address) in both `getProtocolControllerAndModules` and `getDomainOwnerAndModules`.

## Gate outputs

1. **Bundle build** — `pnpm actions:build` → **EXIT 0**. Emitted
   `protocol/actions/dist/render/main.js`, `render-dev/main.js`, `update/main.js`,
   `prep/main.js`, `maintain-cache/main.js`. The known address constant is present in the
   built bundle (`protocol/actions/dist/render/main.js`).
2. **Protocol actions test suite** — `pnpm exec vitest run --config protocol/vitest.config.ts`
   (run from `protocol/`) → **14 files passed (14), 168 tests passed (168)**, 0 failed
   (includes the 4 new tests).
3. **prettier** — `pnpm exec prettier --check` on the two touched files → **clean** ("All
   matched files use Prettier code style!").

KNOWN-FALSE gate: eslint/tsc on `protocol/actions/src` — repo-wide known false negative (src
isn't in any tsconfig; eslint always errors there). Not chased, per instructions.

## Deliverable status

- [x] Commit on `fix/skip-4337-name-probe`: `97ad7b1`
- [x] Pushed to `origin/fix/skip-4337-name-probe`
- [x] PR #76 opened: `perf(actions): skip NAME() probe for known Safe 4337 module`
      (base `main`, head `fix/skip-4337-name-probe`). NOT merged.
