# CHAIN-SECURED WORKLOG

**Branch:** `lit-chain-secured-reprovision`
**Author:** DeepSeek V4 Flash 0731
**Started:** 2026-10-05

## Progress

- [x] 2026-10-05 — Read research: `lit-chain-secured-reprovision-2026-10-05.md`,
      `repo-current-provisioning-2026-10-05.md`; reference
      `/tmp/litresearch/chipotle` (`WritesFacet.sol`, `core_sdk.js`,
      `tx_lifecycle.js`, `account_config_full_abi.js`, `account_config_view_abi.js`,
      `AppStorage.sol`, `ViewsFacet.sol`); repo files to replace
      (`deploy-group.ts`, `swap-action.ts`, `add-action.ts`, `add-dev-action.ts`,
      `update-protocol.ts`, `config.json`, `lit.service.ts`, `shared/src/protocol/index.ts`,
      root `package.json`, `shared/package.json`, vitest config).
- [x] 2026-10-05 — VERIFIED (read-only, pure-keccak implementation) that
      `actionHash = keccak256(toBytes(cid))` reproduces all 5 pinned
      `config.json` hashedCids, and `adminHash(safe) = keccak256(toBytes(getAddress(safe)))`
      = `0x11adab45e07d6dd847846fd13be95947bf24119ebfdae77f91d6598dbed69760`.
- [x] 2026-10-05 — Decided module approach: NEW `shared/src/lit/chain-secured.ts`
      (NOT extending `lit.service.ts`); exposed via new `@s2s/soul2soul-shared/chain-secured`
      subpath so safe-app builds are untouched. Root index deliberately unchanged.
- [x] 2026-10-05 — Wrote `README.md` (branch name + manifest + runbook + dry-run).
- [x] 2026-10-05 — `shared/src/lit/chain-secured.ts` (sovereign client module).
- [x] 2026-10-05 — `shared/src/lit/__tests__/chain-secured.test.ts` (verified vectors).
- [x] 2026-10-05 — `protocol/scripts/lit/deploy-group.ts` (chain-secured provision +
      `--finalize` reading the ACTUAL group id from the `GroupAdded` receipt).
- [x] 2026-10-05 — `protocol/scripts/lit/swap-action.ts` (chain-secured swap).
- [x] 2026-10-05 — `protocol/scripts/lit/add-action.ts` (chain-secured add).
- [x] 2026-10-05 — `protocol/scripts/lit/add-dev-action.ts` (dev-action uploader,
      no Lit registration, dry-run support).
- [x] 2026-10-05 — `shared/package.json` (added `@safe-global/api-kit` +
      `@safe-global/protocol-kit` deps and the `./chain-secured` subpath export).

## Conflict note — parallel writer (IMPORTANT)

Mid-build, a parallel builder overwrote `shared/src/lit/chain-secured.ts` and
`shared/src/lit/__tests__/chain-secured.test.ts` with an INCOMPATIBLE and
INCOMPLETE API (positional encoders, `bigint`-returning `adminHash`/`actionHash`,
and NO `proposeToSafe`, no receipt finalize, no config helpers). It also dropped
`protocol/scripts/lit/safe-client.ts` and modified `shared/src/lit/index.ts`.

Resolution (final, authoritative):

- Restored MY `chain-secured.ts` (object-param encoders, `Hex` returns,
  full `proposeToSafe` / `readExecutedGroupId` / `predictNextGroupId` /
  `isActionInGroup` / config + env helpers) and MY test file, which the four
  scripts are written against.
- Removed the orphaned `protocol/scripts/lit/safe-client.ts` (nothing imports it;
  it referenced the other API's `describeBatch` and would not compile).
- Reverted `shared/src/lit/index.ts` to the ORIGINAL two-line content (no root
  re-export of chain-secured) — safe-app imports the package root but does not
  depend on `@safe-global`, so root re-export would break its Vite build. The
  sovereign module is reached ONLY via `@s2s/soul2soul-shared/chain-secured`.

## Design notes / decisions

1. **Fresh account group ids start at 1** (verified WritesFacet: `addGroup` does
   `account.groupCount++` and returns it; `groupCount` starts at 0). `deploy-group.ts`
   predicts the next id via `listGroups` (max id + 1), binds addActionToGroup /
   addPkpToGroup / setUsageApiKey in the SAME batch, and the ACTUAL id is read
   from the `GroupAdded` receipt at finalize (never hardcoded). If the prediction
   is wrong the Safe batch reverts atomically (nothing persists) — operator
   re-runs, which mints a fresh PKP/usage key (both cheap to re-mint).
2. **`prepare_wallet` is not idempotent** — called exactly once per real run;
   the returned `derivation_path` is passed VERBATIM (0x hex) to
   `registerWalletDerivation`; only `pkps[0]` (address) persists to config.json.
3. **Usage key** — 32 CSPRNG bytes, `'lk_' + 2-digit-0-padded lowercase hex`;
   only `keccak256(utf8(key))` goes on-chain (`setUsageApiKey`); cleartext saved
   to config.json + printed for `.env` (`VITE_LIT_USAGE_KEY`).
4. **Safe propose** mirrors `update-protocol.ts` exactly: protocol-kit
   `Safe.init({provider, signer, safeAddress})` + `createTransaction` +
   `signHash`, api-kit `proposeTransaction`, chainId `8453n`; senderAddress is the
   Safe OWNER EOA from `privateKeyToAccount(PROTOCOL_PRIVATE_KEY)`.
5. **@safe-global deps moved into `shared/package.json`** (same versions as
   protocol) so the subpath module resolves at runtime; requires one
   `pnpm install` (lockfile regen). Root index is NOT re-exported.
6. **Dry-run** (`LIT_DRY_RUN=1` / `--dry-run`): builds full batch, pretty-prints
   each `{to,value,data}` with decoded function+args, prints `dry-run: would mint`,
   stops before propose and before `prepare_wallet`.
7. `swap-action.ts` only issues `removeActionFromGroup(old)` after a best-effort
   `listActionsInGroup` membership check (it reverts if absent) and `removeAction(old)`
   is safe unconditionally (never reverts for an absent hash).

## Verification

- All 6 TS files pass a char-by-char delimiter balance check (0 mismatches).
- Scripts' `@s2s/soul2soul-shared/chain-secured` imports all resolve against the
  module's exports (24/24, 18/18, 15/15).
- Hash vectors independently verified with a pure keccak256 implementation
  (actionHash × 5 pinned CIDs, adminHash for the Safe).

## Secrets

No secrets committed. Env var names only. Usage key minted at runtime, printed
once, persisted to config.json (matching existing repo practice for `usage_key`).
