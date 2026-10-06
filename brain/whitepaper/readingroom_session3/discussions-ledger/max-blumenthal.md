# Max Blumenthal (owner of The Grayzone) — reading-room note (round 3)

_Scope: the proposal to replace the draft's per-publication agreements ledger with a central
agreements contract — a queryable per-author byline record, a soft right-to-be-forgotten, and
solo publication with a cross-referenced signed-hash archive. Read as the operator of an
independent, reader-funded outlet. As in round 1 and 2, I ground my critique in my documented
running of The Grayzone and of independent reader-funded media; where I am reasoning from
principle rather than a documented position I say so and mark it "inference."_

## Verdict

No — on balance this is not an improvement for a working outlet. It genuinely fixes one
author-side problem, and it strengthens single-work verification. But it buys those two things
by handing away the two assets an independent outlet actually competes on — its roster and its
archive — by making a star contributor's exit frictionless and cross-vouched, by centralizing
the canonical record into a single contract that becomes the next gatekeeper I must satisfy,
and by adding a cost surface (the free, unpriced query) that the draft already refuses to
account for. The draft was already written from the author's chair; this proposal pushes it
further down that chair and off the operator's.

## What it genuinely fixes — credit where due

**The fragmentation problem is real, and I'll credit it.** My round-2 note said the paper had
no home for the readership; the proposal at least notices that the *author* is fragmented too.
A writer working across several outlets has their bylines scattered across one ledger per
publication, with no single view of "what this author has published, where, and for how long."
That is a genuine gap in the draft, and a single coherent author record is a real improvement
to the author's experience. I can sign that.

**The cross-referenced signed-hash archive is a genuine verification gain.** The strongest part
of the proposal. A reader checking one work can now corroborate it two ways at once: the
author's self-hosted copy and the publication's vouched record both point at the same plaintext
hash, and both are on the record. That is stronger provenance than either alone, and it is the
one piece I would keep without reservation. It makes the *authenticity* of a work harder to
fake.

## Where it costs — and this is the majority of the proposal

**1. "Anyone can query all bylines for an author" is not a feature; it is my roster and my
archive, handed over.** As an operator, my competitive position is precisely the set of
contributors who write for me, what they wrote, when, and for how long — the accumulated
credibility of a name vouching for a corpus. A freely queryable per-author byline record hands
all of that to anyone who asks: a rival outlet building a contributor book, an employer, a
troll, a hostile state. It aggregates an author's entire career across every outlet into one
surface, which is also a deanonymization surface — cross-publication correlation of pseudonyms,
timing analysis, the whole forensic toolkit. The current draft keeps agreements per-publication
and at least does not assemble the author's full history in one queryable place. The proposal
assembles it for free, and frames the cost as a feature.

**2. The "central" contract is the new gatekeeper, whatever the chain underneath.** My round-2
objection to the governor committee transfers here almost unchanged: I said then that the
platform had not been dissolved, only relocated to a committee I do not control, at a threshold
the paper refuses to set. A single contract holding the canonical byline record for every
author and every publication is the same move at the ledger layer. On chain does not mean not
central in the governance sense — whoever controls that contract's upgrade path controls the
record of who published what, where, and when. That is the platform with a different logo. The
draft's per-publication ledger at least distributed the *canonical record* across the thing
being recorded; the proposal reconcentrates it. I respect the brief asking the question
honestly; my answer is that a new center is a center, and an independent outlet will end up
satisfying it the way it used to satisfy a platform.

**3. Solo publication is an audience-capture device, and the ledger makes it frictionless.**
This is the one that should decide the verdict. My round-2 sharpest question was: when a
contributor leaves, who keeps the readership? The draft left it unanswered. This proposal
answers it — in the author's favor. A star contributor can spin up a solo publication that
re-mints their entire archive, including the work they wrote for me, and the on-chain
cross-reference vouches that it "ran at publication X from Y to Z." So the very record my name
built is repurposed to walk the audience out of my door. My one asset, the trust and the list,
follows the author, and the neutral ledger is the cart that carries it. Under the current draft
my departed contributor's accumulated work at least left my live vouched record — the corpus
was a loss no one could refill, which was the only thing that made leaving cost the author
anything. The solo-publication move re-mints that corpus and refunds the author's cost. My
position gets weaker, not stronger, and the asymmetry the draft already had gets worse.

