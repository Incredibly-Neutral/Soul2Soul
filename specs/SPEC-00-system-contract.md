# Soul to Soul — System Contract (SPEC-00)

> **Audience:** an autonomous agent modifying an *isolated part* of this monorepo.
> **Purpose:** the document you load *before* touching any single component. It tells you
> what the rest of the system assumes about your part, which invariants a local edit can
> silently break, and where the design is still unsettled.
>
> **Status of this file:** scaffold / first pass. Sections marked `⚠ UNVERIFIED` were
> reconstructed from a partial read and must be confirmed against source before relied upon.
> Sections marked `GAP-n` track known unfinished or contradictory areas.

---

## 0. How to use the spec system

```
SPEC-00 (this file)         ← always load first
  ├─ SPEC-protocol-actions  ← Lit Action pipeline (prep / single / merged)
  ├─ SPEC-contracts-publication ← per-publication Safe modules (licensing/whitelist/config)
  ├─ SPEC-contracts-ens     ← protocol-wide naming/resolution/site-root (L1+L2, deploy-once)
  ├─ SPEC-shared            ← types + orchestration imported by everyone (canonical type catalog)
  ├─ SPEC-0xobsidian        ← author identity / Safe / Lens
  ├─ SPEC-neutralpress      ← publication lifecycle + authoring
  ├─ SPEC-safe-app          ← publisher control panel (Safe app)
  └─ SPEC-website-starter   ← output templates / rendered site
```

Rule for the agent: **read SPEC-00 in full, then read only the component spec(s) for the
part you are editing.** If your change touches anything in the Invariant Register (§4), it
is *not* isolated — escalate or read the adjacent component spec too.

**Scope of this spec: the implementation, not the protocol.** S2S conceives of itself as a
*protocol/standard* (like HTTP/RSS) with the current stack (Obsidian / Lens / Chipotle / IPFS /
ENS / Safe) as **one reference implementation**. A formal protocol spec — the
implementation-agnostic requirements (signed pages, provable authorship+licensing, client-side
verification, protocol-key-only root writes, revocability) — is a **separate future exercise**.
This document specs *this implementation*: its concrete components, contracts, and invariants.
Where a constraint is a swappable implementation choice rather than a deep requirement, that is
noted inline (e.g. Lens — see §8 Q5), so an agent knows what is safe to replace.

**Single source of truth (standing rule).** Any code, type, or constant duplicated across packages
is a **defect to resolve by moving it to `shared`** — never by mirroring. The duplicates the specs
flag (the two `S2STemplateConfig`/`S2SCollection` definitions, the parallel `getProtocolInfo`, the
`bodySchema`↔`S2SBody` mismatch, vestigial PKP fields) are violations to consolidate, not patterns
to copy. `shared` exposes multiple **entry points** precisely so one source can serve packages with
different build systems (see SPEC-shared) — that is how to avoid duplication, not by forking.

---

## 1. What the system is (one paragraph)

Soul to Soul is a decentralized publishing protocol. The "publisher" is **neutral**: it is not
an operator but a group of **Lit Actions** (sandboxed JS on the Lit network) controlled by a
single **PKP** (programmable key pair). The PKP renders a content body into HTML, signs a
provenance proof into that HTML, and writes the resulting site's IPFS root on-chain — but only
after on-chain conditions (licensing + authorship + ownership) pass. Authors drive the system
from Obsidian; each publication is an ENS subdomain backed by a Safe multisig with two modules.

---

## 2. Topology — the four trust domains

| Domain | Lives where | Controlled by | Holds |
|---|---|---|---|
| **Neutral publisher** | Lit network (+ Bun preview runner) | PKP + permitted action CIDs | rendering, decryption, signing, on-chain root write |
| **Publication** | Safe on Base (L2) + ENS subdomain on L1 | publication owners (multisig) | licensing, whitelist, config records, site root pointer |
| **Author** | Obsidian + author Safe + Lens | the author's key/Safe | content, encryption, render triggers |
| **Protocol root** | `soul2soul.eth` → controller Safe + global records | protocol operators | PKP info, action CIDs, gateways, ENS records contract |

