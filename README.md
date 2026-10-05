# Chain-Secured (Sovereign) Lit Re-provision — Staging Deliverable

**Branch:** `s2s/lit-chain-secured-reprovision`
**Date:** 2026-10-05
**Scope:** Re-provision the s2s Lit group / PKP / usage key / actions as a **Chain-Secured** account whose on-chain admin is the Gnosis Safe `0x24936f87442673B7c057BF3f5dCCB726baF20c6B` (Base mainnet, chain 8453). Every admin write is a Safe-signed batch against the AccountConfig diamond `0xaaaaa9120fe271f653cfdb6bf400db93d2dea7aa` — **no account API key, no `LIT_ACCOUNT_KEY`**.
**Method:** File-authoring only. Nothing was executed: no git, no live-repo edits, no script runs, no Safe proposal, no `prepare_wallet`.

---

## 1. Module approach chosen

We chose a **new sibling module** `shared/src/lit/chain-secured.ts` over editing `shared/src/lit/lit.service.ts`. Rationale:

- `LitService` is the API-mode client (`X-Api-Key`). Chain-Secured mode has no API key at all — admin writes are **Safe-signed on-chain txs**. Gluing that into `LitService` would entangle two auth models.
- The new module is **self-contained and API-mode-agnostic**; `lit.service.ts` is left untouched (API-mode intact).
- Dependency boundary: `chain-secured.ts` imports **only `viem`** (already a `shared` dependency) so the shared package builds and unit-tests in isolation. The Safe-kit plumbing (`@safe-global/*` are **protocol** deps, not resolvable from `shared/node_modules`) lives in a small protocol-side helper `protocol/scripts/lit/safe-client.ts` that mirrors `update-protocol.ts`'s `proposeToSafe` verbatim.

## 2. Per-file manifest

All paths are under the staging dir and mirror the repo path 1:1. Orchestrator copies each onto the same path in the repo.