**4. The soft right-to-be-forgotten is a presentation layer that guts the honesty.** The whole
reason I value the draft's "ending an agreement is a fact rather than a request" is that the
record is honest and complete — no silent change. A "hide from query" that returns bylines "as
the author wants to be known" reintroduces silence: an author can present themselves as never
having been at a publication they were at, while the underlying facts remain. And because it is
explicitly not deletion, it gives the author cosmetic control without real protection — the 
determined sleuth still finds it, so it protects no one and costs the record its completeness.
It is also, predictably, the first thing a censor or a hostile party will demand — "make this
author stop being known for X" now has a formal, on-chain mechanism. This is the same wedge I
flagged in round 2 about the governor's "child pornography" lever: the first use everyone
agrees with (a genuine request to be forgotten) becomes the mechanism later used under pressure.
*(That the soft right-to-be-forgotten becomes a censorship / laundering vector is my inference
from general principle, not a documented Blumenthal position.)*

**5. Who pays for the query and the storage?** My round-2 sharpest question #3 — who pays for
the machinery — was already unanswered in the draft, and I flagged that the who-pays paragraph
had been cut from §5. This proposal makes the problem larger. A central record that accumulates
the *current and past* agreements of every author and every publication, freely queryable by
anyone, is a growing storage and compute liability with an unpriced, open-ended access surface.
The author's "solo publication" archive is another storage bill, and the "anyone can query"
clause means the outlet and the author carry the cost while everyone else uses it for free.
The proposal does not say who holds the bag, and I will not fill in the blank for it.

## Where I have no documented view

- **Right-to-be-forgotten, in any form** — I have no documented position on right-to-be-forgotten
  specifically. What I said above about it is reasoning from principle (a filtered presentation
  layer weakens an honest record; a removal mechanism is the first thing a censor asks for),
  labeled as inference, not a position I can cite.
- **Solo-publication mechanics** — no documented view on an author running a single-owner
  archive. My concern there is purely the operator's calculus about audience capture, which is
  documented (the round-2 readership-has-no-home point) applied to a new mechanism.
- **Per-author query surfaces** — no documented view on the byline-query primitive itself. The
  critique of it as a surveillance/deanonymization surface and as a leak of competitive data is
  inference from how an independent outlet actually competes, not a documented quote.

## Bottom line for the whitepaper

Keep two pieces and reject the rest. **Keep the cross-referenced signed-hash archive** — it
strengthens verification of a single work without cost to me, and it is the one genuinely
neutral improvement here. **Keep, in principle, the idea that an author deserves a coherent
record of their own work** — but deliver it as the author's *own* self-hosted archive, not as a
central contract anyone can query, and not as the canonical record the whole system depends on.

**Reject or redesign:** the freely queryable all-bylines surface (it is my roster and archive,
and a deanonymization tool); the single central contract as the canonical record (it is the
next gatekeeper); the solo-publication as a sanctioned audience-capture vehicle that re-vouches
my departed contributors' work away from me (it answers "who keeps the readership" in the
author's favor and refunds the star's cost of leaving); and the soft right-to-be-forgotten
(cosmetic control that weakens the record and becomes a removal lever).

The proposal fixes the author's fragmentation by spending the outlet's competitive position.
For a small, reader-funded publication, that is not an improvement — it is a redistribution of
my two assets to the person most able to take them, paid for with a cost surface nobody has
priced. If the authors want the proposal to earn an operator's yes, it has to (a) say who pays
for the query and the archive, (b) stop treating "anyone can query all bylines" as unambiguously
good, and (c) answer, in the proposal's own terms, who keeps the audience when the star leaves —
because right now the answer it gives is "the star, and the ledger helps them carry it out the
door."

## Sources

I ground this on the documented public record of running The Grayzone and independent
reader-funded media, and I flag inference explicitly in the body:

- **Demonetization / platform restriction (documented):** The Grayzone's standing, documented
  experience of being throttled, restricted, and de-monetized by major platforms for content
  and payment viability rather than hosting — the basis for my claim that a single point of
  control (platform, governor committee, or central contract) becomes a gatekeeper the outlet
  must satisfy.
- **Reader-funded model and the fight to own audience and archive (documented):** the basis for
  my claim that the roster and the archive are the outlet's real competitive assets, and that
  handing them to a departing author is a real loss.
- **Specific claims where I have NO documented view (explicitly flagged as inference):** that
  the soft right-to-be-forgotten becomes a censorship/laundering vector; that the per-author
  query surface is a deanonymization and competitive-data leak; the mechanics of solo
  publication. I reason about these from principle and do not attribute any unverified event
  or quote to myself.
