# Max Blumenthal (owner of The Grayzone) — reading-room note (round 2)

_Scope: the full current draft — Abstract + Sections 1–7 (Introduction, Authoring,
Publication, Agreements, Gates, Protocol, Verification) — read as the operator of an
independent, reader-funded publication. Where I state a fact about my own situation I mean the
well-documented public record; where I am reasoning from principle rather than a documented
position I say so and mark it "inference." This is a full-draft pass; where I repeat a
round-1 concern it is because the draft has since changed and I am checking whether the change
helped._

## Verdict

Round 1 I said the Introduction was a strong moral argument and a weak operator's argument. On
the full draft I have to be more precise: it is now an honest argument and still a weak
operator's argument — and the honesty is doing more work than the engineering. Two real
improvements: the per-read payment model is gone, and the draft now admits outright that the
payment gate is "optional… described here and not yet built," which is more truthful than round
1's hand-waving about "nobody is bought." But in the same breath §6 admits that the "unowned"
machinery has a governor committee that "could adopt code that cuts a publication or an author
off." So the single party I could not trust — the platform — has not been dissolved; it has been
relocated to a committee, and the paper says so. I respect the honesty. I do not accept that
it is independence. An editorial line held by people free to leave means something; an editorial
line held by a governor committee I do not control, at a threshold the paper refuses to set,
means what the old platform meant with a different logo.

## What resonates

- **"an editorial line held by people free to leave means something a captive one cannot"**
  (Abstract; echoed in §1) — still the truest sentence in the paper. This is the whole reason
  I would read it twice.
- **"A publication is the set of agreements currently in force"** (§1, §3, §4) — an outlet as
  its live relationships rather than a corpse you are held hostage to. I have watched outlets
  become the corpse. This is the right instinct.
- **§3: "Its contributors can leave at any time, taking their work with them, so a publication
  that wants to keep them must persuade them. A line it cannot hold by position, it must hold
  by argument."** — this is the best paragraph in the draft, and it is the one that will
  actually change how a collective behaves.
- **§4: "ending an agreement is a fact rather than a request."** — the difference between a
  fact and a request is the difference between owning something and renting it. Good.
- **§3 admitting the path is fragile: "the name can be seized, poisoned, or made hard to
  resolve."** — refreshing. The paper does not pretend the DNS layer it rides on is safe.
- **§6: "a limit of the design, named rather than hidden."** — I would rather be told the truth
  about the upgrade path than sold a version that pretended no one could touch it.

## Critical readings (as an operator)

**1. The money is now officially not built — and that is the whole ballgame.** The Abstract
says the payment gate is "described here and not yet built"; §5 gate 3 repeats it. This is
honest, and I will credit the change from round 1. But honesty is not a product. Every thing
that has actually threatened my publication's existence — who takes the reader's dollar, who
can freeze it, who can cut off my funding — sits in that unbuilt gate. And the "who pays for
the infrastructure" paragraph that was flagged in round 1 is no longer in §5 at all; it is not
in the draft. So an operator reading this cover to cover learns: the publishing machinery is
designed, but the thing that keeps the lights on, and the thing that gets me paid, are both
unanswered. That is not a quibble; that is the difference between a paper I act on and a paper
I file away.

**2. The governors are the new platform, and the draft admits it.** The Abstract's strongest
claim is that "no single party can produce a valid rendering alone." Then §6: governors "could
adopt code that cuts a publication or an author off — the upgrade path makes that technically
possible." So there is a party, or a committee, that can end me — and the paper's own example,
"child pornography is the obvious one," is exactly the door a censorship regime walks through,
because everyone agrees with the first use and then no one questions the second. "It would be a
public decision carrying a real reputational cost" is cold comfort: the platforms' terms were
public too. Public does not mean powerless. Note the internal contradiction §6 itself carries: it says the
governors "are not involved in rendering, and are not party to the business between authors and
publications" and that "their only lever is which actions may be called" — then, paragraphs later,
admits they can adopt code that cuts a publication or an author off. Either that lever is
real, in which case they are absolutely party to my business, or it is cosmetic, in which case
the upgrade path is not the safety valve it is sold as. The draft cannot have it both ways. And
the larger point stands: the paper has traded "someone holds the keys" for "a committee holds
the keys and must announce when it turns them," and a reader of the Abstract would not know
that until §6. This is the core contradiction of the full draft and it needs to
be resolved in the Abstract, not buried in the governance section. *(That the "child
pornography" example is the wedge by which a governance layer becomes a censor is my inference
from general principle, not a documented Blumenthal position.)*

**3. The readership still has no home in the model.** §3 defines the publication as "a name, a
look, a domain… and an editorial policy," but never says who keeps the audience when a
contributor leaves. §4's agreement is per-work, not per-audience. My actual asset — the email
list, the trust, the people who show up — is still not represented anywhere in the protocol.
The draft can render pages and verify signatures forever and it still will not tell me who
keeps the readers when a falling-out happens. An owner knows a contributor is not trivially
replaceable when they leave with the audience the publication helped them build. This is the
round-1 asymmetry, unchanged, and it means the paper is still written from the author's chair.

