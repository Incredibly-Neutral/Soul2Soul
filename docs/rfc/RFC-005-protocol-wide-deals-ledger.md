# RFC-005 — protocol-wide deals ledger (shared agreements contract + getBylines)

> Domain: `AGREEMENT` · moved from `brain/specs/RFC-protocol-wide-deals-ledger.md` (2026-11-04); number assigned on the move.

> **Type:** design proposal / forward work (an RFC, not a spec). Captures the required behavior for
> lifting the deals/agreements state machine out of the per-publication `S2SPublicationModuleV2` into
> a **single protocol-wide agreements ledger** keyed by `(publication, genesis)`, with both
> publication-POV and author-POV administration and a new `getBylines(author)` primitive. A future
> agent or human can pick it up cold. **Not implemented.** Parked for now; execution deferred to a
> separate handoff session. When built and reviewed, fold the settled outcome into the relevant SPECs
> (`SPEC-publication.md`, `SPEC-00-system-contract.md`) and strike here.
>
> **Pick-up contract:** a `handoffs/handoff-*.md` to be written when this is unparked — the executing
> session starts there; this RFC is the durable proposal + acceptance contract.
>
> **Origin:** joera direction (2026-09-10): "we take the deals/agreements part of pub module out and
> into a smart contract for the entire protocol … any deal gets administered both from pov publication
> as from pov author … and we add a `getBylines(author)` method." Converged in
> `docs/research/2026-09-10-deals-ledger-convergence.md` (state of record) and two corrective source
> studies: `2026-09-10-deals-ledger-whitelist-split-design.md` and
> `2026-09-10-deals-ledger-dos-spam-risk.md` (correcting the earlier
> `2026-09-10-protocol-wide-deals-contract.md`).

---

## Problem

Today every deal/agreement lives **inside** its own per-publication `S2SPublicationModuleV2` UUPS
proxy: the append log (`versions[(genesis)][]`, `latestIndex`, `genesisAuthor[genesis]`), the
deal/offer sets, `makeOffer`/`acceptOffer`/`retract`/`hasDeal`/`getDeals`/`getOffers`, and the
whitelists. Consequences:

- **No cross-publication author view.** There is no way to ask "what is this author involved in?"
  An author that appears in N publications is enumerable only by scanning N modules (or the factory
  event history). The portable-byline work (CASE 2) keeps hitting this gap.
- **Publication-POV only.** Deal administration is scoped to each publication's Safe; there is no
  author-side management surface.
- **N upgrade surfaces.** Each module carries its own `_authorizeUpgrade` (`onlySafe`), N codebases
  to audit/secure, and per-publication deploy cost.

The protocol already runs protocol-wide shared infrastructure (shared controller Safe, shared records
C3, shared PKP per INV-12, shared Lit group); per-publication modules are the exception, not the norm.
This RFC proposes moving the deals/agreements layer into one shared ledger.

**Explicit non-goal:** this is *not* a marketplace. It is a shared, neutral agreements/records
substrate. There is **no** protocol-level "force-deal / force-retract" write path.

---

## Settled design decisions (committed by the architect)

These are locked and must not be silently reversed:

1. **Split — do NOT hoist the whitelist.** `whitelisted_authors`, `whitelisted_devs`, `canPublish`,
   and whitelist management stay in a **slimmed per-publication gate contract**. Only the deal/agreement
   *state machine* moves to the shared ledger. Rationale: this is the only arrangement that leaves the
   existing gate read-path (`gates.ts::canPublish`, safe-app whitelist tab, `update/main.ts`,
   `maintain-cache/main.ts`) byte-for-byte unchanged. "Gates inside the ledger are just another contract
   address to be called."
2. **No privileged indexer / no protocol-level deal mutation.** The author index is a derived/enumerable
   view; there is no protocol-level force-deal/force-retract (the marketplace censor button).
3. **Key records by the publication Safe address**, not the ENS node (`config.domain` already decouples
   the write node from identity).
4. **Author stays the Safe address** (did:ethr-over-Safe); the contract stores addresses, never did
   strings.