### 2.1 Trust root of the neutral publisher (resolves GAP-3)

The protocol targets **Lit V3 ("Chipotle")**, which replaced threshold cryptography with
**TEE-based execution**. This is the foundation of the neutrality claim, so an agent editing
any signing/decryption path must hold this model:

- The signing/decryption key is **derived inside a TEE enclave** and never leaves it. There is
  **no** t-of-n share recombination anymore — it is effectively one enclave-held key.
- **Authorization is on-chain on Base via a Chipotle _Group_.** A Group binds together three
  things into one logical unit: the **PKP(s)** (wallets), the **permitted action CIDs**, and a
  scoped **usage key**. An action may use the key *iff its CID is in the Group's permitted set*.
  Deployed instance (`scripts/lit/config.json`): group `s2s`, `id: 14`, PKP
  `0xddc4…b414`, usage key `9i8z…`, permitted actions `encrypt, prep, single, cbor, updateEvm`.
  The repo's `LIT_ACCOUNT_KEY` is the **master/admin** credential; the group's `usage_key` is the
  **scoped execution** credential. (Lit also exposes the on-chain Account contract, API Key
  Registry, and PKP Registry; the Group is the part this protocol manipulates.)
- Lit Actions remain immutable, content-addressed (IPFS CID), Deno-sandboxed JS.

**Primitive decision (locked):**
- `Lit.Actions.getPrivateKey({ pkpId })` — **CURRENT / correct for Chipotle.** The enclave
  derives the private key in-sandbox; the action signs directly with `ethers`.
- `LitActions.signAndCombineEcdsa(...)` — **OLD threshold primitive (Datil/Naga). Removed.**
  The commented block in `single/metadata.ts` is dead and is being deleted.

**Footgun for editors:** because `getPrivateKey` materializes the raw key *inside* the action,
an action must never log it, return it, or pass it outside the signing call. The security
argument rests on three legs — (a) action immutability via CID, (b) on-chain permission gating
of CID→key on Base, (c) TEE attestation that the enclave runs the claimed code — **not** on key
secrecy from the action itself.

> Migration note: Datil sunsets ~30 days after Chipotle hits production (targeted late
> Mar 2026). Any code path still assuming Datil/Naga threshold behavior is on borrowed time.

**Critical distinction (agents confuse these):** there are **two** record stores.
- `S2SRecordsModule` (a.k.a. *configModule*) — KV config for protocol/publication
  (gateways, lens app, action CIDs, PKP fields, `ens_records` address). Accessed via
  `getRecords`/`setRecord`.
- The **ENS records contract** (`protocolInfo.ensRecords`) — stores `contenthash_wrapped`
  (the site root) and is read/written via `getText`/`setText`. **This is not the config module.**

---

## 3. The publish pipeline (boundary view)

```
client (neutralpress) ── signature over "lit actions auth"
        │
        ▼
[PREP]    prep/main.ts        runtime: Bun runner (no signing)   → jobs[]
        │   reads: ENS→modules, config, Lens bodies
        ▼
[SINGLE]  single/main.ts      runtime: Lit (PKP)                 → job.html (CID)
        │   gate: canRead/canPublish (on-chain, Base)
        │   PKP: Lit.Actions.Decrypt
        │   sign: provenance JSON-LD (metadata.ts) ⚠ see GAP-1
        ▼
[MERGED]  updateEvm/main.ts    runtime: Lit (PKP)                → new root CID
            builds IPFS MFS tree (delta pages + cp config.assetsCid → /assets),
            pins, evmWrite contenthash_wrapped  (only the PKP can perform this write)
```

Orchestrated client-side by `shared/src/rendering/index.ts :: renderwithLitActions`.
In `dev=true` every stage runs through the **Bun serverless runner** at `run.transport-union.dev`,
which replicates the Lit Actions **without signing** (the shim's `Lit.Actions.getPrivateKey`
has no signing capability). In production SINGLE and MERGED run on Lit nodes.

