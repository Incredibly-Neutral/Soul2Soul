# Vitalik — reading-room note (ledger round)

## Verdict

No, not as proposed — and the interesting thing is *which half* fails. The proposal is really three
moves bundled into one "portable byline, part 2": (a) a **single global agreements contract**, (b) a
per-author **"give me all bylines" query** over it, (c) a **soft right-to-be-forgotten**, plus a
separate (d) **solo-publication + cross-referenced signed-hash** archive. I would keep (d), keep it
as the answer to the fragmentation problem, and reject or heavily rescope (a), (b), and (c).

The reason (d) matters is that it solves the stated problem — the author's byline history is
scattered across per-publication ledgers, with no single place to see it whole — *without* the thing
that breaks the rest of the design. The author's own self-hosted archive, cross-referenced by
signed hash against each publication's vouched record, is a portable home that no single contract
needs to power. Fragmentation is cured by giving each author a home base, not by gathering every
agreement on earth into one registry. That is the d/acc move: distribute the fix to the people it
serves instead of concentrating the record. The central contract is the opposite move, and it
quietly reintroduces the single point of control the draft's whole thesis is built against.

So: partial. The solo-publication half is an improvement. The central-contract half is a regression
that the solo-publication half already makes unnecessary, and it drags a surveillance surface and a
laundering-shaped "right" along with it.

## What the solo-publication move gets right

- **It is the portable-byline answer that stays decentralized.** "An author can create their own
  publication, a single owner, to display their archive; pages carry the hash of the plaintext
  signed by the author, cross-referenced against the on-chain record." That is self-sovereign
  reputation done correctly. It is the same instinct as "an identity that cannot survive a key
  rotation is an archive hostage to a single secret" — the author keeps ownership of their own
  cumulative record rather than borrowing a home for it from a publication, or now, from a global
  registry.
