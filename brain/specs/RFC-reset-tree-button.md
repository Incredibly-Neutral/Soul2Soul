# RFC — "Reset tree" button (clear pages, keep assets, optional bulk render)

> An RFC, not a spec: this is a feasibility proposal for behavior that is **not yet built**.
> When built + reviewed, fold the settled parts into `publication/SPEC-publication-admin-app.md` and
> `SPEC-protocol-actions.md`, then strike here.
>
> Status: PROPOSED 2026-08-20. Follows the Website Tree tab (PR #48/#51/#52, `feat/website-tree-tab`).
> Grounded in live code; all citations file:line.
>
> IMPLEMENTATION STATUS (2026-08-21):
> - PR (a) — reset-tree core — MERGED as **PR #53** (`feat/protocol: publication-owner reset-tree core`,
>   branch `feat/reset-tree`, commit `49c55df`). 8 files, +562/-103 (gates.ts, update/main.ts,
>   action-io.ts, types.ts, sequence.ts, action-io.test.ts, sequence.test.ts, new reset.test.ts).
> - Gates verified by orchestrator: reset.test.ts 6/6 pass; shared sequence+action-io 56 pass;
>   shared + safe-app typecheck pass; safe-app build pass. Lint is pre-existing broken repo-wide
>   (main's lint crashes); changed files are net-neutral vs `origin/main` baseline.
> - Independent review of PR #53 BLOCKED: the `builder` worker truncates after reading any diff
>   (6 consecutive review truncations, all artifact sizes). PR #53 diff is small and self-verified
>   against this RFC; merge decision was with the human (merged).
> - PR (b) — the Website Tree tab "Reset tree" button + optional "Reset & rebuild" (safe-app only,
>   stacks on main, which now contains the reset core) — dispatched 2026-08-21 as
>   `builder/reset-tree-button` (v2 conv 0602dd54b1a64a2eb95feee401ead027). First dispatch died at
>   boot (intermittent worker truncation); re-dispatched. Contract: destructive confirm dialog,
>   signWithSigner('lit actions auth') + renderwithLitActions(..., reset:true) (reset-only = empty
>   contentIds; reset & rebuild = all deal genesis IDs in one call), re-sync() after success, gates
>   = safe-app type-check + build. See §3/§4.

## TL;DR

A "reset tree" button in the Website Tree tab is a **start-over recovery** for a tree that is
confused/broken to the point of wanting a clean slate. Decision (2026-08-20): implement it as a
**`reset` mode directly inside the evm-update action** — not by listing/retracting deals first.
The reset drops the existing MFS tree (including root `index.html` — the home page is cleared
too), keeps `assets/`, and rewrites `contenthash_wrapped`; on-chain deal state is **untouched**
(deals remain the source of truth). An optional bulk render then rebuilds the tree from current
on-chain deals.

**Authorization decision (2026-08-20): only the publication can reset — not an individual
author.** A reset requires the signer to be an **owner of the publication Safe** (the `multisig`
resolved by `getDomainOwnerAndModules`), which is stricter than `canPublish` (that only requires
an owner of a whitelisted *author* Safe). This keeps the neutralpress single-author publish path
unable to nuke the tree; the reset lives with the publication owner (the safe-app, where the
managed Safe IS the publication Safe).

The implementation is small because the update action already has a "no previous root" branch.

## Why this is the right primitive (verified in code)

The evm-update action (`protocol/actions/src/update/main.ts`) builds the new tree like this:

1. Read previous `contenthash_wrapped` → **`files/cp` the old root into a temp MFS path**
   (`cp root ${prevCid} → ${mfsPath}`), **or `files/mkdir` a fresh empty temp path when there is
   no previous root** (`mkdir ${mfsPath}`).
2. Copy delta page jobs (`${mfsPath}/${path}/index.html`).
3. Process `remove[]` entries (each gated by `verifyRevocable` for no-`replacedBy` removals).
4. Copy `assets/` from `config.assetsCid` (unconditional).
5. `files/stat` → new root CID → pin → `setText contenthash_wrapped`.

**A reset is simply: force branch 1 to take the `mkdir` path regardless of the previous root.**
The old (confused) tree is never copied, so every page dir vanishes; assets are still re-copied;
the root is rewritten. No per-path removal, no `verifyRevocable` loop, no deal listing — exactly
the "direct removal inside update action" the user wants.

## Design

### 1. `reset?: boolean` on the evm-update input

- `shared/src/rendering/action-io.ts` — add `reset?: boolean` to `EvmUpdateInput` (schema +
  validation; `validateEvmUpdateInput` passes it through).
- `protocol/actions/src/update/main.ts` — read `input.reset`; change the root-copy branch to:
  `if (prevEncoded && prevEncoded.length > 0 && !reset) { cp root } else { mkdir }`.
  Everything downstream (jobs, remove, assets, stat/pin/setText) is unchanged. Because the old
  root is never copied, root `index.html` (home) is cleared along with every page dir — the
  confirmed intent.
- `shared/src/rendering/sequence.ts` — thread `reset` into `evmInputs`
  (`validateEvmUpdateInput({ ..., reset })`).

### 1b. Publication-owner gate (authorization)

- `protocol/actions/src/libs/gates.ts` — add `canReset(multisig, signerAddress, rpcs)`: read
  `isOwner(signerAddress)` on the **publication Safe** (`multisig`), mirroring the `isOwner` read
  in `canPublish` but against the publication Safe instead of the author Safe.
- `protocol/actions/src/update/main.ts` — when `input.reset` is set, require
  `await canReset(multisig, signerAddress, rpcs?.L2)` and throw `'reset requires publication
  owner'` otherwise. Normal publishes keep the existing `canPublish` check unchanged.
- Effect: the neutralpress single-author path (signer = author-Safe owner, not a publication-Safe
  owner) cannot reset; the safe-app path (signer = owner of the managed Safe, which IS the
  publication Safe) can.

### 2. Sequence: allow a reset-only run (skip prep when nothing to render)

`prep` rejects empty `contentIds` (`protocol/actions/src/prep/main.ts:49-50`), so a clear-only
reset cannot go through the normal prep→render→update flow. Two options:

- **A (preferred, minimal):** in `renderwithLitActions` (`shared/src/rendering/sequence.ts`),
  when `reset === true && contentIds.length === 0`, skip prep + render and go straight to the
  update action with `jobs: []` + `reset: true` (zero-jobs-with-remove is already validated —
  `sequence.test.ts:450`). ~10 lines.
- **B (alternative):** require ≥1 `contentId` even for reset (e.g. the home job) and let prep
  run. Re-renders home as a side effect; more moving parts. Not preferred.

### 3. Button in the Website Tree tab

`safe-app/src/components/s2s-website-tree-tab.ts` is read-only today but already walks the DAG
and knows every page path. Add a **"Reset tree"** button:
1. Destructive-action confirm dialog (explains: clears all pages, keeps assets, on-chain deals
   unchanged; optional follow-up rebuild).
2. Invoke the reset via the existing write pattern — `signWithSigner('lit actions auth')` +
   `renderwithLitActions(..., { reset: true })` — exactly how `s2s-deals-tab.ts:219`
   `bulkRender()` already runs the pipeline (no Safe-tx proposal needed).
3. In-flight/disabled state + inline error handling, mirroring the existing Sync button.

### 4. Optional bulk-render follow-up (works today)

After the reset, rebuild from on-chain deals: `renderwithLitActions` with all deal genesis IDs —
the exact `bulkRender(preview)` logic in `s2s-deals-tab.ts:219`. Reuse or extract it. Can be a
second button action ("Reset & rebuild") or a checkbox on the reset dialog.

## Semantics / integrity notes

- **On-chain deals are untouched.** A reset only rebuilds the IPFS/MFS tree; deals remain the
  source of truth. Pages under active deals disappear from the rendered site until a bulk render
  re-adds them. This is the intended "start over" recovery, and it means reset+bulk-render =
  "reconstruct the tree from current on-chain state" — a clean fix for a confused tree.
- **Authorization (decided): publication-only.** Reset requires the signer to be an owner of the
  publication Safe (`canReset`), NOT merely a whitelisted author (`canPublish`). An individual
  author's neutralpress publish cannot reset the tree. This is a *stricter* gate than a normal
  publish, not a new privilege.
- **Home page (decided): cleared too.** With the `mkdir` branch, root `index.html` is also
  removed (it is not copied), unlike per-path `remove` which reserves `index.html`/`assets`.
  The bulk render re-creates home. Flag in the confirm dialog.
- **`verifyRevocable` is not involved** in reset (no per-path removal) — that gate stays intact
  for normal revokes/renames.

## Change surface (all small)

| Area | File | Change |
|---|---|---|
| Input schema | `shared/src/rendering/action-io.ts` | `reset?: boolean` on `EvmUpdateInput` |
| Gate | `protocol/actions/src/libs/gates.ts` | new `canReset` (isOwner on publication Safe) |
| Action | `protocol/actions/src/update/main.ts` | `!reset` on the cp-root branch + `canReset` gate when reset |
| Sequence | `shared/src/rendering/sequence.ts` | thread `reset`; skip prep when reset+empty contentIds (~10 lines) |
| Button | `safe-app/src/components/s2s-website-tree-tab.ts` | Reset button + confirm + invoke pipeline |
| Bulk render | reuse `s2s-deals-tab.ts` `bulkRender` | optional follow-up |

Gates: `pnpm --filter s2s-records-safe-app type-check`, `pnpm --filter s2s-records-safe-app
build`, `pnpm lint`; plus the shared/protocol vitest suites for the schema/sequence changes.

## Unknowns / open confirmations

- Should the reset dialog offer "Reset only" vs "Reset & rebuild" (bulk render chained)? Default?
- Does the tree tab need to re-sync (walk the new root) after a successful reset/rebuild? (Yes —
  update the tree + last-synced timestamp after the pipeline returns.)
- Decided: home page cleared too; authorization = publication-owner (`canReset`), not individual
  author. The publication-owner gate is the safety mechanism (replaces the earlier `'CONFIRM'`
  field idea — a UI confirm dialog is still shown, but the on-chain gate is what enforces it).

## Suggested path

1. Confirm the two open questions above (dialog shape; confirmation field).
2. Implement in two PRs: (a) `reset` in action-io + update action + sequence (shared/protocol,
   with vitest coverage for the zero-jobs-reset path), (b) the tree-tab button + optional
   bulk-render wiring (safe-app). Each in its own worktree, gates green, independent review.
3. Fold settled behavior into `publication/SPEC-publication-admin-app.md` / `SPEC-protocol-actions.md`; strike this RFC.