**One renderer, run two (soon three) ways (INV-7).** There is a *single* renderer — the action
renderer in `protocol/actions/renderer/`. It runs on **Lit** (prod) and the **Bun runner**
(preview). The separate local renderer in `website-starter/renderer/` is **transitional and slated
to be replaced by the Bun flow**, so author-side local templating will run the *same* code path as
preview and production. Consequence: a template cannot render differently across dev/preview/prod
(no parity drift to police) — and `website-starter` reduces to templates + assets + `mapping.json`
+ scripts, with rendering delegated outward.

**Why two runtimes (design intent):** a Lit render costs ≈ **$0.20–0.50 each**, too expensive for
an author/dev iterating on templates and content. Preview is the **free/cheap, no-provenance**
path — it shows the post exactly as it will render as HTML, minus the signed proof. Production is
the **paid, provenance-bearing** path.

**How the same action code serves both (INV-7 mechanism):** `addAndSignMetadata` wraps signing in
`try/catch`; under the Bun shim the sign step throws and the catch returns the **unsigned** HTML.
So identical action source yields signed HTML on Lit and unsigned HTML in preview.

**IPFS endpoints (don't conflate):** the MERGED action builds the site tree on a **self-hosted Kubo
node** (`ipfs.transport-union.dev`, MFS `files/*` + `pin/add`); **Pinata**
(`neutralpress.mypinata.cloud`) is a separate pinning/CDN + path gateway used for action-code fetch
and preview links. See OPEN-TASK-1 (subdomain gateway).

---

## 4. Invariant Register — what an "isolated" change can break

Each invariant lists the symptom if violated. If your edit touches a row, your change is not isolated.

| ID | Invariant | Enforced across | Symptom if broken |
|---|---|---|---|
| **INV-1** | The auth message string is **exactly** `"lit actions auth"` everywhere it is signed or recovered. | client signer ↔ `libs/gates.ts` (`canRead`,`canPublish`) ↔ `single/main.ts` ↔ `updateEvm/main.ts` | signer recovers to wrong address → every gate fails → "cannot publish" |
| **INV-2** | Config record **keys** match between writer and reader. Readers expect: `assets_gateway, data_gateway, ens_records, lens_app, lit_action_prep, lit_action_single, lit_action_cbor, lit_action_root_update, pkp_tokenId, pkp_publicKey, pkp_ethAddress`. | `shared/src/protocol/index.ts :: getRecords` ↔ whatever sets records (safe-app / scripts) | `getProtocolInfo` returns undefined fields → null PKP / missing action CIDs |
| **INV-3** | `S2SPublicationModule` storage layout is append-only. Never reorder/insert existing slots. | the UUPS proxy + every future implementation | upgrade corrupts licenses/whitelist storage |
| **INV-4** | Module discovery keys: `NAME()` must return exactly `"S2S Records Module"` / `"S2S Publication Module"`. | `getProtocolControllerAndModules`, neutralpress `getModuleAdresses` | modules not found → publication "missing config modules" |
| **INV-5** | Provenance canonicalization in the verifier must replicate `metadata.ts` **byte-for-byte**, including its quirks (top-level-only key sort; `schemaCanonical + proofOptionsCanonical` concatenation; `keccak256(toUtf8Bytes(...))` digest). | `single/metadata.ts` ↔ any external verifier | signatures fail to verify; provenance unprovable. **Also see GAP-2 (nested keys not canonicalized).** |
| **INV-6** | `contenthash_wrapped` round-trips between `toHexString` (write, `libs/evm.ts`) and `contenthashToIPFS` (read, `libs/ipfs.factory.ts`). The codec is **custom & non-standard**: `0x` + `e301` + base58-decoded **CIDv0** bytes — it omits the dag-pb `0x70` codec byte a standard ENS IPFS contenthash carries, and assumes a `Qm…` (base58) input. Internally consistent, but only the project's **own CCIP resolver/gateway** can resolve it. | `updateEvm/main.ts` ↔ `libs/evm.ts` ↔ `libs/ipfs.factory.ts` ↔ `ENSResolverWithCCIP`/`ccip_gateway` | site root unreadable; **and** because `toHexString` base58-decodes, emitting a CIDv1 root (OPEN-TASK-1) breaks the write — keep CIDv0 internally and let the gateway convert |
| **INV-7** | Action source is runtime-agnostic: works under both the Bun shim (`Lit.Actions.*`, global `ethers@5`, **no signing**) and real Lit nodes. | `protocol/serverless` shim ↔ `protocol/actions/*` | preview passes, production fails (or vice-versa) on signing/decrypt steps |
| **INV-8** | A redeployed action requires **two** on-chain updates that must stay in sync. **Canonical sequence:** `build-actions` (bundle → CID) → `swap-action.ts` (Lit **Group**: add new CID, remove old — INV-8b) → `update-protocol.ts` (records: `setRecord` the new CIDs — INV-8a/INV-2, **plus** the INV-12 `authorizeCaller`). `update-protocol` bundles all of this into **one Safe batch proposed to the protocol multisig** (not auto-executed — owners must confirm). | `swap-action.ts` (group) **and** `update-protocol.ts` (records + PKP auth) | **desync footgun:** records-only → orchestrator runs an unpermitted CID → enclave rejects; group-only → orchestrator still fetches the stale CID (also still permitted) → silently renders old code; proposal-not-executed → nothing changes |
| **INV-9** | Chain assumptions: gates read `"BASE"`; provenance `verificationMethod` is `did:pkh:eip155:8453:<pkp>`. Both hardcode Base (8453). | `libs/gates.ts`, `libs/evm.ts`, `single/metadata.ts` | cross-chain deploys silently mis-attribute or mis-gate |
| **INV-10** | Write authorization is **not** uniformly `onlySafe`. Records module: `onlySafe`. Publication module: whitelist mgmt / `acceptLicense` / upgrade = `onlySafe`, but `grantLicense` is **permissionless** (offer-or-direct) and `revokeLicense` is **safe ∨ licenseAuthor**. ENS records `setText` (site root) = `onlyAuthorized`. The neutral publisher writes the root via the **PKP**, never the Safe. | `S2SRecordsModule`, `S2SPublicationModule`, `ENSSubdomainRecordsContract`, `updateEvm` evmWrite | wrong assumption about who can call → reverts, or a security hole if loosened. See SPEC-contracts permissions matrix |
| **INV-12** | The PKP's eth address must be an **`authorizedCaller`** on the ENS records contract (`ENSSubdomainRecordsContract`, Base), separate from the Lit group permission (INV-8). The grant is performed in **`update-protocol.ts`** (`authorizeCaller(pkp.ethAddress, true)`, in the same Safe batch as the record writes). Rotating the PKP requires re-running it. | `update-protocol.ts` ↔ `ENSSubdomainRecordsContract.authorizedCallers` ↔ `updateEvm` `setText` | publish-time `setText` reverts `"Not authorized"` even when the group permits the key — two independent grants gate a publish (INV-8 use-key, INV-12 write-root). **Note:** `update-protocol` writes only `pkp_ethAddress`; `pkp_tokenId`/`pkp_publicKey` are vestigial pre-Chipotle fields to be removed (GAP-11) |
| **INV-11** | **Assets contract:** safe-app `AssetsBuilder` fetches `js/css/fonts/img/svg` from the publication's GitHub repo, builds an MFS dir, and emits an **`assetsCid`** into the publication config; the MERGED action copies that CID into the site root at **`/assets`**. Templates therefore reference assets by **root-absolute** paths (`/assets/...`). | safe-app `AssetsBuilder`/`config-builder` (producer) ↔ publication config `assetsCid` ↔ `updateEvm` (consumer) ↔ templates ↔ serving gateway | wrong/missing `assetsCid` → unstyled site; **and** any path-prefixing gateway (`/ipfs/<cid>/…`) breaks `/assets/...` → previews/sites must be served origin-per-CID (subdomain gateway / ENS·`.limo`), never a path gateway — see OPEN-TASK-1 |

---

## 5. Gap Register — unsettled / WIP (intended design + flag)

| ID | Where | Intended | Actual (as read) | Impact |
|---|---|---|---|---|
| **GAP-1** | `single/main.ts` | derive `S2SContentInfo` (author Lens id, publisher ENS/Safe, content CID, license, `isBasedOn`) from real body/config | object is **hardcoded placeholders** (`"joera.lens"`, `"mypub.eth"`, `0xAuthorAddress…`) | provenance is currently fictional; biggest design↔code gap |
| **GAP-2** | `single/metadata.ts` `canonicalize` | deterministic canonical JSON | `JSON.stringify(obj, keys.sort())` sorts **top-level keys only**; nested objects not canonicalized | non-deterministic signing for nested schema → verification fragility |
| **GAP-3** ✅ | `single/metadata.ts` | choose one signing primitive | **RESOLVED (see §2.1).** Lit V3/Chipotle is TEE-based, not threshold. `getPrivateKey` (active) is correct; `signAndCombineEcdsa` (commented) is the removed Datil/Naga threshold primitive — delete the dead block. | trust root is TEE attestation + on-chain Base permissions, not honest-majority nodes |
| **GAP-4** | `protocol/actions/src` | one renderer, one gates impl | `__renderer` **and** `renderer` both present; gates duplicated in `libs/gates.ts` **and** `shared/src/lit/gates/` | divergence risk; agent may edit the dead copy |
| **GAP-5** | `updateEvm/main.ts` | single merged action | header says it "replaces cbor + root-update" yet a `cbor` action still exists | dead path; unclear which CID the records point to |
| **GAP-6** ✅ | dev/preview | — | **NOT A GAP — design decision (see §3).** Preview intentionally omits signing/provenance to stay free/cheap (Lit render ≈ $0.20–0.50); it is for template/content iteration, not trust validation. | reader should not expect preview to validate trust-critical steps; that is by design |
| **GAP-7** | module upgradeability | consistent policy | `S2SPublicationModule` is UUPS-upgradeable; `S2SRecordsModule` is immutable (`onlySafe`, constructor-bound) | asymmetric migration story |
| **GAP-8** | `getProtocolControllerAndModules` (`shared/src/protocol/index.ts`) | one resolution path | `dev` branch resolves `dev.soul2soul.eth` instead of `soul2soul.eth` | **vestigial** — `dev.soul2soul.eth` was an abandoned preview idea, superseded by the Bun-runner preview (§3.1). Branch should be pruned; do **not** infer that preview needs a parallel on-chain deployment (note: the in-action `ens.factory` copy has no dev branch) |
| **GAP-9** ⚠ | `protocol/actions/src/libs/constants.ts` | secrets injected, not embedded | **Alchemy, DRPC, and Pinata API key + secret are hardcoded in action source.** Actions are content-addressed and **public on IPFS** → these keys are publicly exposed. | high-severity leak; rotate keys and inject via action params / on-chain records instead |
| **GAP-10** | `libs/lens.factory.ts` | production data store | Lens is queried at **`api.testnet.lens.xyz`** in the live path | content/provenance currently anchored to Lens **testnet**; confirm whether intentional (cost/dev) or a pre-mainnet placeholder |
| **GAP-11** | `update-protocol.ts`, `getProtocolInfo` (both copies), `S2SProtocolInfo`, INV-2 key set | one PKP identifier | `pkp_tokenId` + `pkp_publicKey` are **vestigial from threshold-Lit**; Chipotle uses only `pkp_ethAddress` (signing keys off it). The commented writes in `update-protocol` are deliberate. | **cleanup, not a fix:** remove `pkp_tokenId`/`pkp_publicKey` from the record-key set (INV-2), both `getProtocolInfo` destructures, and the `pkp{}` shape — they are dead fields, harmless but misleading |
| **GAP-12** | safe-app `ConfigBuilder`, neutralpress `uploadConfig`, website-starter `LocalConfigBuilder` | one config builder | **three** implementations build the publication config | single-source violation — consolidate config-shaping into `shared`; they can (and the shape-drift suggests already do) diverge |

---

## 6. Dependency edges (build/runtime)

- `neutralpress` → `0xobsidian` at runtime (waits for Obsidian plugin `"oxo-core"`; uses its active user, chains, Lens, Safe).
- everyone → `shared`. Note `shared` exposes **three entry points**: `index` (apps), `lit-actions` (action bundles), `safe-app`. Importing the wrong entry pulls the wrong build target.
- `protocol/actions/*` → `@s2s/soul2soul-shared/lit-actions` only (must stay bundleable into a single Lit Action file; no Node built-ins beyond the shim).
- `safe-app` → `shared/safe-app` + Safe SDK; runs inside the Safe{Wallet} iframe.

---

## 7. Per-component spec template (use for SPEC-<component>)

```markdown
# SPEC-<component>

## Responsibility
One sentence: what this component owns, and what it explicitly does NOT own.

## Boundary interfaces
### Consumes (inbound contract)
- <fn/type/record/event> — from <source> — shape — invariant refs
### Produces (outbound contract)
- <fn/type/CID/tx/event> — to <consumer> — shape — invariant refs

## Shared surface consumed (shared code bundled INTO this package)
- entry point used (`@s2s/soul2soul-shared` | `/lit-actions` | `/safe-app`)
- the specific shared fns/types this package imports — they compile into this build, so treat them
  as part of this package's own code (not an external service). List them so an agent editing here
  knows exactly which shared pieces it depends on.

## On-chain / network calls
- chain, contract, method, read|write, signer (EOA | Safe | PKP)

## Invariants this component must preserve
- INV-n: how it shows up here

## Local gotchas
- runtime constraints, dead code (GAP refs), footguns

## Safe-to-change vs do-not-touch
- green: edit freely | red: changing breaks a cross-cutting contract
```

---

## 8. Open questions to resolve before deepening the spec

1. ~~**GAP-3**: is the neutral-publisher signing key a true threshold PKP, or a Lit *wrapped key*?~~
   **RESOLVED (§2.1):** neither — Lit V3/Chipotle is TEE-based, single enclave-held derived key,
   on-chain permissions on Base. `getPrivateKey` is canonical.
2. ~~Is `dev.soul2soul.eth` a parallel full deployment or only a preview namespace?~~
   **RESOLVED:** neither — it was an abandoned preview idea, superseded by the Bun-runner preview
   (§3.1). The `dev`-branch in `getProtocolControllerAndModules` is vestigial dead code (GAP-8).
3. ~~Where is `contenthashToIPFS` / `toHexString` defined and is the codec versioned?~~
   **RESOLVED:** `toHexString` in `libs/evm.ts`, `contenthashToIPFS` in `libs/ipfs.factory.ts`.
   Custom codec (`e301` + base58 CIDv0, no dag-pb byte), **unversioned**, internally consistent
   (INV-6). Assumes CIDv0 → constrains OPEN-TASK-1 (keep CIDv0 in-action; gateway converts).
   Detail in SPEC-protocol-actions.
4. ~~The *mechanism* for INV-8(b)...~~ **RESOLVED:** the binding is a Chipotle Group on Base
   (§2.1); `swap-action.ts` performs the group remove/add and is **manual + per-action**
   (`action_name` is hardcoded in the script), separate from `update-protocol.ts` which writes
   the records — see the INV-8 desync footgun. *Note:* the `cbor` action is still listed as
   permitted in group `s2s`, consistent with GAP-5 (dead path not yet pruned).
5. ~~Code-vs-design drift — publication membership.~~ **RESOLVED (current = feed-per-publication).**
   The component's job is a *queryable distributed content store* (content bodies + public
   metadata, bound to author). History: **Ceramic/OrbisDB** → stopped functioning → replaced by
   **Lens**. Lens exposes almost no queryable parameters — effectively only the **feed address** —
   so the original *query-by-tag* idea (2025-10 thread) was abandoned and content is associated
   with a publication via a **per-publication feed**. The code (`lens.createFeed`, `feed`-scoped
   queries) is therefore current and correct. **Lens is the acknowledged weak/swappable link**
   (implementation-level, §0); the real contract is "indexable distributed store keyed by a
   publication identifier." *Doc drift:* `action-flow-diagram.md` still names OrbisDB
   (`getBodyOnce`/`getRipplesOnce`, "DB as OrbisDB") — stale from the Ceramic era; rewrite to Lens.
