# RFC-007 — ripples from a revoke in the prep action

> Domain: `PRESS` · moved from `brain/specs/RFC-prep-ripples-from-revoke.md` (2026-11-04); number assigned on the move.

> **Type:** design proposal / forward work (an RFC, not a spec). Captures the required behavior
> for propagating a license **revoke** to dependent pages via the existing ripple mechanism, so a
> future agent or human can pick it up cold. **Not implemented.** Execution deferred to a
> separate handoff session. When built and reviewed, fold the settled outcome into the relevant
> SPEC (`SPEC-protocol-actions.md` §"Ripples vs collections") and strike here.
>
> **Pick-up contract:** `handoffs/handoff-prep-ripples-from-revoke.md` — the executing session
> starts there; this RFC is the durable proposal + acceptance contract.
>
> **Origin:** joera direction (2026-08-18): ripples-from-revoke belongs in the prep action; spec
> it but let another session execute.

---

## Problem

Ripple expansion in `prep` is keyed to a contentId being *rendered* whose `postType` matches a
ripple `origin`. On a **publish** that re-renders the dependent pages and their collections pick
up the new content. But when a license/deal for content is **revoked** on-chain
(`revokeLicense` → `hasDeal=false`), the next render of that contentId produces a `revoked` job
(empty html) and a `remove` entry (no `replacedBy`) — but **the dependent pages that embed/list
that content are NOT re-rendered**, so the revoked post keeps appearing on `home`/list pages and
any page whose body/collection references it. The revoke does not fully propagate.

## Required behavior

`prep` must expand ripples for a contentId being **revoked** just as it does for a publish: for
each matching rippleConfig (`ripples.filter(r => r.origins.includes(body.postType))`),
`fetchByQuery(query)` → destination page(s), push a job per destination page, dedupe by `id`.
The cascaded destination job flows through `single` like any other; its collections re-fetch
current data, from which the revoked item is absent (gate / `revoked`), so the published tree no
longer shows it. A revoke of a `post` ripples to `home`; `home`'s `posts` collection re-runs and
drops the revoked post. **Ripple + collection compose here exactly as on publish** — the ripple
says "re-render home"; home's collection says "list the current posts."

## How `prep` knows a render is a revoke

A contentId's render is a revoke when it will not produce an active page — i.e.
`hasDeal(toBytes32Id(contentId))` is false at the gate, so the job renders `revoked` and its
path is removed. A revoke and a fresh publish are distinguished only by the deal state — the
`postType` (the ripple `origin`) is the same — so the ripple should fire whenever the contentId's
postType matches an origin, **whether the underlying render is a publish or a revoke**. (Confirm
the exact gate/prep read order; see open confirmations.)

## Output coupling with `remove`

A revoke render emits a `remove` entry for the revoked path (no `replacedBy`). The ripple jobs
are additive to `jobs` and must NOT be confused with `remove` entries; cascaded jobs get their own
fresh paths and nothing about the ripple changes the `remove` list.

## No-ripple case: `jobs.length === 0` + `remove.length === 1` must still process the removal

Ripples are the **only** source of render jobs for a revoke — the revoked content's own job
renders `revoked` (empty html) and contributes no active render job. So when there is **no**
matching rippleConfig for the postType, or the bulk path skips cascade, a revoke render
legitimately produces `jobs.length === 0` with `remove.length === 1`. The **render action** must
be adapted so a `jobs.length === 0 && remove.length === 1` result still processes the removal —
it must not treat "no jobs" as "nothing to do" and drop the `remove` entry. Confirm the render
action's current zero-jobs short-circuit (open confirmation 5).

## Acceptance contract (for the executing session)

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
   the latter, the `contentIds.length === 1` guard is itself why revoke ripples are missing — the
   fix may be to also expand on the bulk/revoke path.
3. Whether `hasDeal` at prep time is the right/available signal, or whether the orchestrator
   should pass an explicit "this is a revoke" flag to prep.
4. Confirm a destination re-render actually drops the revoked item (collections filter by
   gate/license), so the ripple is sufficient.
5. Whether the render action currently short-circuits on `jobs.length === 0` and would therefore
   skip a lone `remove` entry — if so, adapt it so `jobs.length === 0 && remove.length === 1`
   still processes the removal.

## Behavioral gotcha to confirm

Ripples expand **only** for `contentIds.length === 1`. A bulk render (multiple ids) skips
cascade expansion — presumably because a full render already covers the dependent pages, but it
means publishing N>1 items in one batch will _not_ trigger a `home` re-render on its own. Verify
this is intended, not a stale-page hazard.

## Working notes for the implementer

- Component: `protocol/actions/src/prep/` (and its shared libs — `getTaskConfig`, ripple config
  selection, `fetchByQuery`); plus the render action's handling of `jobs` / `remove`.
- The ripple job output (`jobs`) is additive to the primary job; it must **not** be confused with
  the `remove` array (revoke render still emits the `remove` entry for the revoked path).
- A fresh worktree on a feature branch; own PR; drive the standard gates green; get an
  independent review before the human merges. Do not touch the publish/contracts/action publish
  path unless the task explicitly requires it.
