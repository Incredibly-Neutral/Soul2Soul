# Findings — Protocol-Wide Deals/Agreements Contract (portable author byline research)

> **Scope:** read-only research. No code changed, no PR. Grounded in `brain/specs/*`
> (SPEC-00-system-contract, SPEC-contracts-publication, SPEC-contracts-ens, SUMMARY-protocol),
> the prior byline research in `brain/research/` (esp.
> `2026-09-10-portable-byline-convergence.md`), and the actual contracts + action libs
> (`protocol/contracts/contracts/*.sol`, `protocol/actions/src/libs/*.ts`, `shared/src/*`,
> `neutralpress/src/publication/*`, `safe-app/src/components/*`).
>
> **Proposal under study:** *"Take the deals/agreements part of the publication module out and
> into a single smart contract for the entire protocol (protocol-wide, not per-publication). Do
> not call it a marketplace — but it is that level of thing. Then any deal gets administered both
> from the publication point of view AND from the author point of view, and we add a
> `getBylines(author)` method."*
>
> Date: 2026-09-10. Workspace: `/home/joera/code/s2s`.

---

## (0) One-paragraph thesis

The proposal is **architecturally feasible and would deliver the single missing on-chain
primitive the portable-byline work keeps hitting** — a cross-publication, author-enumerable deals
surface — **but it is not "just a storage refactor": it is a new on-chain authority and a real
governance + migration decision.** Today the deals/agreements state machine
(`makeOffer`/`acceptOffer`/`retract`/`hasDeal`/`getDeals` + the per-genesis append log, INV-append,
INV-3) lives in a **per-publication UUPS proxy** whose only `onlySafe` administrator is that
publication's Safe (INV-4 discovery via `getModulesPaginated`, INV-10 write matrix). Hoisting it
into one protocol-wide contract means every gate becomes parameterized by a `publication`
identity, the "who may register/upgrade this contract" question becomes a **new collective
authority** (shifting the neutrality posture from per-publication isolation toward a single shared
store), the permissionless `makeOffer` spam surface becomes global, and the renderer/gates/
safe-app/cid-mirror adapters all change their resolution path. The payoff is exactly what makes the
author-POV and `getBylines(author)` first-class: a single contract can maintain an
`author → (publication, genesis)` index and emit `publication`-indexed events, giving both CASE 1
indexers and CASE 2 author bylines a common on-chain substrate. The cleanest seam is: **a
protocol-wide deals contract that is the *enumerable substrate* (what indexers and the byline doc
derive from), while the portable byline itself stays an author-owned content-addressed pointer
(CASE 2) that is cross-checked against it — not replaced by it.** This mirrors the protocol's own
rule that the index is a derived, verifiable view and never a privileged authority.

---

## (a) Current deals/agreements surface inventory

### a.1 `S2SPublicationModuleV2` (current, per-publication UUPS proxy on Base)

**Storage layout (INV-3 — append-only, DO NOT reorder existing slots):** declaration order —
`safe` (`address`); `versions` (`mapping(bytes32 genesis => Version[])`, `Version{cid,timestamp,
tombstone}`); `genesisAuthor` (`genesis => address`); `latestIndex` (`genesis => uint256`);
`whitelisted_authors[]` (cap 100), `whitelisted_devs[]` (cap 20); deal set
`_isDeal`/`dealList`/`dealPos`/`dealAt`; offer set `_isOffer`/`offerList`/`offerPos`/`offerAt`.
`Entry{genesis, author, cid, timestamp}` is a **read-return struct only** — assembled by
`getDeals`/`getOffers`/`getLatest` from `versions[genesis][latestIndex]` + `genesisAuthor`; there
is **no stored `entries[]`** (SPEC-contracts-publication).

**Write API + access control (refines INV-10):**

| fn | who | effect |
|---|---|---|
| `makeOffer(genesis, cid)` | **anyone (permissionless)** | appends a version via `_append`; whitelisted/safe → immediate **deal**; else → **pending offer**; editing an existing offer just appends another version |
| `acceptOffer(genesis)` | `onlySafe` | promote offer → deal (`_removeOffer`, `_addDeal`, `OfferAccepted`) |
| `retract(genesis)` | **safe ∨ genesisAuthor** | asymmetric: author = full withdrawal (deal+offer removed); safe = demote deal→offer, or reject an offer |
| `whitelistAuthor` / `removeWhitelistedAuthor` | `onlySafe` | cap `MAX_WHITELISTED_AUTHORS = 100` |
| `whitelistDev` / `removeWhitelistedDev` | `onlySafe` | cap `MAX_WHITELISTED_DEVS = 20` |
| `_authorizeUpgrade` | `onlySafe` | UUPS upgrade (emits `ContractUpgraded`) |

