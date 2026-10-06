# Scoping Study — Author-Owned Bylines Records Module (decentralized, author-owned)

> **Status:** scoping / research (read-only). No code changed, no PR.
> **Direction (human decision):** REJECT the protocol-wide central deals ledger
> (`2026-09-10-protocol-wide-deals-contract.md`, `2026-09-10-deals-ledger-convergence.md`).
> New direction: **each author's Safe optionally carries a records module it controls**, where the
> author maintains its OWN byline record — the publications it claims to be published on — keyed and
> queryable from the author's own name (`did:ethr` / Safe address / ENS node). The author's claim is
> then verified **on-chain against the publication's own ledger/deals**, with **no single
> protocol-wide store** ("everything queryable but everything-in-one-place is not appreciated").
>
> **Task:** grounded scoping study of this author-owned records-module direction, citing actual
> code/specs. Follows `docs-conventions.md` (this is research, not a SPEC/RFC — no settled behavior
> is being claimed).
>
> Date: 2026-09-10. Workspace: `/home/joera/code/s2s`. Brain: `/home/joera/code/s2s/brain`.
>
> **Prior research read first:** `2026-09-10-portable-byline-convergence.md` (master synthesis, Case 2
> ranked strongest), `2026-09-10-protocol-wide-deals-contract.md` (the now-rejected central-ledger
> option — its verification spine + deal/offer surface), `2026-09-10-deals-ledger-convergence.md`
> (split analysis, right-to-be-forgotten, byline schema `{item, publication, start, end}`), plus the
> source reports `2026-09-10-portable-byline-case2-author-did-surface.md` and
> `2026-09-10-portable-author-byline-resolution.md`.

---

## TL;DR (one paragraph)

The author-owned byline is **architecturally a near-zero-greenfield composition of what already
exists**, and it does **not** need the central ledger it was invented to justify. The author is
already a Safe (`did:ethr` over the Safe address, not an EOA — `shared/src/protocol/types.ts`
`DidEthr`/`toDidEthr`/`eoaOf`; `0xobsidian/src/eth/permissionless.safe.service.ts`
`toSafeSmartAccount`). `S2SRecordsModule.sol` — an **immutable, `onlySafe` KV store** whose reads
are **permissionless** — is already the exact "author controls a store on its own DID" primitive
(Case 2 candidate 1, ranked strongest in the convergence doc). Deploying that same module onto the
author Safe (`S2SRecordsModuleFactory.createModule(authorSafe)` + `enableModule`) gives the author a
**self-sovereign byline store with zero new contract code and zero touch of C3/INV-12**. The
verification spine survives: each `(publication, genesis)` in the author's byline is checked
**on-chain against that publication's own `S2SPublicationModuleV2`** via the existing
`authorOf(genesis)` (immutable, set on first append — INV-append), `hasDeal(genesis)`, and
`getLatest(genesis)` reads. Discovery stays fully fragmented: the reader walks the **author Safe's
own modules** (`getModulesPaginated` + `NAME() == "S2S Records Module"`, the INV-4 pattern) and, per
publication, walks **that** publication Safe's own modules — never a global list. There is no
protocol-wide store, no `getBylines` on a shared contract; "everything queryable" happens only at
read/verify time, per-Safe. The right-to-be-forgotten idea reduces to **author-side curation of the
author's own store** (honest filter, not deletion; the publication-side on-chain deal is untouched).
What's greenfield is thin: an author module-install flow (authors today have no modules/ENS node), a
byline record key/schema, and a `resolveAuthorByline` + verification reader helper.

---

## 1. The crux — can the author write its own records? **Yes — if the store is the author's own, the INV-12 wall vanishes.**

### 1.1 The INV-12 wall is real, but only for the *shared* C3 ENS-records store

`ENSL2nRecords.sol` (`ENSSubdomainRecordsContract`, a.k.a. C3) gates **all** writes with
`onlyAuthorized`:

