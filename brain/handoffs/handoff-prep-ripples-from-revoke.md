# Handoff — Ripples from a revoke action in the prep action

**Status:** PROPOSED 2026-08-18 (`RFC-prep-ripples-from-revoke.md`) — **NOT yet implemented.**
Execution deferred to a separate session (do not implement in s2s-prof's turn; this handoff is
the pick-up contract).

**Contract home:** `specs/RFC-prep-ripples-from-revoke.md` — the durable proposal: required
behavior, no-ripple case, acceptance contract, open confirmations. **Spec (target behavior):**
`specs/SPEC-protocol-actions.md` → §"Ripples vs collections" → "Ripples from a revoke" describes
the target behavior; the settled outcome gets folded into the SPEC after build + review. This file
is the pick-up contract for the executing session.

## TL;DR

Today `prep` expands ripples (cascade re-render of dependent pages) only when content of some
`postType` is **published**. When a license/deal is **revoked** on-chain (`revokeLicense` →
`hasDeal=false`), the next render of that contentId becomes a `revoked` job with a `remove` entry —
but the dependent pages that embed/list the content (e.g. `home`) are **not re-rendered**, so the
revoked post lingers on `home`/list pages.

**Required:** `prep` must also expand ripples for a contentId being **revoked**, so the
destination pages re-render and their collections drop the revoked item.

## Why it's the same mechanism

A publish and a revoke are distinguished only by deal state — the `postType` (the ripple
`origin`) is identical. So the ripple should fire whenever the contentId's postType matches an
origin, whether the underlying render is a publish or a revoke. Destination re-render +
collection re-fetch is what removes the revoked item (no explicit "exclude revoked ids" list
needed — confirm item 4 below).

## No-ripple case: `jobs.length === 0` + `remove.length === 1` must still process the removal

Ripples are the **only** source of render jobs for a revoke — the revoked content's own job
renders `revoked` (empty html) and contributes no active render job. So when there is **no**
matching rippleConfig for the postType, or the bulk path skips cascade, a revoke render
legitimately produces `jobs.length === 0` with `remove.length === 1`. The **render action** must
be adapted so a `jobs.length === 0 && remove.length === 1` result still processes the removal —
it must not treat "no jobs" as "nothing to do" and drop the `remove` entry. Confirm the render
action's current zero-jobs short-circuit (open confirmation 5).

## Acceptance contract (from spec)

1. Given `postType="post"` rippling to `home`: revoking a post's license, then triggering a
   render that includes that postId, yields (a) the post's own job rendered `revoked` + its path
   in `remove`, and (b) an additional cascaded job for `home` whose collection no longer lists
   the revoked post.
2. Holds for any postType with a matching ripple to a destination.
3. For a revoke with **no** matching ripple (postType without a rippleConfig, or the bulk path):
   the render yields `jobs.length === 0` with `remove.length === 1`, and the render action still
   processes the removal — no zero-jobs short-circuit drops the `remove` entry.
4. Existing publish-path ripple behavior unchanged (no regression); bulk render still skips
   cascade unless deliberately changed (then flag it).

## Open confirmations to resolve against live `prep` code

1. Exact current prep ripple-expansion site + ripple selection (module.factory
   `getDeals`/`fetchByPublication` era, GAP-10 ✅).
2. Whether a revoke render is triggered as a single contentId render (ripple fires) or as a
   bulk/full rebuild (ripple currently skipped) in the real neutralpress/orchestrator flow. If
   the latter, the `contentIds.length === 1` guard is itself why revoke ripples are missing —
   the fix may be to also expand on the bulk/revoke path.
3. Whether `hasDeal` at prep time is the right/available signal, or whether the orchestrator
   should pass an explicit "this is a revoke" flag to prep.
4. Confirm a destination re-render actually drops the revoked item (collections filter by
   gate/license), so the ripple is sufficient.
5. Whether the render action currently short-circuits on `jobs.length === 0` and would therefore
   skip a lone `remove` entry — if so, adapt it so `jobs.length === 0 && remove.length === 1`
   still processes the removal.

## Working notes for the implementer

- Component: `protocol/actions/src/prep/` (and its shared libs — `getTaskConfig`, ripple
  config selection, `fetchByQuery`).
- The ripple job output (`jobs`) is additive to the primary job; it must **not** be confused with
  the `remove` array (revoke render still emits the `remove` entry for the revoked path).
- A fresh worktree on a feature branch; own PR; drive the standard gates green; get an
  independent review before the human merges. Do not touch the publish/contracts/action publish
  path unless the task explicitly requires it.
