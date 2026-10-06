# Cory Doctorow — reading-room note (round 2)

## Verdict

Better than round one, and I mean that as a real compliment, not a reflex. The
abstract and §1 now say the thing in a sentence instead of a paragraph: "the
side that can afford to walk away sets the terms." That's the whole paper, and
it's right. The dissociation framing — cost of leaving, who holds the keys —
is the correct diagnosis, and this draft mostly stops re-explaining it and
starts building on it. §6's honesty about the upgrade path ("that is a limit of
the design, named rather than hidden") is the best passage in the document,
and I'll say more about why.

But the draft still has a load-bearing tension it hasn't faced: this is a DRM
machine, and the paper keeps insisting it isn't. The generator decrypts source
only inside itself, under conditions read from a chain, enforced "by the
machinery itself — not by any party's decision when the moment comes." I have
spent my whole career arguing that this is exactly the wrong thing to trust,
and the paper's own §6 concedes why: code is controlled by whoever can upgrade
it. An "independence that is never silent" is one governor vote away from being
theater. I don't think that kills the idea — I think it's the paper's real
subject, and it should be front and center instead of waved at.

Verdict: keep going. The spine is right; the load-bearing claims need to be
either proven or downgraded to what they actually are. Right now the paper
occasionally sells "trustless" when it has built "trust in a smaller, more
accountable set of parties." Those are different things, and conflating them is
where a skeptical reader will pry it open.

## What resonates

1. **The cost-of-leaving diagnosis.** "The party with less to lose sets the
   terms." This is the enshittification dynamic in one clause, and it's the
   correct frame. I've written this argument more times than I can count —
   that the reason platforms extract is that exit is expensive for the people
   inside and cheap for the platform. The draft's move — making departure cost
   *both* sides — is genuinely novel and worth the paper.

2. **"An editorial line held by people free to leave means something a captive
   one cannot."** That's the thesis, and it's true. This is the whole game.

3. **§6's named limit.** "Governors cannot censor a publication or an author
   silently. They could adopt code that cuts a publication or an author off —
   the upgrade path makes that technically possible — but the code that does it
   is visible to everyone." Then: "There are cases where a community will want
   the lever pulled, and child pornography is the obvious one." This is the
   most honest thing in the document. I am not a no-moderation absolutist; I'm
   an anti-concentration, pro-accountability guy. A system that makes the
   censorship decision a *public, reputational* act is the best a
   code-governed system can do, and naming it rather than hiding it is
   respectable. Most crypto papers would have left this out. Good that you
   didn't.

4. **The author keeps the work.** As a Creative Commons person from way back,
   the fact that the author retains cryptographic ownership and can revoke —
   that the publication owns a *render license*, not the work — is the right
   instinct. It's copyright-shaped, which I'll get to, but the direction is
   correct.

5. **The state is scoped out honestly.** "The independence on offer is from
   each other, not from the law." No overclaiming, no "resistance to state
   censorship" puffery. Refreshing.

## Critical readings

**1. You built DRM and called it machinery.** §5: "A gate is enforced by the
machinery itself — by what the code will do and what the key will sign — not
by any party's decision when the moment comes." I have been writing against
this specific sentence in various forms for twenty years. DRM is never
"enforced by machinery"; it's enforced by whoever can change the machinery.
Your own §6 says the governors "could adopt code that cuts a publication or an
author off" and that "the upgrade path makes that technically possible." So the
gates are not enforced by machinery — they're enforced by the current governor
set, and the paper has just told us that set can change the gates. The
difference between "never silent" and "never happens" is doing a lot of work
here. I'm not saying the design is wrong; I'm saying the sentence "no single
party can produce a valid rendering alone" is load-bearing and, as written,
overclaims. The rendering nodes are independent — but who runs them, and what
makes them independent rather than the protocol's own arms? The paper never
says, and that's the exact gap an adversary exploits.

