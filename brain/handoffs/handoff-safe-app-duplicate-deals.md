# Handoff — safe-app shows multiple "deals" that should collapse to 1 (or 2)

**From:** Prof (research; did **not** read source per request — this is a map for code inspection)
**To:** colleague debugging the safe-app deals view
**Date:** 2026-07-22
**Status:** unverified hypotheses + diagnostic plan. Confirm against source before acting.

---

## 1. What the user reported

The safe-app "deals" view shows **5 separate deals** that the user expects to be **one, or perhaps two**.
The data is **fetched from a contract** (an append-log / content-item store). The user's hypothesis:
subsequent versions did not land on the original genesis — each registration minted a new genesis.

The 5 entries (object keys are each entry's own id), normalized:

| # | key / genesis | author (did:ethr) | cid | creationDate | tags | title |
|---|---|---|---|---|---|---|
| 1 | `0x1395f4d9…3bcc` | `0x3b246eB0…7Cac` | `bafkreiabno5…pnby` | 2026-07-06T10:27:24Z | `s3nl4--s2s` | Waardevolle response begint met privacy |
| 2 | `0xf21b21ee…a48a9` | `0x953393DB…88C0` | `bafkreihah3…gled4` | 2026-07-09T08:56:34Z | `s3nl--s2s` | (same) |
| 3 | `0x9845f65c…ff8b5` | `0x953393DB…88C0` | `bafkreihah3…gled4` | 2026-07-09T08:56:34Z | `s3nl--s2s` | (same) |
| 4 | `0xce234559…f09cb` | `0x953393DB…88C0` | `bafkreihah3…gled4` | 2026-07-09T08:56:34Z | `s3nl--s2s` | (same) |
| 5 | `0x59d77221…4647` | `0x953393DB…88C0` | `bafkreibbff…npsd4` | 2026-07-11T19:33:38Z | `s3nl--s2s` | (same) |

All have `status:"deal"`, `postType:"home"`, `encryption:false`, `position:0`.

## 2. The smoking gun

**Every entry's `genesis` field equals its own object key.** None point back to an earlier genesis.
In a correct append-log model, only the *first* version is a genesis row (`genesis == key`); every
subsequent version is an **append** row whose `genesis` points to the original genesis and whose own
id differs. Here all 5 are self-genesis → **the contract holds 5 genesis rows, 0 appends.**

This is consistent with (does not yet prove) a **write-side** bug: registration always takes the
"create genesis" path, never the "append to existing genesis" path. Rule out a read-side grouping
bug too (§5).

## 3. Three distinct sub-symptoms (investigate separately)

**A. Duplicate identical registration (entries 2/3/4).**
Three rows are byte-identical except the genesis key — same author, cid, date, tags, title, position.
Same content registered 3x. Leads:
- Registration is **not idempotent** on content/objectId — re-registering the same item mints a new
  genesis instead of no-op'ing.
- A **retry/re-fire**: `shared/src/helpers/` exports `withRetry` / `callWithTimeout` — check whether
  the registration call is wrapped in a retry that re-submits on a non-final failure, or a UI
  double-submit (button fires 2-3x, or a "did the tx land?" poll that re-submits).
- Genesis appears **non-deterministic**: identical content produced 3 different genesis keys. Per
  SPEC-shared, `objectId` = EIP-712 digest of the signed `S2SPublicContent` and is deterministic
  (available pre-upload). If `genesis` were `objectId`, identical content => identical key. Since the
  keys differ, **genesis is derived from something per-call** (nonce / tx hash / random / a varying
  field like `createdAt` sub-second) rather than from the first version's `objectId`. Find what
  `genesis` is actually hashed from at the registration call site and in the contract.

**B. New version by the same author mints a new genesis (entry 5 vs the 07-09 group).**
Entry 5 (2026-07-11, different cid `bafkreibbff…`) is a genuine new version of author `0x953393`'s
content. Same author, same slug — the append gate (INV-append) should *allow* this append. Yet it is
self-genesis. Lead: the client **never resolves the existing genesis** before registering; it always
calls create. Check whether the write path calls `resolveLatest` / `getHistory`
(`shared/src/identity/verify-content.ts`) to find the existing genesis, or just blind-creates.

**C. Cross-author entry (entry 1 vs the rest) — the "perhaps 2".**
Entry 1 is author `0x3b246eB0…` with tag `s3nl4--s2s` (note the **4**); entries 2-5 are author
`0x953393DB…` with tag `s3nl--s2s`. Two different did:ethr authors => under INV-append they **cannot**
be appends of one another (append is gated to the genesis author's did:ethr). So either:
- They are legitimately **two documents** (different author + different slug) → expected end state is
  **2 deals**, each with its own version chain. Confirm with the user whether 0x3b246e and 0x953393
  are the same human/publication under rotated keys (e.g. a Safe owner EOA vs a different signing
  key), or genuinely separate.
- Or the author re-keyed between 07-06 and 07-09, the append gate **rejected** the new key, and the
  code fell back to create-genesis. This would *cause* the proliferation and is worth checking: is
  there a fallback `try append → catch → create genesis`? Also relevant: `canPublish` in
  `S2SPublicationModule` checks the Safe *address*, not owner EOAs (SPEC-contracts-publication C1
  gotcha: `// could be safe owners ???`). If genesis-author identity is recorded as an EOA did:ethr
  but later versions are signed by the Safe (or vice-versa), the append gate mismatches.

## 4. Expected end state ("one or perhaps two")

- **If 0x3b246e and 0x953393 are the same publication:** 1 deal. Genesis = entry 1 (07-06), with the
  07-09 content (cid `bafkreihah3`) and the 07-11 content (cid `bafkreibbff`) as appended versions.
  The three identical 07-09 rows collapse to one (dedup the retries).
- **If they are two publications:** 2 deals.
  - Deal A: entry 1 (author 0x3b246e, slug s3nl4) — single genesis, no appends.
  - Deal B: author 0x953393, slug s3nl — genesis = one of the 07-09 rows (dedup the 3 identical),
    with entry 5 (07-11, cid bafkreibbff) as an appended version 2.

Either way the current 5 should collapse to 1-2 genesis rows + appended versions, not 5 geneses.

## 5. Diagnostic plan (inspect, in this order)

1. **Confirm write-side vs read-side.** Read the contract directly (the append-log store, whatever
   the deals view queries). Count genesis rows vs append rows. If 0 append rows exist, it's
   write-side (§3). If appends exist but the read model renders each row as a separate deal, it's
   read-side: the deals view must group by `genesis` and show `resolveLatest` per group, not list
   every row.
2. **Find the registration call site** (the app that writes deals — likely the safe-app's new deals
   feature, or the 0xobsidian/neutralpress authoring surface via
   `shared/src/identity/sign-content.ts :: buildSignedContentItem` + the append-log contract call).
   Answer: does it (a) look up an existing genesis first, (b) call an `append(genesis, …)`
   entrypoint, or (c) always call `createGenesis`/`register`? Hypothesis: (c).
3. **Trace `genesis` derivation.** What is hashed to produce the `genesis` key — `objectId`
   (deterministic EIP-712 digest) or something per-call? This explains the 3 identical rows having
   3 keys (§3A) and is likely the root of non-idempotency.
4. **Check the contract's entrypoints.** Is there a distinct `append` vs `createGenesis`? Does
   `append` enforce INV-append (genesis author did:ethr)? Does `createGenesis` reject a duplicate
   objectId (idempotency guard)? A missing guard = the 3x dupes.
5. **Check retry/idempotency.** Is registration wrapped in `withRetry`? Is there a UI debounce?
   Re-submitting a create on a pending tx is a classic multi-genesis cause.
6. **Reconcile the cross-author case.** Are 0x3b246e and 0x953393 the same publication under
   different keys? If the append gate blocks a rotated key, that may be *why* new geneses appear.

## 6. Relevant spec / invariant pointers (load these)

- **SPEC-00 §4 INV-append** — append must gate to the genesis author (or permitted publication
  owners), verified against the did:ethr in the genesis entry. This is the gate sub-symptom C bumps
  into.
- **SPEC-00 §5 GAP-1** — new flat `S2SContentItem` + append-log contract replaces the old Lens
  content model; **"Migration not yet started in action code."** The deals feature is likely the
  client side of this half-finished migration → expect half-wired append paths.
- **SPEC-shared** — `identity/sign-content.ts` (`buildSignedContentItem`, `computeObjectId`,
  `TypedDataSigner`), `identity/verify-content.ts` (`resolveLatest`, `getHistory`, `VersionRecord`),
  `identity/jcs.ts`, `helpers/` (`withRetry`, `callWithTimeout`). `protocol/types.ts`: `S2SContentItem`
  flat shape; `objectId` = EIP-712 digest of `S2SPublicContent`; `author` = `DidEthr`.
- **SPEC-contracts-publication** — `S2SPublicationModule` / `S2SRecordsModule` only. **Neither is an
  append-log contract.** The append-log store the deals read from is **not in any component spec**
  (see §7).
- **SPEC-safe-app** — covers only licenses/whitelist/records/config (publisher control panel).
  **No "deals" view is described** (see §7).

## 7. Spec gaps to flag (don't paper over these)

1. **The append-log contract has no component spec.** INV-append and GAP-1 reference it, SPEC-shared
   references `resolveLatest`/`getHistory`/`VersionRecord`, but there is no SPEC-contracts-* entry
   documenting its entrypoints, storage, access control, or the genesis-vs-append row model. This
   bug is partly a consequence of an undocumented contract. Recommend writing at least a skeleton
   SPEC for it (genesis/append semantics, idempotency, author gate, read model).
2. **The safe-app spec does not cover the deals view.** The deals feature is newer than SPEC-safe-app.
   Once the bug is understood, update SPEC-safe-app (or a new spec) with the deals read model:
   what it queries, how it groups by genesis, what `status:"deal"` / `position` / `postType:"home"`
   mean (none of these are in the specced `S2SContentItem` shape — `status` in particular is
   unexplained; find its enum/origin).
3. **Field-shape drift.** The displayed object (`genesis, author, cid, status, creationDate,
   postType, title, position, tags`) is a **denormalized read model** joining `S2SPublicContent`
   (postType, position, tags, author) + `S2SSecretBody` (title) + a body `cid` + a `genesis` pointer
   + a `status`. It does not match the flat `S2SContentItem` (`public/objectId/proof/encryption/
   secret`). Document where this read model is assembled — likely the culprit for any read-side
   grouping bug and a candidate to single-source into `shared`.

## 8. Open questions to answer (and report back)

- Q1: Does the contract hold any append rows at all, or only genesis rows? (write- vs read-side)
- Q2: What derives `genesis` — deterministic `objectId`, or a per-call value? Why do 3 identical
  rows have 3 different genesis keys?
- Q3: Does the registration path ever call an `append` entrypoint, or always create? Does it
  `resolveLatest` first?
- Q4: Is there an idempotency guard on create (duplicate objectId => no-op or revert)?
- Q5: Is registration wrapped in `withRetry` / re-fired by the UI? (the 3x dupes)
- Q6: Are authors 0x3b246e and 0x953393 the same publication under rotated keys? Does the append
  gate block a rotated key, causing fallback-to-create?
- Q7: Where is the `status:"deal"` value set, and what is its enum? Is it per-row or per-genesis?
- Q8: Is the deals read model grouped by genesis anywhere, or is it a flat list?

## 9. Boundary note

Prof did not read source for this handoff (per user instruction). Everything above is derived from
the 5 data rows + SPEC-00 / SPEC-shared / SPEC-contracts-publication / SPEC-safe-app. Treat the
file/area pointers as "per the specs, likely here — verify" not "it is at line X". When you confirm
or refute a hypothesis, update this file or drop findings in the wiki.
