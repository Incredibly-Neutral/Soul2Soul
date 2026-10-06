# Portable Byline — Convergence of Six Research Streams (CASE 1 + CASE 2)

> **Goal:** design a *mechanical path for readers to follow an author* — a portable byline
> address (likely `did:ethr`-based) plus an index of an author's work and the publications where
> it can be read. Two cases were requested; three researchers were dispatched per case, then the
> findings are converged here.
>
> **Status:** design convergence (research). Not a SPEC (nothing is built). Source reports:
> - CASE 1 (external indexer): `indexer-offchain-resolution-findings.md`,
>   `2026-09-10-external-indexer-trust-model.md`, plus the on-chain factory-surface report
>   (in-session `explore-factory-indexing`).
> - CASE 2 (author-managed on own `did:ethr`): `2026-09-10-portable-byline-case2-author-did-surface.md`,
>   `2026-09-10-portable-author-byline-resolution.md`, plus the content/provenance report
>   (in-session `explore-author-provenance`).
>
> Date: 2026-09-10. Workspace: `/home/joera/code/s2s`. Brain: `/home/joera/code/s2s/brain`.

---

## 0. One-paragraph answer

The portable byline is an **author-owned, content-addressed pointer** that resolves to an
**index of the author's work**. The author is a **`did:ethr` whose address is a Safe** (multisig,
not an EOA) — that is the byline's owner-of-record and it already exists and is portable. The
mechanical path has three parts, and the two cases are **complementary halves of it, not rivals**:

- **CASE 2 (author-managed)** provides the **authority of record** — a small, author-controlled
  byline (an `S2SRecordsModule` on the author Safe, or an author ENS node) asserting "here is my
  body of work and where to read each piece."
- **CASE 1 (external indexer)** provides the **comprehensiveness + independent verification**
  layer — a derived, anyone-can-index view of the on-chain deal/offer append-log and
  `ModuleCreated` events that reproduces the same index *without trusting the author's own claim
  or any single indexer*.
- Both sit on the **same verification spine**: the author's EIP-712 signature
  (`verifyAuthorship`), the page-level PKP Data-Integrity-Proof (`verifyProvenance`), and the
  on-chain `getDeals`/`getLatest` append-log. An index entry is authentic iff these hold, whoever
  built the index.

The recommended trust posture (from the CASE 1 trust study) is **"anyone-can-index over a
verifiable source of truth (core), with an optional Safe-governed registered index as a
convenience surface, and never a privileged indexer write path."**

---

## 1. The portable byline mechanism (the address)

**What an author "is" today (settled):** a `did:ethr` whose address is a **Safe** (4337, threshold
1, deterministic same-address on L1/L2). `shared/src/protocol/types.ts` `DidEthr`, `toDidEthr`,
`eoaOf`. The Safe is the identity that publications whitelist
(`S2SPublicationModule.sol`/`V2` `whitelistAuthor`, `genesisAuthor[genesis]`), that signs content
(`S2SPublicationModuleV2` `Entry.author`), and that gates the Lit actions (`gates.ts` `canPublish`).
There is **no DID document, no resolver, no Veramo, no EthereumDIDRegistry** — `did:ethr` is a
client-side string convention for the Safe address. (`2026-09-10-portable-byline-case2-author-did-surface.md` §a)

**There is no per-author naming or resolution anywhere in code or specs** — the whole read/write
path is keyed on `node = namehash(<publication subdomain>)`. A portable byline is therefore
**greenfield on the semantics** but can **reuse the per-node storage (C3) and the read path**
(`namehash` → `getText` → CID → IPFS) and the permissionless subdomain minting
(`ENSOpenSubdomainRegistry.registerSubdomain`). (`2026-09-10-portable-author-byline-resolution.md` §0)

**So the byline address is one of two concrete forms:**
- **Form A — author ENS node** `<author>.soul2soul.eth` (mintable permissionlessly, owner = author
  Safe), storing the byline/index under the node.
- **Form B — author Safe itself** as the locator: reader walks the author Safe's modules to find a
  records module (`getModulesPaginated` → `NAME()=='S2S Records Module'`), same pattern as INV-4's
  publication walk but keyed on the author.

Both reduce to: **a stable, author-owned string/address the reader can resolve to a content
address.** The `did:ethr:<Safe>` string is the natural human/business label for it.

---

## 2. The index of an author's work

**There is no author index and no global registry today** (confirmed by all six streams):
- `S2SPublicationModuleV2` stores an append-log **per publication**; `getDeals`/`getOffers`/`getLatest`
  are per-module. No cross-publication query.
- `S2SPublicContent.publications[]` (the plural field) is **never populated**; attribution is
  on-chain-anchored per publication only.
