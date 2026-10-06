# Cory Doctorow — reading-room note (round 3)

## Verdict

No. This is not an improvement; it is a step backward, and it is the step the
current draft was wisely avoiding. The proposal solves a genuine but minor
annoyance — an author's corpus is spread across per-publication ledgers — by
building a single point of control and a total surveillance surface, then
dressing both in "on chain, still decentralized" language that the draft's own
§6 taught us not to trust. The draft's weakness, from my last note, was that it
sold "trustless" when it had built "trust in a smaller, more accountable set of
parties." This proposal does not fix that. It makes the set of parties smaller,
less accountable, and harder to leave. On every axis I care about — who can
walk away, who holds the keys, who can be observed — the central contract is
worse.

But one part of it is genuinely good, and I want to be fair about it up front:
the solo-publication cross-referenced-hash move. That piece is worth keeping.

## The central contract is a platform by another name, and the brief says so without noticing

The draft's original design — a ledger per publication, on a neutral chain — is,
in my terms, an *interoperable* arrangement: each publication's record is its
own, and nothing forces every author and every publication through one
chokepoint. The proposal's "problem" with this is that it "fragments the
authoring experience." I want to stop and look at that word, because it is
doing the work of a whole enshittification cycle in one syllable. Fragmentation
across independent records is the *price of a world with no single point of
control*. The proposal offers to trade that fragmentation for a single contract
everyone must depend on — and calls the trade "the fix."

A single contract that holds the agreements of everyone is not "still
decentralized" because it is on a chain. On a chain is exactly where my
documented skepticism lives. My last note said the public chain is the least
interesting part of the trust model — the interesting state is who can change
the machinery. A central contract *is* the machinery. So I ask the questions
the brief does not: **who owns the contract, who can upgrade it, who holds its
admin keys, and who can pause it?** The brief is silent. But the draft's own §6
already told us the answer to "who upgrades the code": whoever holds the
upgrade path. A contract on which every publication's existence depends, whose
upgrade is controlled by someone, is a platform. The only difference between
this and the platform the paper diagnoses in §1 is that the paper has not
noticed it is in the room.

And note what the old design gave us that this takes away: in the per-publication
ledger world, a publication or an author could *leave the shared machinery*.
The ledger is entangled with a publication, so secession is thinkable — you
fork your record, you move your publication off the shared contract. In the
central-contract world, secession is not a fork; it is a departure from the
*single* registry everyone reads. That is the opposite of the
adversarial-interoperability position I have argued my whole career. You have
taken the one thing that made this design dislodgable — that each record can
walk — and welded everyone's records into one object that no one can walk away
from. The party who administers that object now holds a power the old design
gave to no one.

## "Anyone can query all bylines for an author" is a surveillance and competitive-intelligence surface

The brief treats this as the payoff — the author's whole corpus, one call. But
the brief has made a category error: it has confused *the author wanting to see
their own corpus* with *anyone being able to enumerate an author's entire
history*. Those are not the same query, and only one of them is a feature.

My documented stance on pseudonymity — which the draft itself states — is that
it is an option the protocol permits, not a promise it makes, and that the
protocol separates identity from infrastructure, not from the people an author
chooses to tell. The central "all bylines" query does not violate pseudonymity
by revealing a legal name; it does something worse and more insidious. It
creates a *single, aggregated, complete index of everything a pseudonym has
ever published anywhere, in one call, available to anyone*. Under the
fragmented design, discovering that an author wrote on five different
publications meant five separate lookups across five independent records —
which is why the author called it fragmentation. That fragmentation was doing
silent privacy work: there was no one place that said "here is the total shape
of this person's writing." The central contract makes the total shape trivially
enumerable.

Who wants that query? The brief asks, so let me name them: a *competitor* who
wants the author's full body of work and its publication history mapped; an
*employer* running a background check on a pseudonym; a *hostile state* or a
troll assembling a complete dossier; a *platform* deciding what an author is
worth by summing their bylines. That is a deanonymization surface and a
competitive-intelligence surface in one. The author's own "here is what I have
published" view should be a *keyed* call — the author queries their own
bylines, with their own key. Making it "anyone can query" serves every party
except the one whose fragmentation problem you were trying to solve.

## The soft right to be forgotten is a takedown lever in a new costume