5. **`getBylines` is not the portable byline.** The byline (CASE 2) is the author-asserted,
   content-addressed pointer; `getBylines` is chain-derived and comprehensive. They compose — the reader
   verifies the author-asserted byline against `getBylines`/`getLatest` (the three-layer spine).

---

## Required behavior

### The ledger contract (new, shared, keyed by `(publication, genesis)`)

**Moves from each `S2SPublicationModuleV2` into the ledger** (re-keyed by `publication`):
`versions[(publication,genesis)][]`, `latestIndex`, `genesisAuthor[(publication,genesis)]`, the
deal/offer sets (`_isDeal`/`dealList`/`dealPos`/`dealAt`, `_isOffer`/`offerList`/`offerPos`/`offerAt`),
and the methods `makeOffer`, `acceptOffer`, `retract`, `hasDeal`, `hasOffer`, `getDeals`, `getOffers`,
`getDealCount`/`getOfferCount`, `getLatest`, `getVersion`, `getVersionCount`, `isGenesis`, `authorOf`.

**New on the ledger:**

- **`getBylines(author)`** — returns the author's agreements as lightweight pointers
  `(publication, genesis)[]`, dereferenced via `versions[(pub,g)][latestIndex]` + `genesisAuthor`.
  Default substrate: **derived off-chain from events** (Option A, zero new state, preserves
  anyone-can-index); a maintained `authorDeals[author]` index (Option B) is allowed **only** if an
  on-chain O(1) enumeration is explicitly required by a UI (see open confirmations 4).
- **Right-to-be-forgotten as a visibility filter** — `hiddenByAuthor[(publication,genesis)]`
  (bool). `getBylines(author)` filters out hidden tuples; author sets/clears on **their own** tuples
  (`msg.sender == genesisAuthor[(publication,genesis)]`). This is a *filter, not deletion*: the
  publication side (`getDeals(publication)`) is untouched; on-chain nothing is removed; the data
  remains derivable from events. Document as a byline-view preference, not erasure.
- **Byline timestamps** — the byline entry carries `{item/genesis, publication, startTimestamp,
  endTimestamp}`:
  - `startTimestamp` = **deal-struck time** (`dealAt[(publication,genesis)]` — already written by
    `_addDeal`, never exposed today; expose it). No new storage.
  - `endTimestamp` = **not derivable from existing storage** (`retract` stores no timestamp; the
    `Retracted` event carries it only in the log). Default: derive off-chain from `Retracted` events.
    Add a `retractedAt[(publication,genesis)] = block.timestamp` slot **only if** `getBylines` must be
    on-chain self-sufficient (open confirmation 5).
- **`publication` as an indexed event field** on `Appended`/`DealStruck`/`OfferMade`/`Retracted`, so
  off-chain indexers rebuild bylines without the maintained `authorDeals` index.

**Registration / verification (see Q2 in the convergence doc):**
- `registerPublication(publication, gate)` requires **`publication == msg.sender`** (the 4337
  publication Safe proves its own identity — capability-open, no trusted hop). Writes reject a
  never-registered publication.
- `genesisAuthor[(publication,genesis)]` set from `msg.sender` on first append, immutable
  (INV-append) — anti-forgery.
- `acceptOffer`/`retract` bound by `onlySafe(publication)` / `genesisAuthor[(publication,genesis)]`.
- Reads (`hasDeal`, `getLatest`, `getVersion`, `isGenesis`, `authorOf`, `getDeals`, `getOffers`,
  `getBylines`) need **no** `publication` verification — append-only lookups; wrong key → empty result.

**The whitelist dependency — one staticcall:**
- Only `makeOffer` touches the whitelist. The ledger staticcalls the per-publication gate's
  `canPublish(author)` (read-only, no reentrancy, ~2.6k gas + O(100+20) scan) to (i) gate the first
  append and (ii) choose deal vs offer. `acceptOffer`/`retract` never use the whitelist.

**Upgrade authority (governance):** default is **frozen/immutable after genesis** (mirrors
`S2SRecordsModule`, GAP-7); alternatives are multisig-of-publication-Safes or deploy-new-and-migrate
(mirrors CID replacement). No protocol-level deal-mutation write path. See open confirmation 3.

