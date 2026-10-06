# Vitalik — reading-room note (round 2)

## Verdict

This is the strongest whitepaper draft of its kind I have read in a while, and the reason is the
thing most crypto-adjacent papers get wrong: it names its own limits instead of selling past them.
The upgrade-path admission in §6, the pseudonymity-is-an-option-not-a-promise caveat, the refusal to
pretend uncensorability — that is the cypherpunk instinct done right, and it is rare.

The problem is not that the draft oversells. The problem is the opposite and more subtle: in the
Abstract it makes a couple of one-line claims that are *stronger* than the honest body of the paper
supports ("leverage passes to machinery with no interests"), while in §6 it under-specifies the one
place the reader actually needs to see trust being placed (the TEE + node-consensus anchor). So the
draft is simultaneously slightly too confident where it should be scoped, and too quiet where it
should be loud. Both are easy fixes. Verdict: near-ready, with the trust anchor and the symmetry
claims tightened.

## What resonates

These land on documented positions of mine, so I can say so rather than infer:

- **Removing the means of production from anyone's control** — "an editorial line held by people
  free to leave means something a captive one cannot." This is the whole d/acc / "Make Ethereum
  Cypherpunk Again" instinct: decentralization as defense against a power imbalance, not as a
  promise of immutability. The framing of the problem ("someone has to own the room") is exactly
  right.
- **Identity that survives key rotation.** "An identity that cannot survive a key rotation is an
  archive hostage to a single secret." This is account abstraction / ERC-4337 and the Safe-as-identity
  model, stated cleanly. An author being a Safe whose signers can swap underneath the same DID is
  the correct way to make reputation permanent without making it hostage to a single key.
- **Explicit limits over fake guarantees.** The §6 passage admitting governors *can* cut a
  publication off via upgrade, and naming child pornography as the case where a community will want
  the lever pulled, is exactly how a protocol should talk about governance. "Named rather than
  hidden" is the right posture.
- **The plurality closer.** "Temporary collectives formed around topics... the insights only
  diversity can offer" is the plurality idea I have been circling for years. It is the right reason
  to build this thing.
- **ENS as the naming layer**, and the honesty that the *path* to content (DNS) is not made immune.
  Scoping the path rather than pretending to fix it is the correct discipline.
- **The restraint of the unbuilt payment gate** — describing what exists, marking what doesn't, and
  refusing to impose a payment model. Most teams would have shipped the payment gate as the headline.

## Critical readings

1. **"Leverage passes to machinery with no interests" (Abstract) overclaims.** Machinery has
   interests: it has governors, and the paper itself concedes in §6 that those governors can adopt
   code that cuts an author or publication off. So "no interests" is not what the design delivers.
   What it delivers is machinery with *no stake in the parties' business with each other*. That is
   a real and valuable thing — but the abstract should say that, and say it in a way that does not
   quietly retract when the reader reaches §6. As written, the strongest sentence in the abstract is
   contradicted by the most honest paragraph in the paper. Reconcile them in favor of the honest one.

2. **The trust anchor is never named, and it is the load-bearing one.** §6 walks the reader down a
   chain — domain → Safe → records → valid actions → protocol key — and the net effect paragraph
   ("only approved code, running with the approved key") is good. But the claim "no single party can
   produce a valid rendering alone" is only true because decryption and signing happen inside a TEE
   and require consensus across independent nodes. The whitepaper never says this. A reader cannot
   see where the actual trust is placed, which means they cannot evaluate it. The threat model gets
   this exactly right — *"this claim is exactly as strong as TEE integrity and genuine node
   independence; it is not stronger"* — and the paper should say some version of that sentence in
   §6. Without it, the neutrality claim floats. (Inference that you want this in the paper; the
   underlying scoping is documented in your own threat model.)

3. **§7 slightly overclaims "offline" verification.** "using nothing but the page" is true for the
   page's own provenance — the embedded signature and the content-addressed addresses make the page
   self-verifying. But "the name → CID root binding" is *not* self-contained: verifying it requires
   reading the ENS records over the network. So what is offline is the page; what is not offline is
   the name's binding to the root. The draft's "What you see is what was verified" should be split
   accordingly, or it invites the exact "wait, that needs a network call" objection it is trying to
   preempt. There is also an asymmetry worth closing: §3 scrutinizes DNS hard (seizure, poisoning,
   hard to resolve) but §7 does not apply the same scrutiny to ENS's own single points — the records
   contract, and the gateway. Your threat model flags the CCIP gateway as a documented single point.
   Match the scrutiny.

4. **The payment gate quietly re-opens what the paper closes.** §2 is careful: "nothing in the
   protocol requires a fiat on-ramp or off-ramp; how the account is funded... outside its scope."
   But the optional reading gate in §5, if it is ever built, re-introduces a payment rail — and your
   own threat model states "money is a deanonymizer: whatever rail pays a person must settle
   somewhere real." The Abstract's "dividing a payment does not make money harmless" is the right
   instinct, but the paper should carry that admission all the way to §5 and say plainly: a payment
   gate, should it land, re-opens the paymaster/on-ramp/deanonymization questions the protocol
   otherwise avoids. It is also the obvious place to note that running the machinery costs money —
   storage, rendering, gas — and the paper never says who pays for that. The revenue split in §5
   presumes there is revenue; the cost side is silent.