6. **Human authorship — out of scope for this (implementation) spec.** Proving *human* authorship
   (vs wallet ownership), explored via personhood attestations, is a **protocol-level requirement**
   deferred to the separate protocol-spec exercise (§0). Current provenance records a Lens identity
   + wallet only; that is the implementation's actual behavior and is correct *as an implementation*.
7. **Open: does Chipotle still force `ethers@5` in Lit Actions?** The monorepo carries **both viem
   (preferred) and ethers**, because the old Lit runtime injected `ethers@5` as an action global;
   Chipotle's sandbox is Deno-based and it's unconfirmed whether ethers is still required.
   - If still required: the dual stack stays; the rule is that any **shared** function usable from
     both sides must produce identical results under either lib, and the part to single-source is
     the **record-key set + `S2SProtocolInfo` shape** (not the read impl) — INV-2.
   - If no longer required: the action can move to viem and the two `getProtocolInfo` impls collapse
     into one (full dedup). Verify against Lit Chipotle action-runtime docs.

## 9. Open tasks (tracked work items, distinct from gaps)

- **OPEN-TASK-1 — preview subdomain CID gateway on the self-hosted Kubo node.** Stand up a
  dedicated gateway host `preview.transport-union.dev` so each preview root is viewable at
  `https://<cid>.preview.transport-union.dev/…`, giving every preview its own **origin**.
  **This is required, not cosmetic:** templates and assets use **root-absolute** paths
  (`/assets/...`, `/posts/...`, per INV-11). A *path* gateway (`/ipfs/<cid>/…`) reparents the
  site under a prefix, so every root-absolute reference resolves against the gateway root and
  breaks. Origin-per-CID is the only way previews render like the published site (ENS·`.limo`
  is likewise origin-per-name). **IPNS is explicitly rejected** — propagation is too slow for a
  per-render preview. The MERGED action already produces and pins the root CID to the Kubo node
  in preview (`dev=true`) without an on-chain write, so this gateway is the natural way to view it.
  **Implementation constraints (IPFS subdomain-gateway spec):**
  - The subdomain label **must be a CIDv1 in Base32** — the pipeline currently emits CIDv0
    (`Qm…`, Base58), which is case-sensitive and invalid as a DNS/Origin label. Either emit the
    MFS root as CIDv1 (`files` with `--cid-version=1`) or rely on Kubo's automatic
    CIDv0-path → CIDv1-subdomain 301 redirect. Re-encoding is loss-free (same multihash):
    `ipfs cid base32 Qm…`.
  - Standard scheme namespaces the label as `<cidv1b32>.ipfs.<host>`. A bare
    `<cid>.preview.transport-union.dev` (no `ipfs` label, as described) is non-standard and needs
    a custom reverse proxy; the namespaced form works with Kubo's native subdomain gateway.
  - Needs wildcard TLS for the chosen scheme (`*.ipfs.preview.transport-union.dev` or
    `*.preview.transport-union.dev`).
  *Status: **design worked out** in a prior thread (2026-06-14) — not just open. Decided:
  Kubo-native subdomain gateway (`Gateway.PublicGateways["preview.transport-union.dev"]` with
  `UseSubdomains: true, Paths: ["/ipfs","/ipns"]`), which yields the **namespaced** scheme
  `<cidv1b32>.ipfs.preview.transport-union.dev` and serves root-absolute paths correctly.
  Remaining hard requirements: (1) **wildcard DNS** `*.preview.transport-union.dev` → server IP;
  (2) **wildcard TLS via DNS-01** — `certbot --nginx` uses HTTP-01 and cannot issue wildcards, so
  use a DNS plugin or `--manual --preferred-challenges dns`; (3) CIDv1 Base32 as above. Open only:
  whether it supplements or replaces the current Pinata path link in neutralpress FLOW §5.*