**2. Exit without interop is the sock-puppet problem.** Your dissociation story
is the right instinct, but it answers only half the question I'd ask. The
author leaves with the work. Do they leave with the *audience*? (Inference:
I have no published treatment of a protocol shaped exactly like this one; the
concern is doctrine, the application is mine.) In my
"sock puppet economy" argument, the whole trick of platforms is that you invest
in relationships and a name, and when you leave you keep the sock puppets, not
the real thing. Here the publication owns the name and the domain, and the
reader's relationship is with the domain — "to a reader, a publication is
still a name that resolves." So when a writer leaves, does the audience follow?
The paper never touches the reader's side of the exit. If the audience stays
with the name, then the writer has exited *with their work* but *without their
readers*, which is... the platform problem wearing a different hat. Lowering
the cost of leaving for the author is necessary but not sufficient. I want the
reader's cost of leaving addressed, or explicitly scoped out with the same
honesty you applied to the state and to pseudonymity.

**3. You parked the payment gate, and that's where the power actually lives.**
Chokepoint Capitalism, with Rebecca, is about the fact that the creator squeeze
happens at the point of monetization and distribution. This paper's §5 makes
money "optional: the protocol makes room for a payment model to be plugged in,
and does not require one." Fine as scope. But then §1 says "neither party is
paid from the other's hand" and "it removes the paymaster." Those are
load-bearing claims, and a payment *rail* has its own paymaster. Who processes
the per-read or subscription payment? Who's the gatekeeper of the rail — Visa,
the chain, the exchange? "The protocol does not impose a payment model" is a
legitimate scoping choice; "removes the paymaster" is a claim about the one
place enshittification actually happens. You can't have both and stay honest.
And I'll add my documented micropayment skepticism: per-read micropayments are
a graveyard. The paper doesn't have to build the gate, but it should say *who
the paymaster at the rail is*, or say plainly that it's unresolved. Right now
the abstract quietly promises more than the optional gate delivers.

**4. "Trustless" claims wearing a trenchcoat.** The paper leans on "neither
party owns the record" and "auditable from the public end by walking the
chain." I'm documented-skeptical of blockchain trustless framing, and the
reason is the one you've buried: the interesting state — decryption and
rendering — happens *off-chain*, inside the generator, under gates set by the
governors. (This off-chain trust critique is my extension from my documented
skepticism of blockchain "trustless" claims.) The public chain is the least interesting part of the trust model.
What a reader or auditor actually has to trust is: the node operators, the
chain's liveness, ENS, and the governor upgrade path. Those are parties with
interests. The paper should name them as trust assumptions instead of folding
them into "no single party can produce a valid rendering alone." You've been
honest about the law and about pseudonymity; be that honest about the
machinery's operators.

