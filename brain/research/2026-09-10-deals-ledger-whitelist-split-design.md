# Findings — Protocol-Wide Deals Ledger: Whitelist-in-Ledger vs Split, publication verification, and three design extensions

> **Scope:** read-only research. No code changed, no PR. Purpose: answer the architect's four
> precise questions about taking the deals/agreements part of `S2SPublicationModuleV2` out into a
> **single shared protocol-wide ledger**, before any spec is written. Grounded in the actual code:
> `protocol/contracts/contracts/S2SPublicationModuleV2.sol` (and V1), `S2SRecordsModule.sol`,
> `S2SPublicationModuleV2Factory.sol`; `protocol/actions/src/libs/gates.ts`, `libs/module.factory.ts`,
> `libs/protocol.factory.ts`, `libs/ens.factory.ts`, `render/main.ts`, `update/main.ts`,
> `maintain-cache/main.ts`; `shared/src/protocol/index.ts`; `neutralpress/src/publication/
> publication.service.ts`; `safe-app/src/lib/safe-integration.ts`. Prior study:
> `brain/research/2026-09-10-protocol-wide-deals-contract.md`. Date: 2026-09-10.

---

## (0) Thesis

**Split the two contracts — do not move the whitelist into the ledger.** Keep `whitelisted_authors`,
`whitelisted_devs`, and `canPublish` (plus whitelist management and publication registration) in a
**slimmed per-publication gate contract**, and move only the deals/agreements *state machine* — the
append log, `genesisAuthor`, the deal/offer sets, and the new author index (`getBylines`) — into a
single shared ledger keyed by `publication`. This is the only arrangement that leaves the **entire
existing gate read-path unchanged**: `gates.ts::canPublish` (the UPDATE and maintain-cache gate),
the safe-app whitelist tab, and the whitelist administration all read `canPublish`/whitelist on the
**per-publication module** today, and they keep doing so in the split. The shared ledger's one
whitelist dependency — `makeOffer` deciding "deal vs offer" and gating the first append — is a single
read-only **staticcall out to the per-publication gate's `canPublish(author)`**, via a new
`publication → gate` registry. `acceptOffer` and `retract` need **no whitelist at all** (they are
bound by `safeOf[publication]` / `genesisAuthor[(publication,genesis)]`).

The one genuine code-level surprise the human must know: **`makeOffer` is not actually permissionless
today.** `_append` reverts `OnlySafe()` on the *first* append of a genesis unless the caller passes
`canPublish` (whitelisted author / dev / safe). The "anyone → pending offer" branch is effectively
dead for new content. This tightens the whitelist's role: it *is* the new-content gate, not just a
deal-vs-offer switch — and it makes the staticcall-out (or an explicit decision to relax the gate)
mandatory for any split.

---

## (1) Q1 — Do whitelists need to live in the shared ledger? (Answer: no — but see the makeOffer coupling)

### 1.1 Where the whitelist lives and who reads it today

Storage: `whitelisted_authors[]` (cap `MAX_WHITELISTED_AUTHORS = 100`) and `whitelisted_devs[]`
(cap `MAX_WHITELISTED_DEVS = 20`) on the **per-publication** `S2SPublicationModuleV2`, slots 6–7
(INV-3 declaration order). Managed `onlySafe` by `whitelistAuthor`/`removeWhitelistedAuthor`/
`whitelistDev`/`removeWhitelistedDev` (each `onlySafe`), initialized in `initialize` from the
factory-deployed author/dev arrays. `canPublish(address)`: `addr == safe || in devs || in authors`.

Every consumer reads the whitelist **on the per-publication module address** — none read a shared
store, because none exists:

