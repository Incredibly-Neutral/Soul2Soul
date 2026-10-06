---
section: threat-model
actor: publication
protocol: soul2soul
status: drafted
last_reconstructed: 2026-09-09
grounded_in: whitepaper 04-publication-governance.md, 07-domain-resolution.md, 06-website-hosting.md
---

# Threat model — the publication

> **Frame.** The publication is the inverse of the author. The author is a pseudonym that
> transport can keep off the network; the publication is **public and nameable by nature** —
> a brand, a repo, a social presence, owners who run it. The state does not need to
> deanonymize a publication; it needs to **pressure the people and the infrastructure it
> depends on**. So this section is less about anonymity and more about **legal exposure,
> coercion-resistance, and the naming layer**. It also owns the deliberate scoping decision:
> **this version is fully stoppable by design; a fork is the intended path to
> uncensorability.**

## What the protocol actually guarantees

1. **Collective authority, no single owner.** A publication is a **Safe (multisig)**, not a
   person holding credentials. No single signer can act for it; changes need **quorum**. The
   guaranteed property: *no one individual's goodwill or absence can change what the
   publication is.*
2. **Three governed things, all behind the same quorum.** Who may publish (authors admitted),
   what configuration the site runs under, and how the site is built (templates/design).
   **Changing the codebase is itself a governance act** (DR-4.12) — a redesign or new template
   requires the same collective decision as admitting an author. There is **no privileged
   path** to change what a future render produces.
3. **Rules are public and auditable.** Grants and revocations are recorded; anyone can verify
   current permission state. Nothing changes silently, and nothing changes alone.
4. **Content is content-addressed and self-verifying — but not self-preserving.** The rendered
   site is content-addressed (IPFS/Filecoin), so no single host can silently alter the bytes, and
   integrity can be checked against the signed record. **Persistence is not automatic:** content
   survives only as long as someone actively maintains it — pinning, running warm storage,
   paying for retrieval. The warm-storage/cold-backstop split (Component 6) is a *maintenance*
   decision, not a guarantee. Stop the upkeep and the archive drifts and eventually disappears.
   The honest claim: *content cannot be silently altered, and can persist while someone chooses
   to keep it; it does not persist on its own.* (Distinct from the naming layer — see below.)

## The naming layer — the fragile surface

**Separation that matters:** S2S separates *content* (content-addressed — no single host can
alter the bytes, but persistence depends on active upkeep) from *naming* (fragile —
**exactly as censorable as DNS**). Blocking the name blocks the readers while the bytes stay
safe. The state does not need to take the content down; it needs to make the name
unresolvable.

- **ENS resolution is mandatory, with no L1 fallback** (DR-7.2/7.6). Path: `.limo` DNS gateway
  → L1 ENS → **CCIP gateway** (`ccip.transport-union.dev`) → L2 records → IPFS gateway. Kill
  any hop and discovery dies.
- **The CCIP gateway is a single service** (documented `[GAP]`) — a single point in the read
  path, and compellable.
- **DNS gateways (`.limo`/`.link`) are DNS** — jurisdiction-controlled; ISPs/national firewalls
  can block the gateway domain, which blocks readers even though the bytes survive.
- **`soul2soul.eth` is one root** behind a controller Safe that can `reclaimParentDomain` — a
  protocol-level lever over every publication's name (the biggest overclaim "unowned" currently
  glosses over).

**Mitigation — self-owned parent domain (built):** a publication that owns its own parent
domain removes the `reclaimParentDomain` lever; the controller Safe can no longer touch that
name. The state must then attack each name/owner individually. Residual: the name is now
**general-DNS-seizable** per jurisdiction (a `.com` via registrar, a national TLD trivially).
And the gateway dependency is **contingent, not structural**: it exists only because browsers
don't natively resolve `.eth`; as native resolution + ENSv2's Universal Resolver land, the
DNS-gateway hop disappears. Until then, the single CCIP gateway should be made redundant.

## Pressure on owners / operators

- **Legal liability for content.** Owners are nameable and reachable; a hostile state goes
  after the *people*, not the bytes. Not solvable by any protocol.
- **Compelled signing.** The Safe is a multisig, so the state's play is to coerce **enough
  signers to pass quorum** — order an owner to sign a retraction, a config change, or a
  malicious renderer. Quorum makes this expensive but not impossible; it scales with signer
  count, jurisdiction diversity, and key custody.
- **Key seizure of owners' devices.** The author-side machine-custody problem, multiplied
  across every signer. One seized laptop = one owned vote.
- **Doxxing / harassment of owners.** The real way independent outlets get silenced: operators
  self-censor because their real lives are attacked. No protocol touches this.
- **Capture / buying an owner.** A coerced or bought signer is a live governance backdoor
  (the "nobody is bought" claim is about *influence*, not traceability).
- **Compelled disclosure of who the owners are.** Safe signers are addresses on-chain, and a
  public publication's operators are discoverable in practice.