```solidity
modifier onlyAuthorized() {
    require(authorizedCallers[msg.sender] || msg.sender == owner(), "Not authorized");
    _;
}
```
`setText(node, key, value)`, `setAddress`, and `batchSetRecords` all carry `onlyAuthorized`
(ENSL2nRecords.sol). `authorizeCaller(addr, bool)` is itself restricted to `owner() ∨
protocolAddress` (ENSL2nRecords.sol `authorizeCaller`). **INV-12** (SPEC-00 §4; SPEC-contracts-ens
C3): the PKP eth address must be an `authorizedCaller` on C3, granted by `update-protocol.ts`
(`authorizeCaller(pkp.ethAddress, true)` on `ENS_RECORDS_ADDRESS`, same Safe batch as the record
writes). The `update` action writes the site root with `evmWrite('L2', protocolInfo.pkp,
protocolInfo.ensRecords, ... 'setText', [node, 'contenthash_wrapped', ...])` (update/main.ts) —
**only the PKP writes the root**.

So: **the author cannot write its own records on the shared C3 store.** That is the crux the prior
convergence flagged (`2026-09-10-portable-byline-convergence.md` §4 candidate 2 / gaps). The
proposed fix there was to "route author writes through a neutral PKP action gated on author
ownership (preserves 'only the PKP writes the root')". **That fix is only needed for the C3-hosted
ENS-node variant (Form A).**

### 1.2 The author-owned records module sidesteps the crux entirely

`S2SRecordsModule.sol` is a **separate store** with its **own** write gate — `onlySafe`:

```solidity
modifier onlySafe() {
    if (msg.sender != safe) revert OnlySafe();
    _;
}
```
and `safe` is an **immutable constructor arg** (`S2SRecordsModule.sol`:
`constructor(address _safe) { require(_safe != address(0)); safe = _safe; }`). When that `safe` is
**the author Safe**, then `setRecord`/`setRecords`/`deleteRecord` (all `onlySafe`) succeed whenever
`msg.sender == authorSafe`. Because the author publishes through its 4337 Safe (Pimlico
bundler+paymaster — `0xobsidian/src/eth/permissionless.safe.service.ts` `toSafeSmartAccount`),
`msg.sender` **is** the Safe and the gate passes. **This is the minimal mechanism for the author to
append to / update its own byline records: call `setRecord('bylines', <value>)` (or
`setRecords`/`deleteRecord`) from the author Safe — zero new contract code.**

This respects the protocol's own "two record stores" separation (SPEC-00 §2.1: `S2SRecordsModule`
configModule vs the ENS records contract; SUMMARY-protocol §2). The author byline lives in a
records module, **never** in C3, so:
- The "only the PKP writes the root" neutrality guarantee (INV-12, DR-7.3 in the prior docs) is
  **untouched** — the site-root pointer on C3 and the author's byline store are different stores.