**Read API (the gates the actions depend on):** `canPublish(addr)` → `addr == safe ∨ whitelisted
dev ∨ whitelisted author` (note the `// could be safe owners ???` gotcha — it checks the *Safe
address*, so a Safe *owner* EOA does **not** pass); `hasDeal(genesis)` → bool (the Lit gate read);
`hasOffer(genesis)` → bool; `getDeals(offset,limit)` / `getOffers(offset,limit)` → `Entry[]`
(paginate the deal/offer **sets**, not a global log); `getDealCount` / `getOfferCount`;
`getLatest(genesis)` → `Entry`; `getVersion(genesis,index)` / `getVersionCount(genesis)`;
`isGenesis(genesis)` → `genesisAuthor[genesis] != 0`; `authorOf(genesis)` → `genesisAuthor[genesis]`;
`isWhitelistedAuthor` / `isWhitelistedDev` / `getWhitelistedAuthors` / `getWhitelistedDevs`.

**Events:** `Appended(genesis, cid, versionIndex, author)`; `OfferMade(genesis, author)`;
`OfferAccepted(genesis, author)`; `DealStruck(genesis, author)`; `Retracted(genesis, by,
keptAsOffer)`; `AuthorWhitelisted(author)`; `AuthorRemovedFromWhitelist(author)`;
`DevWhitelisted(dev)`; `DevRemovedFromWhitelist(dev)`; `ContractUpgraded(impl)`. Note: `genesis`
and `author` are `indexed`; **`publication` is not an event parameter** (it is implicit in the
per-module instance).

**The append-only core — `_append` (INV-append):** `genesis == 0` and empty-`cid` reverts; on
**first** append `genesisAuthor[genesis] = msg.sender` (the caller must pass `canPublish`, i.e. be
whitelisted/dev/safe); on **every later** append `msg.sender == genesisAuthor[genesis] ∨ safe`.
Identity on-chain is the **address** (the author Safe); the contract stores **no `did:ethr`
string** — `did:ethr` is the client-side layer (`shared/src/protocol/types.ts` `DidEthr`,
`eoaOf`, `toDidEthr`).

**Deployment/discovery:** deployed per-publication by `S2SPublicationModuleV2Factory`
(`createModule(safe, authors, devs)` → `ERC1967Proxy(latestImplementation, initialize(...))`,
emits `ModuleCreated(safe, moduleProxy, implementation)`; keeps `safeModules[safe]` and
`implementationHistory` but **no global module list**). Discovery is INV-4: publication Safe →
`getModulesPaginated` → `NAME() == "S2S Publication Module V2"` (V1 name still accepted
backwards-compat) — implemented in `shared/src/protocol/index.ts::getProtocolControllerAndModules`
and `neutralpress/src/publication/publication.service.ts::getModuleAdresses`.

### a.2 Deprecated V1 equivalents (`S2SPublicationModule`, still accepted by discovery)

Storage: `licenses(string=>bool)`, `licenseAuthors(string=>address)`,
`pendingLicenses(string=>PendingLicense{author,publication,timestamp})`, `allContentIds[]`.
Writes: `grantLicense(pub, content_id)` — **permissionless** (whitelisted/safe → `licenses=true`
immediately, else → `pendingLicenses`); `acceptLicense(content_id)` — `onlySafe`; `revokeLicense(
content_id)` — `safe ∨ licenseAuthors[content_id]`. Reads: `isLicensed`, `isLicensedBulk`,
`getLicenseAuthor`, `getAllContentIds`/`getContentIds`/`getContentIdCount`,
`hasPendingLicense`/`getPendingLicense`. The V2 migration table (SPEC-contracts-publication) maps
V1→V2 1:1; **the same "permissionless author write / onlySafe accept / safe∨author revoke" shape
is preserved** across V1 and V2.

### a.3 Author attribution today

Author appears as (all per-module): `whitelisted_authors[]` (onlySafe-managed), `genesisAuthor[
genesis]` (set once by `_append`, never changes → `Entry.author`/`authorOf`), and in the actions'
gate `gates.ts::canPublish`/`canRead` (recovered EOA from the `"lit actions auth"` sig must be
`isOwner` of the author **Safe** — `Safe.isOwner(signer)` — **and** the Safe must pass
`canPublish`/`hasDeal`). `S2SPublicContent.author` is `did:ethr:<Safe>` (the signed author string);
`S2SPublicContent.publication` is the publication string and is **inside the EIP-712 digest**, so
`genesis = objectId = EIP-712 digest` is de-facto unique per (author, publication) content — but
the contract does not and cannot verify that uniqueness across publications.

---

## (b) Protocol-wide design: what it needs to know + what breaks/cleans up

### b.1 What a single shared deals contract would need to know

- **Publication identity.** The module instance *is* the publication today; a shared contract has
  no such implicit scope. It must carry a first-class `publication` on every record and every call.
  Which identity? The publication **Safe address** is the natural on-chain key (it is the `onlySafe`
  administrator), and/or the **ENS node** (`namehash(publication)`) for naming alignment — but
  `config.domain` (update/main.ts `writeDomain = config.domain ?? publication`) already decouples
  the write node from the identity, so the Safe address is the more stable key. **Recommendation:
  key records by the publication Safe address** (matches `getDomainOwnerAndModules`), not the ENS
  node.
