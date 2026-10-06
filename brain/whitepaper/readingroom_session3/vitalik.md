# Vitalik — reading-room note (round 3)

Scope note: I read only my round-2 note and the current v1.md draft. I did not read the
session-2 notes, so any overlap with them is coincidence, not borrowing. Section numbers below
refer to the current draft (Abstract, then §1–§8). This is a fresh critique that builds on round 2:
where the draft has fixed something I flagged, I say so; where it hasn't, I sharpen; and I add
criticism that only became possible because of what the revision introduced.

## Verdict

The draft has moved decisively in the direction round 2 pushed it, and it is now genuinely close to
publishable. The abstract no longer carries the "machinery with no interests" overclaim, the trust
anchor is no longer invisible, the Verification section no longer pretends to be offline, and the
cost side — which round 2 flagged as a silent hole — now has a home in a dedicated Money section.
The single most important repair is the suppression-versus-forgery reconciliation in §7, which
resolves the exact tension round 2 called the "strongest sentence contradicted by the most honest
paragraph": the paper now says plainly that the abstract's "no single party can produce a valid
rendering alone" claims the no-forgery reading, not the no-suppression one. That is the cypherpunk
instinct done right, and it is rare.

What remains is a smaller, more surgical set of problems, and they cluster in two places: a few
overclaims that survived the abstract rewrite but live on in the body (§1's "no interests," the
abstract's "threshold rather than a single owner"), and the load-bearing assumptions that the paper
now names but still refuses to scope to their strength (the sealed runtime, the node network, the
record's upgradeability). The paper keeps doing the hard, honest work of naming its limits; the last
mile is saying *how strong those limits are* and *what happens in the gap before a limit bites*.
Verdict: near-ready; the remaining fixes are scoping and gap-closing, not architecture.

## What resonates

These land on documented positions of mine (from the sources in my round-2 note — the
cypherpunk/defense line of work, account abstraction, and the naming/path discipline):

- **The new scoping line in the Abstract — "It is not a tool for protecting journalists from a
  hostile state."** This is the explicit-limits posture I keep insisting on, stated at the very top
  where it can't be missed. It tells the reader what the protocol is *for* (rebalancing leverage
  between two private parties) and — just as importantly — what it is not for. It should stay, and
  §1's "courts can compel the parties" is the right companion.
- **"An editorial line held by people free to leave means something a captive one cannot."**
  (Abstract, echoed in §1 and §3.) The whole d/acc framing: decentralization as defense against a
  power imbalance, not as a promise of immutability. "The line is held by position, not argument"
  (§1) is the same idea made vivid.
- **Identity that survives key rotation.** §2 still carries "an identity that cannot survive a key
  rotation is an archive hostage to a single secret," and §2's "the account itself is public... the
  pseudonym is findable, not hidden" is honest about what pseudonymity does and does not deliver.
  This is the Safe-as-identity / account-abstraction model stated correctly.
- **The suppression-versus-forgery distinction in §7.** "Suppression is a public act a community may
  choose within the law; forgery would require the whole protocol to collude in a misrepresentation
  that is public at the same time, which defeats itself." This is a subtle and true distinction, and
  it is the single best paragraph in the draft. The admission that this is "not a guarantee to lean
  on," with child pornography named as the case where a community will want the lever pulled, is
  exactly how governance should talk about itself.
- **The upgrade-path honesty.** §7's "a version with no upgrade path... is always one fork away,"
  and "we do not recommend running an upgrade-free fork until this protocol has been battle-tested,"
  frame the upgrade path as maturation rather than control. This tracks my documented preference for
  explicit, reversible, visible governance over fake immutability.
- **The Money section's restraint.** §6's "three rails and nothing more" — a destination, a
  division, a disclosure mechanism — refuses to design the business model for the user, which most
  teams would have shipped as the headline.
- **The naming/path discipline.** §3 scrutinizes DNS (seizure, poisoning, hard to resolve) instead
  of pretending to fix it. The distinction between a protocol making the name the publication's own
  and it not making the *path* immune is the correct scoping.

## Strongest criticisms

1. **"Leverage passes to machinery with no interests" survived in §1, and §7 now contradicts it
   more loudly than the old abstract did.** Round 2 flagged the abstract's version; the rewrite
   removed it from the abstract but left the same sentence in §1: "Coordination stays in human
   hands; the leverage passes to machinery with no interests." The mechanism is now *worse* than it
   was in round 2, because §7 is more explicit than before: governors can adopt code that cuts an
   author or publication off, and the neutrality claim is conceded to be no more than
   no-forgery. So the strongest sentence in the introduction is now contradicted by the most honest
   paragraph in the paper, in the same paper, one section away. Machinery has interests — it has
   governors, and the code they can steer. What the design actually delivers is machinery with no
   *stake in the parties' business with each other*. Fix §1 to say that, and the sentence stops
   quietly retracting when the reader reaches §7. (This was my round-2 fix #1; the abstract got it,
   the body didn't.)

2. **The trust anchor is now named but never scoped to its strength — and §7 describes two
   different trust models without reconciling them.** Round 2's core criticism was "name the TEE and
   the node consensus." The draft did exactly that, which is progress. But it stopped at naming, and
   it did so with two sentences that point at *different* architectures. §7 says the private part of
   the protocol key "exists only inside those actions" and "the generator runs in a runtime sealed
   against outside interference" — that is a single-TEE model. Two sentences later: "No single party
   holds the protocol key: it exists as shares across a distributed network of independent nodes,
   and is used only when enough of them act together" — that is a distributed-threshold model. The
   reader cannot tell whether the guarantee rests on one sealed enclave or on quorum of independent
   operators, and these have very different trust and failure properties. More importantly, the
   paper never states the load-bearing sentence that would let a reader *evaluate* the claim: the
   "no single party can produce a valid rendering alone" guarantee is exactly as strong as (a) the
   integrity of the sealed runtime and (b) the genuine independence of the node set — and no
   stronger. That sentence, which my round-2 note said belonged in the paper, is still absent. Naming
   the mechanism is necessary; scoping the guarantee to it is what makes the claim testable.

3. **The Money section expanded, so the deanonymization admission is now mandatory, not optional —
   and it is still missing.** Round 2 recommended cutting the unbuilt payment gate; the draft instead
   made the opposite editorial choice and built it a full section. That is a legitimate call, but it
   raises the stakes: a payment gate that is actually described, rather than gestured at, owes the
   reader the admission that a rail that pays a person must settle somewhere real. §6 says the gate
   "answers yes or no, on chain, and never holds the money," and repeats "no fiat on-ramp or off-ramp
   is required... and none is forbidden." What it never says is that *any* on-ramp/off-ramp that is
   actually used is a deanonymizer — a payment that leaves the chain must land in an account that can
   be compelled, and a payment that enters must come from one. The Abstract's "dividing a payment does
   not make money harmless" is the right instinct; it needs to be carried into §5/§6 where the gate is
   specified, as a named limit rather than an implied one. The cost side, by contrast, is now handled
   well: §6's "each participant pays for its own use" and the for-profit-fold-into-subscription /
   bring-your-own split answers round 2's "who pays for storage, rendering, gas." Credit where due.

4. **The record's upgradeability is the third hand the paper never names.** §4 says "neither party
   owns the record," which is true relative to author and publication — but §7 concedes the
   governors hold upgrade power over the module that holds the records, the same lever that lets them
   cut a publication off. So "neither party owns the record" is accurate only if "party" excludes the
   protocol's own governance. A reader who reads §4's "neither party can rewrite it" and then §7's
   governors-can-cut-off could be forgiven for feeling the two don't sit together. They do sit
   together, but the paper should say it in one clause: the record is not owned by either *party*,
   yet it is upgradeable by the protocol's governance — the same suppression caveat that §7 already
   makes for rendering. Right now that triad (author / publication / protocol governance) is implied
   but never stated, and it is the honest way to make §4 and §7 cohere.

5. **The departure-symmetry claim still lacks the one honest caveat round 2 asked for.** The
   mechanism genuinely removes the *structural* exit cost (position), which is the real achievement —
   "departure costs both sides" (§1) is true of the machinery. But social power asymmetry does not
   disappear because the keys changed: a publication with the larger audience still sets terms, and a
   star author with the larger following still does. "An editorial line held by people free to leave
   means something a captive one cannot" is true and worth keeping; it just isn't the same as "the
   sides are now equal." One sentence acknowledging that the rebalancing is structural, not social,
   would make the symmetry claim airtight instead of aspirational. This remains unfixed.

6. **The ENS path gets no scrutiny, while DNS gets a whole paragraph.** §3 spends real effort on the
   risks of DNS; §8 walks the reader through ENS as the naming layer and never applies matching
   scrutiny to ENS's own single points — the records contract, and the gateway that resolves the name
   to the CID. Round 2 flagged this and it is still open. The discipline the paper applies to the
   path ("the protocol makes the name the publication's own; it does not make it immune to the risks
   of the path it rides on") should be applied to its own chosen path with the same force. I flag the
   records-contract and the gateway as the specific single points to scrutinize; I am not asserting a
   specific exploit, and I have no documented view on the exact ENS mechanics beyond the general
   point that a naming layer has single points of its own.

## Sharpest questions

- **Which trust model is §7 actually describing — one sealed runtime, or a threshold of independent
  nodes?** The paper's two sentences describe different architectures with different failure modes,
  and the neutrality claim reads differently under each. Pick one, or say how they compose.
- **What protects an author in the window between an upgrade's adoption and the author's exit?** §7
  says governors "cannot censor silently" because a cut-off would be visible and reputational — but
  it never says what a *non-silent* cut-off costs the author in the gap before they can leave. Is
  there a lead-time or exit guarantee between an upgrade being adopted and an author being cut off?
  This was round 2's sharpest question and it is still unanswered; it is now the most important open
  governance question in the paper.
- **When an author withdraws, is the live site actually pulled, or just the *vouching* for it
  pulled?** §4 says ending an agreement is "a single act with immediate effect" and "the next
  rendering is produced without that work." But a reader visiting the domain before the next render
  still receives the page, because the ENS record still points at the old root. "A page that keeps
  circulating after a withdrawal is a copy the name no longer vouches for" (§4) and "A withdrawn work
  ... is no longer part of that state" (§3) only become true *after* a rerender — and the rerender
  requires someone with the right to set the generator in motion to actually do it. The author does
  have that right (§5, first gate), but the paper never states whether withdrawal triggers a render
  or merely enables one. If it merely enables one, there is a real (if small) window where the domain
  still serves what the author has withdrawn. This is an inference from the paper's own mechanism, not
  a documented position of mine, but it deserves an explicit sentence.
- **What does provenance show across a key rotation?** §2 establishes rotation; it never says whether
  the old signature still resolves to the same identity, or whether the record shows the same account
  under a new key. Round 2 asked this; still open.
- **How are the node operators themselves kept independent, and is that independence an incentive
  question the paper can afford to leave implicit?** The neutrality claim rests on genuine node
  independence (§7). The paper never says what makes the operators independent or what would keep them
  so if running the machinery became lucrative. This is the "who pays for the machinery" question
  answered at the level of the *operator*, not the participant. I have no documented view on a specific
  compensation design; the paper also has none, which is fine — but it should at least name that the
  independence it leans on is an ongoing incentive property, not a one-time setup.

## Suggested changes

1. **§1:** replace "the leverage passes to machinery with no interests" with the scoped version —
   machinery with no stake in the parties' business with each other. (This is round-2 fix #1; the
   abstract got the fix, the body still has the original.)
2. **§7:** reconcile the two trust sentences into one model, and add the scoping sentence: the
   "no single party can produce a valid rendering alone" guarantee is exactly as strong as the
   integrity of the sealed runtime and the genuine independence of the node set — and no stronger.
   That is the sentence that lets a reader evaluate the claim instead of taking it on faith.
3. **§7:** add an explicit treatment of the exit window — what an author can do, and how fast,
   between an upgrade's adoption and being cut off. If there is no lead-time guarantee, say that it
   is an open governance question rather than leaving the reader to assume one exists.
4. **§4/§7:** add one clause reconciling "neither party owns the record" with the governors' upgrade
   power — the record is not owned by either party, but it is upgradeable by the protocol's
   governance, with the same suppression caveat already stated for rendering.
5. **§5/§6:** carry the deanonymization admission next to the payment gate — a rail that actually
   pays a person must settle somewhere real, so building the gate re-opens the on-ramp/off-ramp and
   paymaster questions the protocol otherwise avoids. State it as a named limit, the way §7 names
   suppression.
6. **§8:** apply to ENS the same path-scrutiny §3 applies to DNS — a sentence on the records
   contract and the gateway as the naming layer's single points.
7. **§1 or §3:** add the one-sentence caveat that departure costs are structurally rebalanced, not
   made perfectly symmetric — social power asymmetry (audience, money, reputation) outlives the
   change in keys.
8. **§4:** add one sentence on whether withdrawal triggers a rerender or merely enables one, closing
   the window where the domain still serves a withdrawn page.

## What could be shortened

The abstract is long — a single ~250-word paragraph carrying both the argument and four distinct
caveats. It earns the caveats (they are why it reads as honest), but it is doing the work of an
executive summary plus a scope statement plus a partial body preview. Consider splitting it into a
short abstract plus a one-line "scope" note ("the protocol rebalances leverage between two private
parties; it is not a tool against a hostile state; it does not impose a payment model"). That keeps
the honesty while letting the abstract breathe. The pseudonymity caveat has been trimmed well since
round 2 (it now lives in §2 with a single echo in §1) and needs no further cutting. Everything else
is load-bearing; nothing here warrants removal.

## Sources

Positions I am grounding in (documented, not invented): Vitalik Buterin, "Make Ethereum Cypherpunk
Again" (Dec 2023) and the d/acc essay (Nov 2023) — decentralization as defense against a power
imbalance, explicit limits over fake guarantees, visible-and-reversible governance over fake
immutability; Weyl / Ohlhaver / Buterin, "Decentralized Society: Finding Web3's Soul" (2022) —
identity and reputation without centralization, account-bound identity; ERC-4337 account abstraction
and the Safe-as-identity model — key rotation surviving underneath a stable identity; Buterin, "The
Splintering" (2021) and the plurality line with Glen Weyl — temporary collectives and coordination;
his writing on decentralized social and on ENS as a naming layer. Where a specific recommendation
here (the exact wording of the trust-scoping sentence, the withdrawal-triggers-vs-enables point, the
exit-window framing) is not a documented position of mine, it is labeled inference drawn from the
same scope-discipline thread — a protocol should do the one thing it does well, say where its trust
actually rests, and be explicit about the gaps its own mechanism opens.