| Consumer | Function | Side read | Read target |
|---|---|---|---|
| Contract, first append | `_append` → `canPublish(author)` | per-publication (internal) | same module's whitelist |
| Contract, deal-vs-offer | `makeOffer` → `_inArray(whitelisted_authors, msg.sender)` | per-publication (internal) | same module's whitelist |
| Gate reads | `canPublish`/`isWhitelistedAuthor`/`isWhitelistedDev` | per-publication (external view) | module |
| Actions — UPDATE + maintain-cache gate | `gates.ts::canPublish` → `evmRead(L2, publicationModule, "canPublish", [authorSafeAddress])` | **per-publication** | module resolved by `getDomainOwnerAndModules` |
| Actions — RENDER gate | `gates.ts::canRead` → `canPublish(safeAddress)` **and** `hasDeal(genesis)` | per-publication | module (see note below) |
| safe-app whitelist tab | `safeIntegration.canPublish` / `whitelistAuthor` / `whitelistDev` | per-publication | module (`this.publicationModule`) |
| neutralpress | `publication.service` `makeOffer`/`acceptOffer`/`retract`/`hasDeal` | per-publication | module (`getModuleAdresses`) |

`module.factory.ts` `getDeals`/`getLatestEntry`/`getVersion` and `render/main.ts`
`isRevokedByDealState` (`hasDeal`) read the **module** too, but those are *deals* reads (they move
with the ledger), not whitelist reads.

**Key fact:** the publish/update gate that governs *who may drive a render* is `gates.ts::canPublish`,
which calls the **per-publication module's `canPublish`** via `evmRead`. So the render/publish gate is
already keyed to the per-publication module. Keeping the whitelist there means `gates.ts`, `update/
main.ts`, `maintain-cache/main.ts`, and the safe-app whitelist tab are **byte-for-byte unchanged**.
Moving the whitelist into the ledger would *force* all of these to re-point at the shared ledger (or
introduce an inverted staticcall back to it) for zero benefit — and would break the render gate that
depends on `canPublish` living on the per-publication contract.

### 1.2 Which shared-ledger operations actually need the whitelist?

- `acceptOffer(publication, genesis)` — `onlySafe(publication)` (`msg.sender == safeOf[publication]`).
  **No whitelist.**
- `retract(publication, genesis)` — `msg.sender == genesisAuthor[(publication,genesis)] ∨ safeOf[publication]`.
  **No whitelist.**
- `makeOffer(publication, genesis, cid)` — **needs the whitelist**, for two reasons inherited from the
  current contract: (i) gating the **first append** (`_append`: first-append caller must pass
  `canPublish`), and (ii) choosing **deal vs offer** (whitelisted/safe → deal; else → offer).

So only `makeOffer` touches the whitelist. It can get it either (a) by holding `whitelisted_authors
[publication][]` in the ledger, or (b) by a **read-only staticcall** to the per-publication gate's
`canPublish(author)`. Option (b) keeps a single source of truth and leaves every existing reader
intact.

### 1.3 Staticcall mechanics (option b)

- **Registry:** the ledger needs `gateOf[publication]` (and/or `safeOf[publication]`) — who registers,
  see §3.2. On `makeOffer`, the ledger does `gate.canPublish(msg.sender)` via a `staticcall` (or a
  typed interface marked `view`), so the gate can **not** mutate ledger state mid-call → no
  reentrancy from the gate.
- **Gas:** cold-account touch ≈ 2,600 gas + calldata + the gate's O(n) linear scan (author cap 100 +
  dev cap 20). Negligible next to the append storage write. No amplification risk.
- **What if the module address changes/upgrades?** The gate is a **UUPS proxy** — the *proxy address*
  is stable across implementation upgrades (`_authorizeUpgrade onlySafe` swaps the implementation,
  not the address). So the ledger should register the **proxy address** once and never need to update
  it on upgrade. If the gate is ever *re-deployed fresh* (new address), the publication Safe must
  re-point `gateOf[publication]`. A publication that self-registers controls its own gate pointer, so
  a "malicious gate that reverts" only DoSes that publication's own `makeOffer` — bounded, self-inflicted.
