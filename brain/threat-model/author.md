---
section: threat-model
actor: author
protocol: soul2soul
status: drafted
last_reconstructed: 2026-09-09
grounded_in: whitepaper 00-introduction.md, 01-content-authoring.md, 08-authenticity-provenance.md
---

# Threat model — the author

> **Frame.** The author is a **pseudonym, not an anonym** — and the difference is structural,
> not cosmetic. The Safe address is public forever (on-chain and in every page's provenance,
> Component 8), so transport can never hide *who* the pseudonym is. Transport only ever
> breaks one link: **IP → pseudonym → person.** Every claim below is scoped to that link, and
> to the honest limits we cannot design out.

## What the protocol actually guarantees

1. **The publication is not required to know the author's name.** The publication records
   authors **by Safe address**; a name is not required and not automatic. In most working
   relationships the publication will know the author personally anyway — that is normal and
   fine, since the guarantee is not about hiding from the people an author chooses to work
   with. The point is structural: the record holds no name it could extract, so **no party the
   protocol touches** is in a position to expose one.
2. **The authoring account is funded only for protocol fees, not fiat-identified.** The
   account holds funds — enough to pay protocol fees (gas + per-publish/render) — but
   nothing in the protocol requires it to be funded through any fiat on-ramp. An author who
   chooses not to connect one leaves **no payment trail welded to the identity**. This is
   the single strongest pseudonymity property in the design, and it rests on the scope
   decision: **on/off-ramps are out of protocol scope** (monetization is a separate path;
   the protocol touches only in-protocol value).
3. **Key custody is on the author's own machine**, **encrypted-at-rest** (Electron
   `safeStorage` / OS keychain — Track A, done) rather than plaintext plugin settings
   (DR-1.4's accepted limitation, now closed).
4. **A stable pseudonymous reputation chain** — key rotation swaps the Safe's signers
   *underneath* the same DID, so past-signed work resolves to the same author forever.
   Reputation is possible; permanence is its price.

## The transport traces (what actually leaks, and who sees it)

The author's device touches the network at three points in the publish flow:

| # | Action | Who sees the author's IP | Design response |
|---|---|---|---|
| 1 | **Content-item upload → IPFS/Filecoin** | storage provider | **Eliminated:** the neutral generator uploads the item (it already uploads the rendered site tree, Component 6). |
| 2 | **Deal/append tx → RPC/bundler** | the chain records the Safe address forever; the author's **IP** is already off it | **Already off the author:** the UserOperation is signed by the Safe but **broadcast by the paymaster/bundler's node** (ERC-4337). |
| 3 | **Render trigger → generator** | the render service | **Eliminated:** render is **chain-driven** — the generator watches the publication contract for a new append (carrying a `render:true` intent flag) and renders automatically; the author never calls it directly. |

**The resulting principle:** *the author's device makes exactly one network connection in the
entire publish flow, and that connection is the anonymizable one* — submitting the signed
UserOperation to the paymaster/bundler. Every public, identity-bearing write (upload, deal
tx, root write) is pushed onto the PKP/relay layer, off the author's IP.

## Residuals — named, not hidden

These cannot be designed out. The protocol's honesty lives in stating them:

1. **The pseudonym is public forever** — Safe addr on-chain + in every page's provenance.
   Findable, always. (The price of the reputation chain; a throwaway-identity variant is a
   fork, not this version.)
2. **Time is the adversary.** Transport defeats a *one-off* observer, not a *persistent* one.
   Long-duration monitoring (publish cadence, timing/volume fingerprints, the accumulating
   corpus) erodes any pseudonym. **The longer the listening, the weaker the pseudonym** — a
   property of stability, not fixable by design.
3. **Compellable relays.** The paymaster/bundler/gateway each see *something* and can be
   subpoenaed. The design removes the author's IP from most of them; it cannot remove all of
   them from legal compulsion.
4. **The machine and the person are the custody.** The device holds the key, the plaintext,
   and the history. Seize the machine (or compel the person) and the pseudonym is gone — the
   rubber-hose end no protocol touches.
5. **Reputation is a stylometric surface.** A long chain of distinctive work is a fingerprint;
   the more reputation you build, the more text exists to match you to any sample. Reputation
   and anonymity **actively trade off**.

## Money (in protocol: fees only; on/off-ramps out of scope — declared, not hidden)

The protocol operates entirely within its own value domain. **Authors pay protocol fees**
(gas + per-publish/render) in crypto from the authoring account — this is the answer to "who
pays for the machinery," and it is what makes the account funded but not fiat-identified.
**On-ramps and off-ramps are explicitly out of protocol scope**, as is monetization / author
compensation (Component 2: "encryption here is an ownership boundary, not a paywall"). How an
author's in-protocol value relates to fiat identity is outside the protocol's guarantees — a
matter of the author's own trust network.

A documented use-pattern, *not a feature* — the trusted courier:

- The trail can run **publication wallet → a trusted relation's off-ramp in a friendly
  jurisdiction → "another channel" → author**, dead-ending at the relation. The protocol
  neither provides nor depends on it; it merely permits it.
- **Residuals of that pattern:** it moves the single point of failure to **one trusted,
  compellable human**; "friendly jurisdiction" is a geopolitical variable, not a constant
  (MLATs, banking-secrecy erosion); the publication→relation on-chain link is public forever;
  recurring off-ramping is what AML/CTF flags; it doesn't scale to a cooperative.
- **The fee residual, honest:** funding the fee wallet from a KYC'd exchange deanonymizes;
  recurring on-chain fee patterns are a permanent correlation surface. Smaller than a
  compensation rail, but the same long-duration-tracking weakness.
- **And the deep one:** a courier pattern solves the *trace*, not the *influence*. If a
  publication is funded by one party, the authors are still effectively bought regardless of
  how the money moves. No transport or off-ramp design touches funding independence.

## Scope lines (A/B/C)

- **A — claimed:** publication never requires the name; protocol-fee-only funding with no
  required fiat on-ramp; self-custodied encrypted keys; pseudonymous reputation chain;
  content integrity; author IP removed from upload, deal, and render.
- **B — partial, scoped:** transport anonymity (only if the author runs the anonymizing layer
  for the one residual hop); persistent-attribution resistance (only while the author accepts
  the reputation/attrition trade).
- **C — explicitly out of scope, named and deferred:** the machine/person being seized or
  compelled; stylometric matching over a long career; and **on/off-ramps and author
  compensation** (a trust-network matter, not a protocol feature).

## The two-state split

The adversary is **not one "state."** Two very different ones demand different responses:

- The **hostile state** (surveillance, arrest, no court protects you): the protocol's
  transport + pseudonymously-funded-identity design is built for this, and it can only go so
  far (the residuals above are its ceiling).
- The **rule-of-law state** (compelled disclosure *through courts*, which even a free press
  faces daily): here the protocol can claim more — no name on record, no required fiat rail —
  but it cannot and should not pretend to defeat a court order aimed at the *person*.

## The honest one-liner

> **The protocol removes the rails between the author and the pseudonym; the author owns the
> residual risk of being a person.** It makes no claim to make anyone unbuyable, unseizable,
> or unidentifiable forever.

## Status
- Drafted. Next: `publication.md`.
