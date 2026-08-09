---
component: content-authoring
protocol: soul2soul
number: 1
status: stable
last_reconstructed: 2026-07-15
source: reconstructed from joera↔Claude conversation history; not filled beyond what was discussed
---

# Component 1 — Content authoring (the authoring surface)

> Reconstructed for machine memory. Decision entries preserved as discussed, not
> synthesised. Thin where the record is thin. Gaps marked `[GAP]`, not filled.

## Functional description

A frontend / CMS-like experience where a contributor writes, edits, and stores content,
authenticates as themselves, and from which they trigger the protocol's downstream
actions. Its responsibilities:

- **Authoring** — write, edit, and retain content, self-custodied.
- **Authentication** — the contributor acts under a **`did:ethr` identity whose address is
  a Safe** (see below); the authoring surface authenticates via the Safe's signer.
- **Two downstream interactions** (kept distinct — see DR-1.6):
  - **the publication smart contract** — proposing/agreeing the deal & permission lifecycle;
  - **the neutral generator** — the **publish action** that hands content to the render pipeline.

There is **no single canonical frontend**, and no requirement to use any particular tool.
**Many implementations are possible** — any surface that can author content, authenticate
under the did:ethr-over-Safe identity, and emit these interactions qualifies. The
reference implementation below is *one* such surface, not the definition of the component.

## Minimum guarantee (protocol-level)

- The contributor's working copy is **local-first or self-custodied**: no third party
  need be online, or grant permission, for an author to write, edit, or retain a draft.
- The **publish action is explicit and author-initiated** — never automatic or coerced.
- **Multiple frontends must be possible** — the surface is an implementation, not a
  chokepoint. Any tool that can write content and emit a publish action qualifies.

## Reference implementation *(one of many possible)*

One implementation uses an **Obsidian plugin** as the authoring surface, leveraging
Obsidian's native **frontmatter** and **Bases** (the 1.9.0+ structured-data / `.base`
feature) for post types and structured fields. This is *a* way to satisfy the component,
chosen for being local-first and versatile — not the only way, and not part of the
protocol definition.

In the code this is **two packages**, not one:
- **`0xobsidian` (`oxo-core`)** — the base authoring-identity + core plugin layer.
- **`neutralpress`** — the richer plugin that wires authoring to the publish pipeline:
  publication lifecycle, content authoring/encryption, and **render triggering**. It's
  the front-end that deploys the per-publication contracts and passes the author
  signature into the pipeline.

**Most methods live in the shared lib** (`@s2s/soul2soul-shared`), not in the plugins
themselves — the plugins are thin front-ends over shared services (identity, protocol
info, Lit, IPFS). The two authoring packages consume shared; they don't re-implement it.

## Author identity — `did:ethr` over a Safe

The author's identity is a **`did:ethr` whose Ethereum address is a Safe (multisig), not
an EOA.** Authentication is **through the Safe and its signer.**

> **Naming note:** there is **no `did:safe` method.** This is an S2S-specific *convention*:
> standard `did:ethr`, pointed at a Safe address. Treat any "did:safe" as shorthand for this.

**Why a Safe, not an EOA (rationale chain):**
1. The **publication smart contract records the author by Safe address.**
2. With **permissionless.js + a paymaster (ERC-4337)**, `msg.sender` **is the Safe** (the
   4337 account), not the underlying EOA. So anything keyed to the EOA wouldn't match what
   the contract sees.
3. Therefore the **Safe is the author's main identifier.**

**Why a DID at all (not just the raw address):** a **signal of intent** that S2S doesn't
*only* care about on-chain identity — room for off-chain/portable semantics later. Recorded
honestly: this is currently **"a bit of a dress up,"** since the identity today is on-chain.

**Key rotation:** possible via the `did:ethr` registry contract, **but** it's more
convenient to **swap the Safe's signers** — same DID, new key-holder, no registry tx.
Practical rule: **rotate signers, not the DID.**

(The signer here is *also* the authoring key discussed in DR-1.4 — the plaintext-key note
applies to this same identity.)

---

## Decision record

### DR-1.1 — No canonical frontend; authoring surface is pluggable
**When:** 2025 (recurring, foundational)
**Decision:** S2S defines **no canonical frontend**. The authoring surface is an
*implementation* that must meet the component's function (author + authenticate under
did:ethr-over-Safe + emit the two downstream interactions); many can coexist.
**Reference-implementation choice:** an Obsidian plugin, using native frontmatter and
Bases — chosen because it is local-first and "a remarkably versatile combination," keeping
authoring self-custodied and offline-capable **without S2S building or controlling a
frontend.**
**Status:** stable / foundational. The *no-canonical-frontend* stance is protocol-level;
the *Obsidian* choice is implementation-level and swappable.