### The slimmed per-publication gate contract

Retains `safe`, `whitelisted_authors` (cap 100), `whitelisted_devs` (cap 20), `canPublish`,
`isWhitelistedAuthor`/`isWhitelistedDev`, `whitelistAuthor`/`removeWhitelistedAuthor`/
`whitelistDev`/`removeWhitelistedDev`, `NAME()`, `initialize`, `_authorizeUpgrade`, `MAX_*`. Its
external read surface (`canPublish` etc.) is unchanged so `gates.ts`, the safe-app whitelist tab, and
whitelist administration keep working unmodified.

### Adapter re-pointing

Deals reads move to the ledger with a `publication` arg:
`render/main.ts isRevokedByDealState`, `module.factory.ts getDeals/getLatestEntry/getVersion`,
`publication.service.ts getDeals/getOffers/hasDeal`, safe-app deals tab. Whitelist calls stay on the
per-publication gate. Discovery: `protocol.factory.ts getProtocolInfo` reads a `deals_contract` record
(INV-2 key set / configModule precedent).

### Migration vs coexistence

Carried from the prior study — a separate decision (open confirmation 6). Coexistence (keep existing
V2 modules, new pubs on the shared ledger) = zero replay, two surfaces everywhere. Migration (replay
each module's log into the ledger, gated per publication Safe) = clean long-term. `genesis` (bytes32)
and Safe-address identity preserve verbatim under either. Hybrid read-through not recommended.

---

## Acceptance contract (for the executing session)

1. A new shared ledger contract exposes `makeOffer`/`acceptOffer`/`retract`/`hasDeal`/`getDeals`/
   `getOffers`/`getLatest`/`getVersion`/`getVersionCount`/`isGenesis`/`authorOf` keyed by
   `(publication, genesis)`, matching the semantics of the current per-publication `S2SPublicationModuleV2`
   for a single publication.
2. `registerPublication(publication, gate)` reverts unless `publication == msg.sender`; writes to a
   never-registered `publication` revert; `genesisAuthor[(publication,genesis)]` is immutable after
   first append and always equals the first-append caller.
3. `makeOffer` gates the first append via a **staticcall** to the per-publication gate's
   `canPublish(author)`; `acceptOffer`/`retract` require `onlySafe(publication)` /
   `genesisAuthor[(publication,genesis)]` and make **no** external calls (no reentrancy).
4. `getBylines(author)` returns that author's agreements from both a maintained index (if Option B is
   adopted) and/or is reconstructible off-chain from events with `publication` indexed (Option A);
   hidden tuples (right-to-be-forgotten) are excluded from `getBylines` but remain in `getDeals`.
5. The existing gate read-path is unchanged: `gates.ts::canPublish`, the safe-app whitelist tab, and
   `update`/`maintain-cache` run without modification against the slimmed gate contract.
6. Invariants preserved: INV-3 (append-only, declaration order locked — ledger is a fresh deployment),
   INV-12 (only the PKP writes the root — the ledger is a distinct third store, never PKP-write), the
   two-record-store / capability-open / authority-collective posture from `SUMMARY-protocol.md`.
7. Standard gates green (test / lint / typecheck) on the contracts and adapters; the ledger contract
   has comprehensive tests (it is the single failure domain). Independent review before the human
   merges.

---

## Open confirmations to resolve (decision list, carried from the convergence doc §7)

1. **`makeOffer` gate:** keep the per-publication `canPublish` gate (staticcall out) **vs** relax to
   permissionless offers (restores the *documented* behavior, re-introduces spam → needs caps). Default:
   **keep the gate.** (Note: `makeOffer` is NOT permissionless today — `_append` reverts `OnlySafe()` on
   the first append unless the caller passes `canPublish`; the "anyone → pending offer" branch is dead
   for new content.)
2. **Registration:** publication Safe self-registers (`publication == msg.sender`) vs factory-mediated
   (adds a trusted hop). Default: **self-register.**
