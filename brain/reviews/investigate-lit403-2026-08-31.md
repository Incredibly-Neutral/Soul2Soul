# Investigation — Production 403 on render action (Lit Group authorization)

**Date:** 2026-08-31
**Author:** DeepSeek V4 Flash 0731
**Mode:** read-only `explore` — no source edited, no PR opened.
**Repo state:** `/home/joera/code/s2s`, branch `main`, HEAD `c148667` (Merge PR #69 maintain-cache parallel action; the uncommitted working-tree diff is only the new `maintain-cache` entry in `protocol/scripts/lit/config.json`).

## 1. The failing 403

> `The provided API key is not authorized to execute the specified action (QmbNrx21eNnsK3u84SzYWCR3VmUitguiwUxKTvRvNyY6LH / 790357564...861850)`

- `QmbNrx21…` is exactly the `render` action CID declared in `protocol/scripts/lit/config.json` (`render` entry, hashedCid `0xaebcabc6…8fb37a`).
- The "specified action" is the CID being executed, i.e. the render CID the orchestrator fetches and submits. So the app IS running the new render code, but the **Lit group** does not authorize it for the usage key.

## 2. Authorization model (as built, file:line)

- A Lit **Group** (Chipotle) binds three things: the PKP wallet, the **permitted set of action CID-hashes**, and a scoped **usage key**. An action may use the key *iff its CID-hash is in the Group's permitted set* (`brain/specs/SPEC-00-system-contract.md` §2.1, lines 82–84).
- The group-deployed instance is `s2s`, `id: 14`, usage key `9i8zKrv71/…` (`config.json`).
- `createUsageKey({ executeInGroups:[groupId] })` (`shared/src/lit/lit.service.ts:228`, POST `/add_usage_api_key`, body `execute_in_groups` at :234) creates a key that is **bound to the group**. No per-key CID list is passed — the key's authorization is scoped to the group it can execute in.
- Authorization is resolved at execution time against the **group's current permitted CID-hash list**: `executeAction` (`lit.service.ts:256`, POST `/lit_action` at :264) sends the code, and the node allows it iff the code's CID-hash is in a group the key can execute in. The tooling writes the group's permitted set via `addActionToGroup` (`:207`, `/add_action_to_group`) / `removeActionFromGroup` (`:214`, `/remove_action_from_group`).
- **Implication:** the usage key does **not** carry a stale snapshot that needs re-creating on every CID change. Adding/removing a CID in the group is the source of truth. `refresh-key.ts` (`/refresh-key.ts:37`) only **re-creates/rotates** the group-bound key (`createUsageKey`) and rewrites `usage_key` into config — it is for key rotation / re-issuance, not part of the per-action redeploy sequence. This matches the invariant register: the canonical redeploy is `build-actions` → `swap-action.ts` (group) → `update-protocol.ts` (records), with **no** refresh-key step (SPEC-00 INV-8, lines 212–215).

Confirming evidence that the grant is group-live, not a per-key snapshot: the `usage_key` in `config.json` is **byte-identical across every commit going back to 2026-05-27**, while the render CID has been re-swapped ~7 times since. The same key has kept working across those group re-swaps — only today's change broke it. If the key were a frozen CID snapshot, production would have been broken from the first post-creation CID rotation, not just this one.

## 3. Root cause

**INV-8 group/records desync (the "records-only" footgun).** The render (and `prep`/`update`) action CIDs were rotated in commit `05ce3d0` ("debgugging", 2026-08-31): config diff shows `render` `QmbBbFVS…`(0xdfba53e…) → `QmbNrx21…`(0xaebcabc…), plus `prep` and `update` similarly. Because `update-protocol.ts` (`/update-protocol.ts`, `updateProtocol` → `setRecord("lit_action_render", renderActionCid)`) and config were updated, the **on-chain record / config now point at `QmbNrx21…`** — that is why the orchestrator picks it up and tries to run it (production path: `shared/src/rendering/helpers.ts:34` `runAction` → `lit.executeAction(code, inputs, litUsageKey)`; render CID sourced from `S2SProtocolInfo` records, `shared/src/protocol/index.ts` `lit_action_render`).

But the **Lit Group's permitted CID-hash list was not updated to include `0xaebcabc…` (QmbNrx21)**. The group still lists the previous render hash. So when the group-bound usage key submits `QmbNrx21…`, Lit authorizes against group 14's current permitted set, does not find `0xaebcabc…`, and returns **"API key is not authorized to execute the specified action (QmbNrx21…)"**.

Why the group fell out of sync: `swap-action.ts` is the **only** script that mutates the group's permitted set, and it must be run **per action**: `removeActionFromGroup(old hashedCid)` (`swap-action.ts:60`) then `addActionToGroup(groupId, cid)` (`swap-action.ts:64`). The `deploy-action` npm script (`package.json`) is `actions:build && swap-action $1 && update-protocol` — it updates the group **and** the records, and works *only if actually invoked for the render action against the freshly built bundle*. Here the render CID change was applied to config/records (05ce3d0) without a matching completed `swap-action render` that added `QmbNrx21` to group 14. Result: records ahead of the group → the documented INV-8 symptom "records-only → orchestrator runs an unpermitted CID → enclave rejects" (SPEC-00, INV-8 row, lines 214–215).

Contributing factor (not the cause of this 403): the maintain-cache deploy (PR #69) is *innocuous* to render — `swap-action maintain-cache` only removes/adds the maintain-cache CID (old not present → caught), and adds `QmcvCDWQTt…` to group 14. It never touches the render CID or the usage key, so it did not cause this divergence; the render break is attributable to the `05ce3d0` rotation.

## 4. Verification (how to confirm before fixing)

- `inspect-group.ts` queries the group's action list via `inspectGroup` (`inspect-group.ts:30` → `lit.service.ts` `/list_actions`). **Note:** it currently hardcodes `const groupId = 7;` (`inspect-group.ts:19`) but the live group is `id: 14` — the script must be pointed at `14` first.
- Compare the returned permitted hashes to `config.json`: group 14 is expected to contain `encrypt, prep, render(QmbNrx21/0xaebcabc…), update, maintain-cache`. The 403 predicts `render` (and possibly the current `prep`/`update`) will be absent.
- If — contrary to expectation — group 14 already lists `0xaebcabc… (QmbNrx21)` yet rendering still 403s, then the grant would instead be a frozen per-key snapshot, and the fix flips to re-issuing the key via `refresh-key.ts`. The static config analysis above points to the first (group-desync) case, but the live inspect is the decisive test.

## 5. Recommended fix (describe only — not implemented)

1. **Bring the group in sync with the records/config** by running the canonical per-action redeploy for the newly-rotated CIDs:
   `pnpm actions:build` then `pnpm actions:swap render` (and `prep`, `update`, `maintain-cache` as needed). `swap-action render` (`swap-action.ts:60,64`) removes the old render hash and adds `QmbNrx21`/`0xaebcabc…` to group 14, so the group-bound usage key becomes authorized again.
   Then `pnpm update-protocol` to confirm the on-chain records match. **Remember the Safe proposal is not auto-executed** (INV-8) — owners must confirm it.
2. **Do NOT reflexively `pnpm refresh-key`** for this — the key is group-bound, so re-creating it is unnecessary (and would churn a credential that an already-deployed app references). Reserve `refresh-key.ts` for actual key rotation. Re-issue only if step 1's verification shows the group already contains `QmbNrx21` and the 403 persists (snapshot-grant branch).
3. **Prevent recurrence (the real bug):**
   - Make `update-protocol.ts` **refuse to write** a CID to records unless that same CID-hash is already present in group 14 (query `/list_actions` first), enforcing INV-8 atomically and killing the "records-only" path that produced this outage.
   - Replace the manual, per-action `swap-action $1` with a single "build → swap every configured action → update records" command that guarantees group==records, and/or add a CI check that diffs `config.json` action CIDs against the group's permitted set.
   - Fix the stale `groupId = 7` in `inspect-group.ts:19` → `14` (or read it from `config.json`), so the invariant can actually be observed.

## 6. File:line map

- Usage key bound to group (no per-CID snapshot): `shared/src/lit/lit.service.ts:228–239` (`createUsageKey`, `execute_in_groups` :234).
- Execution authorization at runtime: `shared/src/lit/lit.service.ts:256–282` (`executeAction`, `/lit_action` :264).
- Group mutation: `shared/src/lit/lit.service.ts:207–212` (`addActionToGroup`), `:214–219` (`removeActionFromGroup`).
- How a CID enters the group: `protocol/scripts/lit/swap-action.ts:60` (remove old) + `:64` (add new); **no usage-key refresh here**.
- Key rotation only: `protocol/scripts/lit/refresh-key.ts:37–43` (`createUsageKey` → rewrite `usage_key`).
- Records write (on-chain CID): `protocol/scripts/lit/update-protocol.ts` (`setRecord("lit_action_render", …)` in `updateProtocol`); NOT auto-executed (Safe multisig).
- Orchestrator execution path: `shared/src/rendering/helpers.ts:34` (`lit.executeAction(code, inputs, litUsageKey)`); render CID from records via `shared/src/protocol/index.ts`.
- Invariant: `brain/specs/SPEC-00-system-contract.md` INV-8 (lines 212–215), §2.1 (lines 82–84).
- Inspect tool bug: `protocol/scripts/lit/inspect-group.ts:19` (`groupId = 7` vs live `14`).
- Render CID rotation that caused divergence: commit `05ce3d0` (`config.json`: render `QmbBbFVS…`→`QmbNrx21…`).
