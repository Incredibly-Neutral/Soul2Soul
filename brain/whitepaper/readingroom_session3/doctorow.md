# Cory Doctorow — reading-room note (round 3)

## Verdict

The paper got better in exactly the places I told it to get better, and it
kept its nerve in the places where I told it to keep it. The proof-of-humanity
aside is gone. §7 now says plainly that "no single party can produce a valid
rendering alone" claims the forgery guarantee, not the suppression guarantee —
that is the single most important correction this draft could have made, and
it made it. §4 now admits that the ledger settles what was agreed, not whether
it was honored, which is the right candor about what a record can and cannot
do. §3 names the DNS/path risk instead of pretending the name is immune. These
are all responses to what I actually wrote, and they're the right responses.

But the load-bearing tension I flagged last round is still standing, and a new
one has walked in to keep it company. §5 still says the gates are "enforced by
the machinery itself — by what the code will do and what the key will sign —
not by any party's decision when the moment comes," which is the same sentence
I've been arguing against for twenty years, and §6 still tells us the governors
can change the gates. The paper has not yet chosen between "enforced by
machinery" and "enforced by the current governor set." And this draft leans
heavier than round two on two new trust anchors — a "runtime sealed against
outside interference that can prove, to anyone checking, that it executed the
code as written," and a protocol key held "as shares across a distributed
network of independent nodes, used only when enough of them act together" —
without once saying who runs those nodes or what makes them independent. So
the machinery got more impressive and more opaque in the same breath.

Verdict: still keep going, and the finish line is visible. The remaining work
is a single discipline: every time the paper says "machinery" or "independent
nodes" or "on chain," it owes the reader the sentence that names the human
parties who actually hold the interesting power. Do that and the paper stops
selling "trustless" and starts selling what it has actually built — trust in a
small, named, accountable set of parties — which is the stronger and the more
defensible claim.

## What resonates

1. **The §7 forgery/suppression distinction.** This is the best move in the
   revision. Last round I asked whether "no single party can produce a valid
   rendering alone" survived the upgrade path, and the draft now answers: the
   claim is that no one can forge an unagreed rendering, not that no one can
   suppress one. That is the correct and honest formulation. Suppression is a
   public, reputational act; forgery would require the whole protocol to
   collude in a misrepresentation that is public at the same time. Naming which
   guarantee is actually on offer is what separates this paper from a hundred
   crypto whitepapers that would have claimed both. Keep it.

2. **§4's ledger honesty.** "What the ledger settles is what was agreed and
   when, not whether either party honored it — a page that keeps circulating
   after a withdrawal is a copy the name no longer vouches for." This is the
   copyright-shaped point I raised last round, stated correctly. The revoke is
   a fact in the record; it is not a fact in the world. The draft has stopped
   half-suggesting otherwise, and the section is stronger for it. This is the
   difference between a protocol that overclaims and one that can be read
   without a lawyer bracing for the worst.

3. **The cost-of-leaving thesis, still intact.** "Departure costs both sides,
   because a publication that wants to keep its contributors has to persuade
   them, and a writer who stays is choosing the publication rather than
   avoiding the cost of leaving." That remains the heart of the paper and it
   remains right. Enshittification is the dynamic of extraction when exit is
   cheap for one side and expensive for the other; making exit cost both sides
   is a genuine, novel mechanism and it's worth everything the paper spends on
   it.

4. **The DNS admission in §3.** "While browsers do not support distributed
   domains, [the name] is prone to the risks of DNS: the name can be seized,
   poisoned, or made hard to resolve. The protocol makes the name the
   publication's own; it does not make it immune to the risks of the path it
   rides on." Good candor, and it's the right note of humility about a path
   dependency the paper can't design away. (I have no published position
   specific to DNS/ENS; this is my reading of the draft's own logic, not
   doctrine.)

## Strongest criticisms

**1. §5 still asserts machinery-enforced gates, and §6 contradicts it.** The
sentence "enforced by the machinery itself — not by any party's decision when
the moment comes" is unchanged from round two. It is the one claim in the
paper I am most professionally certain is wrong. DRM is never enforced by the
machinery; it is enforced by whoever can change the machinery, and your own §6
tells us the governors can adopt code that cuts a publication or an author off.
So the gates are enforced by the current governor set, full stop. The paper
has done the hard, right work of reconciling the abstract's "no single party"
claim in §7 — it now needs to do the same reconciliation one paragraph earlier
in §5. "Never silent" is a real and valuable property; it is not the same
property as "never happens," and the paper still lets the sentence drift
toward the stronger of the two.