- **Genesis scoping.** Either (i) assume `genesis` is globally unique (plausible because the
  EIP-712 digest covers `publication` + `author`, §a.3, but **unverifiable on-chain**), or (ii)
  key by a **composite `(publication, genesis)`**. Safer: composite key internally; the existing
  `bytes32` genesis can be kept as a field so callers/adapters (`toBytes32Id`) don't change.
- **Author identity.** Still the **Safe address** (did:ethr-over-Safe, INV-append — the contract
  stores addresses, not did strings). `genesisAuthor[(publication, genesis)] = author Safe`,
  set once per (publication, genesis) on first append, immutable.
- **Offer/deal shape.** `Entry` gains `publication`; otherwise `{genesis, author, cid, timestamp}`
  is unchanged (derived from `versions[(publication, genesis)][latestIndex]` + author map).
- **Genesis/version/CID.** The same `Version[]` append log + `latestIndex` caching, just
  re-keyed by the composite key. INV-3 discipline applies to the *new* contract's layout (fresh
  deployment, no existing slots to preserve — but lock the order after first deploy).
- **Per-publication gating when storage is shared.**
  - `safe` (publication Safe) becomes `safeOf[publication]` — a registry. The `onlySafe` modifier
    becomes `onlySafe(publication)`: `msg.sender == safeOf[publication]`.
  - `whitelisted_authors`/`whitelisted_devs` become `whitelisted_authors[publication][]` /
    `whitelisted_devs[publication][]` (caps remain per-publication).
  - `canPublish` becomes `canPublish(publication, author)`; `hasDeal` becomes
    `hasDeal(publication, genesis)`.
  - **New registration surface:** someone must establish `safeOf[publication]` and the initial
    whitelist. Cleanest self-proving path: the **publication Safe calls
    `registerPublication(authors, devs)` itself** — because with 4337 the Safe is `msg.sender`,
    the Safe proves its own identity with no trusted third party. Alternative: the factory
    registers on the Safe's behalf (trusts the factory, which today is protocol-owned and freely
    callable by anyone — `S2SPublicationModuleV2Factory.createModule` is permissionless).

### b.2 What breaks / gets messier

- **INV-4 discovery changes shape.** The deals function is no longer a Safe module found by
  `getModulesPaginated` + `NAME()`; it becomes a **protocol-level contract** resolved like
  `ens_records` — i.e. a new record key in the configModule (`S2SRecordsModule`, e.g.
  `deals_contract`) consumed by `getProtocolInfo` (`shared/src/protocol/index.ts`,
  `protocol/actions/src/libs/protocol.factory.ts`). `gates.ts` `canPublish`/`canRead` and
  `module.factory.ts` `getDeals`/`getLatestEntry`/`fetchByPublication*` all change signature
  (add `publication` + use the shared address instead of the per-publication module).
- **Per-publication isolation is lost.** Today each publication Safe administers and (UUPS)
  upgrades *its own* module; a protocol-wide contract is one storage + one upgrade surface for
  every publication. A bug, a governance decision, or a DoS on the shared contract affects all
  publications at once. This is the single biggest architectural cost and the strongest argument
  *against* the change from the current topology.
- **Permissionless `makeOffer` becomes global spam.** `makeOffer` is deliberately permissionless
  (anyone can pend an offer). Per-module, that spam is contained in one publication's offer list.
  Shared, an attacker can pollute a **protocol-wide offer log**, and enumeration
  (`getOffers`) — and any byline/index derivation — must tolerate it. Needs bounds (per-author
  cap, per-publication offer cap, or accept spam as the price of "capability open").
- **Neutrality — this is a new on-chain authority.** The current frame is "capability open,
  authority collective" (SUMMARY §1) and "the index is a derived view, never a privileged
  authority" (external-indexer-trust-model §d). A single protocol-wide deals contract is **not**
  a privileged *write* authority as long as `acceptOffer` stays `onlySafe(publication)` and
  `retract` stays `safeOf ∨ genesisAuthor` (do **not** add any protocol-level "remove deal"
  surface — that would be the marketplace/censor button). But it **is** a concentrated authority
  in three senses that must be made explicit and governed:
  1. **Upgrade authority** — who holds `_authorizeUpgrade` on the one contract? (Per-module today
     it's each publication Safe; single-contract it's either the protocol controller, a
     multisig-of-multisigs, or immutable/frozen.)
  2. **Registration authority** — who may set `safeOf[publication]`? (Self-registration by the
     Safe preserves capability-open; factory-mediated adds a trusted hop.)
  3. **Enumeration/governance surface** — one contract is one censorship/availability point for
     the deals layer of *every* publication (threat-model: compellable relay / stoppable-by-design
     logic applies to a single on-chain contract harder than to N isolated ones).
  Verdict on the neutrality claim: the proposal **does** change the neutrality posture — it
  centralizes the deals store and its governance while keeping the per-publication capability
  gates. That is a defensible trade only if the registration/upgrade authorities are explicitly
  collective (Safe-gated, not operator-held) and no privileged deal-mutation path exists.