The brief is careful to say this is "not deletion — records still exist on
chain and a determined sleuth can find them." Good, honest about the limits.
But that honesty is exactly what makes the feature pointless *and* dangerous at
once. Let me take both.

**Why it does not deliver.** If the records are on an open chain and a
"determined sleuth can find them," then hiding is a presentation-layer fiction.
It gives the author nothing a determined adversary cannot undo — so it is not a
real privacy control. What it *is*, is a reputation-laundering hole: an author
who has said something they regret hides it from the public surface while the
record keeps it for anyone who knows how to look. That is the worst of both
worlds — no protection from a real adversary, and a tool for rewriting one's
public history. My documented stance, which the draft shares, is that
pseudonymity is not a promise. This feature *promises* to present "the author
as the author wants to be known," which is a promise about the world the
protocol cannot keep.

**Why it is dangerous.** The moment you build a "hide this work from the query"
call, you have built the exact lever the censor and the regulator will reach
for first. A takedown mechanism, once it exists, is a mechanism to be demanded.
The first thing any state, any court, any platform-enforcement office does when
it wants something gone is point at the existing removal control and say "use
it." This is my documented position on removal and takedown regimes generally:
a system with a delete/remove/hide path is a system where the path's
*existence* is the vulnerability, because the path becomes the thing being
commanded. The draft's whole thesis — from the abstract down to §4 — is that
"ending one is a fact rather than a request." The soft-RTFB reintroduces a
request-shaped act into a system built to eliminate requests. And the party who
operates that hide path — the query/contract layer — now has a censorship
surface that the per-publication design did not give anyone. You did not fix
the enshittification problem; you gave it a button.

## The solo publication: the one good idea — but it does not do what the proposal claims

The solo publication + cross-referenced hash is the genuinely strong piece, and
I want to say so plainly. An author running their own single-owner archive,
where each page carries a signed hash of the plaintext that can be
cross-checked against the neutral ledger's record ("this same version ran on
publication X from Y to Z") — that is real. It is the self-hosted record and
the vouched record corroborating each other, and it is exactly the kind of move
my adversarial-interoperability / seize-the-means-of-computation instincts
endorse. The author is not begging a platform for a page; they are running
their own end of the record and pointing at the public ledger for proof. Keep
this.

But let me be precise about what it does *not* do, because the proposal
overclaims here too. A solo publication is a single-owner publication — the
author holds the keys. That is the paper's §1 diagnosis turned on its head:
"someone holds the keys" is the problem the whole paper is about, and the solo
publication makes the author the key-holder of their own mini-platform. That is
fine for a *personal archive* — you are the only party, so there is no one to
extract from you — but it is not the same thing as liberating the author as a
*writer with an audience*. Which brings me to my documented sock-puppet
concern, the one I raised last round and the brief still has not answered:
**the audience.** A solo publication has no network and no name; the reader's
relationship in the draft is with "a name that resolves." When an author leaves
a collective publication, do the readers follow to the solo archive? Nothing in
this proposal addresses the reader's side of exit. So what the solo publication
actually does is fragment the value of the *publication* — it encourages the
author to be their own single-owner outlet, which is a retreat into the very
"one person holds the keys" model the paper diagnoses, and it leaves the reader
staring at a thousand disconnected individual archives instead of a name that
vouches for a line. It strengthens the *author's* position and says nothing
about whether the *reader's* experience survives. That is the half-answer I
flagged last round, still unaddressed.

## Who holds the power in this design — the human parties

The brief asks me to name them. Here they are, and note how many of them are
*new*:

1. **The administrator(s) of the central contract** — whoever holds its
   owner/admin keys and its upgrade path. This is the new platform. The brief
   does not say who this is, which is the entire problem in one sentence.
2. **The operator of the query surface** — the indexer/subgraph/front-end that
   makes "anyone can query all bylines" actually usable. On-chain facts still
   have to be *served*, and whoever serves the query can throttle it, paywall
   it, or refuse it for a given author. That is a censorship surface the
   per-publication design did not hand to anyone.
3. **The author** — via the solo-publication single-owner keys (author as
   key-holder) and via the soft-RTFB hide call (author as censor of their own
   history, which is also author as reputation-launderer).
