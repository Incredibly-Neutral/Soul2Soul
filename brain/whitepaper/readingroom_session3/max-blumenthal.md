# Max Blumenthal (owner of The Grayzone) — reading-room note (round 3)

_Scope: the current draft (v1.md, Abstract + §1–§8) read as the operator of an independent,
reader-funded publication, against my own round-2 note on the previous full draft. My job here is
to say what changed since I last read it, whether the change helped, and what survived. Where I
state a fact about my own situation I mean the well-documented public record; where I reason from
principle rather than a documented position I mark it "inference." I have no documented view on the
engineering internals (threshold signatures, Merkle trees, ENS, content-addressing) and I do not
pretend to adjudicate them; those are not where my expertise or my stake lies._

## Verdict

Round 2 I said the paper was an honest argument and a weak operator's argument, and that the
honesty was doing more work than the engineering. On this draft I have to upgrade one half of that
and hold the other half. The honesty has materially improved — three of my round-2 asks were
answered, and one was answered in a way that respects the paper's own intellectual standard rather
than just soothing me. But the two facts that decide whether I act on this instead of filing it —
who takes the reader's dollar and who keeps the audience when a contributor leaves — are
unchanged, and the governance contradiction I flagged has been *moved* rather than resolved. So my
verdict is the same as last time, and now it is harder-earned: this is a paper that listens, and
the thing it still cannot bring itself to say is the thing that matters most to an operator.

## What changed since round 2 (and whether it helped)

- **The rule-of-law concession moved to the front.** The Abstract now opens the scope with "It is
  meant to function within the rule of law. It is not a tool for protecting journalists from a
  hostile state." In round 2 this lived in §1 as a buried admission; now it is the first thing a
  reader meets. This is the single most important honesty upgrade in the draft. A paper that states
  its own limit in its opening paragraph earns the right to be argued with, and it spares me from
  being sold a protection the body then retracts. I respect it. It also, for my own situation, says
  plainly that this is not the tool for the threat model I actually live under — which is
  honest, and which I will hold as a real limitation rather than forgive on the strength of the
  candor.
- **The forgery/suppression distinction is now written out, and it directly answers my round-2
  headline objection.** In round 2 I said the Abstract's "no single party can produce a valid
  rendering alone" overpromised against the governor-upgrade reality. §7 now says it explicitly:
  "When the abstract says no single party can produce a valid rendering alone, it claims the
  second, not the first" — the second being forgery, the first suppression. That is the honest
  version of the headline, and the draft now states the limit of its own guarantee rather than
  letting the Abstract imply more than §7 delivers. Credit where it is due: this is exactly the
  reconciliation I asked for, done in the paper's own voice.
- **The who-pays paragraph is back, and it is in §6 where I asked for it.** In round 2 I flagged
  that the infrastructure-cost note had vanished from the draft. It is now restored as "Paying for
  the machinery" in §6: each participant pays for its own use; a for-profit can fold the cost into
  a subscription; anyone else can bring their own machinery and pay their own way. That is the
  right paragraph in the right place. It answers the per-participant bill. It does **not** answer
  who runs the distributed node network that holds the key shares in §7 — see criticisms — but the
  restoration is a real improvement and I want it on the record.
- **The "proof of humanity or a real, administrative identity" line from the old §7 is gone.** In
  round 2 I called that line the vector the state would use. Its removal, together with the
  front-loaded rule-of-law concession, closes the specific opening I flagged. The underlying
  reality — the protocol separates identity from infrastructure, not from the people an author
  chooses to tell — is unchanged, and §2 states it honestly. Good.
- **§4 now limits what the ledger settles.** "What the ledger settles is what was agreed and when,
  not whether either party honored it." This is the cleanest new sentence in the draft. It tells
  the reader the ledger records facts, not justice, and that a page still circulating after a
  withdrawal is "a copy the name no longer vouches for." That is the right ambition and the right
  humility, and it matches my own skepticism about overclaiming what a record can do.

## What resonates (new and standing)

- **"An editorial line held by people free to leave means something a captive one cannot"**
  (Abstract, echoed in §1) — still the truest sentence in the paper, and still the reason I read
  it twice.