**2. The "independent nodes" are still unnamed, and now they're load-bearing.**
Round two I flagged this as the gap an adversary exploits. This draft raises
the stakes: the protocol key "exists as shares across a distributed network of
independent nodes, and is used only when enough of them act together." That is
a threshold-signing design, and the security of the whole forgery guarantee now
rests on who those nodes are and what threshold makes "enough." The paper
never says. How many nodes? What threshold? Who appoints them? What stops the
node set from being the governor set's own arms — the exact concentration the
paper exists to dissolve, now reproduced inside the machinery? This is my
sock-puppet / adversarial-interoperability concern applied at the protocol
layer, and I'll be explicit that the application is mine: the doctrine is
anti-concentration, and the specific "who runs the independent nodes" question
is my inference onto this design. The paper should name the party, or say
plainly that the question is open — because right now "independent nodes" is a
synonym for "trust me."

**3. The sealed runtime is a new trust anchor introduced without ceremony.**
"Runs in a runtime sealed against outside interference that can prove, to
anyone checking, that it executed the code as written" is a remote-attestation
claim, and it is a big one. Whoever's attestation key vouches for the seal,
and whatever hardware enforces it, are parties with interests and failure
modes. This is exactly the kind of "trustless" hand-wave the rest of the draft
has grown out of — you've been honest about the law, about pseudonymity, about
DNS, about the upgrade path; be that honest about the sealed runtime. Either
name the attestation trust anchor and argue why it's small and accountable, or
downgrade the sentence to "the generator runs in a runtime whose execution can
be verified," and flag the verification itself as an assumption. (My skepticism
of trusting a black box's attestation is an extension of my documented
anti-trustless, pro-accountability line, not a separate doctrine I've written
up.)

**4. The paymaster question is still parked, and the abstract still overpromises.**
The money section is better organized this round — separating "rewards for
work" from "paying for the machinery" is the right decomposition. But the
third gate "answers yes or no, on chain, without ever holding the value," and
the abstract still says revenue "splits between author and publication without
passing through a single hand first," and §1 still says "it removes the
paymaster." Remove the paymaster between author and publication and you have
not removed the paymaster at the rail. If the reader pays, who processes it —
and more pointedly, who *asserts* on chain that the reader paid, so the gate
can answer yes? A whitelist the publication maintains is a membership list the
publication controls. A token transfer on chain re-introduces the exchange and
the fiat rail the paper says it neither requires nor forbids. The gate "never
holds the money" is true; the gate still needs someone to observe payment, and
that someone is a party. This is my Chokepoint Capitalism point: the squeeze
lives at monetization and distribution, which is precisely where this design
declines to look. My documented micropayment skepticism also applies — if the
optional gate is per-read, that's a graveyard; if it's subscription/membership,
say that and drop the per-read whisper.

**5. Reader-side exit still isn't addressed, and the sock-puppet gap is the one
place a skeptic will lose you.** The paper's whole promise is that the author
can leave. Leave with the work, yes. Leave with the *audience*? The paper
still doesn't say. "To a reader, a publication is still a name that resolves"
— so the reader's relationship is with the name, and the name belongs to the
publication. When the writer walks, does the audience follow the writer or
stay with the name? If it stays, the writer has exited with their work but
without their readers, which is the platform problem wearing a better hat. This
is the sock-puppet problem: platforms let you keep the fake relationships, not
the real ones. I'll be explicit this is my inference from my documented
"sock puppet economy" argument, not a direct treatment of this protocol. Lower
the author's cost of leaving all you like; until you address the reader's cost
of leaving, or scope it out with the same candor you gave the state and
pseudonymity, the dissociation story answers only half the question I'd ask.

## Sharpest questions

1. What is the *reader's* cost of leaving? If the audience belongs to the
   publication's name, what has the author actually taken when they walked —
   the work, or the working relationship?
2. Who runs the independent threshold-signing nodes, what is the threshold,
   and what incentive keeps the node set independent of the protocol's own
   governors rather than their arms?
3. What is the trust anchor for the "sealed runtime" attestation — which
   vendor's key vouches for the seal, and what happens if that seal or that
   key is compromised?
4. Who asserts on chain that a reader has paid, so the third gate can answer
   yes? Is it a publication-maintained whitelist (a membership list the
   publication controls) or a token transfer (which re-opens the fiat rail)?
   And is the optional gate subscription-shaped or per-read?