- **Do not trust the gate for cross-publication effects:** a publication could register a gate that
  returns `false` always (own deals become un-creatable) or `true` always (own offers auto-deal). Both
  are scoped to that publication; neither can touch another publication's tuples because
  `genesisAuthor`/`safeOf` are keyed by the caller's `publication` argument.

### 1.4 Verdict for Q1

**The whitelist does not need to move into the ledger.** `acceptOffer`/`retract` never use it; `makeOffer`
uses it and can staticcall the per-publication gate. More strongly: **keeping it per-publication is the
only way to leave the existing gate read-path (`gates.ts`, safe-app whitelist tab, whitelist
administration) untouched.** Move only the deal *state*, not the *permission*.

---

## (2) Q2 — Does the shared ledger need to verify the `publication` parameter? (Answer: yes for writes, no for reads)

A shared ledger has no implicit scope — `publication` becomes a first-class argument. Its integrity
comes from exactly three anchors, in increasing strength:

1. **`safeOf[publication]`** — the registration registry, set at `registerPublication` time. Trusted
   **only if registration is self-proving**: `registerPublication(publication, gate)` must require
   `publication == msg.sender` (the publication Safe calls with itself as `publication`, so
   `msg.sender` proves it). If registration is instead protocol- or factory-mediated, that trusted
   third party becomes the anchor. A never-registered `publication` must be rejected by writes.
2. **`genesisAuthor[(publication, genesis)]`** — set from `msg.sender` on first append (INV-append),
   immutable thereafter. This is the anti-forgery anchor: you can never attribute a genesis to anyone
   but the caller, so you cannot forge *another author's* authorship under a forged publication.
3. **`onlySafe(publication)`** — `msg.sender == safeOf[publication]`, which binds `publication` back
   to the caller. Any caller passing a `publication` whose `safeOf` ≠ `msg.sender` reverts.

### 2.1 Verification matrix (every method that takes `publication`)

| Method | Trust/integrity source | Wrong/forged `publication` outcome | Vulnerability? |
|---|---|---|---|
| `registerPublication(publication, gate)` | must require `publication == msg.sender` | forged pub → revert (or ledger would let attacker become its "safe") | **must enforce** — this is the root of trust |
| `makeOffer(publication, genesis, cid)` | `gateOf[publication]` must exist (registered); `genesisAuthor[(publication,genesis)] = msg.sender` on first append; first-append gated by `gate.canPublish(msg.sender)` | unregistered pub → must revert (no gate to consult); registered pub + caller not whitelisted → first-append reverts (current semantics); registered pub + whitelisted → entry created under the *real* pub, author = caller | **write + author-index surface** — see §2.2 |
| `acceptOffer(publication, genesis)` | `onlySafe(publication)` | `safeOf[other] != msg.sender` → revert | none (bound to caller) |
| `retract(publication, genesis)` | `genesisAuthor[(publication,genesis)] == msg.sender ∨ msg.sender == safeOf[publication]` | wrong pub → mapping miss → revert | none (bound to caller) |
| `hasDeal(publication, genesis)` | none (pure read) | empty/false | none |
| `getLatest(publication, genesis)` / `getVersion` / `getVersionCount` | none (pure read) | empty / bounds revert | none |
| `isGenesis(publication, genesis)` / `authorOf(publication, genesis)` | none (pure read) | `false` / `0` | none |
| `getDeals(publication, offset, limit)` / `getDealCount` | none (pure read) | empty | none |
| `getOffers(publication, …)` / `getOfferCount` | none (pure read) | empty | none |
| `getBylines(author)` | keyed by **author**, no `publication` arg | n/a | none |

### 2.2 The one genuine vulnerability surface: `makeOffer` + the author index

Because `genesisAuthor[(publication,genesis)]` is always set from `msg.sender`, no caller can forge
someone else's authorship. The real griefing vectors are:

