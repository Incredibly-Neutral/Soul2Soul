---
title: Soul2Soul — A Peer-to-Peer Publishing System
status: draft
date: 2026-09-07
tone_model: Bitcoin whitepaper (problem → solution once → parts with conditions → failure modes → security condition)
implementation: intentionally excluded — reference implementation documented separately in the component docs (00–08)
---

# Soul2Soul: A Peer-to-Peer Publishing System

## Abstract

A purely peer-to-peer version of publishing would allow a group of writers to publish together
without any single party owning the press. Digital signatures give each author cryptographic
ownership of their work and make the provenance of a page checkable by anyone, but the main
benefit is lost if a trusted third party is still required to control the means of production —
the server, the archive, the byline. We propose a solution to this problem using a peer-to-peer
network. The network renders and publishes content by executing open, transparent code bound to a
key that no single party holds, so that no author, no publication, and no platform can act
unilaterally on anyone else's behalf. The rules are enforced by code and by a public record, not by
an operator. As long as a majority of nodes are honest, they will produce the valid output and
outpace any attacker. The network itself requires minimal structure. Messages are broadcast on a
best-effort basis, and parties can leave and rejoin at will, accepting the current record as proof
of what happened while they were gone.

## 1. Introduction

Publishing online has come to rely almost exclusively on trusted third parties owning the means of
production. To publish together, a group of writers must either accept a platform's terms — which
can change or end without them — or run their own server, which places the site, the archive, and
everyone's work in the hands of whoever holds the credentials. Both arrangements make one party's
continued participation conditional on another party's goodwill.

That asymmetry does not stay administrative. When leaving a publication means leaving your work
behind, the cost of disagreement is set by someone other than yourself, and everyone inside adjusts
accordingly. Pieces that would strain the house line are not filed rather than rejected. Writers
whose instincts fit find their path smooth and stay; those whose instincts don't encounter friction
they cannot name and leave for reasons they call personal. Each individual decision is reasonable.
The aggregate is a publication that speaks with one voice and can point to no instance of having
enforced it, staffed by people who sincerely believe what they write. Uniformity arrives without
anyone choosing it, and cannot be distinguished from agreement.

This is not a failure of any particular platform. It is the inherent weakness of the trust-based
model: whoever controls the press also controls the cost of dissent. Completely non-reversible
publishing is not really possible under that model, because the controlling party can always mediate
disputes over what appears and who may leave with the archive. The cost of that mediation limits who
will associate at all, and there is a broader cost in the loss of the ability to publish under terms
that are temporary, explicit, and equal.

What is needed is a publishing system based on cryptographic proof instead of trust, allowing any
two willing parties — an author and a publication — to associate directly, cooperate temporarily,
and part without negotiation. In this paper we propose a solution using a peer-to-peer network that
generates the publication's output without any party owning the generator. The system is secure as
long as honest nodes collectively control more of the network than any cooperating group of
attacker nodes.

## 2. Content Ownership

We define a content item as a signed object. Each author publishes an item by signing its public
metadata — its author, its type, a hash of its content — and storing it so that the signature is
bound to the content. Anyone can verify the chain of ownership: the signature proves who wrote it
and that it has not been altered, because any change to the content changes its hash and breaks the
signature.

The problem, of course, is that a publication cannot verify, from a signature alone, that the author
did not later republish the same item elsewhere, and an author cannot verify that a publication will
not alter or withhold the item once granted. A common solution is to introduce a trusted central
authority — the platform — that mediates every interaction. The problem with this solution is that
the fate of the entire association depends on the party running the platform, with every interaction
having to go through it, just like a bank.

We need a way for both parties to know the true state of an agreement without trusting the other.
For our purposes, the recorded state is the one that counts; later attempts to change it are
detected rather than accepted. The only way to confirm the absence of a change is to be aware of all
changes. To accomplish this without a trusted party, grants and revocations must be publicly
announced, and we need a system for participants to agree on a single history of the order in which
they were received. The author needs proof that, at the time of each grant, the network agreed it
was authorized; the publication needs proof that the item is what the author signed.

## 3. The Record

The solution begins with a shared record of state. A record works by collecting the changes that
matter — who may publish, whose content may be used, what the site points at — and chaining each
change to the one before it. Each new state includes the previous state in its derivation, forming a
chain in which each addition reinforces the ones before it. Changing an earlier state would require
changing every state after it, which the network will not accept.

