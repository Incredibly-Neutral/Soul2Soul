# Investigation — Live Lit Group vs. the render/update "working today" report (reconciliation)

**Date:** 2026-08-31
**Author:** DeepSeek V4 Flash 0731
**Mode:** read-only `explore` — no source edited, no live swap/deploy/mutation, no PR.
**Repo:** `/home/joera/code/s2s`, branch `main`, HEAD `c148667` (PR #69 merge). **Working tree is being mutated concurrently** (see §6) — treat any in-repo "current" value as volatile.

## 0. TL;DR (definitive answers)

1. **Group 14 is the live/production group.** The production PKP `0xddc48e51…` (written on-chain as `pkp_ethAddress`, and present in the inspected group-14 dump) matches `config.json` `pkps[0]` and the account key's group. The app never reads the group id from `config.json` at all — it only uses the usage key + on-chain records. So `config.json`'s group id is a *script-side* belief; the committed value (14) is the real one. (The working tree now shows `id: 15` — that is a **concurrent, uncommitted mutation during this session** (§6), not the production group.)
2. **Group authorization is by CID-HASH only; the `name` returned by `/list_actions` is a cosmetic registration label.** `render` has historically been registered in the group under its legacy name **`single`** (see the documented rename in `update-protocol.ts` and `protocol/index.ts`). So "group 14 lists `prep`/`single` but no `render`/`update`" does **NOT** prove render/update are unauthorized — the current render CID could be present under a `single`-named hash.
3. **`inspectGroup` is paginated at `page_size=50`** (`/list_actions?...&page_size=50`). The described dump (~1 encrypt + ~19 prep + ~33 single = 53+ entries) already exceeds one page, so the dump is **very likely truncated** and cannot, on its own, prove what is in the group.
4. **The 403 was real and specific to `QmbNrx21`, the *NEW* render CID** (`config.json` render, hash `0xaebcabc6…`). Nothing in the repo shows `0xaebcabc6`, `0x905daba…`(update) or `0x94b1b7…`(maintain-cache) ever having been added to group 14 — only the config + records were advanced to them (commit `05ce3d0`), which is the "records-only" group-desync footgun.
5. **Why render/update "work today":** the app executes the render/update CID it reads from **on-chain records** (`getProtocolInfo` → `lit_action_render`), not from `config.json`. It is still executing the **previous, still-authorized CID** that was registered under `single`/`prep` in group 14. The instant the on-chain record actually points at `QmbNrx21` (records update reaches the chain / Safe is confirmed), the app will hit the *same* 403 again. **Render is therefore not broken *right now*, but it is not fixed either — it is one pending record-flip away from breaking.**

**Bottom line:** Group 14 is live and IS the group the app's usage key (`9i8zKrv71…`) executes in; render/update are authorized **only for the old/current-on-chain CIDs**. The current render CID `QmbNrx21` was swapped into **config + records** but is (very likely) **not yet in group 14**, so a real 403 remains to be fixed (run `swap-action render` + `swap-action maintain-cache` into group 14).

---

## 1. How the app resolves its group + usage key (question 1, question 4)

### 1a. The app never looks up a group id
- The Lit execution path is `LitService.executeAction(code, jsParams, key)` → `POST /lit_action` with **only** `{ code, js_params }` and the key in the `X-Api-Key` header — it does **not** send a group id (`shared/src/lit/lit.service.ts:256–266`; header at `:74–79`).
- The render/prep/update CIDs come from **on-chain records**, read via `getProtocolInfo` → `getRecords([... 'lit_action_prep', 'lit_action_render', 'lit_action_update', 'lit_action_maintainCache', ...])` (`shared/src/protocol/index.ts:44–82`), surfaced as `protocolInfo.litActions.render` etc.
- The orchestration passes `protocolInfo.litActions.*` CID and `litUsageKey` into `runAction` (`shared/src/rendering/helpers.ts:25–37`); production fetches the code from IPFS by that CID and calls `lit.executeAction(code, inputs, litUsageKey!)` (`helpers.ts:34`). The render CID is consumed at `shared/src/rendering/sequence.ts:165` (`protocolInfo.litActions.render`), update at `:283`-ish, maintain-cache at `:303`-ish.
- **Conclusion:** `config.json`'s `id` is used *only* by the management scripts to decide which group to mutate/query. The app itself has no group-id dependency.

### 1b. Which usage key the app executes with
- `neutralpress` (Obsidian): `renderCalls(..., main.oxo.settings.litUsageKey, ...)` — a user-entered setting (`neutralpress/src/publication/publish.ts:82`, `neutralpress/src/publication/revoke.ts:212`; setting defined in `0xobsidian/src/settings.ts:23,41,272`).
- `safe-app`: `import.meta.env.VITE_LIT_USAGE_KEY` (`safe-app/src/components/s2s-deals-tab.ts:298`, `s2s-website-tree-tab.ts:323`).
- `.env` line 35: `VITE_LIT_USAGE_KEY=9i8zKrv71/CKTPYfL2i/ll4oRd5XTzsTNXaGFvQ3zZ8=` — **byte-identical** to `config.json` `s2s.usage_key` (`9i8zKrv71/…`). (Verified: sha256 of both match.)
- So the **executing use key is `9i8zKrv71/…`** in both surfaces. It is a group-bound key created by `createUsageKey({ executeInGroups:[groupId] })` → `POST /add_usage_api_key`, body `execute_in_groups` (`lit.service.ts:228–242`, `:234`). A key created this way is authorized to run **any action whose CID-hash is in the group(s) it can execute in**; it is resolved dynamically against the group's permitted CID set at execution time.

### 1c. Account key vs usage key (question 4)
- `.env` line 34 `LIT_ACCOUNT_KEY=PApy4ygGaNrMVzUDUdi8wkAF5c+u0wFRTPZsN5SxcH8=` is the **admin/management key**. It is what the deployed scripts pass (`accountKey: process.env.LIT_ACCOUNT_KEY!` in `swap-action.ts`, `refresh-key.ts`, `deploy-group.ts`, `inspect-group.ts`) and is the key the human's `pnpm inspect-group` run printed (working-tree `inspect-group.ts` still has `console.log(lit)`, which dumps `accountKey`). It is **not** the key the app uses to execute actions.
- The 403 text `(QmbNrx21… / 790357564…861850)` shows a **truncated/normalized numeric rendering** of the submitted key. The only usage-key credential the app is configured with (`9i8zKrv71…`, identical in config + env + oxo settings) is the app's executing key; `PApy4yg…` is the admin key, never used by the app for `/lit_action`. The `…861850` suffix cannot be mapped byte-for-byte from the repo (no raw key is persisted), but the app's *only* usage key is `9i8zKrv71…`, so the 403 is on that credential.

---

## 2. How authorization actually matches (question 2, question 3)

### 2a. Match is by CID-hash, not name
- `addActionToGroup` sends `action_ipfs_cid` (`lit.service.ts:207–212`); `removeActionFromGroup` sends `hashed_cid` (`:214–219`). The group stores a **set of permitted CID-hashes** (`cid_hashes_permitted`, see `createGroup` body `:144–167`).
- `/lit_action` receives only `code` + `js_params`; the node re-derives the code's CID locally and admits the call **iff that CID-hash is in the permitted set of a group the key can execute in**. The `name` is never part of the authorization decision — `/list_actions` returns `name` only as a human label attached at `registerAction`/`/add_action` time.
- **Therefore** a dump showing `… single` / `… prep` entries with no `render`/`update`/`maintain-cache` *names* is NOT evidence those CIDs are unauthorized. The current render/update CIDs may well be listed under their legacy registered names.

### 2b. `render`'s legacy group name is `single` (and `update`'s is `updateEvm`/old)
- `update-protocol.ts` header comment: "render — was `lit_action_single` (renamed), update — was `lit_action_root_update`…" and `protocol/index.ts:24–26`: "RENAMED: `lit_action_single` → `lit_action_render`, `lit_action_root_update` → `lit_action_update`."
- `add-action.ts` still registers the update action under the (stale) name `updateEvm` (hardcoded `action_name = 'updateEvm'`).
- The current source tree builds dirs `render`, `update`, `maintain-cache` (`build-actions.cjs`), and `swap-action.ts` registers under the argv name (e.g. `render`). So the 33 `single` / 19 `prep` entries in the dump are **historical render/prep versions registered under the old names**, accumulated in the group over many swaps.

### 2c. `inspectGroup` is paginated / possibly truncated (question 3)
- `inspectGroup(id)` → `GET /list_actions?[id]&page_number=0&page_size=50` then `GET /list_wallets_in_group?...` (`lit.service.ts:169–188`). It fetches **only page 0, up to 50 actions**.
- The described dump (~1 encrypt + ~19 prep + ~33 single ≈ 53+ rows) already exceeds 50, so the newest additions (render/update/maintain-cache, if present) very plausibly fall **beyond** page 0 and are simply not shown. Absence in the dump is weak evidence of absence in the group.
- The dump's structure (`{ actions, pkps }`, actions array of `{name, cid_hash/…}`) is exactly `inspectGroup`'s return — it is a read-only query under the **account key** and reflects the same group the app's usage key executes in (same group id, same PKP).

### 2d. The decisive empirical check (could not be completed from the repo)
To *prove* whether group 14 currently authorizes the new CIDs, one must scan the **full** (non-truncated) dump for the hashes:
- `render` `QmbNrx21…` → `0xaebcabc6b026ee4f333204031db4f409332f6ca2f76fd19e06a2555a5d8fb37a`
- `update` `QmfYRYQ…` → `0x905daba952f9225e74a7cc992248bff4253b8eb0bb73c0058755ef72eee929a1`
- `maintain-cache` `QmcvCDW…` → `0x94b1b7db339884f99f4533bd648640dcc2396658607900144fed20df9f1c1e38`
The human's described dump was **not persisted anywhere I could locate** (no file, no log, only the prose description in the task), so I could not literally scan it. Given the code path and the fact that render/update work *today*, the group must still authorize whatever CIDs the app currently reads from on-chain records (the pre-`05ce3d0` ones, listed as `single`/`prep`); there is no evidence the *new* render (QmbNrx21) was ever added under any name.

---

## 3. Reconciliation of the contradiction (question 2)

The human's observation "render/update work several times today" and "group 14 dump has no render/update/maintain-cache" are **not actually contradictory** — they are explained by evaluating the candidate mechanisms:

- **(a) App executes via a different group** — **No.** Group 14 owns the production PKP `0xddc48e51…` (matches config `pkps[0]` and the on-chain `pkp_ethAddress`), and the app's usage key `9i8zKrv71…` is bound to it. There is no evidence the app runs on another group.
- **(b) `inspectGroup` under the account key is a wrong/limited view** — **Partially.** The view is correct but **paginated/truncated** (`page_size=50`, page 0 only), and it reports `name` labels that are legacy (`single`), so a naive "no render name" reading overstates what is missing.
- **(c) Usage key bound to multiple groups** — **No evidence.** One `execute_in_groups` list; config has a single group; key value has been stable across all commits.
- **(d) render/update run under different names and are keyed by CID-hash** — **Yes, this is the mechanism.** Authorization is by CID-hash; `render`'s group entries are named `single`, `update`'s old name differs. So render/update **can** be authorized while the dump shows no `render`/`update` label.
- **(e) The 403 was transient/one key while another works** — **Yes, in this specific sense:** render works today because the app is executing the **old, still-authorized on-chain CID**; the 403 occurred on the **new** CID `QmbNrx21` (config's/records' intended render) which is not (yet) in group 14. It will recur the moment records actually point at `QmbNrx21`.

**Consolidated statement:** The 403 was a genuine authorization rejection of `QmbNrx21` (hash `0xaebcabc6…`). The group still contains the old render (`single`), old prep, and old update CIDs — that is why render/update function today. The config + on-chain records were advanced to `QmbNrx21`/new update/`maintain-cache` (commit `05ce3d0`; `update-protocol.ts` writes `lit_action_render` etc.) **without a matching group swap** (`swap-action.ts` was not effectively applied to group 14), reproducing the documented INV-8 "records-only → orchestrator runs an unpermitted CID → enclave rejects" failure mode. This is exactly the earlier `investigate-lit403` conclusion, **not refuted** by the live report.

---

## 4. Are the two swaps (render QmbNrx21, maintain-cache) applied to the live group? (question 5)

- `swap-action.ts:60` (`removeActionFromGroup(oldHashedCid)`) + `:64` (`addActionToGroup(groupId, cid)`) is the **only** path that mutates the group's permitted set. It must be run per action and, by the dump's description, produced no `render`/`update`/`maintain-cache` entries in group 14.
- `update-protocol.ts` (Safe proposal, **not auto-executed**) and `config.json` were updated to the new CIDs; a `maintain-cache` entry exists only as an **uncommitted working-tree** diff in `config.json` (not even committed, and certainly not confirmed in the group).
- **Conclusion:** the two swaps were applied to **config/records**, but there is **no evidence they were applied to group 14**. So render/update are authorized **only for the pre-rotation CIDs**; the new render QmbNrx21 and maintain-cache remain **unpermitted** in the live group. A real 403 problem does still exist and will resurface once records flip.

---

## 5. Recommended fix (describe only — NOT implemented)

1. **Verify group state definitively:** extend `inspectGroup`/run `pnpm inspect-group` and check **all pages** (fix `page_size` / paginate) — grep the full dump for `0xaebcabc6`, `0x905daba`, `0x94b1b7`.
2. **Bring group 14 into sync with config/records:** `pnpm actions:build` then `pnpm swap-action render` and `pnpm swap-action maintain-cache` (and `prep`, `update` to their config CIDs) so group 14's permitted set includes the new hashes. This is what actually authorizes the usage key for `QmbNrx21`.
3. **Confirm `update-protocol` Safe proposal** on-chain so records match (and then the app will legitimately run the new CIDs).
4. **Prevent recurrence / the real bug:** make `update-protocol.ts` refuse to write a CID to records unless that same hash is already in group 14 (atomic INV-8), collapse the manual per-action swap into a single build→swap-all→update command, and fix `inspect-group.ts` to read the id from config and to paginate.

---

## 6. Concurrency warning (read this)

During this read-only investigation the **working tree changed under me**:
- `protocol/scripts/lit/config.json` mtime `14:37:46` — same day, during this session — now reads `"id": 15` (committed HEAD, all branches, and every commit have `id: 14`). This `14 → 15` flip is an **uncommitted, concurrent mutation** not explained by any commit/deploy, and I did not make it. Whatever live process edited it (a parallel builder session / human / deploy) means the live group id is in flux; the authoritative production group is still **14** (the only id consistent with the production PKP + the inspected dump).
- The described `inspect-group.ts` "hardcoded `const groupId = 14`" matches the current working tree; PR #70 (merged upstream as `e1da414`) is **not** in local `main` HEAD (`c148667`) yet — local `main` is 2 commits behind origin.

Treat any live value from the repo as volatile and re-verify at fix time.

---

## 7. Key file:line map

- App reads CIDs from on-chain records: `shared/src/protocol/index.ts:44–82` (`lit_action_render` destructure `:46,59,79`).
- Prod execution by CID-hash via usage key: `shared/src/rendering/helpers.ts:25–37` (fetch IPFS code `:34`, `executeAction(code, inputs, litUsageKey!)` `:35`); render CID used at `shared/src/rendering/sequence.ts:165`.
- `/lit_action` sends only code+params, key in header: `shared/src/lit/lit.service.ts:256–266`, header `:74–79`.
- Usage key bound to group (`execute_in_groups`): `:228–242` (`:234`).
- Group mutation by hash: `addActionToGroup` `:207–212`, `removeActionFromGroup` `:214–219`; group stores CID-hashes `createGroup` `:144–167`.
- `inspectGroup` paginated `page_size=50` + `/list_wallets_in_group`: `:169–188`.
- Group swap (remove old, add new): `protocol/scripts/lit/swap-action.ts:60,64` → `registerAction(cid, action_name)`; `validActions` includes `render`,`maintain-cache`.
- Records write (Safe, not auto-executed): `protocol/scripts/lit/update-protocol.ts` (`setRecord("lit_action_render", …)`; rename note `:…`; legacy names `single`/`root_update` header).
- Config (group id 14 committed / 15 working-tree, actions hashes, usage_key, pkps): `protocol/scripts/lit/config.json`.
- Inspect script hardcodes `groupId=14`, uses `LIT_ACCOUNT_KEY`: `protocol/scripts/lit/inspect-group.ts` (working tree).
- Credentials: `.env:34 LIT_ACCOUNT_KEY=PApy4yg…` (admin, scripts only), `.env:35 VITE_LIT_USAGE_KEY=9i8zKrv71…` (= `config.json` usage_key = app's executing key).
- App key sources: `neutralpress/src/publication/publish.ts:82` + `revoke.ts:212` (`oxo.settings.litUsageKey`); `safe-app/src/components/s2s-deals-tab.ts:298` + `s2s-website-tree-tab.ts:323` (`VITE_LIT_USAGE_KEY`).
- Rotation that advanced config/records ahead of the group: commit `05ce3d0` (`render` `QmbBbFVS…`→`QmbNrx21…`, plus `prep`, `update`).
- Invariant: `brain/specs/SPEC-00-system-contract.md` INV-8 (records vs group desync).