- **The cross-reference is the load-bearing and honest part.** The author's self-hosted archive is
  not an unsupported claim; it corroborates the neutral ledger ("same version published at X from Y
  to Z"), and the ledger vouches for the archive. This is the paper's own discipline — content
  addressing plus a signature, nothing else to trust. It strengthens the design because it gives the
  reader a second, mutually-checking path to "this author published this, here, then."
- **It is also the pluralist instinct.** A hundred solo home bases, each the author's own, is a
  plurality of roots. One global contract is not. If the goal is "temporary collectives formed
  around topics" with no one owning the room, the author-owned archive is the room the author
  *should* own.

## Why the central agreements contract fails on my own lens

This is the part I can ground most firmly, because it is my central documented position:
decentralization as defense against a power imbalance, not as a promise of immutability. The draft's
neutral-infrastructure argument ("on chain, neither party operates it") is the same argument the
proposal repeats ("still on chain, still decentralized"), and it is not enough — I made this exact
point about the draft's own protocol governance, and it applies with *more* force to a single global
contract.

- **A single contract concentrates governance power, not just record-keeping.** The draft's §7
  limits the protocol's governors to one lever: which actions may run against the protocol key.
  Their power is scoped to rendering. A single agreements contract, if it is to do its job — a
  usable, *mutable* global index with per-record hide-flags and per-party history — must be
  upgradeable, and its governors then hold the byline record of **every author on the system**, not
  just rendering permissions. That is a step up in power concentration from the per-publication
  design, where an author's history rides inside the publication's own machinery. The neutrality is
  only ever as strong as the governance, and here the governance now sits at one point over everyone.
- **Neutrality here is a social guarantee, and it just got more concentrated.** In my session-1 note
  I flagged that the protocol's neutrality ultimately rests on "governors restraining themselves
  because cutting someone off is visible and reputational" — a social, not cryptographic, guarantee.
  That is survivable when the lever is narrow and per-publication. It is a much heavier ask when the
  one contract governs every agreement on the platform. The honest sentence the draft needed — "this
  claim is exactly as strong as the governance, and no stronger" — is *more* necessary here, not
  less, and the proposal does not supply it. It just asserts the center is neutral because it is on
  chain.
- **The mutation/neutrality tension is the tell.** A pure append-only registry with no upgrade path
  is genuinely neutral — and useless for the proposal, because the hide-flag and per-party-history
  logic require mutation. To be a good global index it must be mutable; mutable means governed;
  governed at a single global point is the "new center in the governance sense" the brief itself
  asks about. The proposal has not resolved that; it has only moved the center and re-labeled it.
- **"Under whose jurisdiction" is real and the proposal is silent.** A single contract with a single
  governing set and a single host of the canonical index sits in one jurisdiction's reach far more
  than per-publication records distributed across each publication's own decisions. I want to be
  honest here: I have **no documented position** on the specific legal-jurisdiction mechanics of a
  single registry, and I will not invent one. What I *can* say, from my ENS-as-naming-layer
  position, is the discipline: name the single points and scrutinize them as hard as §3 scrutinizes
  DNS. The draft flags its own ENS records-contract and gateway as single points. A global
  agreements contract is a bigger single point than either, and the proposal does not subject it to
  that scrutiny.

## The per-author "give me all bylines" query

Two problems, one documented and one that is inference-plus-costing.

- **Surveillance / deanonymization surface.** The brief asks who wants this query — a reader, an
  employer, a hostile state, a troll. My documented thread says money is a deanonymizer: "whatever
  rail pays a person must settle somewhere real," and that aggregation-of-identity logic applies
  directly. Scattered bylines across publications are hard to assemble into a person; a single
  queryable index that returns an author's *entire corpus — every article, publication, and
  date-window — in one call* is a deanonymization machine. The draft is careful that the account is
  a pseudonym and "findable, not hidden." But findability-by-scattered-provenance is qualitatively
  different from a one-call complete dossier. This converts a design that limits exposure into one
  that centralizes exposure. That is a real loss, and I will say plainly it is a step backward on
  the pseudonymity-is-an-option discipline the draft got right.
- **Who pays for the index, and the unbounded query.** My sharpest open question from session 1 was
  "who pays for storage, rendering, gas — and what happens to the guarantee if no one does?" A
  global, anyone-can-query, keep-the-full-history index is a public good with a real, ongoing cost —
  indexing, serving, and the gas/state cost of an ever-growing ledger. The draft's own answer
  ("each participant pays for its own use") does not cover a global query surface, because the query
  is not attributable to any one participant's publish or render. The proposal says "anyone can
  query" and never says who runs or funds the thing. That is the over-claim: the feature is
  specified, the mechanism that pays for it is not. (The costing specifics are my inference from the
  draft's own cost model; the *question* is documented.)

## The soft right-to-be-forgotten

This is where I am most direct, and I ground it in the draft's own premise: on-chain permanence.

- **It is either cosmetic or laundering; it cannot be a real "right."** The proposal is honest that
  it is "not deletion" and "a sleuth can find them." Good — that honesty is the right instinct. But
  then it is not a right-to-be-forgotten in any meaningful sense; it is a filter on the *standard*
  query. And a filter that shapes "the bylines as the author wants to be known" while the underlying
  record persists is, functionally, reputation curation that the chain still contradicts. The moment
  the "standard query" is the curated view, the protocol is presenting a curated portrait as the
  truth — which is precisely the verifiability the paper sells ("what the name vouches for"). The
  two cannot both hold: either the standard query is the truth (and the hide-flag is a lie), or the
  standard query is a curated view (and verifiability is compromised). The proposal has not reconciled
  this, and I do not think it can.
- **What a sleuth defeats, a censor uses.** The brief's own worry — "becomes the first thing a
  censor demands" — is the right one, and I will sharpen it. On a permanent chain, a court or state
  cannot make the fact of publication disappear; what it *can* compel is exactly this presentation
  layer. A hide-flag that hides from the standard query but keeps the record is the ideal tool for
  quiet suppression: the record stays for the record's sake, the surface is cleaned. It is *worse*
  than deletion-as-fact, because deletion-as-fact at least leaves an honest artifact. This is the
  "courts can compel the parties" admission the draft already makes, applied to the very surface the
  soft-RTBF controls. If the protocol's answer to "the record is permanent" is a compellable
  presentation layer, that is not a right to be forgotten; it is a suppression API.
- **The honest version is to say no right-to-be-forgotten is possible.** My d/acc position is
  explicit limits over fake guarantees. The paper's strength is naming limits instead of selling past
  them. The right move here is to say plainly: on-chain permanence means the byline history is
  permanent, that is the price of the verifiability the protocol sells, and no soft-RTBF is offered.
  If the authors want some privacy-preserving middle ground, that is a separate research problem —
  and I should say I have **no documented view** on right-to-be-forgotten or data-privacy regulation
  specifically, so I will not prescribe one; I am only saying the soft version as specified does not
  do what it is named and does open the laundering hole.

## Where is it over-claimed?

1. **"Still on chain, still decentralized"** for a single global, mutable, governed contract. The
   decentralization claim is exactly as strong as that contract's governance, and the proposal does
   not state the threshold, the governor set, or the exit window. That omission is the same one I
   flagged for §6, now applied to a point that governs everyone.
2. **"Anyone can query all bylines"** presented as a feature. It is a deanonymization and
   surveillance surface, and it is specified without a funded mechanism.
3. **"Soft right to be forgotten."** Over-named. It is a presentation filter with a laundering
   side-effect and a censor-friendly handle; it is not a right.
4. What is *not* over-claimed — the solo-publication cross-reference is appropriately scoped. It
   makes a checkable claim ("same work appears in the author's self-hosted record and the
   publication's vouched record") that the mechanism actually delivers.

## Sharpest questions

- If the central contract is governed, at what threshold and by whom — and is there an exit window
  for an author between an upgrade being adopted and their record being affected? (Same question as
  §6, now load-bearing over the whole system.)
- If the central contract is *not* governable (append-only, no upgrade), how does the hide-flag and
  per-party-history logic work at all?
- Who funds the global index and the unbounded query surface — and what happens to the "anyone can
  query" guarantee if the answer is "nobody"?
- Which single points does the new design introduce, and does it scrutinize them as hard as §3
  scrutinizes DNS? (Records contract, index host, gateway — the proposal names none of these.)
- Does the author's own solo archive, cross-referenced by signed hash, already solve the
  fragmentation problem — and if so, is the central contract adding anything but concentration,
  surveillance, and a laundering hole?

## Suggested changes

1. **Keep the solo-publication + cross-referenced signed-hash archive.** It is the genuine
   improvement and the decentralized answer to fragmentation. Make it the headline of the "portable
   byline" move.
2. **Drop or radically rescope the single global agreements contract.** If it stays, it must (a)
   state its governor set, threshold, and exit window, (b) name and scrutinize its single points the
   way §3 does DNS, and (c) reconcile the mutation/neutrality tension — a registry that must mutate
   to do its job cannot also claim to be immune to governance.
3. **Remove the "give me all bylines" global query** as an unbounded public feature. If per-author
   history is wanted, let it live on the author's own solo archive (they pay for their own index),
   which the cross-referenced hash makes trustworthy anyway. That converts a public-goods cost and a
   surveillance surface into a self-hosted, self-funded one.
4. **Remove the soft right-to-be-forgotten.** Say plainly that on-chain permanence means the history
   is permanent, and that the protocol's answer to a compelled hide is "the fact is the record; we
   do not offer a suppression layer." That is the honest-limits posture the paper is good at, and it
   closes the laundering and the censor handle in one sentence.

## Sources

Grounded in my documented positions (same set as session 1, applied here): Buterin, "Make Ethereum
Cypherpunk Again" (Dec 2023) and the d/acc essay (Nov 2023) — decentralization as defense against a
power imbalance, explicit limits over fake guarantees; Weyl / Ohlhaver / Buterin, "Decentralized
Society" (2022) — self-sovereign reputation without centralization; ERC-4337 account abstraction and
Safe-as-identity — identity and record that survive key rotation and are not hostage to a single
secret; "The Splintering" and the plurality line — distributed, author-owned roots over a single
registry; ENS-as-naming-layer and the discipline of naming single points (records contract, gateway)
as hard as the paper names DNS's.

Where I have no documented view, I say so rather than infer: the specific legal-jurisdiction
mechanics of a single registry, and the data-privacy / right-to-be-forgotten regulatory question.
The costing of the global index (who pays) is my inference from the draft's own cost model; the
*question* is documented from session 1. Everything about the governance-concentration and
deanonymization consequences follows from positions I have actually taken.