5. **The governors are the real governance question, and the paper punts it — acceptably, but it
   should say so.** "How many governors... this paper does not set them" is fine for v1. But the
   neutrality claim ultimately rests on *governors restraining themselves because cutting someone
   off is visible and reputational* — which is a social guarantee, not a cryptographic one. That is
   honest and fine, but the paper should label it as a governance trust assumption, and surface the
   questions that follow: what is the governor set, is there a quorum and a lead time, and — most
   importantly for the author — *is there an exit window between an upgrade being adopted and an
   author being cut off?* Right now the paper says governors "cannot censor silently" but never says
   what a non-silent censorship costs an author in the gap before they can leave.

6. **The departure-symmetry claim wants one honest caveat.** "Departure costs both sides" is
   presented symmetrically, but the publication loses a replaceable contributor while the author
   keeps their portable work. The mechanism removes the *structural* exit cost (position), which is
   the real achievement — but social power asymmetry (the one with the larger audience still sets
   terms) does not disappear because the keys changed. One sentence acknowledging that would make the
   symmetry claim airtight instead of aspirational.

## Sharpest questions

- Where, concretely, is the trust placed, and can a reader of this paper find it? (TEE + node
  consensus — name it and scope it.)
- If governors can cut a publication off via upgrade, what protects an author in the window between
  an upgrade's adoption and the author's exit? Is there a lead-time or exit guarantee?
- How is an author's key rotation done without losing the reputation chain, and what does provenance
  show across a rotation?
- If the reading gate is ever built, does it re-introduce a paymaster who is legally compellable and
  a fiat rail that deanonymizes — and does the paper owe the reader that admission now, in §5?
- Who pays for storage, rendering, and gas — and what happens to the guarantee if no one does?
- What is the governor set and threshold, and is that decision stable enough to be called governance
  rather than an admin?

## Suggested changes

1. **Abstract:** replace "leverage passes to machinery with no interests" with the scoped version —
  machinery with no stake in the parties' business with each other.
2. **§6:** add one sentence naming the trust anchor — decryption and signing happen inside secure
  hardware (a TEE) and require consensus across independent nodes, so the neutrality claim is exactly
  as strong as that hardware and that independence, and no stronger. (This is your threat model's own
  framing; it belongs in the paper.)
3. **§7:** split "using nothing but the page" — the page's provenance is self-contained; the name's
  binding to the root requires reading the chain. Add a one-line ENS-risk note (records contract,
  gateway) to match the DNS scrutiny already in §3.
4. **§5:** move the "money is a deanonymizer" admission next to the payment gate, and add the
  infrastructure-cost question (who pays for storage/rendering/gas) — or state where it is answered.
5. **§6:** surface the governor-set/threshold/exit-window as an explicit open governance question
  rather than "this paper does not set them."
6. **§1/§3:** add the one-sentence caveat that social power asymmetry outlives the change in keys —
  departure costs are structurally rebalanced, not made perfectly symmetric.

## What could be shortened or left out

Cut the **unbuilt optional payment gate as described in §5 (the third gate), together with its
previews in the Abstract and §1** — and keep only the Abstract's single line that the protocol
"leaves room for one." It is the only element in the paper that is (a) explicitly not built and
(b) not a trust property a v1 reader must absorb to trust the system. The gate is orthogonal to the
paper's actual thesis — rebalancing leverage between author and publication — and that argument
survives with one sentence of headroom and no mechanism. Dropping the third-gate paragraph costs the
draft nothing; keeping it is the one piece of speculative scope-creep in an otherwise disciplined
paper. Cutting the detailed description removes the one piece of speculative
scope-creep from an otherwise disciplined paper, and it dissolves the tension I raised in Critical
Reading 4 — you cannot be accused of re-opening the deanonymization question if you are not
specifying a payment mechanism in the first place. When the gate is built, write it then.

Secondary trims, if you want them: (a) the pseudonymity caveat — "an option the protocol permits,
not a promise it makes" — appears four times (Abstract, §1, §2, §7). It earns exactly one home (in
§2, where identity lives) plus one echo in the Abstract; delete the other two. (b) The aspirational
closer of §1 ("There is a future for online publishing in which...") restates the plurality idea the
introduction already established; it can be tightened to a single sentence or dropped without losing
the argument. Neither of these is load-bearing; the payment gate is the one genuine cut.

## Sources

Positions I am grounding in (documented, not invented): Vitalik Buterin, "Make Ethereum Cypherpunk
Again" (Dec 2023) and the d/acc essay (Nov 2023) — decentralization as defense, explicit limits over
fake guarantees; Weyl / Ohlhaver / Buterin, "Decentralized Society: Finding Web3's Soul" (2022) —
identity, reputation without centralization, soulbound/account-bound identity; ERC-4337 account
abstraction and Safe-as-identity — key rotation surviving underneath a stable DID; Buterin, "The
Splintering" (2021) and the plurality line of work with Glen Weyl — temporary collectives and
coordination; his writing on decentralized social and on ENS as a naming layer. Where a specific
recommendation here (e.g., cutting the unbuilt payment gate, or the exact wording of the trust-anchor
sentence) is not a documented position of mine, it is labeled inference drawn from the minimalism and
scope-discipline thread that runs through the above — the protocol should do the one thing it does
well, and say where its trust actually rests.