### DR-1.2 — Two independent authoring paths, not a pipeline
**When:** 2026-02-01
**Decision:** Authors may choose to work in **either** Obsidian **or** a CRDT-capable
app (candidate: **BlockNote**, ProseMirror/TipTap-based, Yjs out of the box). These are
**two independent authoring paths**, not stages of one pipeline.
**Consequence raised (unresolved):** the open problem becomes "what's the shared format
both can read/write?" Options discussed — markdown as source of truth / block-JSON as
source of truth / bidirectional transform (mdast). `[unresolved: no format chosen]`
**Note:** Obsidian already thinks in blocks (block refs, embeds); frontmatter is a
distinct map, separable from body content — which eases a future CRDT binding.

### DR-1.3 — Collaborative editing explored (y.js / CRDT)
**When:** 2026-01-31 → 2026-02-01
**Status:** explored, not committed `[GAP: no adoption decision recorded]`
**Context:** Looked at y.js for real-time collab on a single article. Possible transports
noted (y-webrtc P2P, or y-sweet/hocuspocus server-mediated); possible to store BlockNote
JSON encrypted on IPFS and only render to markdown/HTML at publish time. No decision to
build collaborative editing was recorded — it remains a candidate for the second
authoring path (DR-1.2), not a shipped feature.

### DR-1.4 — Author identity lives in the plugin; key-at-rest threat model
**When:** 2026-07-02
**Fact established:** The author `private_key` lives in **Obsidian plugin settings
(vault data) in plaintext**.
**Position taken (as discussed):** deliberately accepted as **low-stakes for now** —
it's on the author's local machine, it is *only* an authoring identity, and **no funds
are involved**. A better solution (OS keychain / encryption) is **acknowledged future
work, not a present blocker**.
**Status:** accepted-with-known-limitation. `[future work: OS keychain / encryption]`

### DR-1.5 — Publish action carries the author signature (INV-1)
**When:** 2026-07-02 (spec era)
**Fact established:** `neutralpress` passes the **author signature** into the publish
pipeline (referenced as invariant **INV-1** in the specs). The authoring surface is
therefore also where **authorship is asserted** cryptographically at publish time — the
tie-in to Component 8 (authenticity/provenance).

### DR-1.6 — Split the deal lifecycle from the publish action (two distinct interaction surfaces)
**When:** clarified 2026-07-15
**Decision:** From the authoring surface, the author interacts with **two separate
back-ends**, and these must not be conflated:

**(A) Interaction with the publication smart contract** — the deal/permission lifecycle:
- `proposeNote` (propose an item / note to a publication)
- `offerDeal` (offer a publishing deal; auto-accepts if caller is a whitelisted author or
  owner, else becomes a pending deal)
- `acceptDeal` / `revokeDeal`
- These are **on-chain transactions** against the publication module (see Component 4),
  proposed via the Safe (`safeSdk.txs.send` / a Safe transaction).

**(B) Interaction with the neutral serverless HTML generator** — the **publish action**:
- Hands finished content to the render pipeline (see Component 5), which decrypts, renders,
  signs, uploads, and anchors.
- This is **not** a publication-contract call; it targets the neutral execution environment.

**Key relationship (the reason for the split):** (A) is *often followed by* (B) — you
propose/agree a deal, then publish — **but it does not have to be.** A deal can be offered
or revoked without any render; a republish can happen without a new deal. They are
**independent lifecycles that happen to be adjacent**, not two halves of one action.
**Why it matters:** treating "publish" as one monolithic step hides the contract/generator
boundary and the fact that permission state and rendered state evolve separately.

---

## Open questions / unresolved

- **[unresolved]** Shared content format across the two authoring paths (DR-1.2).
- **[GAP]** Whether the CRDT/collaborative path (DR-1.3) is actually being built.
- **[future work]** Move author key out of plaintext plugin settings (DR-1.4).

## Cross-references
- **Component 3 (encryption)** — `neutralpress` performs content encryption (to the PKP
  via shared `LitService`) at authoring time; see that component for the `litUsageKey`.
- **Component 5 (site generation)** — the **publish action** (DR-1.6 path B) targets the
  neutral generator; that is what triggers a render.
- **Component 8 (authenticity/provenance)** — the author signature originates here (INV-1);
  bound to the did:ethr-over-Safe identity above.
- **Component 4 (governance / permissions contract)** — the **deal lifecycle** (DR-1.6 path
  A: `proposeNote` / `offerDeal` / `acceptDeal` / `revokeDeal`) executes against the
  publication module; `neutralpress` deploys the per-publication contracts and proposes
  mutations as Safe transactions.
- **Component 2 (content storage)** — the author binding on stored items resolves to the
  did:ethr-over-Safe identity defined here (Component 1 is the canonical home for it).