- **Unregistered-publication pollution:** if `makeOffer` does **not** reject a `publication` that was
  never registered, an attacker can create genesis entries and author-index tuples under arbitrary
  (never-registered) publication keys — writing state that no real publication owns. Fix: `makeOffer`
  must revert when `gateOf[publication]`/`safeOf[publication]` is unset (or when the gate-staticcall
  can't be satisfied).
- **Author-index pollution under a *real* publication:** if the first-append whitelist gate is
  relaxed to "anyone may pend an offer" (to restore the *documented* permissionless `makeOffer`), an
  attacker can push `(realPub, bogusGenesis)` tuples into `authorDeals[attacker]` and the real
  publication's offer log. Impact: global offer/author-index spam (the prior study's §b.2-4 concern),
  plus polluting the *attacker's own* byline with junk. It cannot attribute to a victim, but it
  bloats enumeration. Bounds needed: per-publication offer cap, per-author byline cap, or keep the
  first-append gate (`gate.canPublish`) — the current code already keeps it, which is the safer default.
- **`acceptOffer`/`retract` are safe by construction** — both are bound to the caller via
  `onlySafe(publication)`/`genesisAuthor`, so a forged `publication` simply reverts.

**Rule to write into the spec:** *writes* (`makeOffer`, `acceptOffer`, `retract`, `registerPublication`)
must bind `publication` to the caller (registry + `genesisAuthor`/`safeOf`); *reads* (`hasDeal`,
`getLatest`, `getVersion`, `isGenesis`, `authorOf`, `getDeals`, `getOffers`, `getBylines`) need no
verification because they are append-only lookups and cannot mutate or grief.

---

## (3) Q3 — Can we split the two contracts? (Answer: yes — recommended)

### 3.1 The split, precisely

**Stays per-publication — the slimmed gate contract** (holds `safe`, `whitelisted_authors`,
`whitelisted_devs`, `canPublish`, `isWhitelistedAuthor/Dev`, `whitelistAuthor`/`removeWhitelistedAuthor`/
`whitelistDev`/`removeWhitelistedDev`, `NAME()`, `initialize`, `_authorizeUpgrade`, `MAX_*`):

**Moves to the shared ledger** (keyed by `publication`): `versions[(publication,genesis)][]`,
`latestIndex`, `genesisAuthor[(publication,genesis)]`, `_isDeal`/`dealList`/`dealPos`/`dealAt`,
`_isOffer`/`offerList`/`offerPos`/`offerAt`, `makeOffer`, `acceptOffer`, `retract`, `hasDeal`,
`hasOffer`, `getDeals`, `getOffers`, `getDealCount`/`getOfferCount`, `getLatest`, `getVersion`,
`getVersionCount`, `isGenesis`, `authorOf`, plus new `authorDeals`/`getBylines` and the
`publication → gate/safe` registry.

### 3.2 (a) Is the split architecturally sound given the gate flow? — Yes

The decisive fact is which side each gate reads:

- **`gates.ts::canPublish` (UPDATE + maintain-cache gate)** reads `canPublish` on the **per-publication
  module** via the address from `getDomainOwnerAndModules`. In the split this address still points at
  the slimmed gate contract which still exposes `canPublish` → **this gate flow does not change at all.**
- **safe-app whitelist tab** (`s2s-whitelist-tab.ts` → `safeIntegration.canPublish`/`whitelistAuthor`/
  `whitelistDev`) also targets the per-publication module → unchanged.
- **RENDER gate** (`gates.ts::canRead`) calls both `canPublish(safeAddress)` (stays per-publication)
  **and** `hasDeal(genesis)` (moves to the ledger). `render/main.ts::isRevokedByDealState` reads
  `hasDeal` from the module today → must read the **ledger** with a `publication` arg.
- **Deals data reads** (`module.factory.ts` `getDeals`/`getLatestEntry`/`getVersion`,
  `publication.service.ts` `getDeals`/`getOffers`/`hasDeal`) move to the ledger (add `publication`).

