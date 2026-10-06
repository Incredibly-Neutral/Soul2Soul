---
persona: rebecca-mackinnon
role: internet-freedom & governance scholar (Consent of the Networked); Ranking Digital Rights; Global Voices
reviewed: 2026-09-10
target: brain/whitepaper/v1.md — Abstract + Sections 1–7 (full-draft round 2)
lens: who actually holds power over the network — state and corporate alike — and the legitimacy of its governance
---

# Rebecca MacKinnon — reading-room note (round 2)

## Verdict

The draft has matured in exactly the direction I asked for, and I want to credit that plainly.
Round one's "the generator itself is unowned" has been replaced with a frank admission that the
protocol is *governed* — Section 6 now names "the protocol's governors," concedes that the
upgrade path lets them "adopt code that cuts a publication or an author off," and calls the
upgrade "a limit of the design, named rather than hidden." The state is no longer invisible: the
Introduction explicitly brackets it ("the independence on offer is from each other, not from the
law"), and pseudonymity is scoped with real honesty ("an option the protocol permits, not a
promise it makes").

That candor makes the remaining problem *more* visible, not less, and it is the problem my whole
career turns on. Removing ownership has not removed authority — it has relocated and, on one
axis, re-concentrated it. The draft now openly holds power in a small, self-appointed group whose
"only lever is which actions may be called and tied to the protocol key" — and that lever
includes the capacity to sever an author or publication from the system entirely. Yet there is
still **no mechanism by which the people whose speech that system carries consent to that
arrangement or can remove the governors.** "Named rather than hidden" is an improvement over
"unowned"; it is not the same as *legitimate*. Transparency without remedy is what Ranking
Digital Rights would score as a policy that exists on paper but is not enforced — and because the
reader is the other party these promises silently omit, the accountability gap is wider than the
draft lets on. This is not yet a theory of publishing power; it is a well-written component description with an honest
confession of its own limit.

## What resonates

- **Honesty about the state.** The Introduction's refusal to overclaim — "courts can compel the
  parties to any arrangement, this one included" — is the correct and rare posture. Round one
  ignored the state; this draft names it and declines to promise immunity. That is the mark of a
  serious document.
- **"Pseudonymity is an option the protocol permits, not a promise it makes."** This is the
  single most trustworthy sentence in the draft. The internet-freedom field is littered with
  pseudonymity overpromises; scoping it as permission rather than guarantee is the difference
  between a protocol and propaganda.
- **The three-gate architecture, including a named but optional payment gate.** Building the
  money question in as a separable, optional gate rather than pretending payment doesn't exist is
  the right instinct, and it lets the document say plainly "the protocol does not require one."
- **"No change is silent" and "the trail of their decisions is not [hidden]."** The commitment to
  making grants, revocations, and governance decisions visible is a genuine transparency floor,
  and it is an improvement over the opaque operator of round one.
- **Departure costs both sides, restated cleanly.** "A publication that wants to keep its
  contributors has to persuade them" remains the best argument in the document, and Section 3
  ("A line it cannot hold by position, it must hold by argument") sharpens it.

## Critical readings

These are the places the full draft still fails the "who holds power" test.

**1. The consent of the networked is still absent — and now that governance is explicit, its
absence is the load-bearing gap.** Section 6 tells me there are governors who can decide "which
actions may be called and tied to the protocol key," and that "how many governors the protocol
has, and at what threshold they act, are the choices of those who run it." Set aside that this
defers the question entirely. The decisive failure is that the people whose speech this system
carries — the authors and readers — have **no seat, no veto, no removal right, no consent**.
Round one sold me "unowned"; round two has replaced it with "governed by a group I did not choose
and cannot unseat." In *Consent of the Networked* the core test of a legitimate governance
arrangement is whether the governed can hold the governors to account. Nothing in Sections 6 or 7
answers "with whose consent?" for the very writers and readers the protocol claims to free.

**2. Transparency is not accountability; "named rather than hidden" is not a remedy.** The draft
is right that a governor's decision to cut someone off "cannot be done quietly" and "would be a
public decision carrying a real reputational cost." But Ranking Digital Rights' methodology does
not reward companies for *publishing* their content-removal policies; it scores them on whether
those policies are enforced and whether there is **due process, appeal, and a remedy** for the
person affected. An author or publication severed by a governor decision has no appeal mechanism,
no published rationale they can contest, no forum. Watching your own dispossession happen in
public, with nothing you can do about it, is not accountability — it is transparency as theater.
"Named rather than hidden" converts a governance power into an admission, not a constraint.

**3. The state returns through the record and the identity layer — the bracketing is honest but
the design is not neutral toward it.** The Introduction says the protocol does not address the
state and that "courts can compel the parties." Fine. But consider what the protocol actually
*built*: a public, append-only record of every account's provenance and decisions (Section 2, 3,
4), and an account that may optionally carry "proof of humanity or of a real, administrative
identity" (Section 7). That is a state-surveillance surface wearing the costume of
infrastructure. A court or an intelligence service does not need to hack the protocol to find a
journalist; it needs to compel the person behind a DID that the record already links to a "real,
administrative identity." The draft's framing treats the state as a party the protocol declines
to address, when in fact the protocol's own public record and identity options may make its
users *more* exposed, not less. For the journalists in my circle, this is the difference between
a publishing tool and a liability.