- **OPEN-TASK-2 — pin down preview's unsigned guarantee (safety).** Confirm preview HTML carries
  **no** proof rather than an *invalid* proof. The INV-7 mechanism relies on `metadata.ts`'s
  `try/catch` returning unsigned HTML when the Bun shim's `getPrivateKey` throws — but if the shim
  instead returns a dummy key, a present-but-unverifiable proof could be emitted, which is
  dangerous if a preview page ever reached a production origin. Preview output must be provably
  unsigned.

- **OPEN-TASK-3 — object-ify + pre-flight-validate action I/O.** Refactor every Lit action to take a
  single **typed input object** (standardize away from scattered injected globals) and return a typed
  output object. Define one **zod schema per action input/output in `shared`** (authored from each
  action's Consumes/Produces table in SPEC-protocol-actions). **`renderwithLitActions` validates the
  assembled input before dispatch** (client-side, where zod is fine) — failing with the named field
  *before* paying the Lit render cost — and validates the output on return. Keep a tiny
  dependency-free in-action `requireFields` assert as a backstop (the bundle stays zod-free, INV-7).
  Notes: this is **developer-ergonomics/shape-correctness, not a trust boundary** (security stays the
  on-chain gates + TEE); the input schemas **double as the per-action test fixtures**; depends on
  resolving the duplicate/ mismatched shapes first (SPEC-shared: `bodySchema`↔`S2SBody`, dup
  `S2STemplateConfig`).

## 10. Working environment for an isolated agent (Hermes-harness / sandboxed container)

This spec assumes the editing agent may be running **isolated in a Docker container** (e.g. a
Hermes-harness agent), not a developer's pre-configured machine. Verify these before editing:

- **pnpm workspace.** This is a `pnpm` monorepo (`pnpm-workspace.yaml`); packages reference each
  other via the workspace protocol, not published versions. **A dependency used by multiple
  packages belongs on `shared`'s `package.json`, not duplicated into each consumer's** — consumers
  get it transitively through the workspace link. Do not `pnpm add <pkg>` into a consumer if the
  real fix is adding it to `shared` (this *is* the single-source rule, §0, applied to dependencies).
- **`pnpm install` may not be possible inside the agent's own container.** Confirm, before assuming
  otherwise: whether `node_modules`/the pnpm store is **pre-populated in the image**, vs whether the
  agent must run install itself; and whether the container has **registry network access at all** —
  sandboxed containers are commonly egress-restricted to an allowlist (e.g. `registry.npmjs.org`
  reachable, most other domains not), which silently breaks any install/build step that reaches
  outside it. **Do not assume install succeeds; check first**, the way action code must not assume
  Node built-ins exist (INV-7) — same class of environment precondition.
- **The `lit-actions` bundle constraint is a dependency-graph rule, not just a code rule (extends
  INV-7).** `zod` is correctly a dependency of `shared` (for `index.ts`/`/safe-app`), but **no import
  path from `@s2s/soul2soul-shared/lit-actions` may reach it, even transitively** through another
  shared module. This is exactly the kind of thing a partial/incremental edit can violate without
  the editor noticing — check the actual resolved bundle, not just the direct import list, before
  declaring an action-side change safe (relevant to OPEN-TASK-3).
- **Monorepo build/install command sequence, workspace conventions, and CI tooling** are
  intentionally **not** specced here — that is operational documentation for `AGENTS.md` /
  root `README.md`, not system-contract knowledge. If those are missing or stale, flag it rather
  than guess the commands.

---

*Next: confirm this skeleton, then I read each package end-to-end and fill in SPEC-protocol-actions and SPEC-contracts first (they carry the most invariants), followed by the front-ends.*