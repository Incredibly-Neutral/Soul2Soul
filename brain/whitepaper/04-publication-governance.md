---
component: publication-governance
protocol: soul2soul
number: 4
status: active
last_reconstructed: 2026-07-15
source: reconstructed from joera↔Claude history; module architecture, V1→V2 refactor, gating invariants
---

# Component 4 — Publication governance & permissions (the contract)

> Reconstructed for machine memory. This is the **convergence component**: the on-chain
> source of truth for *who may publish*, *who may decrypt*, and *what the publication's
> config is*. It is what Component 3's gate reads and what Component 5's renderer updates.
> Decision entries preserved as discussed. Gaps marked `[GAP]`. Where V1 and V2 differ,
> V2 is current.

## Functional description

A per-publication **on-chain authority** through which the publication's multisig governs
**three things**:

1. **Who may publish / whose content may be rendered** — the render-permission set:
   whitelisted devs/authors (`canPublish`), and which content items may be decrypted and used
   in a render (licenses / deals / `isLicensed`).
2. **The publication's config** — the Records module's `name` (ENS), `config` CID, `repo`,
   `branch`.
3. **The website's codebase** — building and uploading a new templates/assets/config bundle
   from the repo is itself a governed decision (design/template/layout changes), not a deploy
   step. See DR-4.12.

It also keeps a **record of edits (prior versions) per document** offered/licensed to the
publication (the V2 append-log), and exposes the **read gates** the render Lit Action depends
on (`canPublish`, `isLicensed`). Governance is **collective** — a multisig with quorum, not a
single owner — so none of the three change without owner approval.

## Minimum guarantee (protocol-level)

- Rules are **public and auditable**, modifiable **only by the parties the rules designate**
  (the Safe / its signers) — not by any host or tooling provider.
- Governance is **collective**: a multisig with quorum, not a single owner.
- Grants and revocations are recorded so anyone can **independently verify current permission
  state**.

## Architecture (current)

A publication is **not a single contract**. It is a **Safe (multisig) on Base (L2)** with
modules enabled:

- **`S2SPublicationModule`** (UUPS-upgradeable proxy) — the **licensing + permissions** layer.
  Holds `whitelisted_authors[]`, `whitelisted_devs[]`, licenses/deals, and exposes the gates
  the Lit Actions read: `canPublish(address)`, `isLicensed(content_id)`.
- **`S2SRecordsModule`** (immutable; `NAME="S2S Records Module"`) — a pure `string→string`
  KV **config store**. All writes `onlySafe`. Deliberately **dumb storage, no business logic.**
  The **same contract** is deployed at two levels with **different key sets**:
  - **Protocol level** (controller Safe) = **`protocolInfo`**: gateways, **Lit Action CIDs**,
    **PKP** (`pkp_ethAddress`) — the global config a Lit Action bootstraps from.
  - **Publication level** (publication Safe): the publication's own config —
    `name` (ENS name, e.g. `s3nl.soul2soul.eth`), `config` (a **CID** of the built publication
    config), `repo` (template/dev GitHub repo), `branch`. **Not** the PKP or action CIDs —
    those are protocol-level only.

The **PublicationModule**, separately, holds the *governance* state (not in Records):
- **who can initiate a render** — `whitelisted_devs` / `whitelisted_authors` via `canPublish`;
- **which content may be decrypted** in a render — licenses/deals via `isLicensed`/`hasDeal`;
- **a record of edits (prior versions) per document** offered/licensed to the publication (the
  V2 append-log).

The Safe is the **authority** (`onlySafe`), and this is the on-chain anchor of the
`did:ethr`-over-Safe identity (Component 1). Modules are enabled on the Safe partly for
**discovery** (`getModulesPaginated`, INV-4) — the Safe calls *into* them.

**How a Lit Action bootstraps:** from just an ENS name → resolve to the protocol-level
controller Safe → read `protocolInfo` (PKP, action CIDs, gateways) from its Records module →
then read the specific publication's Records (`name/config/repo/branch`) and PublicationModule
gates.

## The publisher UI — `safe-app` (Safe{Wallet} app)

The human interface *to* this contract is **`safe-app`**, a Safe{Wallet} app that **mounts
inside the Safe web UI** (`app.safe.global`). It is the **publication's control panel** for the
multisig owners.

- **Responsibility:** manage licenses/deals, whitelists (authors/devs), and config records; and
  **trigger the build of the publication config** (templates + assets) from the GitHub repo. **It
  does not render content, sign, or write the site root** — that's the Lit Actions/PKP
  (Component 5). Note the **build logic itself is in shared lib** (see below); `safe-app` is one
  UI that drives it.