- No global enumerator: publications are discoverable only by **watching `ModuleCreated`**
  (factory, `S2SPublicationModuleV2Factory`) and `SubdomainRegistered` (ENS registry) **events**;
  there is no `getAllModules()` / `allSubdomains[]`.
- The closest existing index-like surface is the `content_cache_<publication>` IPFS **Archive**
  (maintain-cache action) — genesis-keyed per publication, not cross-author.

**The index object itself is greenfield.** Two viable shapes:
1. **Reuse `contenthash_wrapped`** — the byline node's root points at an *author homepage* (an
   IPFS page/JSON listing publications + pointers). Zero new record keys; reuses the entire
   contenthash read path verbatim. Semantic conflation: "author index" shares the key that means
   "site root" elsewhere.
2. **A new record key** (e.g. `byline` / `index` / `publications`) — more expressive, but **not
   resolvable through the C5 resolver** (generic `text` is stubbed to a hardcoded `"default"` key
   in `ENSResolverWithCCIP.sol`) and not covered by the INV-6 codec. Would be read directly off C3
   (cid-mirror style) or require extending C5.

Recommendation: **index *payload* on content-addressed IPFS** (durable, forkable, per the
protocol's content-vs-naming split), with **discoverability pointers** in the records/ENS layer
(fragile, replaceable, like naming). This mirrors `cid-mirror`: an external resolver over the same
public records with zero protocol authority.

---

## 3. CASE 1 — external / decentralized indexer (three researchers)

Mechanism: a separate indexer **watches the publication factory** → lists all publication modules
(`ModuleCreated` events) → reads each module's `getDeals`/`getOffers`/`getLatest` → **filters by
author** → assembles a cross-publication index of that author's work.

**Trust model — a spectrum, not a binary** (`2026-09-10-external-indexer-trust-model.md`):

| Option | What it is | Verifiability | Censorship exposure | Verdict |
|---|---|---|---|---|
| (i) **Trusted operator** watching contracts | Single indexer service | High (still auditable via proofs) | Highest SPOF — the exact "trust a platform" failure | Only a *convenience* layer, not the core |
| (ii) **Anyone-can-index** (source is public + verifiable) | Derived view of chain + IPFS + both signature layers | **Highest** — every entry independently auditable | Best — forkable/rebuildable commodity | **Core recommendation** |
| (iii) **Registered indexers** (records module / ENS `indexer_*` record, Safe-gated) | Discoverable, revocable set | High | Medium (a gate; mitigates sybil discoverability) | **Optional surface** on top of (ii) |
| (iv) **Lit aggregation** (PKP-signed attestation of aggregates) | Immutable action re-emitting signed index roots | High but can't exceed source | Low-medium (inherits Lit residuals) | Optional, attestation only |

**Why anyone-can-index works (the proof inventory — the crux of CASE 1):** an indexer's claim
about any entry can be checked end-to-end **without trusting the indexer**:
1. **Author-time EIP-712 sig** over `S2SPublicContent` (`buildSignedContentItem`/`verifyAuthorship`)
   — recompute `objectId` = EIP-712 digest from the public fields, recover the signer, assert it
   equals `eoaOf(public.author)` and `proof.signer`. No decryption needed; every public field is
   signed.
2. **Page-level PKP Data-Integrity-Proof** embedded in the HTML (`render/metadata.ts`
   `addAndSignMetadata`; audited by `update/verify.ts::verifyProvenance`) — self-contained, works
   from any host, tamper-evident.
3. **On-chain deal/offer append-log** (`getDeals`/`getOffers`/`getLatest`, `genesisAuthor` gate) —
   the authoritative ordered corpus; any divergence from the indexer's view is checkable.
4. **Commit mechanisms** — `plaintextHash` commits an (encrypted) body without exposing it;
   content-addressing + CID parity gives a verifiable root.

**Invariant guardrail:** there is **no privileged indexer write path today**, and creating one
would loosen `onlySafe`/`onlyAuthorized` (INV-10) and collide with the protocol's neutrality
("capability open, authority collective"). So the index stays a **derived view**; indexers are
readers, exactly like the renderer's own `module.factory` reads.

**Enumeration + resolution gaps for a CASE 1 indexer** (`indexer-offchain-resolution-findings.md`):
- Publications are enumerable **only via `SubdomainRegistered`/`ModuleCreated` events** (no
  `allSubdomains[]`).
- `node = namehash(writeDomain)` where `writeDomain = config.domain ?? publication` — must read
  config first or miss custom-domain publications.
- **genesis→URL is not derivable on-chain**: needs the content item (IPFS) for slug/postType/locale
  + the config for `createPath`. The on-chain graph only gives genesis→content-CID and
  publication→root-CID.
- **Encrypted items are a hard wall** for a public indexer: the slug/title live inside the
  ciphertext; an encrypted item's page uses the bare template path, so multiple encrypted items can
  collide at one URL. Indexing *content* for encrypted items requires access control.
- `getRecords` returns `string[]` (PR #80 ABI fix) — naive `address` decode silently misparses.
- `contenthash_wrapped` uses a **custom `0xe3 01` codec** — must use `decodeContenthashWrapped`.
- **cid-mirror is the pattern to copy**: it already does per-publication resolve→ls→cat→disk with
  zero protocol authority; the indexer generalizes it cross-publication.

---

## 4. CASE 2 — author-managed byline on its own `did:ethr` (three researchers)

Mechanism: the **author controls a byline record on its own identity** — the reader follows the
author (not a third party) to the index.

**Key finding:** the author Safe today has **no modules, no ENS node, no config store, nothing
on-chain** — the only author "config" is local Obsidian settings (`IOxOSettings.authors`). The
whole ENS/records stack is publication-scoped. (`2026-09-10-portable-byline-case2-author-did-surface.md` §a–b)

**Four candidate homes for the byline, ranked by reuse:**

| Candidate | What exists | Greenfield / blocker | Verdict |
|---|---|---|---|
| **1. `S2SRecordsModule` on the author Safe** | The exact primitive exists: immutable `onlySafe` KV store (`setRecord`/`getRecords`/`getAllRecords`, `NAME` getter), readable permissionless. Author Safe has the 4337 client to `enableModule` | Deploy+enable a module on the author Safe (never done today) + define the key scheme (`byline`, `publications`). Zero contract changes. | **Strongest fit** — closest to "author controls a store on its own DID" with live, zero-change machinery |
| **2. Author ENS subnode `<author>.soul2soul.eth`** | `registerSubdomain` is permissionless; C3 stores generic `textRecords[node][key]`; read path is node-agnostic | **INV-12 crux:** C3 `setText` is `onlyAuthorized` (PKP-only today; `authorizeCaller` is owner/protocol-restricted). The author **cannot write its own records** on the shared C3 store. And generic `text` is stubbed in C5. | Viable only via an author-owned records contract or a neutral PKP action — see §5 |
| **3. `did:ethr` document / EthereumDIDRegistry (Track B)** | Nothing in code — RFC Track B is an open proposal (identity-inversion, EOA-named DID for rotation) | Entirely greenfield + naming conflict (§4 gaps) | Long-horizon; not the near-term byline |
| **4. ENS reverse / public-resolver text** | `getContractAddressFromEnsName` (dead code) reads `contract.address` text | Doesn't resolve through C5 (text stub); only for a real L1 author name | Weakest — skip |

**Gaps / invariants that constrain CASE 2** (from both CASE 2 reports):
- **Author is a Safe, not an EOA.** Any author-written record must go through the 4337 Safe so
  `msg.sender == Safe`. An `onlySafe` store (Candidate 1) composes cleanly; anything EOA-keyed
  won't match what on-chain reads see.
- **Who writes the record is the big one.** The only existing per-node store (C3) is PKP-only
  (INV-12). Options: author-owned `onlySafe` records module (zero protocol change) vs routing
  author writes through a **neutral PKP action gated on author ownership** (keeps the "only the PKP
  writes the root" neutrality guarantee, DR-7.3) vs loosening C3 (do-not-touch blast radius).
- **Naming collision:** live convention is `did:ethr:<Safe>`; RFC Track B wants `did:ethr:<EOA>`.
  Must decide which the byline names, or byline and gating identity drift apart.
- **Key rotation:** a byline stored on the Safe survives signer rotation automatically (Safe address
  stable); one keyed to the EOA breaks on rotation unless a registry path exists.
- **Cross-chain same-address (DR-7.4):** assumed for publication Safes; must be verified for author
  Safes specifically (L1 node owner / L2 writer at one address).
- **Discovery:** no `resolveAuthorByline` exists (`resolveLatest`/`getHistory` are stubs).
- **Provenance inconsistency:** `render/main.ts` builds the *publisher* did from the **EOA**
  (`signerAddress`) while the *author* did is the **Safe**. If the byline becomes the durable author
  pointer, provenance emitters should align on the Safe's did:ethr.
- **GAP-1:** the provenance `author` `did:ethr` in the render action is **hardcoded placeholders** —
  the authenticity link the byline depends on is not yet wired to real author data.

---

## 5. The end-to-end reader path (mechanical)

| # | Hop | Existing machinery | Greenfield |
|---|---|---|---|
| 1 | Reader holds the portable byline (`did:ethr:<Safe>` / `<author>.soul2soul.eth`) | Author identity = did:ethr-over-Safe; subdomain mintable permissionlessly | The author node / author index itself |
| 2 | Resolve byline → index | `namehash`; C3 `getText`; C5+gateway — node-agnostic | Expose the index key (text stub) OR read C3 cid-mirror-style; `resolveAuthorByline` helper |
| 3 | Index lists publications + pointers | contenthash decode → CID → IPFS | Index content format (page vs JSON); publication pointer schema |
| 4 | Go to each publication and read | **Fully existing:** `namehash(pub)` → `getText(contenthash_wrapped)` → CID → serve | None |
| 5 | Verify it's really the author's work | EIP-712 `verifyAuthorship` + PKP page proof `verifyProvenance` + on-chain `getLatest(genesis)` | GAP-1 (real author data), GAP-2 (independent verifier) |

Net: hops 2 (partial), 3, 5 are greenfield. Hops 1 (identity) and 4 (per-publication read) are real.

---

## 6. Convergence — the recommended synthesis

The two cases are **not alternatives; they solve different halves and share one spine.**

1. **CASE 2 is the authority of record (author-asserted).** The byline the reader "follows" is
   authored and re-pointed by the author. Lowest-friction, most protocol-consistent implementation:
   an **`S2SRecordsModule` on the author Safe** storing a `byline`/`publications` record that points
   at a content-addressed index doc. If we want an ENS-addressable byline instead, route author
   writes through a **neutral PKP action gated on author ownership** (keeps DR-7.3/INV-12) rather
   than loosening C3. The `config.domain` re-point mechanism in the UPDATE action is the existing
   primitive for portability (rewrite the byline's pointer when the author joins/leaves a
   publication).

2. **CASE 1 is the comprehensiveness + independent-verification layer (derived).** Anyone can run
   an indexer over `ModuleCreated` + `getDeals`/`getLatest` + IPFS + the two signature layers and
   reproduce an author's corpus with **no trust in the author or the indexer**. This is the core
   (anyone-can-index); a Safe-governed `indexer_*` registration is an optional convenience surface.
   **No privileged indexer write path** — that would violate INV-10 and the neutrality principle.

3. **They compose.** A reader can start from the author's byline (Case 2) and cross-check it
   against any indexer's view (Case 1); or start from an indexer (Case 1) for authors who never
   maintained a byline (Case 2). Because both derive from the same public, verifiable source of
   truth, an external verifier confirms an entry via `verifyAuthorship` + `verifyProvenance` +
   `getLatest(genesis)` regardless of provenance. The author byline is self-asserted and therefore
   not authoritative on its own — it is *one* input, verifiable independently.

**Recommended concrete shape (minimum viable):**
- Author Safe gains an `S2SRecordsModule`; `setRecord('byline', <IPFS CID of index doc>)`.
- Index doc (content-addressed JSON/HTML): `{ author: did:ethr:<Safe>, publications: [ { ens, title, latestGenesis, latestCid } ] }`.
- Reader: `resolveAuthorByline(author)` → walk Safe modules → records module → CID → index → per
  publication via the existing per-node read path → verify via the three-layer spine.

---

## 7. Greenfield surface + decision points for the human

**To build (all greenfield, none touches existing guarantees):**
1. Author identity store on the Safe (deploy + enable `S2SRecordsModule`, key scheme) — CASE 2.
2. Index content format + publication-pointer schema.
3. `resolveAuthorByline` reader helper (the stubs `resolveLatest`/`getHistory` are candidates).
4. Cross-publication indexer service — generalize `cid-mirror` (per-publication → cross-publication),
   watching `ModuleCreated`/`SubdomainRegistered` events. — CASE 1.
5. Optional: GAP-1 (wire real author data into page provenance), GAP-2 (publish an independent
   verifier so indexers/auditors have a canonical audit routine), and an enumeration helper (no
   global publication list exists).

**Decision points (need the human):**
- **Trust spectrum for CASE 1:** pure anyone-can-index vs adding a Safe-gated indexer registry
  (`indexer_*` record) — the sybil-vs-neutrality trade.
- **CASE 2 home:** Safe records module (zero protocol change) vs author ENS node via a neutral PKP
  action (ENS-addressable, preserves neutrality, more work) vs long-horizon did:ethr doc.
- **Which address the byline names** (`did:ethr:<Safe>` today vs `did:ethr:<EOA>` Track B).
- **Index key:** reuse `contenthash_wrapped` (zero plumbing, semantic overload) vs a new key (clean,
  needs resolver work).
- **Index format:** human page vs machine-readable JSON vs both.

---

## 8. Source reports (in `brain/research/` + in-session)

- `indexer-offchain-resolution-findings.md` — CASE 1 off-chain resolution surface.
- `2026-09-10-external-indexer-trust-model.md` — CASE 1 trust spectrum + proof inventory.
- `2026-09-10-portable-byline-case2-author-did-surface.md` — CASE 2 author identity/DID surface.
- `2026-09-10-portable-author-byline-resolution.md` — CASE 2 resolution/naming design.
- in-session `explore-factory-indexing` — CASE 1 on-chain factory/module surface.
- in-session `explore-author-provenance` — CASE 2 content/provenance data model.
