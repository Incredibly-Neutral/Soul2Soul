---
persona: rebecca-mackinnon
role: internet-freedom & governance scholar (Consent of the Networked); Ranking Digital Rights; Global Voices
reviewed: 2026-09-10
target: readingroom_session3/discussions-ledger/brief.md — the central agreements contract proposal, against v1.md
lens: who actually holds power over the network — state and corporate alike — and the legitimacy of its governance
---

# Rebecca MacKinnon — reading-room note (discussions-ledger round)

## Verdict

**On the question posed — is this an improvement over the current draft's design? — my answer is no, on balance, for a governance reason, with one genuine exception.** The proposal solves a real problem (the fragmentation of an author's record across per-publication ledgers), but it solves an *authoring-experience* problem by *concentrating* a governance-and-surveillance object. It turns the scattered per-publication record of "who wrote what, where, when, and for how long" into a single, queryable, per-author dossier that rides on one contract. On chain does not make it not-a-center; it makes it a center with better optics. In my terms from *Consent of the Networked*, this does not move power out of the publication — it moves it to a new, singular point that is *easier*, not harder, for a state or a platform to point at and compel.

I want to be clear about what I am not saying. I have **no documented position** on whether one on-chain contract is technically superior to several, on the mechanics of per-author queries, or on the cryptoeconomics of a single ledger. Those are engineering questions I defer to the cryptographers. My objection is to the *governance shape* of the thing — and that I do have a documented view on.

## The core problem: the proposal re-concentrates what the draft had fragmented

My round-2 note praised the draft's honesty but pushed on the fact that "removing ownership has not removed authority — it has relocated and, on one axis, re-concentrated it," and that the protocol's governors hold the power to sever an author or publication, with no consent, veto, or removal right for the governed. This proposal does not fix that. It makes it worse in a specific way.

The current draft spreads the agreements record across per-publication ledgers. From a *reader-experience* or *author-experience* view that is fragmented and awkward — the brief is right that there is "no single place where 'what this author has published, where, and for how long' can be seen as a whole." But from a *power* view, that fragmentation is not a bug; it is a feature. It means no one object, and no one query, holds a complete longitudinal profile of a person. The proposal trades that dispersal for a single contract that is *specifically built* to answer "give me all bylines for author X." Whatever its engineering convenience, that is the re-introduction of a center — and it is a center of the worst kind, because the thing it centralizes is identity-linked publishing history, which is exactly the surface I flagged in round 2 as "a state-surveillance surface wearing the costume of infrastructure."

## The per-author query: a dossier, not just a reader's convenience

The brief asks whether "anyone can query all bylines for an author" is a feature or a surveillance surface. From my lens it is both, and that is precisely the problem — the same query is read as a feature by the author and as a dossier by everyone else. Let me be concrete about who wants that query, because "anyone" hides the politics:

- A **reader** wants it to verify an author's body of work — legitimate.
- An **employer** wants it as a pre-hire background screen — a corporate power use.
- A **hostile state** wants it to map a dissident journalist's full publication history across every outlet, in one call, without assembling it from many ledgers — a state power use, and the exact scenario the draft honestly says it does not protect against.
- A **platform or court** wants it to compile evidence or to compel the identity behind the account.

The proposal's per-author query *converts the network's fragmentation from a protective feature into the very thing the design erases*. This is the distinction my post-Snowden work keeps insisting on: technology does not deliver freedom on its own, and a "feature" that serves the reader serves the watcher equally — unless the design does something active to withhold it from the watcher. This design does the opposite: it makes the dossier cheaper and more complete than the draft ever did.

## The soft right-to-be-forgotten is a governance object with no named authority

"Not deletion, a presentation layer" is honest — the brief concedes a determined sleuth can still find the records, which I respect as non-overclaiming. But as a governance matter it is the weak point, and it reintroduces exactly the question I keep pressing and that the draft still has not answered: **who decides, and who can be compelled?**

Three documented concerns:

1. **It is the first thing a censor demands — but extended, not shrunk.** A state that wants an author silenced does not need the hide; the full record is already on chain. The dangerous compellability is the reverse direction: a state or platform demanding that the hide be *lifted* so a "complete" record is served, or demanding the query against the *unhidden* set to establish that something was hidden at all. The very existence of the soft-hide layer creates a political object ("what is this author not showing?") that did not exist when there was no hide to lift.

2. **It is a reputation-laundering surface.** The author controls what surfaces in "the bylines as the author wants to be known." That is a self-serving presentation layer that lets an author bury a track record — the mirror image of the surveillance problem, and one the draft's own verifiability commitments (nothing silent, the trail is public) would seem to oppose. The proposal needs to say who audits the gap between "what the author wants to be known" and "what is on chain," or it undermines the very provenance the draft sells.

3. **Who administers "as the author wants to be known"?** The brief does not say. Is it the author's own signature (self-serving), a set of rules in the contract (a new governance lever with the same unanswered "chosen by whom, removable by whom" problem I raised in round 2), or a permissioned operator (a private party under a jurisdiction — the corporate power the draft claims to escape)? Until that is answered, the soft right-to-be-forgotten is not a right; it is an unassigned power.

On the substantive question of whether a right-to-be-forgotten should exist at all in such a protocol, I have **no documented position** — my concern is that if the design includes one, it must name who wields it and what they can be compelled to do, and this proposal does not.

## Jurisdiction and compellability: a single contract is a single target