- **Mutations are proposed as Safe transactions, never executed directly:** every write is
  `safeSdk.txs.send({txs:[{to,value,data}]})` → queued at `app.safe.global/transactions/queue`
  for **owner confirmation** (quorum). This is the collective-governance guarantee in practice.
- **Runtime:** Vite-built **vanilla Web Components** (Custom Elements + Shadow DOM), embedded via
  `@safe-global/safe-apps-sdk`, `allowedDomains: [/app\.safe\.global$/]`, ethers **v6**. Imports
  the lean `@s2s/soul2soul-shared/safe-app` entry.
- **Tabs:** a **Deals/Licenses** tab (grant/accept/revoke + list active/pending), a **Whitelist**
  tab (author/dev management), and a **Records** tab (view/edit config; config/asset build entry).
- **Config/asset building is itself a governance act (not a utility).** Rebuilding the config
  and assets from the GitHub repo *is the publication deciding to change its website's
  codebase* — a new design, new templates, layout changes. This is the **developers-propose /
  multisig-approves-an-upgrade** path. The build logic — `ConfigBuilder` (repo + `mapping.json`
  → `S2SPublicationConfig` → Pinata/IPFS → `configCid`) and `AssetsBuilder` (repo
  `js/css/fonts/img/svg` → `assetsCid`, INV-11) — **lives in shared lib** (protocol-level), so
  anyone can build over it; `safe-app` is **one UI** that drives it. Crucially, the resulting
  `configCid`/`assetsCid` are written to the Records module **via a Safe transaction**, so
  **changing the site's codebase goes through the same quorum as any permission change.** That
  is what makes template/design upgrades a governed decision rather than a unilateral deploy.
- **Reads:** direct RPC (modules discovered by `NAME()`, INV-4; records, licenses; site root from
  the ENS records contract, INV-6). **Writes:** always Safe-proposed.

**Naming churn to be aware of (not a real design change):** this tab and its methods flip-flopped
between "**Deals**" and "**Licenses**" naming across refactors (Deals → Licenses ~Feb 2026 →
Deals ~Jul 2026, aligning with the V2 `append`/`retract`/`grantLicense`/`acceptLicense` /
offer-accept vocabulary). Treat the two terms as the **same concept** at different naming epochs;
the underlying thing is the author↔publication agreement over a content item.

---

## Decision record

### DR-4.1 — A publication = Safe + modules, not a bespoke contract *(foundational)*
**When:** 2025-10 →
**Decision:** Model each publication as a **Gnosis Safe** with an enabled
**PublicationModule** (permissions) and **RecordsModule** (config). Collective control via the
Safe; the Safe is the authority.
**Status:** foundational / current.

