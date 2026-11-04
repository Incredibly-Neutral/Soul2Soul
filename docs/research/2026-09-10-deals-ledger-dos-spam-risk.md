# Findings — Reassessing the DoS / Censorship / Spam / Isolation claims on a Protocol-Wide Deals Ledger

> **Scope:** read-only research. No code changed, no PR. This file is a *corrective
> re-examination* of three specific claims made in
> `brain/research/2026-09-10-protocol-wide-deals-contract.md` — §(b.2) "per-publication
> isolation is lost", §(b.2)/(f.4) "permissionless `makeOffer` becomes global spam", and
> the repeated "single point for all publications" / "one censorship/availability point"
> framing (§b.2.3, §e.1) — against the human's challenge:
>
> - *"I have not heard of contracts being DoSed or censored. Explain."*
> - *"I could flood a publication with BS.. would cost me.. when I flood the protocol
>   contract it will still be assigned to an individual publication — i.e. the same as now."*
>
> Grounded in the actual stack: `S2SPublicationModuleV2.sol`, `gates.ts`, `module.factory.ts`,
> `ccip_gateway/src/main.ts`, `cid-mirror/src/ens.ts`, the 4337/Pimlico authoring flow
> (`permissionless.safe.service.ts`, `publication.service.ts`), the threat model
> (`threat-model/README|protocol|publication|author.md`), `SPEC-00-system-contract.md`,
> and whitepaper components 6/7. **Where the prior report overstated, this file says so
> explicitly.** Date: 2026-09-10. Workspace: `/home/joera/code/s2s`.

---

## (0) Thesis

The prior report's headline cost — *"a single shared ledger turns every publication's deals
into one point of failure / one censorship surface"* — **overstated the DoS/censorship
mechanics and under-weighted the only claim that is actually, precisely true**. The honest
picture, in one paragraph:

1. **You cannot "DoS or censor a contract" in the way the phrase implies.** A deployed
   contract is not a service you knock offline. The *real* availability/censorship points of
   this protocol live almost entirely **off-chain** (the CCIP gateway, DNS gateways, IPFS
   gateways, indexers, the Safe-app UI, and — for everything on Base — **Coinbase's single
   sequencer**, which is a property of *every* contract on Base, not of any s2s choice). A
   single shared ledger adds **no new base-layer censorship** whatsoever, because it lives on
   the same Base L2 as the N per-publication modules do today.
2. **The genuine, non-overstated cost of "one contract" is not DoS, not censorship, not even
   really "isolation" — it is a *concentration of upgrade and registration authority*.** The
   only actor who can mutate *everyone's* deals logic in one stroke is whoever holds
   `_authorizeUpgrade` (and, for a maintained author index, whoever maintains the registry).
   Per-publication, each Safe holds that lever for its own module only. That is the real
   blast-radius change, and it is a **governance decision**, not an availability property.
3. **The "global spam" concern is essentially the same as today, not worse.** `makeOffer` is
   already permissionless *per module* — any address can already flood any publication's offer
   list today for the same cost. A shared ledger keeps each offer scoped to its `publication`
   parameter; it adds *one* new spam-adjacent cost (a maintained per-author index is an
   unbounded append) that is **opt-in design** (Option B), not inherent to sharing.

**Net verdict:** "single contract = DoS/censorship risk" is **not a fair claim** as stated.
The fair, honest version is: *a single contract = one upgrade authority + one failure domain
for the deals layer, and it introduces no new on-chain censorship because Base's single
sequencer already covers every contract.* Spam is **same-as-today** unless you adopt the
maintained author index, in which case that specific cost is new and must be bounded.

---

## (1) Can a single on-chain contract actually be DoS'd or censored?

### 1.0 The human's premise, corrected

> *"I have not heard of contracts being DoSed or censored."*

This is **largely correct**, and the reason is structural: an EVM contract is **passive
state + code**. Nobody "takes it offline" — the code runs wherever a node executes it, and the
state persists in the chain's state trie. There are **no servers, no uptime, no host to
pressure**. To "kill" a contract you must either (a) make its *state* unreachable or
un-executable (a base-layer or gateway problem, not a contract problem), or (b) get an
authorized actor to *change* its code or state (an upgrade/authority problem). The prior
report conflated both under the loose phrase "one censorship/availability point." Splitting
them is the whole correction.