**Anonymous owners — possible, with a trade.** A multisig lifecycle (deploy, sign, propose) is
just RPC/bundler traffic; reach it through Tor and the on-chain addresses never correlate to
owner IPs. A Safe record shows addresses, not names. Residuals: **three connection points, not
one** (Safe{Wallet} UI session, wallet-extension RPC, and the bundler — "Tor to RPC" must cover
all three); the **on-chain owner link is forever** (one correlation leak collapses the
pseudonym); and **the decision trail is public** — every governance change is on the record, so
a persistent observer of the record is a persistent observer of the owners even when no name
is ever written down (a decision pattern is a fingerprint). And the **anonymous-owner ↔
trusted-publication tension** — a publication that wants readers, partners, or legal defense
pays a real cost for anonymous operators (framed as sock puppets or astroturf; who answers a
court challenge?).

## The archive — persistence is maintenance, and historical copies are not authenticated

Two related limits on "the content survives":

- **Keeping content alive requires upkeep.** Nothing in the protocol re-pins or re-warms
  storage on its own; if no one maintains it, the archive drifts and eventually disappears.
  This is a *labor and money* dependency, not a guarantee.
- **A third party can archive, but not authenticate.** Anyone may maintain an archive of past
  versions, keeping old content alive on a distributed storage network. But that path is
  **not authenticated by the publication's name**: the domain corresponds to signed metadata
  for the *current* version, not for historical copies. So old content may survive, but as a
  faithful-but-unsigned copy, not as something the name vouches for.

## The infrastructure layer (third-party dependencies)

- **GitHub as the repo host** (Component 4) — the publication's config/templates live there; a
  compellable private company. Pressure on the repo = pressure on the ability to rebuild.
- **Safe{Wallet} / `app.safe.global`** — the governance UI is a hosted third-party service;
  compellable. (Not the authority — the Safe on-chain is — but a soft dependency.)
- **Base (L2) centralization** — the site root lives on Base, whose **sequencer is run by
  Coinbase**; the L2 records contract is at Coinbase's mercy for sequencing.
- **IPFS/Filecoin retrieval gateways** — content survives, but *delivery* depends on providers
  who can be pressured or blocked.
- **The verification extension** — readers verify the embedded proof via a browser
  extension/plugin; the extension store/vendor is a soft chokepoint that can be delisted.

## Time is the adversary (publication is less pseudonymous than the author)

The author is one pseudonym with one anonymizable hop. The publication has **co-owners, each
with multiple connection points** and a **nameable public presence**. Persistent, long-duration
observation erodes any operational secrecy: publish cadence, the accumulating on-chain record,
the growing provenance corpus. The protocol makes individual deanonymization hard; it does not
make persistent attribution hard. This asymmetry is **structural, not fixable by design.**

## The deliberate scoping decision

> **This version is fully stoppable by design.** It optimizes for ownership, independence, and
> resilience of content and authorship — **not** for adversarial uncensorability. Publications
> in this version are intended to be stoppable (institutionally and at the naming layer). The
> escape hatch is the **fork**: anyone who wants a fully uncensorable variant — anonymous
> owners, throwaway identities, no naming dependency — is free to build it. The guarantee is
> about **who controls the content, not who can stop the institution.**

## Scope lines (A/B/C)

- **A — claimed:** collective authority (no single owner); governed codebase changes (no
  privileged path); public/auditable rules; content cannot be silently altered
  (content-addressed); no single paymaster.
- **B — partial, scoped:** naming resilience (self-owned parent domain, multi-gateway
  redundancy, native `.eth` resolution over time); governance under coercion (diverse,
  custody-hardened signers); retrieval (redundant gateways); **content persistence (only
  while someone maintains the archive)**.
- **C — explicitly out of scope, named and deferred:** owners' legal exposure (they run a
  public, nameable publication); the **controller Safe's `reclaimParentDomain` root lever**
  (a protocol-level authority that can affect every publication); Base/Coinbase sequencing;
  GitHub / Safe-UI compellability; and **full uncensorability** (fork territory, not this
  version).

## The two-state split

- The **hostile state** (no courts, surveillance, arrest): the naming layer and owner doxxing
  are its natural levers; the protocol's collectivity slows but does not stop them. Anonymous
  ownership + Tor is the strongest (discipline-costly) counter.
- The **rule-of-law state** (compelled disclosure *through courts*): here the protocol can
  claim more — no single owner to compel, no privileged change path — but a court order aimed
  at the *people* (signers, operators) is not defeatable by design.

## The honest one-liner

> **The protocol guarantees who controls the content and that no one person controls the
> publication; it does not guarantee that the institution, its owners, or its name cannot be
> stopped, nor that the content persists without upkeep.** Stoppability is a declared property
> of this version; uncensorability is a fork.

## Status
- Drafted. Next: merge with the whitepaper Publication section + reader input via Neal
  (GLM 5.3).