5. §5 still says the gates are "enforced by the machinery itself." §6 says the
   governors can change the gates. Which sentence is the paper going to keep,
   and how does it reconcile them in the same way §7 already reconciled the
   forgery/suppression claim?
6. You say "How many governors the protocol has, and at what threshold they
   act, are the choices of those who run it." That's an honest scoping line.
   But now the key-share threshold is also unspecified. Are the governor count,
   the node count, and the signing threshold three separate open parameters
   the paper is comfortable leaving unresolved in a document whose entire
   guarantee is that no single party can forge a rendering?

## Suggested changes

- **Reconcile §5 with §6 in the same move you made in §7.** Rewrite "enforced
  by the machinery itself — not by any party's decision" to say plainly: the
  gates are enforced by the current governor set, and the guarantee is that
  changing them is public, costly, and visible — not that they cannot change.
  This is the single highest-value edit left in the document.
- **Name the node set, or name it as open.** One paragraph: who runs the
  threshold-signing nodes, at what threshold, and what incentive keeps them
  independent of the governors. If the answer is genuinely undecided, say "the
  node set and threshold are open parameters" with the same candor you used for
  the governor count — and then ask whether the forgery guarantee can carry
  that much open weight.
- **Give the sealed runtime the same treatment you gave DNS and the state.**
  Either name the attestation trust anchor and argue for it, or downgrade the
  claim and flag the verification as an assumption. Don't let "can prove, to
  anyone checking" stand as a magic phrase.
- **Fix the paymaster language in the abstract, §1, and §5's third gate.**
  Either identify who observes payment on chain, or soften "removes the
  paymaster" / "without passing through a single hand" to match the optional,
  not-built status of the gate. And choose a shape for the gate — subscription
  or membership, not per-read — or say the shape is undecided.
- **Address reader exit, or scope it out with the same candor as the state and
  pseudonymity.** One paragraph on whether the audience follows the writer.
  This is the most likely place a skeptical reader — especially one who knows
  my sock-puppet argument — loses you, and it's cheap to fix.

## What changed since round two (credit where due)

- §7 "proof of humanity" aside: **cut**, as recommended. The pseudonymity
  thread is now clean and the section is tighter.
- §7 now explicitly scopes "no single party can produce a valid rendering
  alone" to forgery, not suppression: **responds to my sharpest question #6.**
- §4 now admits the ledger settles agreement, not performance: **responds to
  my copyright reading.**
- §3 names DNS/path risk; §6 splits "rewards" from "paying for the machinery":
  **both are improvements.**
- My runner-up trim — the §2 funding paragraph with its lone "gas" — is now
  less orphaned, because §6 explicitly introduces "blockchain writes,
  distributed storage, and the network functions that render." I no longer
  recommend cutting it; the machinery-cost concept now appears where it
  belongs. I'll withdraw that suggestion.

## Sources

(For this round I critiqued from the current draft plus my own round-two note
and documented positions. Where I extend beyond a documented view — the node
set, the sealed-runtime attestation anchor, the on-chain payment oracle — I've
labeled it as inference, not doctrine. I did not read the other readers'
session-2 notes.)

- "Adversarial Interoperability" (EFF, June 2020) — interop, not just exit, is
  how users resist lock-in; underlies the node-set and reader-exit readings.
- "The Sock Puppet Economy" (Locus, Feb 2024) — you keep the fakes when you
  leave; reader-exit is my inference onto this design from that doctrine.
- "Chokepoint Capitalism" (with Rebecca Giblin, 2022) — the squeeze lives at
  monetization and distribution; underlies the paymaster/rail criticism.
- "Enshittification" (2023) and associated essays — extraction when exit is
  asymmetric; grounds the cost-of-leaving resonance.
- "Information Doesn't Want to Be Free" (McSweeney's, 2014) and the anti-DRM
  record (the W3C EME fight and before) — the §5 "enforced by machinery"
  criticism, which is my strongest documented position and the one I will not
  soften.
- Micropayment skepticism ("The Problem With Micropayments," 2013–) — the
  per-read vs. subscription shape question on the third gate.
- Inference, flagged: node identity/threshold (criticism #2, question #2),
  sealed-runtime attestation anchor (criticism #3, question #3), and the
  on-chain payment observer (criticism #4, question #4). I have no direct
  published treatment of a protocol exactly shaped like this one.