**4. The privacy frame is entirely author-centric; the reader is invisible.** Every privacy
guarantee in the draft is about the person behind the byline. But the third gate (Section 5) puts
"the record shows that reader has paid" on a public chain — which is to say, **who read what,
and when, becomes public**. For a dissident's readership, for sources, for anyone whose *reading*
is more sensitive than their writing, this is a surveillance exposure the draft never
acknowledges. A rights-respecting design cannot protect the writer and leave the reader's
behavior as an on-chain public good. And even without the payment gate, Section 7's reader
receives a rendered page *served by a host* — so the hosting layer, which the draft never names,
sees who reads what regardless. This is the single largest privacy blind spot in the document,
and it doubles as the clearest instance of Critical 5.

**5. The infrastructure layer is dissolved at the author–publication layer and reintroduced at
the nodes/hosting layer.** The draft is scrupulous about the two parties it names — author and
publication — and even concedes "the name... is prone to the risks of DNS." But who runs "the
independent nodes" that "render and sign," who hosts and serves the rendered pages, who pays for
the gas, who can operate ENS, DIDs, and a Safe? Nothing in the draft says. Those are private
parties under some jurisdiction, and they are exactly where the corporate power the draft claims
to escape would re-enter. For the global south and ordinary non-technical users, the gap is
starker: the entire surface — ENS domains, content-addressed CIDs, Merkle trees, Safes, gas
fees — presumes a sophisticated, resourced, technically fluent elite. The people my work is
most concerned with are precisely the ones this stack would exclude.

**6. "Argument, not position" is still presented as power-neutral.** Section 3's "A line it
cannot hold by position, it must hold by argument" is seductive, but argument is itself governed
by who has reach, reputation, promotion, and attention. The protocol removes the administrative
lever while leaving the economic and reputational one untouched — the same asymmetry I flagged in
round one, now spread across the full document rather than confined to the Introduction.

## Sharpest questions

- **Who, concretely, are "the protocol's governors," and what makes their authority legitimate to
  the writers and readers whose speech they can sever?** How many, chosen how, removable by whom,
  and with whose consent?
- If a governor's decision cuts an author or publication off, **what is the remedy, appeal, or
  published rationale they can contest?** Where is due process?
- The account may carry "proof of a real, administrative identity." **Who verifies that, who can
  be compelled to reveal it, and what happens to the journalist behind it when a court comes
  looking?** How is this not a state-compellable identity layer wearing neutral clothing?
- The third gate writes reader payment on a public chain. **Who protects the reader's privacy,
  and why is the reader absent from the protocol's privacy frame entirely?**
- **Who runs the independent nodes, and who hosts and serves the pages?** Why would that not
  reconcentrate into a few corporate providers under a few jurisdictions?