### 1.1 (a) Base-layer censorship/availability — Base is the single sequencer

Base is a **single-sequencer rollup operated by Coinbase**. Everything on Base — every s2s
per-publication module *and* any proposed shared ledger ��� is sequenced by that one entity. If
Coinbase's sequencer refuses a transaction or stalls, **every contract on Base is affected
identically**. This is:

- **Not special to a single s2s contract.** It applies with exactly the same force to the N
  per-publication modules that exist today. The human's instinct is correct here: there is
  *nothing about the shared ledger* that makes it more or less censorable than the modules —
  they all ride the same rollup.
- **Acknowledged as out-of-scope by the protocol's own threat model.** `publication.md`
  names "**Base (L2) centralization** — the sequencer is run by Coinbase; the L2 records
  contract is at Coinbase's mercy for sequencing" as an explicit **C (deferred)** item.
  `protocol.md` likewise treats RPC/paymaster/bundler as **compellable relays**. So "the
  sequencer can drop your tx" is a real availability/censorship vector — **but it is already
  true for every contract on Base today and is orthogonal to N-vs-one**.
- **Sequencer-level DoS on a specific contract is not a real mechanism.** A sequencer
  operator can censor a *specific address* or *all* traffic, but "the contract is DoS'd" is
  not something an external attacker can do to a contract that the contract itself didn't
  allow. The classic "contract DoS" is a **griefing pattern on *shared* mutable state**, not
  on availability — and s2s deals state has none of the classic hooks (no `transfer` to a
  blacklisted contract, no `block.timestamp` dependency, no ETH-locked-then-unreachable).

**Verdict on (a):** the only real base-layer censorship in this stack is Coinbase's sequencer
over Base — and it is **identical for N modules and 1 shared ledger**. The shared contract
introduces **zero** new base-layer risk. Saying "a single contract is a DoS/censorship point
for every publication" is **overstated** unless it is explicitly restated as "everything on
Base already shares this one point, so this adds nothing."

### 1.2 (b) Contract-level failure modes that ARE real for a single shared ledger

These are the modes worth taking seriously — and note they are **failure/authority** modes,
**not** "DoS/censorship" in the availability sense. Each is a real *new* property of one
shared contract that per-publication modules do not have:

1. **Single point of FAILURE (one bug/hack/freeze bricks every publication's deals vs N
   isolated modules).**
   - **Real:** one contract means one codebase, one storage layout, one freeze point. A bug in
     `_append`/deal-set logic, a reentrancy/front-run flaw, or a storage-corruption upgrade
     would corrupt or block the deals layer of **every** publication simultaneously. With N
     per-publication UUPS proxies, a bug is discovered and patched against **one** module while
     the other N keep working; a catastrophic bug breaks one publication, not all.
   - **Magnitude honesty:** the deals ledger is a **small append-log with no custody and no
     funds** — it holds no ETH, no tokens, nothing to steal. The realistic "hack" blast radius
     is *logic* corruption or a freeze, not theft. And a freeze on a ledger is **read-only
     damage**: content itself lives on IPFS/Filecoin and is never hostage to the ledger (the
     ledger only records *deals*, and `hasDeal` gates publishing — see 1.2.3). So the
     single-point-of-failure is real but it is a **modest, recoverable** one, not a
     catastrophic one. The prior report called it "the single biggest architectural cost" —
     that is defensible as *an* honest concern, but the report over-sold the severity by
     implying availability/DoS rather than a fixable logic bug.