- No `authorizeCaller` change, no loosening of `onlyAuthorized`, no neutral PKP action required.
- This is exactly why the convergence doc ranked candidate 1 ("`S2SRecordsModule` on the author
  Safe") as the **strongest fit**: "live, zero-change machinery."

**Conclusion for §1:** the crux dissolves once the author's records live in the author's own
`onlySafe` module. The neutral-PKP-action fix is a *fallback* reserved for the ENS-node-on-C3
variant (§2.4), and it should **not** be the primary design — it reintroduces C3/INV-12 complexity
for no benefit.

---

## 2. Module shape — the same `S2SRecordsModule`, deployed on the author Safe as an optional module

### 2.1 The module is reused as-is

`S2SRecordsModule.sol` is a generic `string→string` KV store: `setRecord(s)`, `deleteRecord`
(`onlySafe`); `getRecord`, `getRecords`, `getAllKeys`, `getAllRecords`, `getRecordCount`,
`getKeyAtIndex`, `recordExists` (permissionless views); `NAME() = "S2S Records Module"` (INV-4);
immutable (GAP-7). Deployed by `S2SRecordsModuleFactory.createModule(safe)` →
`address(new S2SRecordsModule(safe))`. **It is already used on the protocol controller Safe and on
every publication Safe** (SPEC-contracts-publication C2). There is nothing publication-specific in
it — it can be deployed onto an author Safe with **no modification**.

### 2.2 What the author must add to its Safe (the greenfield install path)

Today the author Safe has **no modules, no ENS node, no config store** — confirmed by the Case 2
report (`2026-09-10-portable-byline-case2-author-did-surface.md` §a–b) and by inspection: author
provisioning is `toSafeSmartAccount` (a Safe, threshold 1) with no module wiring, unlike
`newPublicationSafe` which does the full module dance. The publication install path is the exact
template to copy:

`shared/src/publication/new.ts :: newPublicationSafe`:
1. L2 `recordsFactory.createModule(publicationAddress2)` → records module;
2. L2 `publicationFactory.createModule(publicationAddress2, authors, [])` → publication module;
3. `safe.enableModule(recordsModule)` + `safe.enableModule(publicationModule)` (batch).

For an author, steps 1 and 3 only (no publication module, no whitelist): **deploy an
`S2SRecordsModule` via `recordsFactory.createModule(authorSafe)`, then `enableModule(recordsModule)`
on the author Safe**, and finally `setRecord('bylines', ...)` from the author Safe. This is the
**optional** install — an author who never opts in simply has no records module and no byline
(matching the "each author optionally gets a records module" framing in the task).

### 2.3 Does the author need an ENS node? **No — Form B (Safe-addressed) is sufficient and preferred.**

- **No ENS node required.** The records module is keyed to the **Safe address** (`safe` immutable),
  and discovery is the INV-4 Safe-module walk (`getProtocolControllerAndModules` in
  `shared/src/protocol/index.ts`: `getModulesPaginated` → match `NAME() == "S2S Records Module"`).
  The `did:ethr:<Safe>` string is the client-side label for the same address (SPEC-00 INV-append:
  on-chain identity is the **address**, never a did string; `did:ethr` is `shared`-layer).
- The whole ENS stack (C4 `registerSubdomain`, C3/C5 resolution) is **publication-scoped and
  optional for authors**. `registerSubdomain` is permissionless (C4) so an author *could* mint
  `<author>.soul2soul.eth`, but then the byline must live either in the author's records module
  (discovered via the ENS node → owner → Safe → modules) or on C3 (hits the INV-12 wall, §1.1).
- **Recommendation:** key/discover purely off the Safe address / `did:ethr` (Form B). This keeps
  the design maximally fragmented (no shared C3 involvement) and matches the on-chain identity the
  gates and deals already use (SPEC-00 INV-append: `genesisAuthor` is the Safe address). An ENS node
  adds a friendly label layer **on top**, pointing at the same records module — not a prerequisite.

### 2.4 If an ENS-addressable byline on C3 is ever wanted (Form A, not recommended now)

The neutral-PKP-action fix from the convergence applies only here: a new Lit action (CID-registered
per INV-8, PKP authorized on C3 per INV-12) that, **gated on author ownership** (recover the 4337
signature, verify `Safe.isOwner(signer)` on the author Safe — the `gates.ts` pattern), writes the
author's own node's records on C3. This preserves "only the PKP writes the root." It is strictly
more machinery than §2.2 for the same author-facing outcome, so it is deferred/optional.

---

## 3. The verification seam — the author's byline is a claim, verified on-chain against the publication's own module

### 3.1 The claim

The byline is **author-asserted**: `"I (authorSafe) was published in publication X (genesis g)"`.
A byline entry is essentially the tuple `(publication, genesis)` (optionally plus off-chain
title/URL). It is self-attested and therefore **not authoritative on its own** — it must be
verified (convergence doc §6: "the author byline is self-asserted ... one input, verifiable
independently").

### 3.2 The verification is a cross-contract read against the publication's own `S2SPublicationModuleV2` — **no new primitive required**

Every read needed already exists on the per-publication module
(`S2SPublicationModuleV2.sol`, SPEC-contracts-publication C1):
- `authorOf(genesis) → genesisAuthor[genesis]` — **immutable**, set once on first append by
  `_append` (`genesisAuthor[genesis] = author`), never changes (INV-append). **The core check:**
  `authorOf(genesis) == authorSafe` proves the genesis belongs to this author on this publication.
- `hasDeal(genesis) → _isDeal[genesis]` — whether the genesis is currently a live deal (the Lit gate
  read, SPEC-contracts-publication). Confirms the claim is **current**, not merely historical.
- `getLatest(genesis)` / `getVersion(genesis, i)` — the current `Entry{genesis, author, cid,
  timestamp}` (module.factory `ENTRY_COMPONENTS`/`getLatestEntry`) — the on-chain current
  content/CID and timestamp.
- `getDeals(offset, limit)` — enumerate the publication's deals to cross-check the full set.
- `canPublish(addr)` — is this address whitelisted/dev/safe (a weaker "belongs" check).

**Discovery of the publication's module to call:** the reader must first resolve the publication
Safe, then walk *its* modules (`getModulesPaginated` + `NAME() == "S2S Publication Module V2"` /
back-compat `"S2S Publication Module"`) — the same INV-4 walk in
`getProtocolControllerAndModules` / `getDomainOwnerAndModules` (update/main.ts), but per-publication.
So verification = **resolve publication → find its publication module → call `authorOf(genesis)` /
`hasDeal(genesis)` / `getLatest(genesis)`**. This is purely **off-chain read orchestration over the
existing per-publication contracts**; no on-chain primitive, no shared ledger, no `getBylines`.

### 3.3 Verifiable vs self-attested (what stays off-chain)

| Aspect | Verifiable on-chain? | How / where |
|---|---|---|
| Genesis exists; author is `authorSafe` | ✅ **Yes (hard)** | `authorOf(genesis) == authorSafe` (immutable, INV-append) |
| Currently a live deal | ✅ Yes | `hasDeal(genesis)` |
| Current content CID + timestamp | ✅ Yes | `getLatest(genesis).cid / .timestamp` |
| Author signed the content | ✅ Yes (off-chain read of signed item) | EIP-712 `verifyAuthorship` (`shared/src/identity/verify-content.ts`) over the IPFS `S2SContentItem`; PKP page proof `verifyProvenance` (render/metadata.ts) |
| **Human titles / slugs / URLs** | ❌ **No** | live inside the content item (IPFS), often ciphertext; `genesis→URL` needs config + `createPath` off-chain (indexer-offchain-resolution-findings §b) |
| The publication "is what the byline says it is" | Partially | the byline's human-readable publication label is self-attested; only the Safe address is on-chain-verifiable |

So the verification seam confirms **the on-chain core of the claim** (genesis exists, belongs to the
author, is a deal) while titles/URLs remain **self-attested pointers** — exactly the division the
task anticipates. The three-layer spine from the convergence (EIP-712 `verifyAuthorship` + PKP page
proof + on-chain `getLatest`) is preserved, now with `getLatest` being a per-publication read rather
than a shared-ledger read.

---

## 4. The queryable surface — "queryable from their name": the mechanical read path

### 4.1 Read path for "all bylines of author A"

The reader holds the author's **portable byline** — `did:ethr:<authorSafe>` (or an ENS label that
resolves to it). The mechanical read:

1. **Identity → Safe:** `eoaOf(did)` gives the Safe address (client-side; `toDidEthr`/`eoaOf`,
   `shared/src/protocol/types.ts`).
2. **Safe → records module (INV-4 walk):** `Safe.getModulesPaginated(0x0…01, pageSize)` → filter
   modules by `NAME() == "S2S Records Module"`. Same pattern as `getProtocolControllerAndModules`
   (shared/src/protocol/index.ts) and `getModuleAdresses`/`safe-integration.ts` (NAME check).
3. **Records module → byline value:** `getRecord('bylines')` (or `getAllRecords()`) — permissionless
   view.
4. **Byline → publications:** the value is either a content-addressed pointer (CID → IPFS index doc)
   or an inline list of `(publication, genesis)` tuples (schema decision, §7).
5. **Per publication:** resolve each publication's Safe + publication module (INV-4 walk), then
   verify via §3.2.

### 4.2 Who can read — **permissionless**

All `S2SRecordsModule` read functions (`getRecord`, `getRecords`, `getAllRecords`, `getAllKeys`,
`getRecordCount`, `getKeyAtIndex`, `recordExists`) are **plain `view` with no auth** — anyone can
read author A's bylines. Writes are `onlySafe` (only the author Safe). This preserves the protocol's
"read open, write capability-gated" posture and the anyone-can-index property (CASE 1): an external
indexer can walk any author Safe's modules and read the byline, then verify each entry against the
per-publication modules — **no privileged indexer, no shared store** (external-indexer-trust-model:
"no privileged indexer write path," INV-10).

### 4.3 ENS-node variant (Form A) read path — if ever used

`namehash(<author>.soul2soul.eth)` → C3 `getText(node, key)` (read via the CCIP gateway → C5).
**Gotcha (already documented, SPEC-contracts-ens C5):** the generic `text(bytes32,string)` in
`ENSResolverWithCCIP.sol` `resolve` is **stubbed to a hardcoded `"default"` key**, so arbitrary text
keys do not resolve through the resolver; the value must be read directly off C3 (`getText`, the
cid-mirror pattern) rather than through `resolveText`. This is another reason to prefer Form B
(Safe-addressed) — it avoids the C5 stub entirely.

---

## 5. Fragmentation / decentralization check — no protocol-wide store; where 'everything' could creep back

### 5.1 Confirmed: records are per-author, per-Safe

Each author's byline lives in **that author's own Safe-controlled `S2SRecordsModule`**. There is
**no** `getBylines` contract, **no** `authorDeals[author]` mapping, **no** protocol-wide deal/offer
ledger, **no** global `allSubdomains[]`/`getAllModules()` (confirmed absent — 
`S2SPublicationModuleV2Factory` keeps only `safeModules[safe]` per-Safe, no global list). The prior
central-ledger Option B (`authorDeals` index, deals-ledger-convergence §6a) is **dropped**. Storage
is fragmented by construction.

### 5.2 Where 'everything' creeps back in (and how to keep it out)

1. **The C3 shared ENS records store.** It remains protocol-wide and PKP-only (INV-12), but the
   author byline **does not touch it** (§1.2). Keep it that way — any Form-A/C3 author record
   reintroduces a shared write surface.
2. **The publication's own module as a verification source.** The publication module is the
   authoritative on-chain source for *its* deals; the author's byline is a *claim pointing at it*.
   This is **not** a store creep — it is the fragmentation that makes verification possible without
   a central index. "Everything queryable" here means *queryable across N independent Safe-scoped
   stores*, not *stored in one place*.
3. **A global author→module registry / enumerator.** This is the real temptation and the real
   centralization risk. If a protocol record (`ens_records`-style, in the controller configModule,
   e.g. `author_records`) were added to enumerate all author modules, that is a single authority and
   a single availability/censorship point — the exact "everything-in-one-place" the human rejected.
   **Keep discovery purely per-Safe (INV-4 walk).** No shared enumerator.
4. **The optional content-addressed index doc** (convergence §6 recommended `setRecord('byline',
   <CID>)`). A CID on IPFS is content-addressed, forkable, replaceable — not a store. This is the
   protocol-consistent way to carry the human-editable titles/URLs (content-vs-naming split,
   SPEC-00 §3.2), and it stays **author-owned**.

Net: the design keeps each author's records in their own Safe-controlled module; the only
"shared" pieces are (a) the immutable reusable `S2SRecordsModule` implementation/factory (shared
*code*, not shared *state* — harmless, like the per-publication module impl), and (b) the C3 store
for site roots, which author bylines do not use. No protocol-wide byline/deal state exists.

---

## 6. The right-to-be-forgotten idea — fits naturally, becomes self-sovereign curation

The prior convergence proposed a per-tuple `hiddenByAuthor[(publication,genesis)]` **filter** on a
shared ledger (deals-ledger-convergence §6b): the author hides a tuple from its own byline view;
publication side untouched; honest filter, not deletion. In the **author-owned** design this is
**trivially self-sovereign** — it needs no new filter flag at all:

- The author **controls the only store that renders "the author's bylines."** To hide a
  `(publication, genesis)` from their own byline, the author simply **omits it** from the
  `bylines` record (or `deleteRecord`/overwrites an individual tuple key), exactly like editing any
  other record in their own KV store (`onlySafe`). No shared contract, no `hiddenByAuthor` mapping,
  no gas on a shared index.
- **Publication side is untouched** (matches the convergence requirement): the deal remains a live
  deal on the publication's `S2SPublicationModuleV2` (`hasDeal(genesis)` still true), the CID/version
  log and `(publication,genesis)` record remain fully on-chain and verifiable via `authorOf`/
  `getLatest`. **On-chain nothing is deleted.**
- This is **honest filtering, not erasure** (as the convergence insisted): the tuple is still
  derivable from the publication's own module and from events (`Appended`/`DealStruck`), so hiding
  cannot masquerade as true deletion — it is a visibility preference in the author's curated view.
- It is **orthogonal** to `retract(genesis)` (real removal from the publication's deals/offers) and
  to `tombstone` (dead storage, never set — S2SPublicationModuleV2 `_append` always
  `tombstone: false`; deals-ledger-convergence §6b). Retract removes the *on-chain* deal; hiding
  only removes the *author's curated pointer*.

So the right-to-be-forgotten requirement is **fully satisfied and simplified** by the
author-owned design: it is just author-side curation of the author's own store, with the 
on-chain source of truth untouched. (If per-tuple history is desired — e.g. "I was published here
2008–2012" — the schema's `start`/`end` timestamps from deals-ledger-convergence §6c apply: `start`
= deal-struck time (`dealAt`, written by `_addDeal`), `end` = derived off-chain from `Retracted`
events, since `retract` stores no timestamp on-chain.)

---

## 7. Gaps + open decisions (greenfield surface)

### 7.1 Greenfield (must be built; none touches existing guarantees)

1. **Author module-install flow.** Authors today have no modules/ENS node; there is no
   "install a records module on an author Safe" path. Model on `newPublicationSafe`
   (`shared/src/publication/new.ts`): `recordsFactory.createModule(authorSafe)` +
   `authorSafe.enableModule(recordsModule)` + initial `setRecord`. Needs an author-side UI/action
   (0xobsidian author modal / a shared TxRunner path) and a decision on **who pays** (author Safe /
   protocol paymaster — SPEC-00 §3.2 payer model).
2. **Byline record schema (the claim format).** Decide between:
   - (a) a **single `bylines` record** holding an inline JSON list of `{publication, genesis,
     start?, end?}` tuples, or a **content-addressed pointer** (`setRecord('bylines', <CID>)`) to an
     IPFS index doc carrying human titles/URLs (convergence §6 recommended CID; content-vs-naming
     split); or
   - (b) **one record key per tuple** (e.g. `byline:<publication>:<genesis>`), leveraging the
     module's enumeration (`getAllKeys`) as the "list all my bylines" primitive.
   Option (b) makes hiding a single entry a `deleteRecord` (cleanest for §6); option (a) is simpler
   to write but rewrites a whole blob per change. Recommend exploring a hybrid: per-tuple keys for
   the on-chain claim, with titles/URLs in the content-addressed doc.
3. **`resolveAuthorByline` + verifier reader helper.** The `resolveLatest`/`getHistory` stubs in
   `shared/src/identity/verify-content.ts` are the natural home ("append-log contract pending" is
   stale — GAP-1 tail). A client-side `resolveAuthorByline(authorSafe)` should: walk Safe modules →
   find records module → read byline → for each tuple resolve the publication's module → verify
   `authorOf(genesis) == authorSafe && hasDeal(genesis)` → return verified bylines.
4. **GAP-1 tail (unrelated but blocking full verification):** the provenance `author` `did:ethr` in
   the render action was historically a hardcoded placeholder (SPEC-00 GAP-1). Current state per
   GAP-1: superseded — `render/main.ts` builds provenance from real signed data + `did:ethr`. The
   remaining tail is wiring the client-side history readers to the per-publication module. This
   should be resolved for the byline's verification spine to be fully grounded.

### 7.2 Open decisions (need the human)

1. **Author ENS node or not.** Form B (Safe/`did:ethr`-addressed, recommended, no ENS) vs Form A
   (`<author>.soul2soul.eth` via neutral PKP action on C3, more work + C3/INV-12 involvement) vs a
   thin ENS label pointing at the Safe's records module (label layer only, no C3 write).
2. **Module install path + governance of the author's own module.** `S2SRecordsModule` is
   **immutable** (GAP-7): no upgrade path. If the byline schema evolves, the author deploys a new
   records module and re-points (the deploy-new-and-migrate pattern from deals-ledger-convergence
   §e.4/§7.3) — or we accept the schema is stable. This is a non-issue for a v1 but should be
   stated: **the author's module has no upgrade authority**, which is a feature (neutrality /
   self-sovereignty) not a bug.
3. **Verification primitive: none needed, but decide the reader API.** Confirm we use existing
   `authorOf`/`hasDeal`/`getLatest` reads (recommended, zero new contract) vs adding a small
   cross-contract "verify tuple" helper on the records module (convenience, still per-author, not a
   shared store). Recommend the former; a helper is optional sugar.
4. **Claim schema + what is self-attested vs on-chain** (§3.3, §7.1.2): decide how much human
   metadata (titles/URLs) goes in the content-addressed doc vs inline, and how the reader
   distinguishes "verified on-chain" from "author-asserted label."
5. **Interplay with the portable-byline convergence.** This design **is** the convergence's CASE 2
   home (author-owned records module) with the central-ledger `getBylines`/`authorDeals` option
   (CASE via shared ledger) **removed**. The CASE 1 anyone-can-index layer remains complementary and
   is *simplified*: an indexer still watches `ModuleCreated`/`SubdomainRegistered` events and reads
   each per-publication module's `getDeals`, filtering by author — it does not need a shared ledger
   either. Decide whether to keep CASE 1 as a separate derived view (recommended) and how the
   author-asserted byline (CASE 2) is cross-checked against it (convergence §6.3 composition).
6. **"Only the PKP writes the root" boundary** — confirm and record that author byline writes go
   through the author's `onlySafe` module, never C3, so INV-12/DR-7.3 stays intact (§1.2). If the
   human ever wants the ENS-node/C3 variant, that is the decision point where a neutral PKP action
   becomes necessary.

### 7.3 What this design explicitly avoids (the rejected centralization)

- No `getBylines(author)` on a shared contract (protocol-wide-deals-contract §d — dropped).
- No `authorDeals[author]` maintained on-chain (deals-ledger-convergence §6a Option B — dropped).
- No protocol-wide `safeOf`/`gateOf` registration registry (Q2 of the ledger convergence — dropped).
- No shared `hiddenByAuthor` filter store (§6 — reduced to per-author curation).
- No global author-module enumerator / `author_records` protocol key (§5.2.3).

---

## Recommended minimum-viable shape (concrete)

1. **Reuse `S2SRecordsModule` verbatim** on the author Safe. Author optionally installs it:
   `recordsFactory.createModule(authorSafe)` → `authorSafe.enableModule(recordsModule)` →
   `setRecord('bylines', ...)` (or per-tuple `byline:<pub>:<genesis>` keys). **Zero new contract
   code**, zero C3/INV-12 involvement.
2. **Byline key/schema (v1):** store the on-chain claim as per-tuple records (or one `bylines`
   JSON/pointer) carrying `(publication, genesis[, start][, end])`; human titles/URLs in a
   content-addressed index doc (content-vs-naming split). No author ENS node in v1 (Form B).
3. **Reader + verifier:** `resolveAuthorByline(authorSafe)` → INV-4 walk the author Safe → records
   module → read byline → per `(publication, genesis)` resolve that publication's Safe + module →
   verify `authorOf(genesis) == authorSafe && hasDeal(genesis)` (+ `getLatest` for cid/timestamp) →
   return verified bylines; labels remain self-attested.
4. **Right-to-be-forgotten:** author omits/deletes the tuple from its own records; publication-side
   deal untouched (honest filter, not deletion).
5. **Keep CASE 1 anyone-can-index** as a complementary derived view (events + per-publication
   `getDeals`), cross-checking the author's byline — no shared store either way.
6. **Non-goals for v1:** author ENS node, neutral PKP action for author records, global author
   registry, shared deals ledger, `getBylines` on a shared contract.

**Grounding files:** `S2SRecordsModule.sol` + `S2SRecordsModuleFactory` (onlySafe KV, immutable,
NAME); `S2SPublicationModuleV2.sol` (`_append`/`genesisAuthor`, `authorOf`, `hasDeal`, `getLatest`,
`getDeals`, INV-append); `ENSL2nRecords.sol` (onlyAuthorized, INV-12) / `ENSOpenSubdomainRegistry.sol`
(C4 permissionless register) / `ENSResolverWithCCIP.sol` (C5, generic text stub); 
`S2SPublicationModuleV2Factory.sol` (per-Safe `safeModules`, no global list); `shared/src/protocol/
index.ts` (getProtocolControllerAndModules, INV-4 walk, INV-2 key set); `shared/src/publication/new.ts`
(module install template); `shared/src/protocol/types.ts` (DidEthr/eoaOf, S2SPublicContent);
`shared/src/identity/verify-content.ts` (verifyAuthorship + resolveLatest/getHistory stubs);
`protocol/actions/src/{update/main.ts, libs/gates.ts, libs/module.factory.ts}` (PKP root write,
author-Safe gates, deals read adapters); `protocol/scripts/lit/update-protocol.ts` (INV-12
authorizeCaller); specs SPEC-00 (INV-2/3/4/6/10/12, GAP-1/7, INV-append), SPEC-contracts-ens
(C3/C4/C5, INV-6/12), SPEC-contracts-publication (C1/C2, permissions matrix), SUMMARY-protocol
(two record stores, neutrality). Prior research: `2026-09-10-portable-byline-convergence.md`,
`2026-09-10-protocol-wide-deals-contract.md`, `2026-09-10-deals-ledger-convergence.md`,
`2026-09-10-portable-byline-case2-author-did-surface.md`, `2026-09-10-portable-author-byline-resolution.md`,
`indexer-offchain-resolution-findings.md`, `2026-09-10-external-indexer-trust-model.md`.