- **§7: "It is not forgery... Suppression is a public act a community may choose within the law;
  forgery would require the whole protocol to collude."** The distinction between what the
  machinery can be made to do and what a community can decide to stop is the intellectually honest
  core of the whole design, and now it is stated cleanly.
- **§4: "What the ledger settles is what was agreed and when, not whether either party honored
  it."** (new) — an honest limit, and a sentence that will age well.
- **§3: "Its contributors can leave at any time, taking their work with them, so a publication
  that wants to keep them must persuade them. A line it cannot hold by position, it must hold by
  argument."** — the best paragraph in the draft, unchanged and still the one that would change how
  a collective actually behaves.
- **§3: "Marketing and outreach are the publication's own business, off the record; the protocol
  neither provides them nor governs them."** (new) — I list this under what resonates and also under
  criticisms, because it is honest scoping and simultaneously the draft's way of not answering my
  hardest question. The candor I credit; the consequence I hold against it.

## Strongest criticisms

**1. The governance contradiction is moved, not resolved — and the draft has now made both sides
of it sharper and closer together.** In round 2 I said the paper could not both claim the
governors "are not party to the business" with "only" one lever, and also hold the power to cut a
publication off. The draft answered my Abstract-vs-§6 objection by narrowing the Abstract claim to
forgery — good — but it left the internal §7 contradiction standing, and in fact tightened it. §7
still asserts, in one breath: "their only lever is which actions may be called and tied to the
protocol key" and "they are not involved in rendering, and are not party to the business between
authors and publications." And in the next breath: "They could adopt code that cuts a publication
or an author off" — and then, as if to settle it, "That is suppression — stopping a rendering — and
it is the only power on the table." So the draft's own accounting concedes that suppression, the
cut-off, is real and is the only power. If suppression is real, a committee that can end my
publication is party to my business by any honest definition of the word — the "not party to the
business" line is doing the same rhetorical work the old "nobody is bought" line did, which I
already rejected. The draft has improved the honesty about suppression while keeping the
reassuring frame in the same paragraph. Either the lever is real — then they are party to my
business — or it is cosmetic — then the upgrade path is not the safety valve it is sold as. The
paper still will not pick.

**2. Money is still "not yet built," and the deployment path I asked for is still not there.** The
honesty is intact ("described in this paper and not yet built," Abstract; the third gate is still
"an optional gate... into which any on-chain logic can be plugged"). And the who-pays paragraph is
restored. But neither tells me, today, what my reader pays with or what stops a payment freeze —
the two things that have actually threatened my publication's existence live in that unbuilt gate.
And the restored who-pays paragraph, good as it is about per-participant use costs, still does not
answer who runs the "distributed network of independent nodes" that holds the protocol key shares
in §7, who pays those operators, or what happens to my publication when that bill does not get paid
or a node goes dark. The §6 answer covers the author's and the publication's own machinery; the
shared signing network is still a landlord I have not met. That was my round-2 question and it
remains unanswered.

**3. The readership still has no home — and the draft has now made the exclusion explicit rather
than accidental.** My asset — the list, the trust, the people who show up — is still represented
nowhere in the protocol. §3 still defines the publication as "a name, a look, a domain its pages
are served from, and an editorial policy"; §4's agreements are still per-work, not per-audience.
The new "marketing and outreach... off the record" line is honest about scope, but its effect is to
declare the audience-building function explicitly outside the model. That is not a neutral scoping
decision; it is the decision that keeps the paper written from the author's chair. The whole value
proposition of "a publication that wants to keep its contributors must persuade them" depends on
leaving costing the publication something real — and the only thing that makes leaving costly is
the audience the contributor helped build. Take the audience out of the model and the persuasion
incentive has nothing to bite on. An owner reading §3 will note that the paper can render and
verify pages forever and still not say who keeps the readers when a falling-out happens. *(That a
leaving contributor's leverage comes from the shared audience is, in part, my inference about how
collectives behave, not a documented position.)*

**4. The governor question — who "those who run it" are — is still open, and it is the question
that decides whether the committee is my landlord or my peer.** §7: "How many governors the
protocol has, and at what threshold they act, are the choices of those who run it; this paper does
not set them." Who runs it is not answered. If the honest answer is "the same people who pay for
the nodes," then the who-pays and who-governs questions are the same question, and neither is
answered. My round-2 fear stands: a committee I do not control, at a threshold this paper refuses
to set, replaces the platform I do not control.