2. **Upgrade/governance authority — the REAL "censorship" vector.**
   - `S2SPublicationModuleV2` is **UUPS**; `_authorizeUpgrade` is `onlySafe` (that module's
     publication Safe). Today each Safe can only upgrade *its own* module.
   - In a single shared contract, **whoever holds `_authorizeUpgrade` can replace the deals
     logic for every publication at once.** A malicious, coerced, or buggy upgrade mutates
     everyone's deals — e.g. an upgrade that flips `hasDeal` to false for a target genesis, or
     changes `_append` gating. **This is the only genuine "censorship" vector in the entire
     discussion** — it is the one place a single actor could reach across publications. The
     prior report named this correctly (§b.2.1, §e.4) but buried it under the looser
     "censorship/availability point" language.
   - Mitigations exist and are already the protocol's own frame: **immutable/frozen after
     genesis** (mirrors `S2SRecordsModule`, GAP-7), or a **multisig-of-publication-Safes**
     upgrade gate, or "upgrade = deploy new address + migrate" (mirrors how CIDs are replaced,
     not mutated). The decision is purely **who holds the one `_authorizeUpgrade`**, which is
     a governance choice, not a DoS property.
3. **Dependency coupling (render gate depends on the ledger).**
   - `gates.ts::canRead` reads `hasDeal(genesis)` on the module; `canPublish` reads
     `canPublish(addr)`. `module.factory.ts` reads `getDeals`/`getLatest`/`getLatestEntry` for
     the render pipeline. Today these read **per-publication modules**; with a shared ledger
     they read **one contract**.
   - If the shared ledger is broken/frozen/renounced, the render gate (and thus *publishing*)
     for **every publication** is coupled to that one contract. Per-publication, a frozen
     module only blocks that one publication. **This is the real, non-overstated form of
     "isolation lost"** — a *dependency-coupling* blast radius, not availability DoS. It is
     the same class as the existing coupling to the `configModule`/records contract (which is
     already protocol-shared today), so it is **not a novel pattern** — it is the protocol
     already running shared infrastructure (§3.2 below).
4. **State-bloat / gas ("DoS via state growth") on L2 — mostly NOT real.**
   - Each `makeOffer` appends one `Version` (a `string cid`, `uint256 timestamp`, `bool
     tombstone` — a few hundred bytes) plus at most one genesis to `dealList`/`offerList`.
   - **On Base this is not a free DoS.** Storage writes cost gas proportional to the bytes
     written, and the gas is paid by the *caller* (the flooder) — so an attacker must pay to
     grow the state. There is no "one cheap tx makes everyone else's reads expensive" trick
     here because enumeration is **paginated** (`getDeals(offset,limit)`, `_page` bounds each
     call to `limit`). A huge polluted `offerList` only makes a *full* enumeration take many
     pages — an off-chain indexer's problem, not an on-chain DoS. So "DoS via state growth" is
     **overstated** on L2. The *real* gas/state concern is the **maintained author index**
     (§2.4), which is new and unbounded *if* you build Option B — but that is a design choice,
     not a property of sharing.

### 1.3 (c) Where censorship ACTUALLY lives in this stack (off-chain)

The protocol's own threat model is explicit and honest about this, and it is **the** answer to
"where does censorship live":

- **The CCIP gateway** — `ccip_gateway/src/main.ts` is a **single Express service**
  (`ccip.transport-union.dev`) with a small `BASE_RPC_URLS` fallback list *inside itself*.
  It is a documented **`[GAP]` single point** in the read path (whitepaper 07, `publication.md`):
  kill the gateway and **name→content resolution dies for every publication**. This is the
  real "one point for all publications" today — and it is **off-chain**.
- **DNS gateways** (`.limo`/`.link`) — ENS has **no L1 fallback** for the root; every reader
  path goes through a jurisdiction-controlled DNS gateway. Block the gateway domain and
  readers lose the name even though the bytes survive.
- **IPFS/Filecoin retrieval gateways** — delivery depends on providers that can be pressured
  or blocked (whitepaper 06/07; `publication.md` infrastructure layer).
- **Indexers / CASE-1 enumerators** — the protocol's design principle is *anyone-can-index*,
  so no single indexer is authoritative; but any one indexer is individually compellable.
- **The Safe-app UI / GitHub repo host / paymaster / bundler / RPC** — all named in the threat
  model as **compellable relays** (RPC, paymaster, bundler, repo host, UI host). These are the
  *operational* chokepoints.