### b.3 What gets cleaner

- **Cross-publication author views** become trivial (see §d — the whole point of `getBylines`).
- **One implementation to audit/upgrade/secure** instead of N proxies + a factory with
  `implementationHistory` (`S2SPublicationModuleV2Factory`).
- **Deployment cost per publication drops**: no publication-module proxy, no `createModule`,
  no `enableModule` for it (though `newPublicationSafe` still deploys the records module + Safe).
  (`shared/src/publication/new.ts::newPublicationSafe`).
- **Indexers/renderers get one source**: today a CASE 1 indexer must enumerate publications via
  `ModuleCreated`/`SubdomainRegistered` events, then call each module's `getDeals`; a shared
  contract can expose cross-publication enumeration (or at least one contract to read).
- **Two-record-stores principle is respected (orthogonal):** the deals contract is a *third*
  store distinct from the configModule (`S2SRecordsModule`, onlySafe KV) and the ENS records
  (C3, PKP-only root write, INV-12). As long as it is discovered via a configModule pointer and
  never conflated with C3, the "two record stores" separation (SUMMARY §2) and the INV-12
  PKP-only root-write guarantee are **untouched** — the deals contract sidesteps INV-12 entirely
  (its write auth is `onlySafe(publication)`/permissionless/`genesisAuthor`, not
  `authorizedCallers`).

---

## (c) Author-POV administration: requirements + invariants it touches

### c.1 What the author "is" today (per surface)

Author = the **Safe address** (did:ethr-over-Safe, not EOA): whitelisted in
`whitelisted_authors[]` per module; `genesisAuthor[genesis]` per genesis; `Entry.author`; and in
the actions `gates.ts` the recovered EOA must be `isOwner` of the author Safe *and* the Safe must
pass `canPublish`. The author's Safe has **no modules, no ENS node, no config store** today
(CASE-2 report §b) — the only author "config" is local Obsidian settings.

### c.2 First-class author-side operations a shared contract must enable

1. **Author lists its own deals across publications** — the `getBylines(author)` core (see §d).
   Requires the contract (or an indexer) to know `author → {(publication, genesis)}`.
2. **Author retracts as author** — today `retract(genesis)` already works when
   `msg.sender == genesisAuthor[genesis]`; in the shared contract it becomes
   `retract(publication, genesis)` and the gate stays `msg.sender == genesisAuthor[(publication,
   genesis)]`. The *author POV* gap is not the permission (it exists) but **discoverability**:
   the author must first know which publications it is in — i.e. it needs the byline/index.
3. **Author makes offers / tracks offer→deal status** across publications — `makeOffer` is
   already the author write; the author-side UX needs an aggregate view of its pending offers and
   accepted deals (again `getBylines`-backed).
4. **Author "moves a publication pointer" (portability)** — this is the byline layer, **not** the
   deals contract. The existing re-point primitive is `config.domain` (`update/main.ts`:
   `writeDomain = config.domain ?? publication`) and the CASE-2 byline (author-owned records
   module / author ENS node / content-addressed index doc). The deals contract does not need a
   "move" operation; the author's *records* need it.
5. **Whitelist self-service** — the author **cannot and should not** whitelist itself; that stays
   `onlySafe(publication)` (publication administers its whitelist). From the author POV this is a
   read (am I whitelisted here? → `isWhitelistedAuthor(publication, author)`).

### c.3 Storage/events needed for author-POV

- **Storage:** an explicit `authorDeals[author] → (publication, genesis)[]` (or lighter,
  `authorPublications[author] → publication[]`) index maintained by `makeOffer`/`acceptOffer`/
  `retract` — OR rely on deriving it from a scan (§d.2). If maintained on-chain, retract must
  remove the tuple (swap-pop like `_removeDeal`/`_removeOffer`) and tombstone semantics must be
  handled (a retracted-then-re-offered genesis must not double-list).
- **Events:** the shared contract's events should add **`publication` as an indexed field**
  (today `Appended`/`DealStruck`/`OfferMade`/`Retracted` index `genesis` and `author` only;
  `publication` is implicit per-module). Indexed `(author, publication)` is what lets an
  **off-chain** indexer (CASE 1) rebuild the byline without calling `getBylines` — keeping the
  "anyone-can-index, derived view" property intact.

### c.4 Invariants the shared contract inherits / touches

- **Safe-not-EOA invariant (unchanged, must be preserved):** all author writes flow through the
  4337 Safe (Pimlico bundler+paymaster), so `msg.sender == author Safe`. The contract stores
  addresses, never did strings (INV-append). `gates.ts`'s EOA-isOwner check stays the client-side
  gate; the contract only ever sees the Safe.
- **INV-append:** every append still gated to `genesisAuthor ∨ safeOf` — now per
  `(publication, genesis)`. The `author`/`publication` fields come from the caller; the contract
  must not trust a passed-in author for the *first* append either (use `msg.sender` as today).