**5. The copyright shape.** The author keeps ownership; the publication holds a
render license. That's a copyright system — which is fine — but the paper
should say so rather than imply it's outside licensing. And it should
acknowledge what I've argued for years: a strong-copyright tool helps creators
*only if* it's not itself a chokepoint. "Revoke at any time" interacts with the
legal reality the paper already concedes ("courts can compel the parties to any
arrangement, this one included"). The revoke is a fact in the record; it is not
a fact in the world, and the paper should stop halfway suggesting otherwise.

## Sharpest questions

1. What is the *reader's* cost of leaving? If the audience belongs to the
   publication's name, what has the author actually taken when they walked?
2. Who runs the independent rendering nodes, and what incentive makes them
   independent of the protocol's own governors rather than its arms?
3. You name the upgrade path honestly. So what stops a future governor set from
   patching the gates to serve a paymaster — and is "never silent" really the
   guarantee you think it is, or just "public before it happens"?
4. Who is the paymaster of the payment rail in the optional gate? Removing the
   paymaster between author and publication doesn't remove the paymaster at the
   rail.
5. Where does "proof of humanity" come from, and why is it in §7? It's a
   one-sentence aside that opens an entire accountability/ID can the paper
   otherwise wisely avoids.
6. Is "no single party can produce a valid rendering alone" true given the
   governor upgrade path can alter what the generator may do — and if it's
   "true until the governors change it," should the paper say that?

## Suggested changes

- **Address reader exit, or scope it out with the same candor as the state and
  pseudonymity.** One paragraph on whether the audience follows the writer, and
  if it doesn't, what that means. This is the sock-puppet gap and it's the most
  likely place a skeptical reader loses you.
- **Downgrade §5's "enforced by the machinery itself — not by any party's
  decision."** Reconcile it with §6's upgrade path. Say plainly: the gates are
  enforced by the current governor set, and the guarantee is that changing them
  is public and costly, not that they can't change.
- **Fix the paymaster language in §1/§5.** Either keep "removes the paymaster"
  and identify the rail's paymaster, or soften it to match the optional,
  not-built status of the gate. The abstract currently promises a little more
  than the gate delivers.
- **Name the trust assumptions explicitly.** Node operators, chain liveness,
  ENS, governor upgrade path — list them as the parties a reader must actually
  trust, then argue why that set is small and accountable. That's a stronger
  paper than one that says "trustless."
- **Say the copyright shape out loud** — author owns, publication holds a
  render license — and note it's a copyright-facilitating tool, not a
  copyright-abolishing one.

## What could be shortened or left out

**Cut the final aside in §7: "an author's account, identified by its DID, can
accumulate verified reputation — and, if the author chooses, proof of humanity
or of a real, administrative identity."** This is the single most cuttable
thing in the draft. It introduces a concept — proof of humanity / verified real
identity — that appears nowhere else in the paper, isn't developed, and opens a
whole accountability-and-ID can the rest of the draft wisely refuses to touch.
It muddies the clean pseudonymity thread ("pseudonymity is an option the
protocol permits, not a promise it makes") by hinting at an identity layer the
protocol doesn't build and the argument doesn't need. §7 is about the
reader's verify path from name to signed page; the sentence isn't part of that
path. Drop it and the section is *tighter*, not thinner.

Runner-up if you want a second trim: the funding paragraph in §2 ("The account
needs funding only as far as protocol fees require — gas, publishing,
rendering — and nothing in the protocol requires a fiat on-ramp or off-ramp").
It's implementation residue — "gas" appears nowhere else in the paper — and the
who-pays question is already a parked pending note. It doesn't carry the
dissociation argument. But the §7 aside is the one I'd cut first, because it
actively works against the paper's own clean stance on identity.

## Sources

(For this round I critiqued from the document itself plus my documented
positions. Where I extended beyond a documented view — reader exit, node
incentives — I've labeled it as inference, not doctrine.)

- "Adversarial Interoperability" (EFF, June 2020) — the case that interop, not
  just exit, is how users resist platform lock-in.
- "The Sock Puppet Economy" (Locus, Feb 2024) — how platforms let you keep fake
  relationships instead of real community when you leave.
- "The Internet Con: How to Seize the Means of Computation" (2023) — secession,
  interoperability, and why walled gardens need to be pried open.
- "Chokepoint Capitalism" (with Rebecca Giblin, 2022) — the creator squeeze
  happens at monetization and distribution.
- "Enshittification" (2023) and the associated essays — platform value
  extraction from users to business customers to shareholders.
- "Information Doesn't Want to Be Free" (McSweeney's, 2014) — copyright and the
  creator economy; my long-standing anti-DRM record (the W3C EME fight and
  before) underlies the DRM critique in Critical reading #1.
- Micropayment skepticism: "The Problem With Micropayments" and related essays
  (2013–) — per-read micropayments as a graveyard.
- Inference, flagged: reader-side exit and rendering-node incentives (Critical
  readings #2; Sharpest questions #1–2) — I have no direct published treatment
  of a protocol exactly like this; labeled as extension, not doctrine.