**The striking fact for this review:** every one of these — the CCIP gateway, DNS gateways,
IPFS gateways, indexers, Safe-app, the Pimlico paymaster/bundler, and Base's sequencer — is
**already a single point affecting every publication**, *independent of* the N-vs-one deals
question. A shared ledger sits at the *bottom* of the stack, off the read path that actually
matters (name→content). **Moving deals from N modules to 1 ledger does not touch a single one
of these real censorship points.** This is the crux: the protocol already runs shared,
compellable, single-point infrastructure; the deals ledger is, by comparison, one of the *most*
decoupled, censorship-resistant pieces of the whole stack.

### 1.4 Verdict on Q1

**"Single contract = DoS/censorship risk" is not a fair claim.** The honest decomposition:

| Claim in prior report | Honest status |
|---|---|
| "Base-layer DoS/censorship" | **Overstated / not a new risk.** Base's single Coinbase sequencer already governs *every* contract on Base; N-vs-one is irrelevant. |
| "A single contract can be DoS'd" | **Not a real mechanism** for this contract; no availability attack surface exists on passive state. State-growth is paid-for and paginated (not free DoS). |
| "One censorship/availability point for all publications" (implied on-chain) | **Overstated.** The real single points (CCIP gateway, DNS gateways, IPFS gateways, indexers, Base sequencer, Safe-app) are all off-chain and all already protocol-wide today. The ledger adds none of them. |
| **Single point of FAILURE (one bug/freeze bricks all deals)** | **Real, but modest:** a small, no-funds append-log; a logic bug or freeze affects all publications' *deal records*, recoverable, not catastrophic. |
| **Upgrade/governance authority (one `_authorizeUpgrade`)** | **THE real censorship vector.** Whomever holds it can mutate all deals logic. Mitigable by freeze/multisig-of-Safes/deploy-new. |
| **Dependency coupling (render gate reads the ledger)** | **Real and the honest form of "isolation lost."** A broken ledger couples publishing across all publications; but the protocol already couples to shared `configModule`/records today. |
| State-bloat "DoS" | **Overstated on L2**; the real variant is the (optional) maintained author index. |

---

## (2) Spam economics reality-check

### 2.1 (a) Who pays gas for `makeOffer` today?

- The write path is **`publication.service.ts::makeOffer` → `main.oxo.ctrlr.account[L2].genericTx`**
  → `PermissionlessSafeService.smartAccountClient.sendTransaction`, which is a **Safe via
  ERC-4337**, submitted through a **Pimlico bundler + Pimlico paymaster**
  (`paymaster: this.pimlicoClient` in `setSafe`; `createPimlicoClient` in the constructor).