- **INV-3 (append-only layout):** applies to the new contract's own storage; document the slot
  order and never reorder after deploy (GAP-7 asymmetry with the immutable `S2SRecordsModule`
  resurfaces — decide upgradeable vs frozen).
- **INV-10:** the write matrix is *re-derived* (parameterized): whitelist/acceptOffer/upgrade =
  `onlySafe(publication)`; `makeOffer` = permissionless (now with global-spam consequences, §b.2);
  `retract` = `safeOf ∨ genesisAuthor`.
- **INV-12 (PKP-only records) — sidestep, do not inherit:** the deals contract is **not** C3;
  its writes are not `authorizedCallers`-gated. Do **not** route author or publication deal writes
  through the PKP (that would loosen the "only the PKP writes the root" neutrality guarantee for
  zero benefit). The INV-12 boundary is about the *site-root pointer*, which stays untouched.
  The one interaction: if the *byline* (CASE 2) wants the author to write records on C3, *that*
  is where INV-12 bites — but that is the records/byline layer, not the deals contract.

---

## (d) `getBylines(author)` design + composition with the portable-byline work

### d.1 The gap today

There is **no author→publications index and no global enumerator** (confirmed by all six prior
streams): `S2SPublicationModuleV2` stores an append-log **per publication**; `Entry`/
`genesisAuthor` are per-module; the factory has `safeModules[safe]` but no global list; the only
publication-enumeration surface is `SubdomainRegistered`/`ModuleCreated` events
(`indexer-offchain-resolution-findings.md §d`). So `getBylines(author)` cannot be implemented
meaningfully on the current topology without a global scan of N modules.

### d.2 Two ways to build it on the shared contract

**Option A — derived (scan the shared log).** `getBylines(author)` as a view that iterates the
global deal/offer log filtering `author == given`. On-chain this is **O(total-deals)** per call —
impractical as an on-chain view as the protocol grows, and it returns only what is stored
(genesis/cid/timestamp/author/publication), never human titles (ciphertext for encrypted items) or
URLs (needs config + `createPath` off-chain — indexer-offchain-resolution-findings §b). Viable
**off-chain**: an indexer rebuilds it from events (`Appended`/`DealStruck` with `author` indexed
+ new `publication` indexed) — this is exactly the CASE 1 anyone-can-index core and needs **zero
new contract state**.

**Option B — explicit author index (maintained on-chain).** The shared contract maintains
`authorDeals[author] → (publication, genesis)[]` updated in `makeOffer`/`acceptOffer`/`retract`;
`getBylines(author)` returns it directly. This is the only way to get an **O(1) on-chain author
enumeration** (cheap for safe-app/author UIs and for a `getBylines` RPC). Cost: state complexity,
list-maintenance on retract, and it makes the contract the *maintainer of a registry* — a step
toward the contract being an authoritative index (see neutrality, §b.2).

**Recommendation: Option B for the on-chain substrate (because a shared contract exists anyway,
the incremental state is small and it delivers the author-POV UX), with the off-chain derived view
(Option A / events) kept as the *verification* path** — so `getBylines` is a convenience surface,
never the only way to reconstruct the byline.

### d.3 Composition with the portable-byline convergence design

The convergence doc's recommended shape (CASE 2): author Safe gains an `S2SRecordsModule`;
`setRecord('byline', <IPFS CID of index doc>)`; index doc `{ author, publications: [{ ens, title,
latestGenesis, latestCid }] }`; reader = `resolveAuthorByline(author)` → walk Safe modules →
records module → CID → index → per-publication read → verify via EIP-712 `verifyAuthorship` +
PKP page proof + on-chain `getLatest`. CASE 1: anyone-can-index over `ModuleCreated` +
`getDeals`/`getLatest` + IPFS + the two signature layers.

**Is `getBylines` the on-chain substrate the byline should point at, or redundant?**

- **Not redundant — it is the missing enumeration primitive.** The byline index doc is a
  self-asserted, *curated* list (the author may omit/order/annotate). `getBylines(author)` is
  *derived from the chain* — comprehensive but un-curated, and it cannot produce titles/URLs by
  itself (§d.2). They answer different questions: "what the author says its work is" vs "what the
  chain records the author's deals as." A reader verifies the byline doc *against*
  `getBylines`/`getLatest` — the three-layer spine (convergence §5 hop 5).
- **Cleanest seam:** keep the portable byline **author-owned and content-addressed** (CASE 2)
  — the pointer/name layer stays fragile, replaceable, author-asserted — and treat
  **`getBylines(author)` as the on-chain enumerable substrate** that both CASE 1 indexers and
  CASE 2 bylines read from/are cross-checked against. Do **not** make `getBylines` the byline
  itself (no titles/URLs; and an on-chain index is not something an author should hand-edit — it
  would become an authority).
- **With the shared contract, CASE 1 simplifies:** the indexer's enumeration leg
  (per-publication modules) collapses to "read the shared deals contract / its events" — the same
  anyone-can-index guarantee, cheaper to build. Without the shared contract, CASE 1 still works
  today (per-module scan); `getBylines` is a *convenience + author-POV UX* enhancement, not a
  prerequisite for the byline.

