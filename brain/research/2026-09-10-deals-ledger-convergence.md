# Convergence — Protocol-Wide Deals Ledger: decisions, split, and grounded answers to the architect's four questions

> **Status:** research convergence (design committed, not yet built). Routing: change proposal
> belongs in an RFC when promoted to implementation; this doc is the state-of-record synthesis of
> two corrective research passes. Grounded in code. No code changed, no PR.
> Date: 2026-09-10. Workspace: `/home/joera/code/s2s`.
>
> **Supersedes / corrects:** `brain/research/2026-09-10-protocol-wide-deals-contract.md` where
> that study overstated DoS/censorship/spam/isolation. The two source studies for this convergence:
> `brain/research/2026-09-10-deals-ledger-whitelist-split-design.md` and
> `brain/research/2026-09-10-deals-ledger-dos-spam-risk.md`.

---

## (0) The committed direction

The architect has decided: **lift the deals/agreements part of `S2SPublicationModuleV2` out into a
single protocol-wide agreements ledger** (not called a "marketplace" — but that's the level), so
that any deal is administered **from both the publication POV and the author POV**, and add a
**`getBylines(author)`** primitive. Rationale (architect): the whole system is consultation between
authors and publications; the record of the interaction between the two is "just another signature"
that must exist regardless — so the shared ledger needs to happen anyway.

Two decisive constraints from the architect:
- **Split, don't hoist the whitelist.** Whitelists stay per-publication; the ledger's only whitelist
  dependency is a single read-only staticcall out. "Gates inside the ledger are just another contract
  address to be called."
- **No privileged indexer / no protocol-level deal mutation.** The author index is a derived/enumerable
  view; there is no protocol-level "force-deal / force-retract" write path (that would be the
  marketplace censor button).

---

## (1) Q1 — Do whitelists need to live in the ledger? **No.**

- `acceptOffer` and `retract` **never** use the whitelist — they are bound by
  `onlySafe(publication)` / `genesisAuthor[(publication,genesis)]`.
- Only `makeOffer` touches the whitelist, for two inherited reasons: gating the **first append**
  (`_append` requires `canPublish` on first append) and choosing **deal vs offer**
  (whitelisted/safe → deal, else → offer).
- `makeOffer` can get it via a **read-only `staticcall`** to the per-publication gate's
  `canPublish(author)` (via a `publication → gate` registry). Cold-account touch ≈ 2,600 gas +
  O(100+20) scan — negligible; `staticcall` means the gate cannot mutate ledger state mid-call (no
  reentrancy).
- **Stronger reason to keep it per-publication:** every existing consumer reads the whitelist on the
  per-publication module — `gates.ts::canPublish` (the UPDATE + maintain-cache gate), the safe-app
  whitelist tab, `whitelistAuthor/Dev`. Moving the whitelist would force all of these to re-point for
  zero benefit. **Keeping it per-publication leaves the entire existing gate read-path byte-for-byte
  unchanged.** Move the deal *state*, not the *permission*.
- **Surprise the architect must know:** `makeOffer` is **not actually permissionless today** —
  `_append` reverts `OnlySafe()` on the *first* append of a genesis unless the caller passes
  `canPublish`. The documented "anyone → pending offer" branch is effectively dead for new content.
  The split therefore forces an explicit choice: **keep the gate** (staticcall out, matches current
  behavior) or **relax to permissionless offers** (restores documented behavior, re-introduces spam →
  needs caps). Default recommendation: **keep the gate.**

## (2) Q2 — Does the ledger need to verify the `publication` parameter? **Yes for writes, no for reads.**

Three anchors, increasing strength:
1. **`safeOf[publication]`** — registration registry. Self-proving: `registerPublication` requires
   `publication == msg.sender` (the 4337 publication Safe proves its own identity). Never-registered
   pubs must be rejected by writes.
2. **`genesisAuthor[(publication,genesis)]`** — set from `msg.sender` on first append, immutable
   (INV-append). Anti-forgery: you cannot attribute a genesis to anyone but the caller.
3. **`onlySafe(publication)`** — binds `publication` back to the caller; passing a pub whose
   `safeOf != msg.sender` reverts.

- **Reads** (`hasDeal`, `getLatest`, `getVersion`, `isGenesis`, `authorOf`, `getDeals`, `getOffers`,
  `getBylines`) need **no** verification — append-only lookups; a wrong key yields an empty result,
  no harm. The architect's guess was right.
- **The one genuine vulnerability surface:** `makeOffer` writing under a **never-registered**
  publication (must revert), and **author-index pollution** under a real publication if the first-append
  gate is relaxed (bounded by caps; cannot forge another author's authorship).

## (3) Q3 — Risks of a single contract. **The prior study overstated DoS/censorship; the honest risks are three.**

The architect was right to push back. Honest decomposition (grounded in `threat-model/*`):
- **You cannot "DoS or censor a contract" in the availability sense** — a contract is passive
  state + code; no servers, no uptime, no host to pressure. The real censorship/availability points
  of this stack are all **off-chain**: the CCIP gateway, DNS gateways, IPFS/Filecoin gateways,
  indexers, the Safe-app UI, and — for everything on Base — **Coinbase's single sequencer**, which is
  a property of *every* contract on Base, not of any N-vs-one choice. A shared ledger adds **zero**
  new base-layer censorship.
- **The real, non-overstated risks:**
  - **R1 — Upgrade authority (THE genuine "censorship" vector).** Whoever holds the one
    `_authorizeUpgrade` can mutate *all* publications' deals logic at once (e.g. flip `hasDeal`).
    Mitigations, all protocol-consistent: **frozen after genesis** (mirrors `S2SRecordsModule`, GAP-7),
    **multisig-of-publication-Safes** upgrade gate (authority collective), or **deploy-new + migrate**
    (mirrors how CIDs are replaced, not mutated). No protocol-level force-deal/force-retract.
  - **R2 — Single point of failure.** One bug/freeze bricks all publications' *deal records*. Modest:
    a small append-log with **no custody, no funds, nothing to steal**; content (IPFS/Filecoin) is
    never hostage; a freeze is read-only/recoverable.
  - **R3 — Dependency coupling.** The render gate reads `hasDeal` on the ledger, so a broken ledger
    couples *publishing* across all publications. But the protocol **already** couples to shared
    `configModule`/`ens_records`/shared PKP today — so this is not a novel pattern.
- **Neutrality frame already runs shared infrastructure:** shared controller Safe, shared records
  (C3), shared PKP (INV-12), shared Lit group. Per-publication modules are the exception, not the
  norm. Hoisting the ledger is therefore **not novel centralization**; and under freeze/multisig the
  upgrade authority is *as distributed as or more distributed than* per-publication `onlySafe` today.

## (4) Q4 — Spam. **The architect is right: same as today, not worse.**

- `makeOffer` is **already permissionless per module** today — any address can already flood any
  publication's offer list at gas cost. Per-publication "containment" was **never real** — it is
  *scoping* (each pub sees its own offers), not *containment* (no global pool, no per-pub rate limit).
- In the shared ledger, `publication` is an explicit parameter; a flood offer lands in **that
  publication's** offer set, keyed by `(publication,genesis)`. **No flooding crosses publication
  boundaries.** Identical to today.
- **The only genuinely new spam-adjacent cost:** the maintained per-author `authorDeals[author][]`
  index (Option B) is an unbounded append per author. It is (i) **opt-in**, (ii) cheaply bounded with
  the existing `MAX_*` cap pattern, and (iii) entirely avoidable by deriving bylines **off-chain from
  events** (Option A, zero new state — preferred for the anyone-can-index principle).
- Gas is paid by the caller / paymaster; state-growth is paid-for and paginated (no free on-chain DoS
  on L2).

---

## (5) The split — **recommended: yes, split the two contracts.**

| Concern | Side | Administered by |
|---|---|---|
| Whitelist (`whitelisted_authors/devs`), `canPublish`, whitelist mgmt | **per-publication** (slimmed gate contract) | each publication Safe (`onlySafe`) |
| Publication registration (`safeOf`/`gateOf`) | **shared registry** (one ledger) | each publication self-registers its own row |
| Append log, `genesisAuthor`, deal/offer sets | **shared** | `makeOffer` (gated/permissionless per Q1 decision), `acceptOffer`/`retract` |
| Author index (`authorDeals`), `getBylines` | **shared** | derived from writes; visibility filtered by author (§6b) |
| Ledger upgrade authority | **shared** | protocol decision — freeze / multisig-of-Safes / deploy-new (Q3) |

The split is the **only** arrangement that leaves the existing gate read-path
(`gates.ts::canPublish`, safe-app whitelist tab, update/maintain-cache) untouched. The ledger's only
whitelist dependency is one `staticcall` in `makeOffer`. Cost is confined to the deals read adapters
(`render/main.ts isRevokedByDealState`, `module.factory.ts`, `publication.service.ts`, safe-app deals
tab), all of which already take a `publication`-ish scope and simply re-point to the ledger with a
`publication` arg.

### Implementation gotchas (record for the RFC/handoff)
1. Keep `genesis` as a field even though the ledger keys internally by `(publication,genesis)`;
   `toBytes32Id` converters stay unchanged.
2. Key records by the **publication Safe address**, not the ENS node (`config.domain` already
   decouples the write node from identity).
3. Events add `publication` as an **indexed** field (`Appended`/`DealStruck`/`OfferMade`/`Retracted`)
   so off-chain indexers rebuild bylines without the maintained `authorDeals` index (preserves
   anyone-can-index, derived view — CASE 1).
4. `dealAt`/`offerAt` are **write-only today** (written, never exposed) and `tombstone` is **dead
   storage** (never `true`) — all free to (re)purpose in a fresh ledger.
5. Register the gate's **UUPS proxy address** (stable across implementation upgrades); only a
   *fresh* gate deployment needs `gateOf[publication]` re-pointed by its Safe.

---

## (6) Validated design extensions

### (a) Dual data structures — one record + two indexes (publication-POV and author-POV). Feasible.
- Primary store (unchanged shape, re-keyed): `versions[(publication,genesis)][]`,
  `genesisAuthor[(publication,genesis)]`, `latestIndex`, deal/offer sets — the deal *record* stored
  **once**, publication-scoped.
- Author index: `authorDeals[author] → (publication,genesis)[]` — **lightweight pointers** (2×
  bytes32/address), not copies. `getBylines(author)` dereferences each tuple via
  `versions[(pub,g)][latestIndex]` + `genesisAuthor`.
- Maintenance: push on first append (dedup), swap-pop on author retract; policy on safe demote
  deal→offer (remove from deals index, may reappear on re-acceptance). Cap per-author length.
- Reads from either POV: `getDeals(publication,…)` ← dealList; `getBylines(author)` ← authorDeals.
  Both O(1) + dereference.

### (b) "Right to be forgotten" as author-side visibility control. Achievable — honest framing: a *filter, not deletion*.
- `hiddenByAuthor[(publication,genesis)]` (cleaner than a per-author array; the tuple is unique to
  its author). `getBylines(author)` filters out hidden tuples; author sets/clears on **their own**
  tuples (`msg.sender == genesisAuthor[...]`).
- **Publication side untouched:** `getDeals(publication)` still returns the deal; the CID, version
  log, and `(publication,genesis)` record remain fully on-chain and verifiable.
- On-chain **nothing is deleted** — a visibility preference in the author's aggregate byline view.
  Data remains derivable from events, so it cannot masquerade as true erasure.
- Orthogonal to `retract` (real removal from both views) and `tombstone` (dead storage, never `true`).
- Mirrors the CASE-2 author-asserted byline; only change is moving the author's *curation* on-chain as
  an explicit filter.

### (c) Byline entry schema `{item/genesis, publication, startTimestamp, endTimestamp}`.
- **`startTimestamp` — derivable, no new storage:** "agreement began" maps to **deal-struck time** —
  `dealAt[(publication,genesis)]` is already written (`_addDeal` sets `block.timestamp`) but never
  exposed; expose it. (First-append time is the alternative definition.)
- **`endTimestamp` — NOT derivable from existing storage:** `retract` stores no timestamp; the
  `Retracted` event carries it only in the log (not queryable on-chain). Options: add a
  `retractedAt[(publication,genesis)] = block.timestamp` slot (one slot, cheap) **if** `getBylines`
  must be on-chain self-sufficient; otherwise derive `endTimestamp` off-chain from `Retracted` events
  and keep the contract lean. Recommendation: derive off-chain; add the slot only if on-chain
  self-sufficiency is required.
- `Entry.timestamp` (latest-version time) is neither agreement-start nor agreement-end — the byline
  genuinely needs the two explicit timestamps, not a reuse of `Entry.timestamp`.

---

## (7) Decision list for the architect (open, for the RFC)

1. **`makeOffer` gate:** keep the per-publication `canPublish` gate (staticcall out) vs relax to
   permissionless offers (restore documented behavior + caps). Default: keep the gate.
2. **Registration:** publication Safe self-registers (`publication == msg.sender`, capability-open)
   vs factory-mediated (adds a trusted hop). Default: self-register.
3. **Ledger upgrade authority:** frozen/immutable after genesis vs multisig-of-publication-Safes vs
   deploy-new-and-migrate. Default (protocol-consistent): frozen first version.
4. **Author index:** maintained on-chain `authorDeals` (Option B, O(1), unbounded→cap) vs derived
   off-chain from events (Option A, zero state, anyone-can-index). Default: Option A for the
   verification/derived path; Option B only if on-chain enumeration is required for UIs.
5. **`endTimestamp`:** on-chain slot vs off-chain from `Retracted` events. Default: off-chain.
6. **Migration vs coexistence** (carried from prior study): coexistence = zero replay, two surfaces;
   migration = clean long-term, per-publication-Safe-gated replay. Hybrid read-through not
   recommended. `genesis` (bytes32) and Safe-address identity preserve verbatim under either.

---

## (8) Files / specs relied on

**Source studies:** `2026-09-10-deals-ledger-whitelist-split-design.md`,
`2026-09-10-deals-ledger-dos-spam-risk.md`, `2026-09-10-protocol-wide-deals-contract.md`,
`2026-09-10-portable-byline-convergence.md`, `2026-09-10-external-indexer-trust-model.md`,
`2026-09-10-portable-byline-case2-author-did-surface.md`,
`2026-09-10-portable-author-byline-resolution.md`.

**Contracts:** `S2SPublicationModuleV2.sol` (`makeOffer` L146/L151, `_append` L352/L362,
`canPublish` L280, whitelist slots 6–7 caps 100/20, `_addDeal`/`_removeDeal` swap-pop, `dealAt`/
`offerAt` write-only, `tombstone` dead, `_authorizeUpgrade onlySafe`, UUPS), `S2SPublicationModule.sol`
(V1), `S2SPublicationModuleV2Factory.sol` (`ModuleCreated`, `safeModules`),
`S2SRecordsModule.sol` (immutable `onlySafe` KV, GAP-7), ENSL2nRecords/ENSOpenSubdomainRegistry/
ENSResolverWithCCIP (INV-6/INV-12, untouched).

**Actions/adapters:** `gates.ts` (`canRead`/`canPublish` per-publication gate), `module.factory.ts`
(deals read adapters → move to ledger), `protocol.factory.ts`/`ens.factory.ts` (discovery),
`render/main.ts` (`isRevokedByDealState` → ledger), `update/main.ts` L82, `maintain-cache/main.ts` L80
(unchanged), `render/verify.ts`; `shared/src/protocol/index.ts` (INV-4/INV-2 walk),
`shared/src/identity/verify-content.ts` (`resolveLatest`/`getHistory` stubs → wire to ledger);
`neutralpress/src/publication/publication.service.ts`, `safe-app/src/lib/safe-integration.ts`
(whitelist calls stay per-publication; deal calls move to ledger).

**Specs/threat model:** `SPEC-00-system-contract.md` (INV-2/3/4/6/7/8/10/12, GAP-1/GAP-7, INV-append),
`SPEC-contracts-publication.md`, `SUMMARY-protocol.md`; `threat-model/{README,protocol,publication,
author}.md` (compellable relays, Base sequencer as C-deferred, no single owner);
`whitepaper/01-content-authoring.md` (did:ethr-over-Safe, 4337 paymaster), `06-website-hosting.md`,
`07-domain-resolution.md` (CCIP gateway `[GAP]` SPOF).