**5. Pseudonymity is now honestly scoped, and that scope is a real limitation for me.** The
removal of the "proof of humanity" line and the front-loaded rule-of-law concession together make
the paper truthful about what it does not do. I credit it. But I want the reader to feel the
consequence: for a publication whose operational threat model is state and platform pressure, the
first paragraph is the paper telling me, plainly, that it is not the tool for that job. The
protocol separates identity from infrastructure, not from the people an author chooses to tell,
and the state can still compel those people. Good that the paper says so. It is still a reason I
would not bet my existence on this.

## Sharpest questions

1. **If suppression — ending a rendering — is "the only power on the table," then the governors are
   party to my business. Which sentence in §7 is true: "their only lever is which actions may be
   called and... not party to the business," or "they could adopt code that cuts a publication or
   an author off"?** You cannot hold both. Pick one.
2. **Who runs the distributed network of independent nodes that holds the key shares? Who pays
   them, and what happens to my publication when a node dies or the bill is not paid?**
3. **The payment gate is "not yet built." What is the deployment path — and today, concretely, what
   does my reader pay with, and what mechanism stops a freeze?**
4. **When a contributor leaves, who keeps the readership both of us built? And is the new "marketing
   and outreach... off the record" line the paper's way of declining to answer?**
5. **"Those who run it" choose the governor count and threshold. Who are "those who run it," and how
   is that different from the platform I left?**
6. **If "child pornography" is the first governor lever, what is the second — and does a "public
   decision" protect me when the decision is made under state pressure?** *(This is inference from
   general principle, not a documented Blumenthal position.)*

## Suggested changes

- **Resolve the "only lever" vs. "suppression is the only power" contradiction in §7.** The draft
  already concedes suppression is real ("it is the only power on the table"). Keep that, and delete
  or rewrite "their only lever is which actions may be called" and "not party to the business
  between authors and publications," because a committee that can end a publication is party to its
  business by definition. The honest version is one sentence: *the governors can end a rendering,
  and that is the whole of their power — they cannot forge one.* That keeps the forgery/suppression
  honesty you already earned and drops the reassuring frame that reopens the contradiction.
- **Extend the restored who-pays paragraph to the shared node network.** §6 now answers
  per-participant cost and the bring-your-own path. Add one sentence on the key-sharing network in
  §7: who runs it, who pays it, and what the continuity story is when it breaks. Even "the protocol
  permits both and promises neither" is better than silence, and it is the tone you have already
  found.
- **Give the readership a home, or decline explicitly.** State in §3 or §4 who retains the audience
  when an agreement ends — or concede that the protocol does not address it. The "off the record"
  line on marketing must not be allowed to quietly drop the audience question, because the whole
  persuasion incentive in §3 depends on leaving costing the publication something real.
- **Keep the "not yet built" honesty, and add one deployment-path line.** You told me it is not
  built; tell me what the path to built looks like, so a reader can tell whether this is a paper or
  a product. You answered this for the who-pays paragraph; answer it for the payment gate.
- **One concrete sentence on who "those who run it" are.** It can be deliberately open — but name
  the standing and selection question, even to say it is not yet settled. Without it, the committee
  is a landlord I have not met, and that is the sentence I most want the next draft to engage.

## Where I have no documented view

I have no documented position on the technical machinery — threshold key shares, Merkle-tree site
rebuilding, ENS/content-addressing, the render/rebuild action split, or the correctness of the
"one chain of authorization" claim. I do not pretend to adjudicate those; they are outside my
recorded expertise and outside my stake, and I will not fabricate an engineering verdict to fill
the space. My documented ground is the public record of running a reader-funded independent outlet
— demonetization and content restriction on major platforms, dependence on reader support, and the
fight to own one's audience and archive — and everything above is anchored to that. Where I reason
from principle rather than a documented position (the censorship-wedge argument, the cold-comfort of
a public decision under state pressure, the leverage of the shared audience), I have said so and
marked it inference, and I attribute no specific unverified event or quote to myself.