So the split cleanly separates "who may publish" (stays per-publication, gate flow untouched) from
"what deals exist / who authored what" (moves to the ledger). That is exactly the seam the prior study
wanted. The cost is confined to the *deals read adapters* (render `hasDeal`, `module.factory`, safe-app
`getDeals`/`getOffers`), all of which already take a `publication`-ish scope and simply re-point.

### 3.3 (b) What the ledger needs from the per-publication side

A registry **`publication → gate contract`** (and `safeOf[publication]`), so the ledger can
(1) staticcall `gate.canPublish(author)` in `makeOffer` and (2) enforce `onlySafe(publication)` in
`acceptOffer`/whitelist. **Who registers:** recommendation is **self-registration by the publication
Safe** — `registerPublication(publication, gate)` with `publication == msg.sender` (the 4337 Safe is
`msg.sender`, so it proves its own identity, preserving "capability open, authority collective").
Alternative: the factory registers on the Safe's behalf (adds a trusted hop, as the prior study noted).

### 3.4 (c) Gas / reentrancy / upgrade gotchas of the cross-contract read

- **Reentrancy:** the ledger's cross-contract read is a **`staticcall` (view-only)** to `canPublish`;
  the gate cannot mutate ledger state mid-call. `acceptOffer`/`retract` make **no external calls**.
  No reentrancy surface. Keep CEI (check `gateOf` exists → staticcall → then write).
- **Gas:** cold gate ~2,600 gas + calldata + O(100+20) scan. Negligible.
- **Upgrade:** register the gate's **UUPS proxy address** (stable across implementation upgrades). If
  a gate is replaced by a *new* deployment, its Safe updates `gateOf[publication]`. The ledger's own
  upgrade authority is a separate governance decision (protocol-controller vs frozen — see prior study
  §e.4); a frozen first version is the most protocol-consistent.
- **Byzantine gate:** a publication's own gate misbehaving only DoSes that publication's `makeOffer`;
  it cannot cross-scope because `genesisAuthor`/`safeOf` are keyed by the caller's `publication`.
- **`makeOffer` permissionless drift (must decide):** current `_append` requires `canPublish` on first
  append, so the "anyone → offer" branch is dead for new genesis. The split forces an explicit choice:
  keep the gate (staticcall, matches current behavior) or intentionally relax to permissionless offers
  (restores documented behavior, re-introduces the §2.2 spam risk → add caps).

### 3.5 (d) What must be shared vs per-publication (administration map)

| Concern | Side | Administered by |
|---|---|---|
| Whitelist (`whitelisted_authors/devs`), `canPublish` | **per-publication** | each publication Safe (`onlySafe`) |
| Publication registration (`safeOf`/`gateOf`) | **shared registry** (one ledger) | each publication self-registers its own row |
| Append log, `genesisAuthor`, deal/offer sets | **shared** | `makeOffer` (permissionless-or-gated), `acceptOffer`/`retract` (`onlySafe(publication)` / `genesisAuthor`) |
| Author index (`authorDeals`), `getBylines` | **shared** | derived from writes; visibility filtered by author (§4b) |
| Ledger upgrade authority | **shared** | protocol decision (see prior study §e.4) |

### 3.6 Recommendation

**Split.** It preserves the per-publication neutrality of *who may publish* (the whitelist and the
render/publish gate stay where they are and where every existing reader already points), while giving
the cross-publication author/enumeration substrate (`genesisAuthor`, deal log, `authorDeals`,
`getBylines`) a single home. Moving the whitelist into the ledger would be *more* disruptive to the
existing gate path and concentrate the *permission* state (not just the deal data) into the one
contract — the opposite of what the protocol's neutrality posture wants. The ledger's only whitelist
dependency is the one staticcall in `makeOffer`.

---

## (4) Q4 — Validate the three design extensions

### 4.1 (a) Dual data structures (deals indexed by publication AND by author)