Not everything belongs in the record. Content itself is large, private, and expensive to store; the
record holds only what must be agreed upon: the permission state and the pointer to the current
output. Content lives elsewhere, addressed by its hash, so that anyone can fetch and verify it
without trusting the party that stored it.

This split is the first appearance of a principle that recurs throughout the system: capability is
open, authority is collective. Anyone can store and read content; only the designated parties can
change the record.

## 4. The Generator

To make the record enforceable without a trusted party, we need a way to turn permission state into
published output without any party owning the press. We propose an autonomous generator: open,
transparent code bound to a key that no single party holds, executed by independent nodes. The
generator reads the record, decrypts the content it is permitted to decrypt, renders the page, signs
it, and updates the pointer to the current output — but only when the recorded rules pass.

The key property is that no party — not the author, not the publication, not even the generator's own
developers — can substitute different logic or extract the key. The code is published and auditable;
a valid signed output is the product of that code and nothing else. This is what makes the publisher
neutral: the rules are enforced by code and recorded state, not by an operator. There is no owner to
be captured, pressured, or turned.

The generator also solves the problem of representation in collective decision-making. The
alternative — one-account-one-vote — could be subverted by anyone able to allocate many accounts.
Here the majority is represented by the chain of recorded state, which carries the consent of the
parties the rules designate. If a majority of nodes are honest, the honest output is produced and
any competing output is outpaced. To change a past state, an attacker would have to produce a
competing record that outruns the honest one.

## 5. The Network

The steps to run the network are as follows:

1. An author writes and signs a content item, keeping cryptographic ownership of it.
2. The item is offered to a publication under explicit terms.
3. The publication's designated parties accept or reject; grants and revocations are recorded.
4. On publish, the generator reads the record, decrypts what it may, renders, signs, and publishes.
5. The new output pointer is written to the record, and the site resolves to it.
6. Nodes and readers accept output only if its provenance verifies and the recorded rules pass.

The parts of the system are not independent; each depends on a condition, and each has a way to
fail. Reading down the middle column gives the trust model in one pass. Reading the third gives the
honest limits — the part that makes a reader believe the rest.

| Part | Works if | Fails to |
|---|---|---|
| **Authoring** | the author's key stays theirs alone and revocation is enforced at the mechanism, not by request | an author who cannot actually leave |
| **Agreement** | terms are legible to both sides and machine-enforced, not merely recorded | a document nobody can act on |
| **The generator** | the code is open, the key is bound to that code, and no single node can produce a valid render | a printing press with an owner again |
| **Upgrades** | upgrades require the designated parties and cannot be pushed silently | developers as the new central party |
| **Output** | a reader can verify without trusting the publisher | provenance you have to take on faith |

## 6. Incentive

By design, a publication that joins the network gives up unilateral control over its own archive.
Why would a publication accept less control than a platform gives it?

The reason is that the control is not the craft. The person who commissions the piece is currently
also the person who can end your career there — the coordinating role and the coercive role are
welded together. What the network does is separate them: coordination stays in human hands, while
the leverage is handed to a mechanism with no interests. Editorial judgment survives entirely. What
goes is the leverage, which was never the craft.

This buys a publication things it could not otherwise have:

- **Recruitment.** Writers who would never sign over an archive will contribute to something they
  can leave.
- **Temporary coalitions.** A small publication can assemble names it could never retain.
- **Credible unanimity.** A line held by writers who could have walked carries weight a captive one
  cannot.

The incentive also keeps the network honest. A party powerful enough to attack would have to choose
between using its power to coerce others or using it to publish under terms it can defend. It ought
to find it more profitable to play by the rules — which let it attract the writers the coercive
model repels — than to undermine the system and the validity of its own publication.

The honest losses should be conceded: exclusivity, lock-in, and the ability to guarantee a funder a
stable line. Institutions where the fixed narrative is the product are not the adopters. The network
is built for new publications, investigative collectives, and issue-based coalitions — who mostly
lack that leverage already and would trade it for the ability to attract people.

## 7. Verification Without Trust

It must be possible to verify a page without running anything. A reader needs no key, no wallet, no
node: the page carries its own proof. The signature covers the page's content, so changing a single
character breaks it. The proof names who wrote it, who published it, and that the neutral generator
produced it under the recorded rules. Verification is client-side and self-contained; the document
proves itself.