| # | Staging file → repo target | Type | Purpose |
| - | - | - | - |
| 1 | `shared/src/lit/chain-secured.ts` | NEW | Sovereign module: `adminHash`, `actionHash`, WritesFacet ABIs (8 fns), encoders, `buildSafeBatch`, `decodeEntry`/`describeBatch`, `prepareWallet` (no-auth fetch), `generateUsageKey`, `computeActionCid`, `verifyAccountChainSecured`, `getGroupCount`, event ABIs + `extractGroupAdded`. |
| 2 | `shared/src/lit/__tests__/chain-secured.test.ts` | NEW | Unit tests incl. the verified encrypt/adminHash vectors, usage-key format, `setUsageApiKey` arg encoding, `buildSafeBatch` shape. |
| 3 | `shared/src/lit/index.ts` | COMPANION (edit) | Add `export * from './chain-secured';` so `@s2s/soul2soul-shared` exposes the module (required for the scripts' package imports). |
| 4 | `protocol/scripts/lit/safe-client.ts` | NEW | `proposeToSafe(account, transactions)` (mirrors `update-protocol.ts`) + `proposeOrDryRun` dry-run gate. Lives in `protocol` because `@safe-global/protocol-kit`/`api-kit`/`types-kit` are protocol deps. |
| 5 | `protocol/scripts/lit/deploy-group.ts` | FULL REPLACEMENT | Script A: chain-secured verify → `prepare_wallet` → usage key → predict group id → build+propose full Safe batch → `--sync` reads the real `addGroup` receipt + writes `config.json` → .env instructions. |
| 6 | `protocol/scripts/lit/swap-action.ts` | FULL REPLACEMENT | Chain-secured remove-old + add-new against existing group from `config.json`; updates `config.json`; reminds `update-protocol`. |
| 7 | `protocol/scripts/lit/add-action.ts` | FULL REPLACEMENT | Chain-secured `addAction` + `addActionToGroup` against existing group; updates `config.json`; reminds `update-protocol`. |
| 8 | `protocol/scripts/lit/add-dev-action.ts` | FULL REPLACEMENT | Build + Pinata-upload `render-dev` (keeps `dev-actions.json` + `S2S_RUNNER_URL` working) **and** chain-secured registration of the dev CID against the existing group. |

`config.json` / `dev-actions.json` are **runtime outputs** written by the scripts (deploy-group `--sync`, swap/add/update config maps) — not authored here. `update-protocol.ts` is **not replaced** (its records-batch mechanism is reused verbatim; it runs *after* the group/actions land on-chain).

## 3. Verified constants (baked — do not re-derive)

- Action hash = `uint256(keccak256(cid bytes))` (matches existing `registerAction` helper). Verified encrypt vector: `actionHash('QmQNnefQsHQoUGyLaGJHMNhTaRtEYGfccejPsQXhJn7Rsh') = 0xf2925f24662e3bd9ab6c3087a0ab7f8384eb96bacd46729a8eaeaba828ce97e1`.
- Admin hash = `uint256(keccak256(abi.encodePacked(safeAddress)))`. Verified vector for `0x24936f87442673B7c057BF3f5dCCB726baF20c6B` = `0x11adab45e07d6dd847846fd13be95947bf24119ebfdae77f91d6598dbed69760`.
- 5 pinned CIDs reused + their hashed CIDs (computed with the same formula, verified against the research table):

| action | CID | hashedCid |
| - | - | - |
| encrypt | `QmQNnefQsHQoUGyLaGJHMNhTaRtEYGfccejPsQXhJn7Rsh` | `0xf2925f24662e3bd9ab6c3087a0ab7f8384eb96bacd46729a8eaeaba828ce97e1` |
| prep | `QmNPXjE8X9fP1JeqMGNrhq6GDypghtdYBWJfXQdzd6sLQy` | `0xff4c3b1127ba642fccef8f2f8921aa15120969b69b1ae7b5a8e7a6d4b75ea657` |
| render | `QmPmZeTd7cYzkcadpYjYVJTgGDrz3dyFkKxPEAJYZajdsd` | `0xac828e8cad1d224b209d7d2ea1380f0719e455f32d9cd76eba18b3163ef2e1f6` |
| update | `QmR2jxUm2jKiiUegx1VwWbAeCXYPuTbtQWBBUetnzv1gBn` | `0xc739a3937eddfedcb3b5a9fef918d6b52ac950374c53dc61f2be828aeb91bfa3` |
| maintain-cache | `Qmf9emwnMV7KLZE8BjqjhFLKfkUWUPvH4Q8tD43FNcDmtF` | `0x9d7bbe2a9f72e232e5cc97d811cd6d663b0d19e4375110552eba303c46f4e3f7` |

## 4. Ordered human runbook (after the orchestrator applies files + gates + PR)

Prereqs: `pnpm install` (workspace), `pnpm shared` (rebuild shared so `@s2s/soul2soul-shared` exposes `chain-secured`). Root `.env` must have `PROTOCOL_PRIVATE_KEY`, `PROTOCOL_SAFE_ADDRESS=0x24936f87442673B7c057BF3f5dCCB726baF20c6B`, `VITE_DRPC_API_KEY` (and `IPFS_URL`/`PINATA_JWT`/`PINATA_GATEWAY` for Pinata steps). `LIT_ACCOUNT_KEY` is **obsolete** — do not set it.

1. **Dry-run everything first** (no side effects): `LIT_DRY_RUN=1 pnpm deploy-group` → verify account, prints the full decoded Safe batch, prints `dry-run: would mint` / `dry-run: would propose to Safe`, exits 0.
2. **Deploy the new group** (real): `pnpm deploy-group`. It verifies chain-secured (non-fatal warn), mints a fresh PKP via `POST /core/v1/prepare_wallet` (no auth), mints a usage key client-side (`lk_` + 64 hex), predicts the new group id (`groupCount + 1` from `ViewsFacet.listGroups`), builds + **proposes** the Safe batch, prints the Safe tx hash.
3. **Owners confirm + execute** the proposed Safe transaction in Safe{Wallet} (threshold confirmations). Not auto-executed — INV-8.
4. **Sync local config from the receipt** (reads the *actual* `addGroup` group id from the `GroupAdded` log, NOT hardcoded): `pnpm deploy-group --sync`. Writes `protocol/scripts/lit/config.json` (group id, the 5 actions w/ CIDs, `pkps[0]` = new PKP, `usage_key` = new key). Prints .env instructions.
5. **Update `.env`:** set `VITE_LIT_USAGE_KEY=<printed usage key>`; `LIT_ACCOUNT_KEY` obsolete (leave/remove); `PROTOCOL_SAFE_ADDRESS` unchanged. Rotate `0xobsidian`/`neutralpress` `litUsageKey` settings if those consumers are in use.
6. **Write protocol records** (after the group + actions are on-chain): `pnpm update-protocol` → Safe batch writing `pkp_ethAddress` = new PKP, `lit_action_*` = new CIDs, re-`authorizeCaller(newPkp, true)` on the ENS records contract. Confirm + execute in Safe.
7. **Subsequent action changes:** `pnpm actions:swap <name>` or `pnpm actions:add [name]`, then `pnpm update-protocol` again (keeps records + group in lockstep — INV-8). Dev action: `pnpm actions:add-dev`.

> Ordering rule: **group + actions on-chain first, records second, usage-key env last.** Do not advance records ahead of the group.

## 5. Dry-run usage

All four scripts honor `LIT_DRY_RUN=1`:
- They build the **full Safe batch**, pretty-print every `{to, value, data}` as a human-readable function name + decoded args (via `decodeFunctionData` against the WritesFacet ABI).
- They **stop before proposing** AND **before `prepare_wallet`** (prints `dry-run: would mint` at the PKP step, `dry-run: would propose to Safe` at the end), and **before any Pinata upload**.
- No on-chain writes, no Safe proposal, no wallet mint, no IPFS upload happen.

```
LIT_DRY_RUN=1 pnpm deploy-group        # verify + decoded batch + would-mint/would-propose
LIT_DRY_RUN=1 pnpm actions:swap prep   # decoded remove/add batch for 'prep'
LIT_DRY_RUN=1 pnpm actions:add render  # decoded add batch
LIT_DRY_RUN=1 pnpm actions:add-dev     # decoded dev-action add batch
```

## 6. Env names referenced (no secrets in code)

`PROTOCOL_PRIVATE_KEY`, `PROTOCOL_SAFE_ADDRESS`, `VITE_DRPC_API_KEY`, `IPFS_URL`, `PINATA_JWT`, `PINATA_GATEWAY`, `VITE_FILEBASE_TOKEN`, `LIT_DRY_RUN`. Runtime-only secrets: the usage key (printed + written to `config.json` by the scripts; pointed at by `VITE_LIT_USAGE_KEY`).

## 7. Files NOT authored here (read-only references)

`protocol/scripts/lit/update-protocol.ts` (reused mechanism, runs afterwards), `shared/src/lit/lit.service.ts` (API-mode, intact), `shared/src/index.ts` (package root, unchanged — we only touch the `lit` sub-index), `protocol/scripts/lit/config.json` + `dev-actions.json` (script outputs), research reports.