The draft is honest that "courts can compel the parties to any arrangement, this one included" and that the state is bracketed, not removed. The proposal inherits that honesty and then *adds to its force*. A state or platform that wants a query served, a hide lifted, or a record preserved does not need to contend with N ledgers and N possible forums. There is now one contract, one set of operators/validators, one place to point a subpoena or a preservation order. **On chain is not a jurisdiction; it is infrastructure under some jurisdiction, and a single contract concentrates the compellable surface into the smallest possible target.** If the draft's fragmentation had any governance merit, it was that there was no single point to compel; this proposal removes it.

I want to be careful not to overclaim: I have **no documented view** on whether a single contract is more or less legally compellable in practice across jurisdictions — that is a question for the lawyers and the chain's validators, not for me. But I do have a documented view, from the Ranking Digital Rights / GNI work, that corporate and state power over networks is exercised at the point where infrastructure is concentrated and operators can be pressured. A single agreements contract is precisely such a point.

## What is genuinely good: the solo publication and cross-referenced hash

The one part of this proposal that works in my lens is the **solo publication / self-hosted archive cross-referenced against the on-chain record.** Here the author's own home-base archive and the neutral ledger *corroborate* each other — the same work appears in the author's self-hosted record and in the publication's vouched record, and the hash of the plaintext signed by the author can be cross-checked against what the ledger says was published where and when.

This matters to me because it moves *verification authority back toward the author* rather than concentrating it in the single ledger. It is the only element of the proposal that *disperses* power instead of gathering it: the author is not merely a row in someone else's queryable table; they hold a self-hosted, independently-maintained record that can vouch for the ledger, and the ledger can vouch for them. That is a two-way corroboration, and it is the direction my round-2 critique pushed the draft — toward the person whose speech the system carries having their own standing and their own copy of the truth.

But it does not rescue the whole. It complicates the design (the author now must run or host infrastructure), it does nothing to answer who can compel the *central* query or the hide, and it re-imports the global-south participation concern I raised in round 2: self-hosting an archive is a resource-intensive act that presumes technical fluency and resourcing that the authors my work is most concerned with do not reliably have. It is a good idea that the rest of the design does not earn.

## Summary of what is gained, lost, and still over-claimed

- **Gained:** a coherent author-facing view of their own bylines; the solo-publication/cross-referenced-hash mechanism, which genuinely disperses verification toward the author. These are real, and I credit them.
- **Lost:** the protective fragmentation of the draft. The proposal erases the very property — no single dossier, no single target — that made the per-publication record less dangerous. It also subordinates verifiability to a self-serving presentation layer ("as the author wants to be known") without naming who polices the gap.
- **Still over-claimed:** the framing that a single on-chain contract is "still decentralized." Decentralized *operation* is not the same as decentralized *power*. This is a single governance object with a single query surface and a single compellable point; calling it decentralized because it is on chain is the techno-solutionist error I have spent a career pushing back on.

## What would change my verdict

I would flip to "yes" if the proposal answered, in the terms of my round-2 suggested changes (which the brief does not appear to incorporate):

1. **Governance-legitimacy for the contract itself** — who upgrades it, who chooses/removes its governors, on what consent basis, and what recourse a party has — the same three-sentence test I asked for in round 2.
2. **An explicit answer to who can compel the per-author query, the hide, and the record's preservation**, and whose law governs each — a named threat model rather than "on chain."
3. **A due-process/remedy mechanism around the soft right-to-be-forgotten** — who decides what surfaces, who audits the gap between "wants to be known" and "is on chain," and what happens when a state or platform demands the hide be lifted.
4. **Recognition that the per-author dossier serves the watcher as readily as the reader** — and a design that withholds the complete longitudinal profile from the watcher, not just from the reader's imagination.

Absent those, my honest answer to the panel's question is: **this proposal is not an improvement; it is a regression on the axis that matters most to me — it re-concentrates governance-relevant, identity-linked, jurisdictionally-compellable data into a single point.** Fix the authoring-experience fragmentation if you like, but do it with a mechanism that disperses rather than concentrates, and borrow from the solo-publication idea — which is the only part of this that points the right way.

## Sources

Grounded in Rebecca MacKinnon's documented positions; where she has no documented view I say so.

- MacKinnon, Rebecca. *Consent of the Networked: The Worldwide Struggle for Internet Freedom* (Basic Books, 2012) — the state/corporation/network triad; governance legitimacy as the consent of the governed; the democracy deficit of internet governance (basis for the "on chain ≠ not-a-center" and "no named authority for the hide" critiques).
- MacKinnon's work at **Ranking Digital Rights** — transparency ≠ accountability; enforcement, due process, and remedy, not publication of policy (basis for the "who administers the presentation layer" and "no audit of the hidden-gap" critiques).
- MacKinnon's **Global Network Initiative** and corporate-responsibility work — corporate power over the network must be constrained alongside state power; power is exercised at concentrated infrastructure points (basis for the jurisdiction/compellability critique).
- MacKinnon's post-Snowden commentary on surveillance and the limits of techno-solutionism — technology alone does not deliver freedom; the political/social layer is decisive (basis for "the per-author dossier serves the watcher as readily as the reader").

**No documented position (not inventing one):** MacKinnon has no documented view on whether one on-chain contract is technically superior to several, on the mechanics of per-author queries, on the cryptoeconomics of a single ledger, on the practical legal compellability of a single contract across jurisdictions, or on whether a right-to-be-forgotten should exist in such a protocol at all. On those she defers to the cryptographers and the lawyers. Her critique here is deliberately confined to the governance, accountability, and power questions on which she has published.