**Feasible — this is the standard "one record + two indexes" pattern, not data duplication.**

- **Primary store (unchanged shape, re-keyed):** `versions[(publication,genesis)][]`,
  `genesisAuthor[(publication,genesis)]`, `latestIndex`, and the deal/offer sets — the deal *record*
  is stored **once**, publication-scoped (as `getDeals` reads it).
- **Author index:** `authorDeals[author] → (publication, genesis)[]` — a list of **lightweight
  pointers** (2× bytes32/address per entry), not copies of the record. `getBylines(author)` dereferences
  each tuple via `versions[(pub,g)][latestIndex]` + `genesisAuthor`, exactly as `getDeals` does today.
- **Maintenance:**
  - `makeOffer` first-append → push `(publication, genesis)` into `authorDeals[msg.sender]` if not
    already present (dedup check to prevent retract-then-re-offer double-listing).
  - `acceptOffer` → no author-index change (the tuple was added at first append).
  - `retract` (author full withdrawal) → swap-pop the tuple from `authorDeals[author]`.
  - `retract` (safe demotes deal→offer) → policy decision: a demoted-to-offer is no longer an
    *accepted* agreement, so remove it from the deals index (it may reappear on re-acceptance).
  - Cap the per-author list length to bound the dedup scan and enumeration gas.
- **INV-3 discipline:** the ledger is a **fresh deployment** — there are no existing slots to preserve,
  so define the declaration order once and lock it (document slot order, never reorder). No conflict
  with the existing per-publication gate module's slots (those stay as-is). Note the GAP-7 asymmetry
  (frozen vs upgradeable) resurfaces for the ledger; a frozen first version is the protocol-consistent
  default.
- **Read from either POV:** `getDeals(publication,…)` ← dealList; `getBylines(author)` ← authorDeals.
  Both O(1) + dereference, bounded.

### 4.2 (b) "Right to be forgotten" as author-side visibility control

**Achievable on-chain, and must be framed honestly as a *byline-view preference*, not deletion.**

- **Mechanism:** `authorHidden[author][]` (or a per-tuple flag `hiddenByAuthor[(publication,genesis)]`,
  which is cleaner because the tuple is unique to its author). `getBylines(author)` filters out hidden
  tuples. The author sets/clears it on their **own** tuples (`msg.sender ==
  genesisAuthor[(publication,genesis)]`).
- **The publication side is untouched:** `getDeals(publication)` still returns the deal; the content
  CID, the version log, and the `(publication,genesis)` record remain fully on-chain and verifiable.
  "Hidden" changes **only** what `getBylines(author)` enumerates for that author.
- **Honest framing:** on-chain **nothing is deleted** — this is a visibility preference in the author's
  aggregate byline view, not a removal. It must be documented and implemented as a *filter*, and the
  data remains independently derivable from events (`DealStruck`/`Appended` with `author` indexed +
  new `publication` indexed), so it cannot masquerade as true erasure.
- **Interaction with tombstone/retract:**
  - `retract` already removes the tuple from the deal set (and `authorDeals`) — a real state change;
    the agreement no longer exists and is gone from both views.
  - **`tombstone` is currently dead storage** — `_append` always writes `tombstone: false` and nothing
    ever sets it `true` (verified: the only `tombstone` write in `S2SPublicationModuleV2.sol` is
    `tombstone: false` at line 362). Do not assume a tombstone-based "ended" marker exists; it does not.
  - "Hidden" is orthogonal to both: it applies to *active* agreements the author no longer wishes to
    showcase; `retract` is the real removal; `tombstone` is an unused legacy field.
- This mirrors the CASE-2 byline (author-asserted index doc) — the only change is moving the author's
  *curation* (the exclusion) on-chain as an explicit filter, which is honest and cheap.

### 4.3 (c) Byline entry schema `{item/genesis, publication, startTimestamp, endTimestamp}`