3. **Ledger upgrade authority:** frozen/immutable after genesis vs multisig-of-publication-Safes vs
   deploy-new-and-migrate. Default: **frozen first version.**
4. **Author index:** maintained on-chain `authorDeals` (Option B, O(1), unbounded → cap) vs derived
   off-chain from events (Option A, zero state, anyone-can-index). Default: **Option A** for the
   verification/derived path; Option B only if on-chain enumeration is required for UIs. If Option B is
   adopted, bound the per-author array (existing `MAX_*` cap pattern) and maintain it on
   offer/accept/retract with dedup.
5. **`endTimestamp`:** on-chain `retractedAt` slot vs off-chain from `Retracted` events. Default:
   **off-chain.**
6. **Migration vs coexistence** (replay vs two surfaces). Default for a parked RFC: leave open; both
   preserve `genesis` and Safe identity verbatim.
7. **Dependency coupling guard:** whether the render gate needs a read-through fallback / last-known-good
   cache on the ledger (R3 in the risk register), given a frozen ledger makes a bug permanent-but-harmless
   and content is never hostage.

---

## Behavioral gotchas to confirm

- **`makeOffer` is not permissionless today** (`_append` first-append gate) — the split forces an
  explicit keep-vs-relax decision (open confirmation 1). This is the load-bearing whitelist coupling.
- **`tombstone` is dead storage** — `_append` always writes `tombstone: false` and nothing ever sets it
  `true` (`S2SPublicationModuleV2.sol` L362). Do not assume a tombstone-based "ended" marker exists.
- **`dealAt`/`offerAt` are write-only** — written by `_addDeal`/`_addOffer`, never exposed. Free to
  (re)purpose; `dealAt` is the byline `startTimestamp`.
- **Key records by the publication Safe address** (matches `getDomainOwnerAndModules`), not the ENS node.
- **Register the gate's UUPS proxy address** (stable across implementation upgrades); only a *fresh* gate
  deployment needs `gateOf[publication]` re-pointed by its Safe. A Byzantine gate only DoSes that
  publication's own `makeOffer` (self-inflicted, bounded) — it cannot cross publication scope.
- **Keep `genesis` as a field** even though the ledger keys internally by `(publication,genesis)`;
  `toBytes32Id` converters stay unchanged (minimize adapter churn).
- **Fresh deployment ⇒ no existing slots to preserve** — define declaration order once and lock it
  (INV-3 discipline); no conflict with existing gate-module slots.

---

## Working notes for the implementer

- **Components:** `protocol/contracts/contracts/` — new ledger contract (e.g. `S2SDealsLedger.sol` or
  similar) + slimmed `S2SPublicationModuleV2` (or a split-out gate); `protocol/actions/src/libs/`
  (`gates.ts`, `module.factory.ts`, `protocol.factory.ts`), `render/main.ts`, `update/main.ts`,
  `maintain-cache/main.ts`; `shared/src/protocol/index.ts` + `shared/src/identity/verify-content.ts`
  (`resolveLatest`/`getHistory` stubs → wire to the ledger's `getBylines`/`getLatest`);
  `neutralpress/src/publication/publication.service.ts`; `safe-app/src/lib/safe-integration.ts`
  (whitelist calls stay per-publication; deal calls move to ledger).
- A fresh worktree on a feature branch; own PR; drive the standard gates green; get an **independent
  review** before the human merges. This RFC is parked — do not start until a handoff is written and
  the pick-up contract is set.
- Grounding (state of record): `docs/research/2026-09-10-deals-ledger-convergence.md`,
  `2026-09-10-deals-ledger-whitelist-split-design.md`, `2026-09-10-deals-ledger-dos-spam-risk.md`,
  `2026-09-10-protocol-wide-deals-contract.md`, `2026-09-10-portable-byline-convergence.md`,
  `2026-09-10-external-indexer-trust-model.md`, `2026-09-10-portable-byline-case2-author-did-surface.md`,
  `2026-09-10-portable-author-byline-resolution.md`.
- Do not loosen C3/INV-12 to give the author write access; route any author-side write through the
  protocol-consistent boundary (neutral PKP action gated on author ownership) if it ever arises.