This is reliable as long as honest nodes control the network, but more vulnerable if the network is
overpowered by an attacker. While network nodes can verify for themselves, a reader relying on the
embedded proof can be fooled for as long as an attacker can continue to produce a competing output
that the reader cannot distinguish. The defense is the same as in the generator: the reader can
always fetch the full record and the content directly, and any reader who verifies against the
record rather than taking the page on faith is safe. Parties that receive many pages will still
want to verify against the record for more independent security.

## 8. Separation and Combination of Authority

Although it would be possible to model each article as an indivisible grant, it would be unwieldy to
require a separate agreement for every use. To allow value to be combined and separated, the system
keeps two concerns apart that are usually welded together: who may *decide* and who may *act*. A
publication coordinates editorial and promotional decisions collectively; the generator acts on them
without owning the content. An author grants access to a specific item under specific terms; the
grant can be revoked without negotiation, and the author's other work is untouched.

It should be noted that fan-out is not a problem here. A page may draw on several items, and those
items on many more; there is never a need to extract a complete standalone copy of an item's
history, because the record holds the current state and the content is addressable by its hash.

## 9. Privacy

The traditional model achieves privacy by limiting access to information to the parties involved and
the trusted third party. The necessity to record the essential state publicly precludes this
method, but privacy can still be maintained by breaking the flow of information in another place: by
separating what must be public from what must not. What is recorded is the permission state — who
may do what, and what the output points at. What is not recorded is the content itself, which is
encrypted and revealed only transiently inside the generator, and only when the recorded rules
pass. Anyone can see that a page exists and who authored it; no one who lacks permission can read
what it contains.

## 10. The Security Condition

We consider the scenario of an attacker trying to produce a competing output faster than the honest
network. Even if this is accomplished, it does not throw the system open to arbitrary changes — it
cannot create authority out of thin air or take content that never belonged to the attacker, because
readers and nodes will not accept output whose provenance does not verify and whose rules did not
pass. An attacker can only try to change its own past actions to take back something it recently
granted.

The security of the system rests on a single, explicit condition, and honesty about the bound is
worth more than any claim of invulnerability: the output is trustworthy as long as honest parties
control the network, and the probability of a slower attacker catching up diminishes as the honest
record advances. The claim is not that no one can attack; it is that an attack cannot succeed
cheaply, silently, or for long.

## 11. Conclusion

We have proposed a system for publishing without trust. We started with the usual framework of
signed content, which gives authors strong control of ownership and readers strong proof of
provenance, but is incomplete without a way to make agreement enforceable without a controlling
party. To solve this, we proposed a peer-to-peer network using an autonomous generator to record a
public history of permission state that quickly becomes impractical for an attacker to change if
honest nodes control the network. The network is robust in its unstructured simplicity. Parties work
all at once with little coordination. They do not need to be identified, since output is produced by
open code rather than routed through any particular place, and parties can leave and rejoin at
will, accepting the record as proof of what happened while they were gone. They vote with their
participation, expressing acceptance of valid output by relying on it and rejecting invalid output
by refusing to.

The consequence is a different arrangement of ownership: association that can be genuine and
temporary at once, where departure costs nothing structural and unanimity, when it occurs, is
therefore worth something. What is made durable is not disagreement but the meaning of agreement.
Non-conformity is affordable, and because it is affordable, pluralism is durable.

---

## Notes (editorial scaffolding — not part of the paper)

- **Word count:** ~2,100. Bitcoin is ~3,500; this reads deliberately tight. Expand toward 3,500 if
  desired by deepening §1 (mechanism), §4, or §6, or leave short per the "concise, short" brief.
- **Implementation excluded** per the brief; each section maps to a reference-implementation
  component doc for the separate implementation document:
  - §2 Content Ownership → component 2 (content-item schema)
  - §3 The Record → component 4 (publication governance)
  - §4 The Generator → component 5 (neutral renderer)
  - §5 The Network → components 1 (authoring), 3 (gate), 6 (hosting), 7 (domain resolution)
  - §7 Verification Without Trust → component 8 (authenticity & provenance)
- **Thesis placed** in §11 (non-conformity is affordable → pluralism is durable; the narrower form:
  what is made durable is the *meaning* of agreement). It is not on the label, but present.
- **Bakhtin / monologic** kept out of the paper body (orientation-only), per open question Q1.
- **Security condition** kept as a short principled section (§10) rather than Bitcoin-style math,
  because there is no proof-of-work race to compute; collusion is answered plainly instead.
- **Editor framed as ally** (§6): publication is the customer; concedes exclusivity/lock-in/stability
  honestly and names the adopters (new publications, collectives, issue-based coalitions).
