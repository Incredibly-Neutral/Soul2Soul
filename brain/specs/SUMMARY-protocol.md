# The s2s protocol — a working summary

> Enough to get a decent, self-sufficient understanding of how the protocol works, why it is
> built this way, and how actions drive it — so that a proposal (e.g. locale-in-config) can be
> written without re-reading the specs. Distilled from SPEC-00-system-contract, SPEC-protocol-actions,
> SPEC-shared, SPEC-website-starter, RFC-website-starter-agent-kit, and the whitepaper. Where a
> detail is unsettled it is marked `[GAP]` / `[unresolved]` — treat those as real state, not docs holes.

## 1. What s2s is, and why it is built this way

**s2s is a publishing protocol where authors and publications hold independent, equal power.**
Shorthand: *"decentralized WordPress, not a web3 Substack."* A publication is not an account on a
platform — it is its **own static website**: fully customizable, content-addressed, with embedded
proof of who wrote it, who published it, and that it wasn't altered.

The problem it solves: author collectives face an impossible choice — **trust a platform** (policy
shifts, deplatforming, shutdown) **or run your own server** (which puts the whole site in one
person's hands). s2s lets people cooperate temporarily while keeping individual sovereignty.

The core principle (the "secret sauce"): **remove the means of production from anyone's control.**
The "publisher" is not an operator — it is an open-source **Lit Action bound to a key it cannot
expose (a PKP)**, run by independent nodes reaching consensus in secure hardware. It decrypts
content, renders HTML, **signs** the page, uploads it to IPFS, and **anchors the site root
on-chain** — and it does so **only** when the on-chain rules (licensing + authorship + ownership)
pass. Neither author nor publication holds that key.

A recurring through-line: **capability is open, authority is collective.** Reusable logic lives in
shared/protocol-level code so anyone can build another frontend over it; but the effects that
matter (who may publish, whose content decrypts, what the site's code is, what the root points at)
are gated by a Safe multisig and enforced by the neutral generator. Frontends are swappable; the
guarantees are not.

Identity, in one paragraph: the author is a **`did:ethr` whose address is a Safe (multisig), not an
EOA** — the publication contract records the author by Safe address, and with ERC-4337 + a paymaster
the on-chain `msg.sender` *is* the Safe. Key rotation = swap the Safe's signers.

The eight components (each is a *minimum guarantee*; the named tech is a *reference implementation*):
1 content authoring (Obsidian plugin) · 2 content-item schema + content-addressed storage ·
3 encryption & access control (the gate) · 4 publication governance & permissions (Safe + modules) ·
5 **site generation — the neutral renderer** (the heart of neutrality) · 6 website hosting (IPFS/Filecoin) ·
7 domain resolution (ENS subdomains of `soul2soul.eth`, L2 records, CCIP-Read) ·
8 authenticity & provenance (embedded PKP-signed page proof).

## 2. The trust topology (four domains, and two record stores)

| Domain | Lives where | Controlled by | Holds |
|---|---|---|---|
| **Neutral publisher** | Lit network (+ Bun preview runner) | PKP + permitted action CIDs | rendering, decryption, signing, on-chain root write |
| **Publication** | Safe on Base (L2) + ENS subdomain (L1) | publication multisig | licensing, whitelist, config, site-root pointer |
| **Author** | authoring surface + author Safe | author's key/Safe | content, encryption, render triggers |
| **Protocol root** | `soul2soul.eth` → controller Safe + global records | protocol operators | PKP info, action CIDs, gateways, ENS records contract |

Trust root (Lit V3 "Chipotle"): the signing/decryption key is **derived inside a TEE enclave and
never leaves it** — no t-of-n share recombination. Authorization is on-chain on Base via a Chipotle
**Group** binding PKP(s), permitted action CIDs, and a scoped usage key. An action may use the key
iff its CID is in the Group's permitted set. Actions are immutable, content-addressed (IPFS CID),
Deno-sandboxed JS. `Lit.Actions.getPrivateKey` is the current primitive (enclave derives the key
in-sandbox); the old threshold `signAndCombineEcdsa` is removed.

**Two record stores — do not conflate:**
- `S2SRecordsModule` (a.k.a. *configModule*) — KV config for protocol/publication (gateways, action
  CIDs, PKP fields, `ens_records` address); read/write via `getRecords`/`setRecord`.
- The **ENS records contract** (`protocolInfo.ensRecords`) — stores **`contenthash_wrapped`** (the
**site root**); read/written via `getText`/`setText`. **Only the PKP writes this, as the "publish."**

## 3. The publish pipeline — how actions work (PREP → RENDER → UPDATE)

Orchestrated client-side by `shared/src/rendering/index.ts :: renderwithLitActions`. Three stages,
each is a self-contained `main({…inputs})` function bundled to one file, fetched by CID, executed
either on Lit nodes (prod) or the Bun runner (preview).

```
client ── signature over "lit actions auth" ───▶
        ▼
[PREP]     runtime: Bun runner (NO signing)      → jobs[]
           reads: ENS→modules, config, content bodies; expands "ripples" (related content)
        ▼
[RENDER]   runtime: Lit (PKP)                   → job.html (CID)
  "single"  gate: canRead/canPublish (on-chain, Base) AND signer ∈ owners of author Safe
           PKP: Lit.Actions.Decrypt (gated collections)
           render: Handlebars → HTML; sign: provenance embedded
           upload: HTML → IPFS
        ▼
[UPDATE]   runtime: Lit (PKP)                    → new root CID
  "merged"  builds IPFS MFS tree from job html, cp config.assetsCid → /assets,
           removes stale paths (`remove[]`: slug renames / revocations),
           pins, evmWrite contenthash_wrapped  (ONLY the PKP can write the root)
```

- **PREP** — cheap, **no signing**, runs on the Bun runner in dev *and* prod. Resolves the
  publication (ENS→modules), reads config, fetches content bodies, expands **ripples** (related
  content that must re-render), emits a deduped `jobs[]`. For a single contentId it also detects
  **slug changes** (diffs genesis slug vs current) and emits `remove[]` entries.
- **RENDER/SINGLE** — one Lit action per job; **this is where trust is enforced.** Recovers the
  caller's signer from a sig over `"lit actions auth"`; runs the on-chain gates; PKP-decrypts gated
  collections; renders Handlebars HTML; signs + embeds provenance; uploads HTML to IPFS. Produces
  per-job HTML; it does **not** write the site root.
- **UPDATE/MERGED** — assembles the IPFS MFS tree from the rendered jobs, pins it, and **writes
  `contenthash_wrapped`** (the new site root) on-chain via the PKP. The single privileged root write.

**Preview vs production (INV-7 — one renderer, run two ways):** in `preview=true` every stage runs
through the **Bun serverless runner** (`run.transport-union.dev`), which replicates the Lit Actions
**without signing** (the shim's `getPrivateKey` has no signing capability). `addAndSignMetadata`
wraps signing in try/catch — under the shim the sign throws and the catch returns **unsigned** HTML.
So identical action source yields signed HTML on Lit and unsigned HTML in preview. Why two runtimes:
a Lit render costs ≈ **$0.20–0.50 each** — too expensive for iterating on templates; preview is the
free/cheap, no-provenance path. There is a **single renderer** (`protocol/actions/renderer/`) run two
ways — a template cannot render differently across dev/preview/prod (no parity drift to police).

**I/O contract (every action returns one shape):** `ActionResult<T> = { ok:true, action, data, trace } |
{ ok:false, action, error, trace }`, discriminated on `ok`; `trace` is on **both** branches (survives
a throw). **Fatal** (can't produce a result) → `throw` a *string* naming the offending value → caught →
`{ ok:false, error }`. **Non-fatal** (result still produced, e.g. one collection item failed to decrypt
but the page rendered) → push to `trace`, stay `ok:true`. Validation is **client-side only, both ends**
(zod schemas in `shared/src/rendering/action-io.ts`; bundles stay zod-free, INV-7). Dispatch: `preview`
chooses transport (Bun fetch vs Lit `executeAction`), nothing else.

## 4. The data model — content items, bodies, and the render-time view

**New canonical content-item (identity/provenance) — flat, no union:**
`S2SContentItem = { public(S2SPublicContent), objectId, proof(S2SProof), encryption(boolean), secret(string) }`
- `S2SPublicContent` (signed, EIP-712): `specVersion, author(DidEthr), postType, mediaType, parent,
  position, publication, locale, createdAt(unixts), base?, tags[], attributes?, plaintextHash`
- `secret` = stringified JSON `{ title, slug, content, custom? }` when `encryption:false`, ciphertext
  when `true`. **`secret` is not signed** — `plaintextHash` commits the plaintext instead.
- `objectId` = EIP-712 digest of `public`, available pre-upload/pre-CID.
- Every field in `S2SPublicContent` is signed; there is no unsigned public field.

**Legacy `S2SBody` (deprecated, actions still use it):** discriminated union —
`S2SBodyBase` + `S2SBodyPlain` (`encryption:false`, `content, title, slug, custom?`) /
`S2SBodyEncrypted` (`encryption:true`, no plaintext fields). Lens-era.

**Render-time view `S2STemplateData`:** `id, controller, tags, language, position, encrypted, postType,
publications[], collections?, path, base?, custom, content, dates`.

**⚠ Naming drift (the root of the locale/language confusion):** the **stored canonical field is
`locale`** (in `S2SPublicContent`), while the **render-time view uses `language`** (in `S2STemplateData`),
and the deprecated `S2SBody` carries *both*. Any config/filter that keys on language must be aligned to
the canonical field — `locale`.

## 5. `mapping.json` and the render config

- `S2SPublicationConfig` = `{ assetsCid, contract, dataGateway, mapping, name, templateCid }` — the
  publication's config tree; `mapping` is the site map.
- `S2STemplateConfig` = `{ reference, file, path, collections?, filters? }` — one entry per template:
  stable `reference`, template `file`, output URL `path` (may contain `{slug}`), `collections[]` the
  template iterates.
- `S2SCollection` = `{ source, query, filters?, key, value, slug }` — derived data (e.g. deals) matched
  by `filters[]` (`{ field: value }` predicates).
- `S2SRipple` = `{ origins[], destination, reference, query }` — regeneration rule: when an `origin`
  (post-type) changes, re-render the `destination` config.
- `S2SJob` = `{ id, templateConfig, path?, templateData?, html?, revoked? }`.

**Ripples vs collections — two distinct mechanisms, do not conflate.** Ripples are *regeneration
rules* (which pages re-render when content changes — the PREP stage's job expansion). Collections are
*data the template iterates* (fetched by `fetchCollections` and injected into `templateData` at RENDER
time). A ripple says "when X changes, rebuild Y"; a collection says "template Z shows items matching
filters F."

## 6. `createPath` and locale routing (the worked example)

`createPath` is the renderer's URL-path function: given a body and a templateConfig, it decides the
output path. A `{slug}` in `templateConfig.path` is substituted with the body slug for unencrypted
bodies that have one; encrypted bodies keep the template path. **Locale routing is currently a
hardcoded two-language scheme** (`nl`/`undefined` → no prefix; anything else → `/en`).

Why that is "too opinionated for wider use": it bakes a specific two-language policy into the renderer

core, makes the default language implicit (`undefined` counts as `nl`), and forces every publication to
speak the Dutch/English split even if they are monolingual or use other locales. A config-driven,
publication-level `localePaths` map (keyed on the canonical `locale`) is the agreed generalization —
**monolingual by default** (no map = clean pass-through, no prefix), with per-language prefixes
(`{ default:'', nl:'', en:'/en', de:'/de' }`) as an explicit opt-in. The full derivation lives in the
RFC proposal; this summary is sufficient to re-derive it (see §7).

## 7. The website-starter clone's place (and the locale proposal, re-derived)

A publication is a **standalone repo** with zero `@s2s/*` deps; it needs only two config strings
(`S2S_RUNNER_URL` + the dev-action CID). `website-starter` reduces to **templates + assets +
`mapping.json` + scripts**, with rendering delegated outward to the Bun flow (the transitional local
renderer is slated for removal). The `render:dev` loop POSTs all render materials (templates, partials,
fixtures, helper source) to the runner and writes `html/*.html` — **zero drift**, HTML string is the
source of truth, browser is styling only. `scripts/render-dev.ts`'s local specs can drift from
`mapping.json` (they hardcode their own templateConfig/collections) — keep them in sync.

**Constraints a clone must respect:** no block helpers (`{{#name}}…{{/name}}` is skipped); Track 2
helper injection is dead in production — build-ins + the publication helper module (`helpers.source`,
bare expression, no trailing `;`, pure functions) only; helper failures are silent (missing → raw
`{{…}}`, error → `""`); root-absolute paths (INV-11); the template→config contract is do-not-touch.

**Re-deriving the locale-in-config proposal from this summary alone:**
1. The canonical language field is `locale` (stored, signed) — filters/tags must align on it (§4).
2. `templateConfig.path` is a per-template output URL; `{slug}` is substituted per body (§5).
3. `createPath` currently hardcodes an nl/en prefix policy (§6) — that is a *policy*, not a *mechanism*,
   and it belongs in config, not in the renderer.
4. Therefore: add a **global, publication-level `localePaths`** (`{ locale: prefix }`) to the config;
   `createPath` becomes `prefix(locale) + templateConfig.path`; **unconfigured = monolingual pass-through**
   (clean break — no compat flag for the old auto-`/en`); detail configs sharing a template across
   locales get distinct paths (`/{slug}/` nl, `/en/{slug}/` en) so same-slug pages don't collide.
5. Verify via `render:dev` (ground truth against the real renderer) once the local spec drift is fixed.

## 8. Where the details live (cross-references)

- Orientation: `whitepaper/00-introduction.md` (read first) · renderer: `whitepaper/05-neutral-renderer.md`.
- System contract + invariants + gaps: `specs/SPEC-00-system-contract.md`.
- Actions (I/O contracts, decision tree): `specs/SPEC-protocol-actions.md`.
- Shared types + validation + entry points: `specs/SPEC-shared.md`.
- Website-starter kit: `specs/SPEC-website-starter.md` + `specs/RFC-website-starter-agent-kit.md`.
- Clone-local skills: `skills/template-design/SKILL.md` + `skills/s2s-protocol/SKILL.md` (in
  `~/code/website-starter/skills/`, mirrored into each clone).