**4. Continuity is unaddressed, and the "who pays" question is missing from the draft.**
§6: "How many governors the protocol has, and at what threshold they act, are the choices of
those who run it; this paper does not set them." Who runs it? Who pays for the nodes, the
storage, the record writes? When the machinery breaks, who do I call, and what happens to my
publication while it is down? Round 1 I asked this about the unowned generator. On the full
draft the question is sharper, because the paragraph that would have started to answer it (the
who-pays infrastructure note) has been removed from the paper entirely. A publication built on
machinery whose bills are someone else's problem is a publication with a landlord it has not
met.

**5. Pseudonymity: honest, and a limit.** §2: "pseudonymity is an option it permits, not a
promise it makes." I respect not overpromising — it is the same honesty I credited in the
payment gate. But the companion line in §7, that an author may attach "proof of humanity or of
a real, administrative identity," is the vector the state will use. If the identity is
separable from infrastructure but the state can still compel the people an author "chooses to
tell," then the protection is against the platform, not against the law — and the paper's §1
already concedes "courts can compel the parties to any arrangement." Good that it concedes it.
I just want the reader to feel the weight of the concession.

## Sharpest questions

1. **You admit the governors can adopt code that cuts me off. Who are they, how are they
   chosen, and why is a committee I do not control — at a threshold this paper refuses to set —
   better than the platform I do not control?**
2. **The payment gate is "not yet built." So today, concretely, what does my reader pay with,
   and what stops a payment freeze?**
3. **Who pays for the nodes, the storage, and the record writes — and what happens to my
   publication when the bill does not get paid?**
4. **When a contributor leaves, who keeps the readership both of us built?**
5. **If "child pornography" is the first governor lever, what is the second — and does a
   "public decision" protect me when the decision is made under state pressure?**

## Suggested changes

- **Reconcile the Abstract with §6.** The Abstract's "no single party can produce a valid
  rendering alone" overpromises what §6 then walks back. Either qualify the Abstract claim to
  match the governor-upgrade reality, or shrink the governor layer so the claim is true. As it
  stands the paper's headline and its governance section contradict each other, and a reader
  who skims the Abstract will be sold a promise the body retracts.
- **Restore the who-pays paragraph into the paper.** The infrastructure-cost note exists (it
  was cut from §5 and lives in the handoff). Put it in §6, where an operator will look for it:
  who pays for storage, rendering, and record writes, on both the serviced and the
  bring-your-own-keys paths. "The protocol permits both and promises neither" is the right
  tone; it just is not in the draft.
- **Give the readership a home.** State, somewhere in §3 or §4, who retains the audience when
  an agreement ends — or explicitly concede that the protocol does not address it. Otherwise
  the draft remains written from the author's chair and an owner will walk away.
- **Keep the honest payment-gate framing, but say what is built.** "Not yet built" is fine; add
  one line on what the deployment path is, so the reader knows whether this is a paper or a
  product.

## What could be shortened or left out

If I had to cut one thing and lose nothing of the argument, I would cut the final paragraph of
§1 — "There is a future for online publishing in which association and dissociation between
groups of people are easier and involve less friction: temporary collectives formed around
topics and interests, bringing together a plurality of opinions, and the insights only diversity
can offer." The Abstract already ends on the same aspiration almost verbatim ("There is a future
for online publishing in which association and dissociation between groups of people are easier
and involve less friction"). The Introduction's actual argument is complete two paragraphs
earlier, at "An editorial line held by people free to leave means something a captive one
cannot." The closing paragraph is an inspirational coda that repeats the abstract and adds no
operative content — exactly the kind of filler an editor strikes, and it is the one cut that
strengthens the piece by tightening it.

Two smaller trims: the stray "- [ ] buy groceries" checklist line at the top of v1.md is an
editing artifact and should go before any reader sees it; and §6's "A version with no upgrade
path at all — one its own governors could not alter — is possible to build, and this protocol
would be glad to be its inspiration" is a self-congratulatory aside that pads the governance
discussion — the "limit of the design, named rather than hidden" line immediately before it
already does the honest work, so the aside can be dropped without losing the point.

## Sources

I ground my critique on the well-documented public record of running The Grayzone and
independent reader-funded media, and I flag where I am reasoning from principle rather than a
specific documented quote:

- **Demonetization / platform restriction (documented):** The Grayzone's public reporting and
  Max Blumenthal's public statements on demonetization and content restriction on major video
  and social platforms — the standing, documented experience that an independent outlet outside
  corporate consensus gets throttled, restricted, and de-monetized not for its hosting but for
  its content and payment viability.
- **Reader-funded model (documented):** The Grayzone's operation as a reader/donation-supported
  outlet is a matter of public record and central to how I describe the funding mismatch and
  the missing who-pays answer.
- **Independent media's dependence on reader support and the fight to own audience and archive
  (documented):** Max Blumenthal's published commentary on independent journalism outside the
  corporate-platform machine.
- **Specific claims where I have NO documented view (explicitly flagged as inference in the
  body):** that a governor committee with a "child pornography" lever becomes a censorship wedge;
  that a public decision by the governors is cold comfort under state pressure. I reason about
  these from general principles labeled as inference, and I do not attribute any specific
  unverified event or quote to myself.