- **`startTimestamp` — derivable, but define WHICH start.** Two candidates already exist:
  - First-append time: `versions[(publication,genesis)][0].timestamp` (when the author first submitted).
  - Deal-struck time: `dealAt[(publication,genesis)]` — **already written** (`_addDeal` sets
    `dealAt[g] = block.timestamp`) but **never exposed by any reader today** (it is written and
    deleted, never returned). "Agreement began" maps most naturally to deal-struck → expose `dealAt`.
  No new storage needed for `start`; pick one and document it.
- **`endTimestamp` — NOT derivable from existing storage.** `retract` stores no timestamp; the
  `Retracted` event carries `block.timestamp` only in the log, which is **not queryable on-chain**. So
  an on-chain `endTimestamp` requires **new storage**: either store `retractedAt[(publication,genesis)]
  = block.timestamp` on retract (one slot, cheap), or write a tombstoned record carrying the end time.
  Do **not** rely on `Version.tombstone` — it is never set `true` today (§4.2).
- **Deriving end off-chain is free:** an indexer reconstructs `endTimestamp` from the `Retracted`
  event. So: if `getBylines` must return `endTimestamp` on-chain, add the slot; if the byline is
  assembled off-chain from events, no storage change is needed. Recommendation: add the retract-time
  slot only if `getBylines` is required to be on-chain self-sufficient; otherwise derive from events
  and keep the contract lean.
- Note the current `Entry` carries only the **latest-version** timestamp (`versions[g][latestIndex].
  timestamp`), which is neither agreement-start nor agreement-end — so the byline schema genuinely
  needs the two explicit timestamps above, not a reuse of `Entry.timestamp`.

---

## (5) Files / functions relied on (grounding)

**Contracts (`protocol/contracts/contracts/`)**
- `S2SPublicationModuleV2.sol` — `whitelisted_authors`/`whitelisted_devs` (slots 6–7, INV-3),
  `canPublish` (L280), `_append` (first-append gate `canPublish(author)`, L352; `genesisAuthor[genesis]
  = author`; `tombstone: false` always, L362), `makeOffer` (L146, deal-vs-offer via
  `_inArray(whitelisted_authors, msg.sender)` L151), `acceptOffer` (onlySafe), `retract`
  (safe ∨ genesisAuthor), `whitelistAuthor`/`removeWhitelistedAuthor`/`whitelistDev`/
  `removeWhitelistedDev` (onlySafe, caps 100/20), `_addDeal`/`_removeDeal`/`_addOffer`/`_removeOffer`
  (swap-pop; `dealAt`/`offerAt` written but unread), `_page`, `NAME()`, `_authorizeUpgrade`.
- `S2SPublicationModule.sol` (V1) — same whitelist/canPublish shape (`grantLicense`/`acceptLicense`/
  `revokeLicense`), backwards-compat discovery.
- `S2SPublicationModuleV2Factory.sol` — `createModule`/`createModuleEmpty`/`setImplementation`,
  `safeModules`, `ModuleCreated` (per-publication deployment; a `publication→gate` registry in the
  ledger would parallel this).
- `S2SRecordsModule.sol` — `onlySafe` KV (configModule; would hold a `deals_contract` pointer /
  registry precedent, INV-2 key set), immutable (`safe` constructor-bound, GAP-7).
- `ENSL2nRecords.sol` / `ENSOpenSubdomainRegistry.sol` / `ENSResolverWithCCIP.sol` — INV-6/INV-12
  layer, untouched by a deals ledger.

**Action libs (`protocol/actions/src/`)**
- `libs/gates.ts` — `canRead` (calls module `canPublish` **and** `hasDeal`), `canPublish` (module
  `canPublish` + Safe `isOwner`) — the publish/update gate that stays per-publication;
  `canReset` (Safe `isOwner`).
- `libs/module.factory.ts` — `Entry`, `getDeals`, `getLatestEntry`, `getVersion`, `fetchById`,
  `fetchByPublication`, `fetchByPublicationDetailed`, `toBody` (deals read adapters → move to ledger).