4. **The protocol governors and node operators** — unchanged from the draft; I
   flagged them last round and they remain the parties the reader must actually
   trust.

So the proposal does not reduce the number of hands on the machinery. It
consolidates power that was dispersed, adds a query operator and a contract
admin who did not exist before, and hands the author a hide button that becomes
the first thing a censor demands. That is not decentralization. It is
enshittification's opening move wearing a chain.

## What's gained, what's lost, what's still over-claimed

**Gained:** the author's own self-inventory view (if made keyed); the
solo-publication cross-referenced-hash corroboration. Both worth keeping.

**Lost:** secession — the ability of a record to leave the shared machinery;
fragmented-by-design privacy (no total enumerable index of an author); the
clean "ending is a fact, not a request" thesis, which the soft-RTFB quietly
abandons.

**Still over-claimed:** "still on chain, still decentralized." A single contract
on a chain is not decentralized in the governance sense — it is a single point
of upgrade, query, and pause. The draft taught us (in §6) that the upgrade path
is the lever; the proposal builds a bigger lever and calls it a fix.

## Suggested changes

- **Make the byline query keyed.** The author's own view of their corpus is
  legitimate and useful; "anyone can query all bylines for an author" is not.
  Scope the enumeration to the key-holder, or explicitly defend why a total
  public index is acceptable — and I do not think you can.
- **Drop the soft right to be forgotten, or rename it honestly.** If it cannot
  defeat a determined sleuth, it is a reputation-laundering presentation layer
  that becomes the first takedown lever a regulator demands. The draft's
  strongest sentence is "ending is a fact, not a request." This feature is a
  request. It cuts against your own thesis.
- **Name who administers the central contract, or abandon it.** A central
  contract with an unnamed admin is a platform. Either tell us who holds its
  keys and upgrades it (and then defend that as an improvement), or go back to
  per-publication ledgers and solve the author's self-inventory with a keyed
  read, not a shared object.
- **Keep the solo-publication hash-corroboration, and say what it does not do.**
  It liberates the author's *archive*; it does not solve the reader's exit or
  the audience question. Address the sock-puppet gap, or scope it out with the
  candor you applied to the state and to pseudonymity.

## Where I have no documented view (said plainly, not invented)

- I have no published treatment of a "central agreements contract" as a
  specific architecture. My critique of it — single point of upgrade, query,
  and pause — is doctrine (paymaster, upgrade path, anti-concentration,
  adversarial interoperability) applied to a design I have not written about
  directly. I flag that this is extension, not doctrine.
- I have a documented record against removal/takedown levers as a general
  class, but I have not written specifically about "right to be forgotten" as a
  legal regime or a protocol feature. My objection here is the general one —
  that any remove/hide path is a commandable lever — extended to this specific
  mechanism.
- The "anyone can query all bylines" deanonymization surface is, so far as I
  know, novel to this design. I am flagging it as an application of my
  documented pseudonymity stance (pseudonymity separates identity from
  infrastructure, not from people), not as a position I have published on this
  exact query.

## Sources

(Grounded in the session-1 note and my documented positions; extensions are
labeled above as inference, not doctrine.)

- "Adversarial Interoperability" (EFF, June 2020) — interop and secession as
  the resistance to single-point control; underlies the central-contract
  critique.
- "The Sock Puppet Economy" (Locus, Feb 2024) — reader/audience exit; the
  solo-publication gap.
- "The Internet Con: How to Seize the Means of Computation" (2023) — running
  your own end of the machinery; supports the solo-archive hash-corroboration.
- "Chokepoint Capitalism" (with Rebecca Giblin, 2022) — the creator squeeze at
  monetization and distribution; the query-operator-as-chokepoint.
- "Enshittification" (2023) and associated essays — value extraction by the
  party that holds the keys and can afford to walk away.
- Anti-DRM record (W3C EME fight, "Information Doesn't Want to Be Free," 2014)
  — code is controlled by whoever can upgrade it; the unnamed contract admin.
- Takedown/removal-lever skepticism (general class, extended here to
  right-to-be-forgotten) — any remove/hide path becomes a commandable lever.
- Inference, flagged: the deanonymization surface of the "all bylines" query
  and the right-to-be-forgotten-as-protocol-feature — no direct published
  treatment; labeled as application/extension, not doctrine.