---

## (e) Topology, migration, upgrade assessment

### e.1 Topology

| Aspect | Today (per-publication modules) | Protocol-wide shared contract |
|---|---|---|
| Deployments | 1 UUPS proxy + 1 records module per publication, via factories (`S2SPublicationModuleV2Factory`, `S2SRecordsModuleFactory`); no global enumerator | 1 contract, deployed once; address stored as a protocol record (e.g. `deals_contract` in configModule, read by `getProtocolInfo`) |
| Discovery | INV-4: Safe `getModulesPaginated` → `NAME()` | Protocol-level record (`ens_records` pattern) |
| Upgrade | Each publication Safe upgrades its own proxy (`_authorizeUpgrade onlySafe`) | One `_authorizeUpgrade` — **new governance question** |
| Isolation | Bug/halt/upgrade contained per publication | Single point for all publications |
| Cross-publication author views | Not possible without N-module scan | `getBylines` feasible |
| `makeOffer` spam | Contained per publication | Global offer log (needs bounds) |

### e.2 Migration / coexistence for existing publications + deals

- **Coexistence (zero-migration, two surfaces):** keep existing V2 modules (their deals stay in
  per-module logs); new publications use the shared contract. The renderer
  (`module.factory.getDeals`/`getLatestEntry`), `gates.ts`, safe-app
  (`safe-integration.getAllDealsAndOffers`, `s2s-deals-tab.ts`), and CASE 1 indexers would have
  to handle **both** surfaces. Messy but no data replay and no disruption to live deals.