- `libs/protocol.factory.ts` — `getProtocolInfo` (protocol-level discovery; would read a
  `deals_contract` record); `libs/ens.factory.ts` — `getDomainOwnerAndModules` (INV-4 `NAME()`
  discovery that resolves `publicationModule`; unchanged in the split).
- `render/main.ts` — `isRevokedByDealState` (`hasDeal`, L41–62; moves to ledger with `publication`),
  `main` gate path.
- `update/main.ts` (L82 `canPublish`) and `maintain-cache/main.ts` (L80 `canPublish`) — per-publication
  gate, unchanged.
- `render/verify.ts` — `verifyRevocable` (`hasDeal`-backed).

**Shared (`shared/src/`)**
- `protocol/index.ts` — `getProtocolInfo`, `getProtocolControllerAndModules` (INV-4 walk),
  `getRecords` (INV-2 key set); `protocol/types.ts` — `DidEthr`, `eoaOf`, `toDidEthr`, `S2SPublicContent`
  (`.publication` inside the EIP-712 digest → `genesis` de-facto unique but unverifiable on-chain);
  `identity/contract-id.ts` — `toBytes32Id`.
- `identity/verify-content.ts` — `resolveLatest`/`getHistory` (**stubs** — candidates to wire to the
  ledger's `getBylines`/`getLatest`).

**Apps / adapters**
- `neutralpress/src/publication/publication.service.ts` — `makeOffer`/`acceptOffer`/`retract`/`hasDeal`/
  `getDeals`/`getOffers`/`getModuleAdresses` (would re-point to the ledger, add `publication`).
- `safe-app/src/lib/safe-integration.ts` — `getAllDealsAndOffers`, `makeOffer`/`acceptOffer`/`retract`,
  `whitelistAuthor`/`whitelistDev`/`canPublish` (whitelist calls stay on the per-publication gate;
  deal calls move to the ledger); `safe-app/src/components/s2s-whitelist-tab.ts`,
  `s2s-deals-tab.ts`, `s2s-app.ts`.

**Specs / research**
- `brain/specs/SPEC-contracts-publication.md` (V1→V2, permissions matrix, INV-3/INV-4/INV-10, the
  Safe-owner-EOA gotcha), `SPEC-00-system-contract.md` (INV-1..13, INV-append, INV-2, GAP-1/GAP-7),
  `SUMMARY-protocol.md` (two-record-stores, capability-open/authority-collective),
  `2026-09-10-protocol-wide-deals-contract.md` (prior full study: §b.1 composite key, §b.2 spam,
  §e.4 upgrade authority), `2026-09-10-portable-byline-convergence.md` (CASE 1/CASE 2, three-layer
  spine, author-index as derived/enumerable substrate).

---

### Cross-cutting notes for the architect

1. **`makeOffer` is not permissionless today** — `_append` gates first append to `canPublish`. Any
   split must decide explicitly whether to keep this gate (staticcall out) or relax it (restore the
   documented "anyone → offer" and accept the global-spam/bounds cost).
2. **`tombstone` is dead storage** (never `true`) and **`dealAt`/`offerAt` are write-only** — both are
   free to (re)purpose in a fresh ledger, which also settles the byline start/end question cleanly.
3. **Keep `genesis` as a field even if the ledger keys internally by `(publication, genesis)`** — the
   existing `bytes32` genesis and `toBytes32Id` converters stay unchanged, minimizing adapter churn.
4. **Key records by the publication Safe address** (matches `getDomainOwnerAndModules`), not the ENS
   node (`config.domain` already decouples the write node from identity).
5. **Events should add `publication` as an indexed field** to `Appended`/`DealStruck`/`OfferMade`/
   `Retracted` so off-chain indexers can rebuild bylines without the maintained `authorDeals` index —
   preserving the "anyone-can-index, derived view" property (CASE 1).