### DR-4.2 — Split Records (dumb config) from Publication (logic) — but keep permissions+deals together
**When:** 2025-10-20
**Decision:** Two separations were considered; the settled shape is:
- **RecordsModule = pure config KV**, no business logic, no dependencies ("the possible third
  wheel… should be isolated and only do basic configuration").
- **PublicationModule = all permission/deal logic together.**
**Rejected:** splitting deals from permissions into two mutually-referencing modules — because
`canPublish` must check owner ∨ whitelisted-author ∨ dev ∨ has-deal **all at once**, so
splitting would force the modules to call each other. Rule adopted: *if two modules would have
to depend on each other, keep them one module.*
**Status:** current.

### DR-4.3 — Authority is the Safe address, not OwnableUpgradeable *(load-bearing)*
**When:** 2026-01-29
**Decision:** Remove `OwnableUpgradeable`; replace `onlyOwner` with **`onlySafe`**; all
permission checks key on the **Safe address** (`_address == safe`), not a deployer/owner.
**Consequence + open gotcha:** `canPublish` checks the Safe *address*, so a **Safe *owner*
EOA does not pass** the check. Flagged in code as `// could be safe owners ???` — **unresolved
design question** (should a signer EOA count as canPublish, or only the Safe itself?).
**Status:** current; the owner-EOA question is `[unresolved]`.

### DR-4.4 — Two permission tiers: authors vs devs (staging/live foresight)
**When:** 2025-10-20 → 2026-01-29
**Decision:** Separate **`whitelisted_authors`** from **`whitelisted_devs`**. Devs were
initially assigned as whitelisted authors, but are kept separate deliberately for a **future
staging vs live distinction** (devs can re-render the whole publication, possibly only a
staging version). Caps: **100 authors, 20 devs.**
**Status:** current; staging/live distinction is foresight, not yet built.

### DR-4.5 — The two gates the renderer reads: `canPublish` vs decryption
**When:** 2025-10-20, reaffirmed 2026-07-02
**Decision (ties to Component 3, DR-3.2):**
- **decrypt** gated on **`hasDeal`/`isLicensed`** (content may be revealed for rendering);
- **trigger re-render + update rootCid** gated on **`canPublish`** (safe ∨ whitelisted
  dev ∨ whitelisted author).
These are enforced in `libs/gates.ts` (`canRead`/`canPublish`) **inside the Lit Action**, and
additionally require the caller's **signer to be an owner of the author's Safe**.
**Status:** load-bearing.

### DR-4.6 — V2 refactor: append-log model (publish = append, retract = revoke) *(current)*
**When:** 2026-06-30 → 2026-07-07
**Decision:** `S2SPublicationModuleV2` replaces per-content license bookkeeping with an
**append-only version log per genesis document**:
- `versions[genesis] = Version[]` where `Version = { objectId, cid, timestamp, tombstone }`.
- `genesisAuthor[genesis]` = the Safe address that created the document.
- **Publishing and licensing are one concern:** `append` (abandon content to the log) **grants**
  its license; `retract` (tombstone) **revokes** it. The set of licensed content ids **is** the
  set of genesis documents; the license author **is** the genesis author.
- A separate **offer/accept path** (`grantLicense` → `acceptLicense`, `onlySafe` to accept) is
  kept for **non-whitelisted authors** proposing content the Safe then accepts.
- `getLatest` returns the most recent non-tombstone version.
**Storage layout is append-only / DO-NOT-REORDER (INV-3):** new fields appended at the end to
preserve UUPS upgrade layout.
**Status:** current (V2).

### DR-4.7 — Explicitly NOT event-sourced
**When:** 2026-06-30
**Decision:** Deliberately **did not** move to an event-sourced storage model. At
**one-publication scale on an L2**, the storage array is fine and event-sourcing complexity
isn't justified.
**Status:** settled (a "considered and rejected" to preserve).

### DR-4.8 — CRITICAL BUG (flagged): `append()` not gated to the genesis author *(INV-append)*
**When:** 2026-06-30
**Issue:** `append()` checks only `canPublish(msg.sender)` (true for Safe ∨ any whitelisted
author ∨ any whitelisted dev), writes `genesisAuthor` on first append but **never consults it
on subsequent appends**. → any *other* whitelisted author B can append a new version to author
A's genesis, and since `getLatest` returns the newest non-tombstone, **B can overwrite A's
current version.** The log is forgeable across authors within a publication.
**Tell it's an oversight:** `retract()` *does* enforce `msg.sender == genesisAuthor[genesis] ||
== safe`. So you can't retract someone else's doc but you can append to it — append and retract
must agree.
**Prescribed fix:** first version (genesisAuthor == 0) → gate to `canPublish` + set
genesisAuthor; existing document → require `msg.sender == genesisAuthor[genesis] || == safe`.
**Status:** `[verify: confirm fixed before/after deploy]` — recorded as the load-bearing
invariant INV-append.

### DR-4.9 — Gating is `msg.sender == safe`; authorship proofs verified off-chain *(settled)*
**When:** 2026-06-30
**Decision:** Prime identity is `did:ethr`-over-Safe, so on-chain gating is
**`msg.sender == safe`** with **no in-contract signature verification** — content-authorship
proofs (the EIP-712 `proof`, Component 2) are verified **off-chain at render time** inside the
Lit Action. Keeps the contract simple; the expensive verification lives where the content is
already being handled.
**Status:** settled.

### DR-4.10 — RecordsModule specifics: two key sets + vestigial keys
**When:** 2026-07-02
**Facts:** `S2SRecordsModule` is **immutable** (not upgradeable — intentional asymmetry vs the
upgradeable PublicationModule, GAP-7). Key set is enforced by *readers*
(`getProtocolInfo`/`getConfig`), not the contract. **Two distinct key sets by deployment level:**
- **Protocol (`protocolInfo`):** gateways, Lit Action CIDs, `pkp_ethAddress`.
- **Publication:** `name` (ENS), `config` (built-config CID), `repo`, `branch`.
**Vestigial keys (pre-Chipotle), protocol level:** `pkp_tokenId` / `pkp_publicKey` are dead;
only **`pkp_ethAddress`** is current — prune the other two.
**Status:** current; prune-vestigial is `[future work]`.

### DR-4.11 — Publisher UI is a Safe app; all mutations are Safe-proposed
**When:** 2025-09 → 2026-07 (evolving)
**Decision:** The publication's control panel is **`safe-app`**, mounted inside the Safe web UI,
not a standalone site. Every mutation is **proposed as a Safe transaction** (multisig queue,
owner confirmation) — the app **never executes writes directly**, and **never renders/signs/
writes the site root** (that's Component 5's PKP).
**Build capability is shared, not app-owned:** the config/asset generation + upload
(`ConfigBuilder`/`AssetsBuilder` → `configCid`/`assetsCid`) lives in **shared lib**, so anyone
can build on it. **`safe-app` is one UI over that shared capability**, not the only way to drive
it (a different UI or a headless tool could produce the same CIDs).
**Why:** keeps collective governance real (nothing changes without quorum), keeps the publisher
UI on the *governance* side of the contract/generator boundary, and keeps the reusable build
logic at protocol level rather than locked in one frontend.
**Naming note:** the deals/licenses tab renamed back and forth (Deals↔Licenses) across
refactors — same concept, different epochs.
**Status:** current.

### DR-4.12 — Updating the website codebase is a governance decision *(principle)*
**When:** clarified 2026-07-15
**Principle:** Building + uploading a new config/assets bundle from the repo — new design, new
templates, layout changes — **is a governance act**, not a deploy step. It is the publication's
multisig deciding to **change its website's codebase**, i.e. the developers-propose /
multisig-approves-an-upgrade path (the same "the magazine's multisig can upgrade to a newest
version" idea from the earliest S2S framing).
**Mechanism:** the built `configCid`/`assetsCid` land in the Records module **via a Safe
transaction**, so a codebase/design change requires the **same quorum** as any licensing or
whitelist change. There is no privileged path to change what future renders produce.
**Consequence:** the build capability is deliberately **shared-lib / protocol-level** (any UI or
headless tool can drive it), but its *effect* is gated by the Safe — capability is open,
authority is collective.
**Status:** current; foundational to why S2S is "governed infrastructure," not a hosting product.

### DR-4.X (SUPERSEDED / EXPLORED) — Human Wallet (2PC) vs Safe for individual authors
**When:** 2026-01-23
**Status:** explored, not the current model. For the record: discussed supporting **Human
Wallet (2PC/MPC)** for individual authors (better UX, cross-chain) vs **Safe** for
DAOs/orgs/co-authors (true multi-party governance) — possibly both. Current architecture
standardized on **Safe as the author identity** (Component 1); the dual-wallet idea is not the
present design.

---

## Invariants (named, for machine cross-reference)
- **INV-3** — PublicationModule storage is append-only; DO NOT REORDER.
- **INV-4** — module discovery via `NAME()` / `getModulesPaginated`.
- **INV-10** — write-authorization matrix (`onlySafe` for management; `grantLicense` open →
  pending; `acceptLicense` `onlySafe`; `revokeLicense` safe ∨ licenseAuthor).
- **INV-append** — `append` must gate new docs to whitelist and edits to the genesis author
  (DR-4.8).
- **INV-2** — record-key set defined by readers, not the RecordsModule.

## Open questions / unresolved
- **[unresolved]** Should a Safe *owner EOA* pass `canPublish`, or only the Safe address?
  (`// could be safe owners ???`, DR-4.3).
- **[verify]** Confirm the INV-append fix (DR-4.8) landed before deploy.
- **[future work]** Prune vestigial `pkp_tokenId`/`pkp_publicKey` keys (DR-4.10).
- **[GAP]** Whitelist removal does **not** revoke existing licenses — intended or gap?

## Cross-references
- **Component 1 (authoring)** — the deal/license lifecycle (`proposeNote`/`offerDeal`/
  `acceptDeal`/`revokeDeal`, or V2 `append`/`retract`/`grantLicense`/`acceptLicense`) is invoked
  from the authoring surface via Safe transactions; canonical home of the did:ethr-over-Safe id.
- **Component 2 (schema)** — `objectId`/`cid` stored per version; the contract is the
  publication-scoped discovery mechanism (replaces the old "index").
- **Component 3 (encryption)** — provides `canPublish`/`isLicensed`/`hasDeal` that the render
  action gates decryption on; PKP admin via the Safe/Records.
- **Component 5 (site generation)** — reads gates here, writes the new rootCid back (to the ENS
  records contract; the Records module holds the `ens_records` pointer).
- **Component 7 (domain resolution)** — publication = subdomain of `soul2soul.eth`; ENS records
  contract pointer lives in RecordsModule.