- The draft says the state is out of scope, yet the public record and identity options are
  state-relevant. **Is the state really absent, or is it merely unnamed?**

## Suggested changes

- **Add a governance-legitimacy subsection to Section 6** (or fold it into Verification): who
  selects the governors, on what consent basis, how they are removed, and what recourse the
  governed have. Even three sentences — "governors are chosen by X, can be removed by Y, and a
  severed party may appeal to Z" — would turn "named rather than hidden" into a claim a hostile
  reader can test. (Addresses Critical 1.)
- **Add a due-process/remedy mechanism for removal decisions.** A severed author or publication
  should have an appeal path and a published, contestable rationale — the RDR enforceability
  standard, not just publication. (Addresses 2.)
- **Add an explicit reader-privacy commitment** to Section 5's third gate and Section 7: state
  what is visible about reading (including "reader paid, which author, when") and either
  design it out or say plainly what is exposed and to whom. (Addresses 4.)
- **Reconsider tying "proof of a real, administrative identity" to the account** given
  state-compellability, or at minimum address the state threat model the Introduction brackets.
  If pseudonymity is only an option, the document should say what the protocol does when the
  state comes for the name behind the DID. (Addresses 3.)
- **Name the infrastructure layer's operators** — nodes, hosts, storage, resolution — their
  jurisdictions, and their incentives, and address the global-south participation question
  (gas, ENS/DID literacy, who can afford to participate). (Addresses 5.)

## What could be shortened or left out

If I could cut one thing without losing the argument, it is the **final paragraph of Section 1**
(Introduction): *"There is a future for online publishing in which association and dissociation
between groups of people are easier and involve less friction: temporary collectives formed
around topics and interests, bringing together a plurality of opinions, and the insights only
diversity can offer."* It is the only soft, aspirational sentence in an otherwise hard-nosed,
restrained document. "Easier and involve less friction" is vague, "the insights only diversity
can offer" is a mission-statement flourish, and nothing in it is testable or load-bearing — the
thesis is already carried by the Abstract and the body. For a draft whose credibility rests on
precision and on refusing to overclaim, this paragraph reads like the one place the writer
relaxed, and it undercuts the tone. Cut it, or replace it with a concrete statement of what the
protocol actually enables.

Two secondary trims, if space is wanted: the Section 6 sentence *"a version with no upgrade path
at all — one its own governors could not alter — is possible to build, and this protocol would be
glad to be its inspiration"* is rhetorical self-indulgence and could collapse to one clause; and
Section 5's third gate is the longest speculative passage in the draft for something the document
itself says is "not yet built" — worth keeping for the removes-the-paymaster argument, but
condensable.

## Sources

Grounded in Rebecca MacKinnon's documented positions; where she has no documented view I say so.

- MacKinnon, Rebecca. *Consent of the Networked: The Worldwide Struggle for Internet Freedom*
  (Basic Books, 2012) — the state/corporation/network triad; governance legitimacy as the consent
  of the governed; the democracy deficit of internet governance.
- MacKinnon's work at **Ranking Digital Rights** — the methodology that scores companies on
  whether free-expression/privacy policies are *enforced* with due process and remedy, not merely
  published (basis for the transparency-vs-accountability critique).
- MacKinnon's Global Network Initiative and corporate-responsibility work — corporate power over
  the network must be constrained alongside state power.
- MacKinnon's post-Snowden commentary on surveillance and the limits of techno-solutionism —
  technology alone does not deliver freedom; the political/social layer is decisive (basis for
  the state-returns-through-the-record and reader-privacy critiques).

**No documented position (not inventing one):** MacKinnon has no documented view on the specific
technical architecture — ENS on the chain, Merkle-tree site roots, the three-gate design, the
Safe/module structure, per-read vs. subscription gating, or whether the payment gate should be
built. On those she defers to the cryptographers and flags them as open engineering questions.
Her critique here is deliberately confined to the governance, accountability, and power questions
on which she has published.