- **Migration (clean long-term, one-time cost):** a batch "import" re-emits each existing
  module's log into the shared contract. Because `Entry` is *derived* (`versions[genesis]
  [latestIndex]` + `genesisAuthor`), migration is a replay per (publication, genesis):
  `versions[]` (all indices, preserving `tombstone`/timestamps), `genesisAuthor`,
  deal/offer membership, and whitelist. Genesis is `bytes32` and identity is the Safe address, so
  both are preserved verbatim. Gated by each publication Safe (migration is `onlySafe(publication)`
  work). After migration, retire the per-publication module or keep it read-only.
- **Hybrid read-through (not recommended):** shared contract *references* legacy modules for
  reads (aggregate `getDeals`). Doubles the surface without removing the old one; worse than both
  clean options.

### e.3 Factory + ENS/records + render/cid-mirror/safe-app impact

- **Factory:** `S2SPublicationModuleV2Factory.createModule` is retired for the deals part
  (publication registration moves into the shared contract, §b.1); `newPublicationSafe`
  (`shared/src/publication/new.ts`) changes (no publication-module deploy/enable; add
  `registerPublication`). `records_factory`/`S2SRecordsModule` untouched.
- **ENS/records layer:** C3/C4/C5 (ENSL2nRecords / ENSOpenSubdomainRegistry /
  ENSResolverWithCCIP) are **untouched** — `contenthash_wrapped`, INV-6, INV-12 stay. The only
  records-layer change is a **new configModule key** (like `ens_records`) pointing at the deals
  contract, read by `getProtocolInfo` / `protocol.factory.ts`. `config.domain` re-pointing
  (portability) is unaffected.
- **Render pipeline:** `module.factory.ts` `getDeals`/`getLatestEntry`/`fetchByPublication*` gain a
  `publication` parameter + read the shared address; `render/data.ctrlr.ts` (`fetchCollections`,
  the deal→collection path) follows; `update/verify.ts` (`verifyRevocable`) unchanged (still reads
  `hasDeal`).
- **cid-mirror / CASE 1 indexers:** the resolution chain (`cid-mirror/src/ens.ts::getProtocolInfo`,
  `resolveEnsToCID`) gains the deals-contract record; per-publication deal reads become shared-contract
  reads. One less enumeration hop.
- **safe-app:** `s2s-deals-tab.ts` + `safe-integration.ts::getAllDealsAndOffers` switch from the
  per-publication module to the shared contract (and can now offer author-POV cross-publication
  views backed by `getBylines`). `s2s-website-tree-tab.ts`/records tab unaffected.

### e.4 Upgrade/governance options (the decision that matters)

1. **Protocol-controller UUPS** (one `_authorizeUpgrade`, held by the protocol Safe): simplest,
   but concentrates upgrade power — every publication's deals layer changes at the protocol's
   discretion. Weakest fit for the neutrality claim.
2. **Multisig-of-publication-Safes upgrade gate**: no single Safe can upgrade; requires a quorum
   of publications (authority collective). Novel, needs a registry + vote plumbing.
3. **Immutable / frozen after genesis** (like `S2SRecordsModule`, GAP-7): no upgrade path;
   bugs are permanent but so is neutrality. Given deals logic is stable (V1→V2 was a modest
   change), a frozen first version with a *new address + migration* as the upgrade mechanism is
   the most protocol-consistent option (mirrors how `contenthash`/actions are replaced by CID,
   not mutated).

---

## (f) Gaps, open questions, decision points

1. **Genesis uniqueness across publications** — is `bytes32 genesis` globally unique (EIP-712
   digest covers `publication`+`author`, §a.3) or must records be keyed `(publication, genesis)`?
   Composite key is the safe default; affects every function signature.
2. **Who may register a publication** (`safeOf[publication]` set): publication Safe self-registers
   (capability-open, recommended) vs factory-mediated vs protocol-owned. This is the crux of the
   neutrality assessment in §b.2.
3. **Who may upgrade / is it frozen** — controller UUPS vs multisig-of-Safes vs immutable (§e.4).
   Directly determines whether "protocol-wide" is a governance centralization.
4. **Permissionless `makeOffer` at protocol scale** — global offer-log spam: accept it (preserves
   "capability open") vs per-author/per-publication caps vs whitelist-gated offers (changes the
   open property). Also: does an unwhitelisted author's offer need a per-publication bound?
5. **Marketplace framing** — the proposal says "not a marketplace, but it is that level of thing."
   The design must keep `acceptOffer`/`whitelist`/`retract` strictly publication-scoped
   (`onlySafe(publication)` / `genesisAuthor`) so the shared contract cannot become an open market
   where any Safe accepts any deal or where the protocol mutates deals. State explicitly that no
   protocol-level "force-deal / force-retract / list-author" write path exists.
6. **`getBylines` semantics** — returns `(publication, genesis, cid, timestamp)` only (no
   titles/URLs; encrypted items expose nothing). Define the return struct, pagination
   (offset/limit like `getDeals`), whether offers are included, and whether the byline doc
   (CASE 2) is generated from it or independent-and-verified-against-it (§d.3).
7. **Maintained vs derived author index** (§d.2) — on-chain `authorDeals[]` (O(1), state
   maintenance) vs off-chain event derivation (zero state, anyone-can-index). Decision drives
   whether `getBylines` is an on-chain method at all.
8. **Event schema** — add `publication` as indexed to `Appended`/`DealStruck`/`OfferMade`/
   `Retracted` so off-chain indexers can rebuild bylines without the maintained index.
9. **Migration vs coexistence** (§e.2) — replay existing V2 logs (gated per publication Safe) vs
   run both surfaces. Tombstone/retract replay must be exact (INV-append).
10. **INV-12 / two-record-stores hygiene** — keep the deals contract a distinct third store
    discovered via configModule; never give the PKP deal-write powers and never route byline
    records through C3 without the CASE-2 INV-12 decision (author-owned records module vs neutral
    PKP action) from the convergence doc §6.
11. **GAP-1 tail / stubs** — `resolveLatest`/`getHistory` in `shared/src/identity/verify-content.ts`
    are stubs ("append-log contract pending"); if a shared deals contract lands, wire these to it
    (they become the canonical client-side history/byline API) — closes a long-standing gap for
    indexers/auditors.
12. **Safe owner-EOA gotcha** — `canPublish` checks the Safe address, not owner EOAs
    (SPEC-contracts-publication gotcha); with a shared contract and `gates.ts` this unchanged
    semantics must be preserved or explicitly redesigned (it interacts with who "counts as" the
    author for `getBylines`).

---

## (g) Files / contracts / functions relied on (grounding)

**Contracts (`protocol/contracts/contracts/`)**
- `S2SPublicationModuleV2.sol` — `makeOffer`, `acceptOffer`, `retract`, `whitelistAuthor`/
  `removeWhitelistedAuthor`, `whitelistDev`/`removeWhitelistedDev`, `canPublish`, `hasDeal`,
  `hasOffer`, `getDeals`, `getOffers`, `getDealCount`/`getOfferCount`, `getLatest`, `getVersion`,
  `getVersionCount`, `isGenesis`, `authorOf`, `isWhitelistedAuthor`/`isWhitelistedDev`,
  `getWhitelistedAuthors`/`getWhitelistedDevs`, `_append` (INV-append), `_addDeal`/`_removeDeal`/
  `_addOffer`/`_removeOffer` (swap-pop sets), `_page`, `onlySafe`, events, storage slots (INV-3).
- `S2SPublicationModule.sol` (V1, deprecated) — `grantLicense`, `acceptLicense`, `revokeLicense`,
  `licenseAuthors`, `pendingLicenses`, `isLicensed`, `isLicensedBulk`, `getLicenseAuthor`,
  `getAllContentIds`/`getContentIds`, `hasPendingLicense`/`getPendingLicense`.
- `S2SPublicationModuleV2Factory.sol` — `createModule`, `createModuleEmpty`, `setImplementation`,
  `getModulesForSafe`, `implementationHistory`, `ModuleCreated`.
- `S2SRecordsModule.sol` — `setRecord(s)`, `deleteRecord`, `getRecord(s)`, `getAllKeys`,
  `getAllRecords`, `onlySafe`, `NAME` ("S2S Records Module") — the configModule that would hold a
  `deals_contract` pointer.
- `ENSL2nRecords.sol` (C3) — `setText`/`getText`/`batchSetRecords`, `authorizeCaller`,
  `authorizedCallers`, `onlyAuthorized`, `onlyProtocol`, `exportState` (INV-12 surface; untouched).
- `ENSOpenSubdomainRegistry.sol` (C4) — `registerSubdomain`, `registeredSubdomains`,
  `SubdomainRegistered` (enumeration surface).
- `ENSResolverWithCCIP.sol` (C5) — `resolve`, `resolveText` (generic `text` stubbed to `"default"`),
  `resolveContenthash*`.

**Action libs (`protocol/actions/src/`)**
- `libs/gates.ts` — `canRead`, `canPublish`, `canReset`, `extractSignerAddress` (author Safe +
  EOA-isOwner gate; would take `(publication, module|sharedContract)`).
- `libs/module.factory.ts` — `Entry`, `getDeals`, `getLatestEntry`, `getVersion`, `fetchById`,
  `fetchByPublication`, `fetchByPublicationDetailed`, `toBody` (render pipeline deals adapter).
- `libs/protocol.factory.ts` — `getProtocolInfo` (protocol-level discovery, would read the
  deals-contract record); `libs/ens.factory.ts` — `getProtocolControllerAndModules`,
  `getDomainOwnerAndModules`; `libs/evm.ts` — `evmRead`/`evmWrite`.
- `update/main.ts` — `writeDomain = config.domain ?? publication`, `node = namehash(writeDomain)`,
  `setText(node,'contenthash_wrapped', ...)` (INV-6/INV-12 write; the existing re-point primitive).
- `render/data.ctrlr.ts` — `fetchCollections`, deal→collection path; `render/metadata.ts`,
  `render/main.ts` — provenance (`addAndSignMetadata`, author `propertyID: 'did:ethr'`).
- `maintain-cache/main.ts` + `libs/archive.factory.ts` — `content_cache_<publication>` archive.

**Shared (`shared/src/`)**
- `protocol/types.ts` — `DidEthr`, `eoaOf`, `toDidEthr`, `S2SPublicContent` (`.author`, `.publication`
  inside the EIP-712 digest), `S2S_TYPES`, `S2S_DOMAIN`, `S2SProtocolInfo`.
- `protocol/index.ts` — `getProtocolInfo`, `getProtocolControllerAndModules` (INV-4 walk),
  `getRecords` (INV-2 key set).
- `publication/new.ts` — `newPublicationSafe` (ENS `registerSubdomain`, records module,
  publication module, `enableModule`, whitelist).
- `identity/verify-content.ts` — `verifyAuthorship`, `verifyPlaintextHash`, `resolveLatest`/
  `getHistory` (**stubs** — the future client-side byline/history API).
- `identity/sign-content.ts` — `buildSignedContentItem`; `identity/contract-id.ts` — `toBytes32Id`.

**Apps / adapters**
- `neutralpress/src/publication/publication.service.ts` — `makeOffer`/`acceptOffer`/`retract`/
  `hasDeal`/`getDeals`/`getOffers`/`getModuleAdresses` over V2 (author-side + publication-side
  deal admin today).
- `safe-app/src/components/s2s-deals-tab.ts`, `safe-app/src/lib/safe-integration.ts`
  (`getAllDealsAndOffers`), `safe-app/src/components/s2s-website-tree-tab.ts` — publication-POV
  deals UI (would gain author-POV/cross-publication views from `getBylines`).
- `cid-mirror/src/ens.ts` — `getProtocolInfo`, `resolveEnsToCID` (read-path precedent for a
  CASE 1 indexer; would add the deals-contract record).

**Specs / research**
- `brain/specs/SPEC-contracts-publication.md` (C1/C2, V1→V2 table, permissions matrix, INV-3/
  INV-4/INV-10), `brain/specs/SPEC-00-system-contract.md` (INV-1..13, INV-append, INV-2 key set,
  GAP-1/GAP-7/GAP-8), `brain/specs/SPEC-contracts-ens.md` (C3/C4/C5, INV-6/INV-12),
  `brain/specs/SUMMARY-protocol.md` (§1–2: two record stores, neutrality; §3–5 pipeline/mapping).
- `brain/research/2026-09-10-portable-byline-convergence.md` (CASE 1 + CASE 2 synthesis, three-
  layer verification spine, recommended shape), `indexer-offchain-resolution-findings.md`
  (enumeration gaps, genesis→URL not on-chain, encrypted-item wall, `getRecords` string[] fix),
  `2026-09-10-external-indexer-trust-model.md` (anyone-can-index core, no privileged indexer
  write path), `2026-09-10-portable-byline-case2-author-did-surface.md` (author Safe has no
  modules; Safe-not-EOA; INV-12 crux), `2026-09-10-portable-author-byline-resolution.md`
  (`config.domain` re-point primitive; author ENS node vs Safe records module).