- So `msg.sender` **is the author Safe** (the 4337 account), and gas is paid via the **Pimlico
  paymaster** keyed by the plugin's `pimlico_key`. The author's identity account is *funded
  only for protocol fees* (`author.md §2`; `01-content-authoring.md` DR-1.4 "no funds
  involved"); the paymaster covers the operation. Whether the *author* or the *protocol*
  ultimately bears the cost is a paymaster-sponsorship-policy question on the Pimlico key —
  but the key structural facts are: (i) **an author does not pay raw gas out of pocket per
  call in the normal flow** (paymaster-funded), and (ii) **any arbitrary address can call
  `makeOffer`**, and if *they* do, *they* pay (or their own paymaster pays).
- **Crucially for the spam question:** `makeOffer` is **permissionless** in the contract —
  no `onlySafe`, no whitelist requirement to *call* it (whitelist only decides whether the
  result is an instant deal vs a pending offer, and `_append` reverts `OnlySafe` only if the
  caller is neither `genesisAuthor` nor safe on a *subsequent* append of the same genesis).
  So **any address can already append a new pending offer to any publication's module**,
  paying only their own gas (≈ a few hundred bytes of L2 storage + calldata — on Base, roughly
  a fraction of a cent to a few cents per call in 2026 terms).

### 2.2 (b) Is an offer still scoped to one specific publication in the shared ledger?

**Yes — this is the human's key insight, and it is correct.** In the shared design the
`publication` is an **explicit parameter** on every record and every call (prior report §b.1;
`onlySafe(publication)`, `safeOf[publication]`, `canPublish(publication, author)`,
`hasDeal(publication, genesis)`). A flood offer lands in **that publication's** offer set, keyed
by `(publication, genesis)`. **No spamming the protocol contract crosses publication
boundaries** — there is no "global deal" that a flood could pollute for others. The shared
ledger is a *shared substrate with per-publication scoping*, exactly as the human says: *"it
will still be assigned to an individual publication — i.e. the same as now."*

### 2.3 (c) Is flooding the shared contract materially worse than flooding a per-publication module today?

**No — and this is the second insight the prior report got wrong.** The prior report (§b.2,
§f.4) claimed per-module "containment" is a property that would be *lost*. But:

- **Any address can ALREADY call any publication module's `makeOffer` permissionlessly
  today.** The offer list lives in that one module, and an attacker can already stuff it with
  garbage pending offers at gas cost — identical to what they'd do against the shared ledger's
  per-publication offer set.
- **Per-publication "containment" is therefore not real today.** It is *scoping* (each
  publication sees only its own offers via `getOffers`), not *containment* (there is no
  global offer pool today to be protected, and no per-publication rate limit exists in the
  contract). The only thing that limits flooding today is **gas cost**, not isolation.
- A shared ledger changes **none** of this: same permissionless `makeOffer`, same gas cost,
  same per-publication scoping. **The "global spam" framing in the prior report overstates
  the delta.** There is no new "protocol-wide offer log" that an attacker can pollute *other
  publications* with — each offer is scoped to its publication. Enumeration across
  publications (`getDeals` with a `publication` param, or a byline indexer) must tolerate
  noise *per publication*, which is exactly the tolerance needed today.

### 2.4 (d) Does the shared ledger add NEW spam-adjacent costs?

Honest accounting of what is genuinely *new* (vs the same-as-today baseline):

1. **A maintained `authorDeals[author][]` index (Option B) — the one real new spam-adjacent
   cost.** If the design adopts the on-chain author index (prior report §d.2 Option B) to make
   `getBylines(author)` an O(1) read, then `authorDeals[author]` is an **unbounded append per
   author**: every `makeOffer`/`acceptOffer` pushes a `(publication, genesis)` tuple onto that
   author's list. A flooder who controls an address can grow that one array without bound,
   bloating state and making that author's `getBylines`/pagination expensive.
   - **Mitigations (easy):** per-author or per-publication caps (the contract already has the
     pattern — `MAX_WHITELISTED_AUTHORS = 100`, `MAX_WHITELISTED_DEVS = 20`); cap the pending
     offer count per publication; or **drop the maintained index** and derive bylines
     **off-chain from events** (Option A — zero new state, and the protocol's *anyone-can-index*
     principle already prefers this; events gain an indexed `publication` field per prior
     report §c.3). If Option A is chosen, **this cost disappears entirely** — `getBylines`
     becomes an off-chain indexer concern, not an on-chain state-bloat concern.
   - **Important:** the *maintained-index* growth is **not* an L2 "free DoS" (each append
     still costs the flooder gas), it is just a per-author unbounded array. Bounded, it is a
     non-issue; unbounded, it is a minor, fixable state-growth concern. This is the **only**
     place the shared design adds a genuinely new spam-adjacent surface, and it is **opt-in**.
2. **Global event-log size.** Events (`Appended`, `DealStruck`, `OfferMade`) are *not* stored
   state and cost the emitter gas; a flooder grows the event log at their own expense. Larger
   event volume makes off-chain indexers scan more — a *processing* cost, not an on-chain DoS,
   and identical in kind to today (today the events are per-module but equally floodable).
3. **`getDeals`/`getOffers`/`getBylines` pagination over a polluted set.** Already paginated
   and bounded per call (so no on-chain DoS); a polluted set only means an indexer/UI does
   more pages. Identical to today's per-module pollution, except a byline enumerator might
   aggregate across publications (their cost, not the chain's).
4. **Gas for every publication's reads.** Reads are `eth_call`s (gas-free to the caller, RPC
   cost only). A shared contract does not make reads more expensive per publication; it may
   even reduce the *number* of discovery hops (one contract instead of N modules + factory
   `getModulesForSafe`). No new read-side gas is added.

### 2.5 Verdict on Q2

**"Global spam" is essentially the same as today, not worse — the human is right.** Because
`makeOffer` is already permissionless per-module with no containment and the same gas cost, and
because the shared ledger keeps every offer scoped to its `publication`, flooding the shared
contract is functionally identical to flooding a per-publication module today. The **only
genuinely new** spam-adjacent cost is the **maintained per-author `authorDeals[]` index**
(Option B) — and it is (i) opt-in, (ii) cheaply bounded with the same cap pattern the contract
already uses, and (iii) entirely avoidable by deriving bylines off-chain from events (Option A).
The prior report's "permissionless `makeOffer` becomes global spam" (§b.2, §f.4) is **overstated**:
it should be restated as *"makeOffer stays permissionless and equally floodable as today; the
only new surface is an unbounded author-index append, which is a bounded, optional design
choice."*

---

## (3) Isolation-reassessed — is the real cost the UPGRADE AUTHORITY, not "isolation"?

### 3.1 What "isolation" actually buys today, and what it doesn't

Per-publication UUPS proxies give each publication:
- **Its own `_authorizeUpgrade`** (`onlySafe` of that module) — a per-publication upgrade
  lever.
- **Its own failure domain** — a bug/freeze in one module doesn't touch another's storage or
  logic.
- **Its own offer/deal list** — but this is *scoping*, not security (anyone can already flood
  any of them, §2.3).

What per-publication isolation does **NOT** buy today:
- **Any base-layer independence** — every module is on Base behind Coinbase's sequencer (§1.1).
- **Any off-chain censorship independence** — every publication already depends on the shared
  CCIP gateway, DNS gateways, IPFS gateways, the shared controller Safe, shared records, and
  the shared PKP (threat model; whitepaper 6/7).
- **Any read-path independence** — a CASE-1 indexer already walks shared protocol discovery
  (`getProtocolInfo`) before reaching any module.

### 3.2 The neutrality frame already runs shared infrastructure

The protocol already has **protocol-wide shared, single-instance authority and state** that is
not per-publication:
- a **shared controller Safe** (`parentDomainController`, `soul2soul.eth` root — the biggest
  protocol-level lever, named in `publication.md` as the `reclaimParentDomain` C-item);
- **shared records** (`S2SRecordsModule`/configModule on the controller, and the `ens_records`
  records contract C3 that holds every publication's site root — a single shared contract
  whose `contenthash_wrapped` every publication writes);
- a **shared PKP** (one enclave-held key that writes the root for *every* publication, INV-12);
- **shared action CIDs / Lit Group** (one group governs all rendering).

**Consequence:** the protocol's architecture is *already* "one shared store + one shared key +
one shared controller." The per-publication modules are the **exception**, not the norm, in
this stack. Hoisting the deals ledger into a shared contract is therefore **not a novel
centralization** — it *reduces* the count of upgradeable modules while keeping the ledger as
decentralized as the existing shared records contract (arguably more so, since it holds no
root and no funds).

### 3.3 The real cost, isolated

Given (i) the ledger is a **small append-log with no custody/no funds**, (ii) the neutrality
frame already runs shared controller/records/PKP, and (iii) the alternative is N UUPS proxies
each with its own `_authorizeUpgrade`:

**The real cost is almost entirely the UPGRADE AUTHORITY decision — who controls the one
`_authorizeUpgrade` (and, secondarily, who may register a publication / whether the author
index is maintained).** The word "isolation" is a red herring for *availability* or *censorship*
(§1) — the only place isolation has real teeth is the **authority to change deals logic for
everyone at once**, which is a governance decision with three protocol-consistent answers
already on the table (prior report §e.4): frozen/immutable (mirrors `S2SRecordsModule`),
multisig-of-publication-Safes (authority collective, matches the threat model's "collective
authority, no single owner"), or deploy-new-address-and-migrate (mirrors the CID-replacement
pattern). Under the first two, the single contract's upgrade authority is **as distributed as
or more distributed than** per-publication `onlySafe` today — at which point the "loss of
isolation" argument largely dissolves.

### 3.4 Verdict on Q3

**Yes — the real cost is the upgrade-authority decision, not "isolation" per se.** The
single-failure-domain cost is real but modest (a no-funds append log whose only catastrophic
mode is a fixable logic bug or freeze), the neutrality frame already centralizes far more
(shared controller, shared records, shared PKP, shared gateway), and the alternative of N
upgradeable proxies buys per-publication authority at the price of N upgrade surfaces and zero
cross-publication enumerability. The honest framing: **moving to one ledger converts N
per-publication `_authorizeUpgrade` levers into one lever, and the entire "isolation lost"
concern reduces to "who may pull that one lever" — a governance decision that freeze/multisig
can answer without any availability or censorship cost.**

---

## (4) Bottom-line risk register for the single shared deals ledger

Rates: Likelihood (L) = chance over the protocol's lifetime; Blast radius (B) = publications
affected; M = mitigations.

| # | Risk | L | B | Assessment | Mitigation |
|---|---|---|---|---|---|
| R1 | **Upgrade authority capture** — whoever holds the one `_authorizeUpgrade` mutates all deals logic (e.g. flips `hasDeal`, loosens `_append`). | **Low-Med** (depends on holder) | **All** | **The real censorship vector.** Per-module, each Safe holds only its own lever; one contract = one lever. | Freeze after genesis (immutable, like `S2SRecordsModule`); or multisig-of-publication-Safes upgrade gate (authority collective); or deploy-new-address + migrate (CID-replacement pattern). No privileged deal-mutation write path (no protocol "force-deal/force-retract"). |
| R2 | **Single point of FAILURE** — a logic bug or storage-corruption upgrade freezes/corrupts the deals layer for all publications at once. | **Low** | **All (deals records only)** | Real but modest: small append-log, **no custody, no funds, nothing to steal**; content (IPFS/Filecoin) is never hostage; a freeze is read-only/recoverable. | One codebase to audit/secure (cheaper than N); comprehensive tests on the single implementation; freeze-first to make bugs permanent-but-harmless; keep content off-ledger (already true). |
| R3 | **Dependency coupling** — render gate (`gates.ts hasDeal`, `module.factory.getDeals/getLatest`) coupled to one broken/frozen ledger blocks publishing for all publications. | **Low** | **All (publishing)** | The honest form of "isolation lost"; but the protocol already couples to shared `configModule`/`ens_records` today, so it is not a novel pattern. | Read-through fallback / last-known-good cache; keep the ledger minimal and stable; document the coupling in the render spec. |
| R4 | **Base sequencer censorship/stall** (Coinbase) over the deals layer. | **Med** (external) | **All** | **Not a new risk** — identical for N modules and 1 ledger; already a named C-item in `publication.md`. Nothing s2s can do on-chain; a fork/other-chain is the escape hatch (threat model). | None on-chain; it is a rollup property. Do not treat it as a single-contract risk. |
| R5 | **Permissionless `makeOffer` flood** (spam pending offers). | **Med** | **1 publication at a time** | **Same as today.** `makeOffer` is already permissionless per-module; shared ledger keeps offers scoped to their `publication`. Gas cost bounds it. | Per-publication/per-author offer caps (existing `MAX_*` pattern); paginated reads (already); accept spam as the price of capability-open. |
| R6 | **Maintained `authorDeals[author][]` index growth** (Option B) — unbounded per-author append. | **Low** | **Per-affected author** | **The only genuinely new spam-adjacent cost** — and it is opt-in design. | Bounded per-author array / caps; or drop the on-chain index and derive bylines off-chain from events (Option A, zero state) — preferred for the anyone-can-index principle. |
| R7 | **Global event-log / indexer processing volume** under flood. | **Low-Med** | **Indexers** | Not an on-chain DoS (events aren't state; emitter pays gas); a processing cost for off-chain enumerators, same kind as today. | Anyone-can-index (no privileged indexer); indexers bound their scans; per-publication scoping in events (`publication` indexed). |
| R8 | **Registration authority** — who may set `safeOf[publication]`. | **Low** | **All (discovery)** | A new authority not present today; a malicious registration could squat a publication identity. | Publication Safe self-registers via 4337 (self-proving, capability-open) — no trusted third party needed. |

**Net:** only **R1 (upgrade authority)** and **R3 (dependency coupling)** are real,
non-overstated *new* risks of a single ledger, and both are governance/architecture decisions
with clean mitigations. **R2** is real but modest. **R4** is not a single-contract risk at all.
**R5** is same-as-today. **R6** is the only genuinely new spam-adjacent cost and is opt-in,
bounded, or avoidable. The prior report's headline "single point for all publications /
global spam / isolation lost" **overstated R4/R5** and correctly but unclearly flagged R1/R3.

---

## (5) Files / specs relied on

**Research / specs**
- `brain/research/2026-09-10-protocol-wide-deals-contract.md` (the study being challenged —
  §0, §a, §b.1–b.3, §c, §d.1–d.3, §e.1–e.4, §f).
- `brain/threat-model/README.md` (stoppable-by-design, compellable relays, fork-as-escape-hatch,
  no single owner).
- `brain/threat-model/protocol.md` (censorship by upgrade is B-partial; compellable relays;
  fork as escape hatch).
- `brain/threat-model/publication.md` (naming layer fragile; CCIP gateway `[GAP]` SPOF; DNS
  gateways; **Base/Coinbase sequencer centralization as C-deferred**; shared controller
  `reclaimParentDomain` lever; collective authority).
- `brain/threat-model/author.md` (author identity = Safe; paymaster/bundler are compellable
  relays; author account funded only for protocol fees).
- `brain/specs/SPEC-00-system-contract.md` (§2 trust domains; §3 payer model; INV-2/INV-3/
  INV-4/INV-6/INV-7/INV-8/INV-10/INV-12; GAP-7 module upgradeability asymmetry).
- `brain/whitepaper/06-website-hosting.md` (content-addressed, not self-preserving; retrieval
  gateways; Filecoin warm-storage).
- `brain/whitepaper/07-domain-resolution.md` (CCIP-Read flow; CCIP gateway `[GAP]`; no L1
  fallback; DNS gateway dependence).
- `brain/whitepaper/01-content-authoring.md` (did:ethr-over-Safe; 4337 paymaster → `msg.sender`
  is the Safe; author identity funded for protocol fees only).

**Contracts / action libs / code**
- `protocol/contracts/contracts/S2SPublicationModuleV2.sol` — `makeOffer` (permissionless),
  `_append` (INV-append), `acceptOffer`/`retract`, `_authorizeUpgrade onlySafe` (UUPS),
  `hasDeal`, `canPublish`, `getDeals`/`getOffers`/`_page` (paginated), `MAX_WHITELISTED_AUTHORS/
  DEVS`, event set, storage layout (INV-3).
- `protocol/actions/src/libs/gates.ts` — `canRead` reads `hasDeal(genesis)`; `canPublish` reads
  `canPublish` + `isOwner` (the render gate dependency in R3).
- `protocol/actions/src/libs/module.factory.ts` — `getDeals`, `getLatestEntry`, `getLatest`,
  `fetchByPublication*` (the render-pipeline deal reads).
- `protocol/ccip_gateway/src/main.ts` — single Express service, `BASE_RPC_URLS` fallback array,
  `getText` on the records contract (the on-chain-adjacent read SPOF).
- `cid-mirror/src/ens.ts` — `getProtocolInfo`, `resolveEnsToCID` (CASE-1 read-path precedent;
  discovery walk controller → configModule → records contract).
- `0xobsidian/src/eth/permissionless.safe.service.ts` — `toSafeSmartAccount`,
  `createSmartAccountClient` with `paymaster: this.pimlicoClient` (Pimlico bundler+paymaster;
  `msg.sender` = Safe).
- `0xobsidian/src/paymaster/paymaster.factory.ts`, `constants.ts` — paymaster balance checks,
  entrypoint constants.
- `neutralpress/src/publication/publication.service.ts` — `makeOffer`/`acceptOffer`/`retract`
  over `genericTx`; `neutralpress/src/publication/publish.ts` — the sign→Kubo→`makeOffer`→render
  author flow.
