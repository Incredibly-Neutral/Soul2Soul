# SPEC-protocol-actions

> **Audited against live code:** 2026-08-03; **partial re-audit 2026-08-06** for the Lit fetch-budget
> fix, `evmRead` failover, MFS tree-path removal (`remove`), and slug-override propagation (see
> handoff `handoff-actions-fixes-and-remove.md`). **Constants extraction implemented 2026-08-07**
> (see handoff `handoff-actions-extract-constants.md`) — `libs/constants.ts` + `renderer/constants.ts`
> deleted; gateway + RPCs now arrive via the `endpoints` action input (GAP-9 action-side resolved;
> orchestrator `rpcs` source still unwired, see handoff §6). **Tree-mutation integrity gate implemented
> 2026-08-07** (see §A3 Decision Tree below). Sub-component paths and the Lens→module migration
> are reconciled to current code where today's work touched them; the ripples/collections narrative
> still needs a full re-confirm against `prep` (flagged inline).
>
> Component spec for `protocol/actions/` — the Lit Action pipeline (the "neutral publisher").
> Read **SPEC-00** first. This spec follows the SPEC-00 §7 template and doubles as the
> **I/O contract** for unit/integration tests: every action's Inputs/Outputs table is also its
> fixture definition.
>
> Invariants carried by this component: INV-1, 2, 5, 6, 7, 8, 9, 11 (see SPEC-00 §4).

---

## Responsibility

Owns: turning licensed content into signed, addressable HTML and anchoring the site root
on-chain. Specifically — resolve a publication, enforce on-chain access, decrypt, render,
sign provenance, assemble the IPFS site tree, write the root.

Does **not** own: authoring/encrypting content (neutralpress), publication/Safe/module creation
(neutralpress), config/asset _production_ (safe-app), or the trust enforcement itself (Lit/Chipotle
enclave + on-chain groups — this code only _runs inside_ that).

Runtime: each action is a self-contained `main({...inputs})` function bundled to one file, fetched
by CID, executed on Lit nodes or on the Bun runner by the render mode. Globals: `ethers@5`,
`Lit.Actions.*` (see `action_globals.ts`). **No Node built-ins** beyond the shim (INV-7).

---

## Sub-component map

| Path                       | Role                                                                                                                                                              | State                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `prep/main.ts`             | Stage 1 — build `jobs[]` from contentIds (cheap, no signing)                                                                                                      | live                                                                               |
| `render/main.ts`           | Stage 2 — per-job: gate → decrypt → render → colophon (signed on publish, no `proofValue` when `unsigned`) → upload HTML                                                                          | live                                                                               |
| `update/main.ts`           | Stage 3 (merged) — assemble MFS tree, **remove stale paths**, pin, write root                                                                                     | live                                                                               |
| `cbor/`                    | old root-builder                                                                                                                                                  | **gone** — merged into `update` (GAP-5 ✅); no longer in the group's permitted set |
| `renderer/`                | Handlebars render (`renderHTML`)                                                                                                                                  | live                                                                               |
| `__renderer/`              | older renderer copy                                                                                                                                               | **dead** — duplicate (GAP-4)                                                       |
| `render/config.ctrl.ts`    | `getConfig`, `getTaskConfig`                                                                                                                                      | live                                                                               |
| `render/data.ctrlr.ts`     | `initTemplateData`, `fetchCollections`, path helpers                                                                                                              | live                                                                               |
| `render/metadata.ts`       | `addAndSignMetadata` (provenance)                                                                                                                                 | live (see GAP-1, GAP-2)                                                            |
| `libs/protocol.factory.ts` | in-action `getManifest` — the document and `VERSION()`, both on the hardcoded records module                                                                     | live (dup of shared, see Gotchas)                                                  |
| `libs/ens.factory.ts`      | `getDomainOwnerAndModules` — the publication and records kinds are read from the factory the record names, and nowhere else; `moduleAddress(safe, kind)` per kind, answer needs code | live |
| `libs/module.factory.ts`   | `getLatestEntry` / `getAgreements` / `fetchById` / `fetchByPublication` — reads latest cid from the publication module + IPFS cat (replaces `lens.factory`, GAP-10 ✅). The module's published set is `getAgreements(offset, limit)`; the helper asks for it by that name from bundle **0.1.2**, and earlier bundles ask for `getDeals`, which the module does not expose | live on **0.1.2**; dead on 0.1.0/0.1.1                                           |
| `libs/evm.ts`              | `evmRead` (catch-all failover + aggregated error), `evmGetCode` (one `eth_getCode`, same failover), `evmWrite`, `toHexString`                                      | live ⚠ GAP-15 (partly addressed)                                                   |
| `libs/ipfs.factory.ts`     | IPFS cat/add/dag/MFS + `contenthashToIPFS`                                                                                                                        | live (dag/cbor helpers mostly dead)                                                |
| `libs/gates.ts`            | `canPublish`, `canRead`, `canPreview`, `canAuthorVerdict`, `isOutOfForce`, `canReset`, `canReview`, `extractSignerAddress`                                                      | live                                                                               |
| `libs/decrypt.ts`          | `decrypt` (`Lit.Actions.Decrypt`, behind `canRead`, or `canPreview` when the run is a preview)                                                                                                                           | live                                                                               |
| `decrypt/main.ts`          | GATES-1 — open an author's draft: one `canAuthorVerdict` call for modules, `authorOf` and the owner answer, entry read at the block the verdict names, cat, decrypt, `plaintextHash` check (decisions in `libs/author-draft.ts`) | live                                                                               |
| `encrypt/main.ts`          | seal a body under the PKP, `Lit.Actions.Encrypt`                                                                                                                  | live                                                                               |
| `libs/author-draft.ts`     | `decryptAuthorDraft` — the draft decision with injected reads, cat, decryptor and signature recovery                                                              | live                                                                               |
| ~~`libs/constants.ts`~~     | ~~endpoints + hardcoded API keys~~                                                                                                                                | **gone** — extracted to action input `endpoints` 2026-08-07 (GAP-9 action-side resolved; `renderer/constants.ts` also deleted). `rpcs`/`gateway` now threaded through `evm.ts` / `ipfs.factory.ts` / etc. Orchestrator `rpcs` source still unwired (handoff §6). |
| `libs/helpers.ts`          | `fetchWithTimeout`, `addressToUserId`                                                                                                                             | live                                                                               |

---

## Shared surface consumed (bundled INTO the action files)

Entry point: **`@s2s/soul2soul-shared/lit-actions`** — **types + ABIs only, no runtime** (INV-7).
Imports: types `S2SJob`, `S2STemplateConfig`, `S2SBody`, `S2SRipple`, `S2SPublicationConfig`,
`S2SManifest`, `PKP`, `S2SContentInfo`; and the contract ABIs (`Abi_S2SRecordsModuleV0_1`, etc.).
These compile into each bundled action — they are this package's code, not an external service.
**Constraint:** nothing imported here may pull in a runtime/Node dep (would break the bundle). The
zod validators in shared are deliberately _not_ exported through this entry.

## I/O contract (generic — the per-action contracts in §A are instances of this)

The **definition** of conformant action I/O. The `lit-actions-io` skill is the _procedure_ to
produce it; **if skill and spec disagree, this section wins.** The Consumes/Produces tables in
§A1–A3 are the per-action instances.

**Envelope — every action returns one shape.** `ActionResult<T>` (`shared/src/lit/actions/types.ts`):

```ts
type ActionResult<T> =
  | { ok: true; action: string; data: T; trace: any[] }
  | { ok: false; action: string; error: string; trace: any[] };
```

Discriminated on `ok`; `action` is the producer (`"prep"|"single"|"evm-update"`). `trace` is on
**both** branches → survives a throw. Per-action `<A>Input`/`<A>Data` interfaces also live in
`types.ts`; `Data` is the `T`. Types re-export through `@s2s/soul2soul-shared/lit-actions`
(zod-free, INV-7).

**Fatal vs non-fatal — the rule that decides throw vs record.** Fatal (can't produce a result) →
`throw` a **string** naming the offending value → caught → `{ ok:false, error }`. Non-fatal (result
still produced, e.g. one collection item failed to decrypt but the page rendered) → push to `trace`,
stay `ok:true`. Never join non-fatal problems into `error`. `trace` is declared **before** the
`try` so the `catch` returns it too. Throw strings, not `Error` (Bun/Deno serialize `Error.message`
inconsistently).

**Validation — client-side only, both ends.** zod schemas live in `shared/src/rendering/action-io.ts`,
reusing the canonical base schemas in **`shared/src/publication/validation.ts`** (never a second
schemas file; SPEC-00 §0). `validate<A>Input` runs **before dispatch** (fail with the field name
before paying Lit cost); `validate<A>Output` validates the returned `ActionResult` **before consume**.
Bundles stay zod-free (INV-7) — the action's own guard is `requireFields` (presence-only:
`undefined`/`null`/`""`; passes `[]`/`0`/`false`, so add explicit shape asserts, e.g. non-empty array).

**Interface↔schema sentinel.** Interface (bundle, zod-free) and zod-inferred type are hand-paired:
`type _Assert = <A>Input extends <A>ActionInput ? true : never`. This sentinel now resolves to `true`
for all three actions — the `S2SJob.html` mismatch was resolved (optional in both interface and schema).

**Dispatch — the render mode chooses each stage's transport (SPEC-00 §3).** `runAction` is the only
place a transport is named; everything after is uniform (validate-in → dispatch → check `ok` →
validate-out → consume `data`/`trace`), once per stage, never per branch:

```ts
async function runAction<T>(transport: 'runner' | 'lit', lit, cid, inputs, litUsageKey): Promise<ActionResult<T>> {
  if (transport === 'runner') {
    const w = await fetch('https://run.transport-union.dev/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cid, inputs }),
    }).then((r) => r.json());
    if (w.success === false) throw new Error(`runner: ${w.error ?? 'transport'}`);
    return w.response;
  } // Bun wraps {success,response}
  const code = await fetch(`https://neutralpress.mypinata.cloud/ipfs/${cid}`).then((r) => r.text());
  return (await lit.executeAction(code, inputs, litUsageKey)).response; // Lit: response IS the ActionResult
}
```

`renderwithLitActions` takes a `RenderMode` (`'dev' | 'preview' | 'publish'`) and routes the three
stages: prep is runner in every mode; render is runner in `dev`, Lit in `preview` and `publish`;
update is runner in `dev` and `preview`, Lit in `publish`. `maintain-cache` runs only on publish, on
Lit. Every mode makes a single attempt, publish included: `RENDER_RETRY_ATTEMPTS` is 1 by operator
directive (2026-10), because each retry re-fires the Lit action and re-drains a fresh session's
50-request budget. Fail fast; the orchestrator marks the job failed.

**Two error levels, verified:** a thrown action error returns `success:true, response:{ok:false}`, so
runner `success:false` means **transport/crash only**, action `ok:false` means **logic failure**.
The runner wrapper exists on the Bun path only; `runAction` absorbs it so callers see one shape.
**prep is runner-only** (no signing → never on Lit, in any mode). A separate prod branch that returns
`success:true` on `ok:false` is the bug this structure forbids.

**The two boolean inputs.** The per-action inputs keep `preview` (true for `dev` and `preview`, false
for `publish`) because the deployed actions read it: render uses it in the cache-refresh gate
(`shouldWriteBackCache`), update uses it to skip the on-chain write. From 0.1.4 the render also uses
it to pick the decrypt gate and the revoke rule (see §A2). The render action released in 0.1.4 also
reads `unsigned` (true for `dev` and `preview`); absent or false keeps the signing attempt. A pinned
render action that predates `unsigned` would ignore it on Lit and sign the page, so
`renderwithLitActions` refuses `preview` unless the manifest advertises
`capabilities.unsignedRender`, before dispatching anything.

The same release writes a second capability into the document it files, `capabilities.offerPreview`:
the render action it pins gates decryption on `canPreview` and reads `hasOffer` in its revoke guard,
so an offer may be previewed before it is accepted. Nothing in the press reads the flag; the safe-app
requires it for an offer row, beside `unsignedRender`, which every preview still needs. The two
arrive together because 0.1.4 is unfiled, so one pin enables the whole preview.

## Action contracts (= test fixtures)

### A1 — `prep` `main({ publication, contentIds, configCid?, endpoints })`

**Consumes**

| field               | type              | source                          | notes                                        |
| ------------------- | ----------------- | ------------------------------- | -------------------------------------------- |
| `publication`       | ENS name          | caller                          | e.g. `alice.soul2soul.eth`                   |
| `configCid`         | `string?`         | caller                          | if absent, `getConfig` reads `config` record |
| `contentIds`        | `string[]`        | caller                          | Lens post ids                                |

**Produces** `{ success: true, jobs: S2SJob[], remove?: { path, replacedBy? }[] }` — deduped by `id`. For a **single** contentId
(`contentIds.length === 1`), also expands **ripples** — i.e. appends _additional re-render jobs_
for pages whose output depends on the published content (see "Ripples vs collections" below).

**Network/chain:** `getManifest` (one BASE `getRecord` and one `VERSION()`) then
`getDomainOwnerAndModules` (ETHEREUM + BASE reads); `getConfig` (BASE read + IPFS cat); `fetchById`/`fetchByQuery` (Lens testnet); **version
log reads** for slug-change detection (BASE reads). No signing, no PKP. **Runs on Bun runner.**

**Invariants:** INV-4 (module discovery): the publication and records modules are read from the
factory the `publication_factory` record names — not from whichever factory deployed the Safe. It
answers `moduleAddress(safe, bytes32 kind)`, where `kind` is
`keccak256("s2s.module.publication")` (`0x93cd3ffe…`) or `keccak256("s2s.module.records")`
(`0x32af023b…`), derived at bundle load with `ethers.utils.id(...)`; the same pair lives in
`shared/src/protocol/constants.ts` for the app. A Safe the factory has no record of still gets an
answer: `S2SPublicationModulesFactoryV0_1.sol:299-304` returns a fresh prediction, and `address(0)`
when the kind has no implementation set. An answer without code at it is no module, and so is the
zero answer. A revert happens when the record itself names a factory older than `moduleAddress`:
the read fails, the action fails loudly, and the publication is refused. The code does not separate
that revert from a transport failure, because ethers v5 wraps a transport `SERVER_ERROR` as
`CALL_EXCEPTION` with `data="0x"` (see SPEC-system-contract GAP-15); failing closed is the rule
instead. There is no fallback for these two kinds — no module-list read, no ERC-165 probe, no
`NAME()` match, no CREATE2 version walk. **Not resolved at all:** `PROTOCOL_RECORDS_MODULE`
(`0xBB0BBd828c19502a8fCFbF07f5ACEcd8E8641D29`, `libs/protocol.factory.ts`) — the bootstrap root,
where the `publication_factory` record itself is read from; it is a plain-CREATE deployment no
factory made, so no factory can resolve it. **Different authority, not a different source:** the
author Safe's drafts and owner-history modules live in `shared/src/gates/modules.ts`, which also
asks a factory for `draftsModuleAddress` / `ownerHistoryModuleAddress` (:46-60) — there the
predictions are only probe order, and the Safe's `getModulesPaginated` list (:197) with
`supportsInterface` (:149) decide. This change does not touch that path. **Outside this package:**
the operator tools `scripts/lit/fetch-items.ts` and `scripts/lit/probe-archive.ts` still scan by
`NAME()`; they are pinned to the legacy fleet and use the viem helper from `shared`, not this
package's discovery, so the kind-based rule does not govern them. **Gotcha:** returns `undefined`
(not an error) if modules missing — caller must treat falsy `jobs` as failure.

**Slug-change detection (auto `remove`):** for each contentId, prep reads the first (genesis)
version's CID from the on-chain version log (`getVersion(genesis, 0)`), fetches the content item
from IPFS, extracts the old slug, and diffs it against the current slug. The slug is parsed from the
item's `s2s` body (`storedBody`, i.e. `bodies.s2s` on a v3 item, `body` on a v1/v2 item), and an
item with no `s2s` body yields no old slug rather than an error. If the slugs differ, the old
slug path is emitted as a `remove` entry with `replacedBy: contentId`. This replaces the previous
plan of having neutralpress track slug changes in frontmatter — prep is the single auditable
location. The `remove` array flows through `renderwithLitActions` unchanged into the update action.

---

### A2 — `single` `main({ job, signature, authorSafeAddress, configCid, publication, preview, unsigned })`

**Consumes**

| field               | type                                           | source      | notes                                         |
| ------------------- | ---------------------------------------------- | ----------- | --------------------------------------------- |
| `job`               | `S2SJob`                                       | prep output | `{ id, templateConfig, templateData?, html }` |
| `signature`         | hex sig over `hashMessage("lit actions auth")` | caller      | INV-1; recovered to `signerAddress`           |
| `authorSafeAddress` | `address`                                      | caller      |                                               |
| `configCid`         | `string?`                                      | caller      |                                               |
| `publication`       | ENS name                                       | caller      |                                               |
| `unsigned`          | `boolean?`                                     | caller      | true for `dev` and `preview`; skips only the PKP key read inside `addAndSignMetadata`, so the colophon is embedded with its proof options and no `proofValue`. Absent/false keeps the signing attempt. Read by the render action released in 0.1.4; older actions ignore it. |
| `preview`           | `boolean?`                                     | caller      | true for `dev` and `preview`, false for `publish`. Every deployed render reads it for the cache-refresh gate; the 0.1.4 render also uses it to ask `canPreview` instead of `canRead`, and to count an open offer as in force in its revoke guard. |

**Produces** `{ success, timestamp, job, html, logz, errors? }` where `job.html` = CID of the
uploaded page, `job.path` = interpolated slug path, `job.revoked` set when the gate refused the
decryption, or when the genesis is out of force for this mode.

**Sequence (each step is an assertion point for tests):**

1. `extractSignerAddress(hashMessage("lit actions auth"), signature)` → `signerAddress` (INV-1)
2. `getManifest(false)` (in-action) → `S2SManifest` — one `getRecord('manifest')` and one
   `VERSION()` on `PROTOCOL_RECORDS_MODULE` (the host-side reader asks for the same record through
   the batched `getRecords` with that one key), no ENS walk; the record is one JSON document. A
   missing record, bad JSON, a bad shape or a major mismatch fails here with that reason stated
3. `getDomainOwnerAndModules(publication, rpcs, protocolInfo.moduleFactory)` → `{ multisig, configModule, publicationModule }` (INV-4). The factory names both kinds and each answer is kept only when code sits at it.
4. `fetchById(job.id)` → body
5. `getConfig(configCid, configModule)` → config
6. `initTemplateData(...)` → decrypts body if `body.encryption` (gated `canRead`: the publication's
   admission, then ownership of the author Safe at the append block, or live ownership of the
   reader Safe it named; a preview gates on `canPreview` instead, see below); sets `revoked`
7. if not revoked: `fetchCollections` → per-item `decrypt` (the same gate as the run) → `renderHTML` →
   `addAndSignMetadata` (the colophon; PKP sign unless `unsigned`, INV-5) → `uploadFile` → CID
8. if the job is a triggered id and the page has a path: `isRevokedByAgreementState(job.id,
   publicationModule, rpcs, preview)`. A publish revokes when `hasAgreement` is false; a preview
   revokes only when `hasAgreement` and `hasOffer` are both false. A failed read revokes nothing
9. a revoked job: `job.revoked = true`, empty html/path

**Network/chain:** ETHEREUM+BASE reads (modules, config, gates), Lens testnet (body/collections),
IPFS add/cat, **PKP** for `Lit.Actions.Decrypt` and the metadata signature. **Runs on Lit for
`preview` and `publish`, on the Bun runner for `dev` (unsigned).**

**Invariants:** INV-1, 5, 7, 9, and the gates (`canRead` = the publication's own
`canRead(genesis, safe)` **AND** ownership of the reader it admitted, as either the genesis author
at the append block of the manuscript's last version or, for the publication Safe and a reviewer
Safe, the Safe's live owner set). The author half is `canAuthor`, which resolves the block from the
author Safe's drafts module; a Safe whose modules cannot be resolved is refused there, a version
with no height is answered against the Safe's live owner set, and a positive block with no
owner-history module on the Safe is refused with that module named. The other admitted Safes run no
drafts module, so their half is `isOwner(readerSafe, signer)`, read only after the author half
refuses, and a Safe the verdict named as the genesis author never falls back to it. **Preview changes
the decrypt gate and the revoke rule, and nothing else.** With `preview` true the render asks
`canPreview`, which requires an agreement or an offer on every path: `hasAgreement` and `hasOffer`
are read first, and when neither is true the render refuses before any author or Safe read. It then
admits the contract's `canReview(genesis, signer)`, a listed reviewer, which already requires an
agreement or an offer; or the manuscript's author, whose Safe the publication module's
`authorOf(genesis)` records and whose drafts log must name that same Safe, judged by `canAuthor` at
the append block; or an owner of the publication Safe named by the module's `safe()` getter, read
live. The author path is reached before the owner path, and an `authorOf` that is missing, not an
address or the zero address, or a drafts log naming another Safe, refuses the author path alone.
Every read is fail-closed: a throw or a non-`true` answer refuses the question it was asked, and a
`safe()` that is not a usable address refuses the owner path. `publish` keeps `canRead` unchanged. `genesis = toBytes32Id(contentId)` — `toBytes32Id` lives in `@s2s/soul2soul-shared` and is imported at the top of
`gates.ts`. **Gotchas:** GAP-1 (provenance is now built from real signed data in `render/main.ts`, not literals — only the `S2SContentInfo` type-rename tail remains; see the A3 trust TODO for the planned genesis-as-explicit-signed-field addition); the `assets_gateway` shape mismatch (see Gotchas); **GAP-13** (informational) — the Bun shim has no `Lit.Actions.Decrypt`, so a `dev` render cannot open an encrypted body and the app does not offer it for one. A `preview` render runs on Lit for exactly that reason and passes `unsigned: true`, so it decrypts without signing, and that preview is also how a publication reviews an offer. The separate `decrypt` action serves a draft's author and is not a publication read (A1 library table, `libs/author-draft.ts`).

---

### A3 — `updateEvm` (merged) `mergedMain({ signature, authorSafeAddress, publication, jobs, preview })`

**Consumes**

| field               | type                                       | source                          | notes                                                                                                                                                                             |
| ------------------- | ------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signature`         | hex sig                                    | caller                          | INV-1                                                                                                                                                                             |
| `authorSafeAddress` | `address`                                  | caller                          |                                                                                                                                                                                   |
| `publication`       | ENS name                                   | caller                          |                                                                                                                                                                                   |
| `jobs`              | `S2SJob[]`                                 | single outputs (`renderedJobs`) | each has `path` + `html` (CID)                                                                                                                                                    |
| `preview`           | `boolean`                                  | caller                          | true for `dev` and `preview` ⇒ skip the on-chain write; false for `publish`                                                                                                                                                        |
| `remove`            | `{ path: string; replacedBy?: string }[]?` | caller (orchestrator)           | MFS paths to delete — slug **renames** (`replacedBy` = superseding job genesis, validated against `jobs`) or **revocations** (no `replacedBy`). See Sequence + trust model below. |

**Produces** `{ success, cid?, response?, logz }` — `cid` = new site root.

**Sequence:** recover signer (INV-1) → `getManifest` (the document, whose `publicationFactory` is the factory discovery asks for, plus `VERSION()`) → modules (INV-4, with that factory) →
read prev `contenthash_wrapped` via `getText` on `protocolInfo.ensRecords` → `contenthashToIPFS`
(INV-6) → copy prev root into temp MFS → `cp` each job's html CID to `{path}/index.html` →
**`remove` loop** (delete stale paths — see below) → `cp` `config.assetsCid` → `/assets` (INV-11) →
mirror every file in `assets/txt/` to the tree root and drop the stale root txt →
`files/stat` new root → `pin/add` →
**if `!preview`**: `toHexString(root)` + `evmWrite setText(node,"contenthash_wrapped")` with the
**PKP** (INV-10) → `finally` rm temp MFS.

**Tree-path removal (`remove`) — new 2026-08-06:** after the copy loop, before stat+pin, the action
processes `input.remove[]`. For each `{ path, replacedBy? }`: strip leading/trailing `/` (skip
empty / `index.html`); if `replacedBy` is present it must equal a genesis in the incoming
`jobs[].id` set — a **rename** (same content moved to a new path), allowed; a mismatch is skipped
(traced). With no `replacedBy` it is a **revocation**, allowed only while the page's genesis is
out of force and skipped once a deal is in force (the shared `isOutOfForce` is the read). Each
validated entry is `files/rm`'d (recursive) on the temp MFS tree.
**Trust model:** the orchestrator supplies the `remove` list — the same actor that supplies `jobs`
(what to add). No gate stands in front of the loop, because a removal takes away a path the
agreements in force no longer put there. The published tree is the render of the agreements in
force; anything on it that is not that render is drift, and drift is repaired by the press rather
than authorised by a caller. So the loop limits what may go, not who may ask: a path whose genesis
still has a deal in force stays, and a caller nobody trusts can cause the removal of a page nobody
pays for.

**Network/chain:** Kubo MFS/pin on `ipfs.transport-union.dev`; BASE read (`getText`) + BASE write
(`setText`, PKP-signed). **Runs on Lit for `publish`; on the Bun runner for `dev` and `preview`
(`preview=true`, no write).**

**Invariants:** INV-1, 4, 6, 8, 9, 10, 11. **Gotchas:** Kubo `files/cp` does not overwrite — code
`rm`s first; CID is CIDv0 (INV-6 / OPEN-TASK-1). **Tree-mutation integrity gate implemented 2026-08-07** — see §A3 Decision Tree below.

## A3 Decision Tree — update action logic gates (implemented 2026-08-07)

### Gap (why this exists)

Tree assembly moved out of the enclave when `cbor` (in-enclave root-builder) was merged into the
client-supplied-`jobs[]` `update` action (GAP-5 ✅). The merge kept tree-building but dropped the
implicit in-enclave custody over what enters the tree — never replaced with an explicit check.
This closes that gap.

### The chain that already exists (contract → PKP sig → tree)

- Contract `_append` is genesis-author-gated (INV-append): only `genesisAuthor[G]` (or Safe) can put
  a cid at `getLatest(G)`. On-chain identity is an address, authenticated by tx-origin.
- Render fetches `getLatest(G)` and **the PKP signs the rendered output** (`render/metadata.ts`
  `addAndSignMetadata`): `proof.proofValue` is a PKP sig over
  `canonicalize(schema)+canonicalize(proofOptions)`, where the schema commits to **both**
  `encoding.sha256` (sha256 of the HTML body) **and** the genesis (now explicit `identifier` field).
- So a real render output is HTML carrying a PKP sig that simultaneously commits to the HTML bytes
  **and the genesis**. That sig is the render↔update tie — update verifies it.

### Produce side (render/metadata.ts): `identifier` field added

`identifier: id` (the job's genesis/objectId bytes32) added as a top-level field in the JSON-LD
schema. Already covered by the existing PKP sig — signing covers the entire schema, so adding the
field signs it automatically.

### Consume side (update): decision tree

Every incoming job in `jobs[]` must pass **three checks** before its HTML enters the tree.
The remove path runs after the copy loop succeeds (structural execution order).

```
input.jobs[] →  verifyProvenance(htmlCid, id, pkp, gateway)
                    │
                    ├─ !preview ──▶ cat HTML from IPFS ──▶ extract JSON-LD ──▶ checks
                    │                                        │
                    │    ┌───────────────────────────────────┼───────────────────────┐
                    │    │ Check 1: Sig                      │ Check 2: Sha256       │ Check 3: Genesis
                    │    │ recoverAddress(                    │ recompute             │ schema.identifier
                    │    │   keccak256(                       │ sha256(html body)     │ == expectedGenesis
                    │    │     canonicalize(schema) +          │ == schema.encoding.   │ (job.id)
                    │    │     canonicalize(proofOptions)      │   sha256              │
                    │    │   ), proofValue)                    │                       │
                    │    │ == protocolInfo.pkp                │                       │
                    │    └───────────────────────────────────┼───────────────────────┘
                    │                                        │
                    └─ all pass ──▶ cp (add to tree)
                      └─ any fail ──▶ throw (reject entire update)

                                          NON-PUBLISHING PATH (runner, no getPrivateKey):
                                          preview=true (dev, preview) → skip verify entirely → cp anyway

                                          SLUG OVERWRITE check (before rm+cp):
                                          if existing entry at destPath and !preview:
                                            │
                                            ├─ readGenesisAtMfsPath(destPath)
                                            │   → extract schema.identifier
                                            │
                                            ├─ existingGenesis == incomingGenesis?
                                            │   └─ YES → allow (same page re-render)
                                            │
                                            └─ NO → hasAgreement(genesis) on publicationModule?
                                                    │
                                                    ├─ true → throw (refuse overwrite)
                                                    │   Path is occupied by deal-protected content
                                                    │   from a different genesis. Buyers paid for
                                                    │   that content; silent replacement steals it.
                                                    │
                                                    └─ false → allow (rm + cp)

input.remove[] →  per-entry (parallel)
                    │
                    ├─ sanitizeRemovePath(path) ──▶ rejects: .. traversal, reserved roots
                    │                                    (assets, index.html, empty)
                    │
                    ├─ replacedBy? ──▶ YES ──▶ jobGenesisSet.has(replacedBy)?
                    │                                │
                    │                                ├─ YES (rename) ──▶ files/rm
                    │                                │    Rename = content moved to new
                    │                                │    path. Same genesis, deal unaffected.
                    │                                │    No hasAgreement check needed — content
                    │                                │    wasn't removed, just relocated.
                    │                                │
                    │                                └─ NO  ──▶ skip (trace: unknown genesis)
                    │
                    └─ replacedBy? ──▶ NO (revocation) ──▶ !preview?
                                                              │
                                                              ├─ false (preview) ──▶ files/rm
                                                              │
                                                              └─ true (Lit path)
                                                                   │
                                                                   ├─ readGenesisAtMfsPath(gateway,
                                                                   │     mfsRoot+path+"/index.html")
                                                                   │   → extract schema.identifier
                                                                   │
                                                                   ├─ toBytes32(genesis)
                                                                   │
                                                                   ├─ hasAgreement(bytes32) on publicationModule
                                                                   │     │
                                                                   │     ├─ true  → skip (trace: active deal)
                                                                   │     │   Content under active deal is
                                                                   │     │   immutable by anyone. Deal must
                                                                   │     │   be revoked first by the striking
                                                                   │     │   author or publication admin.
                                                                   │     │
                                                                   │     └─ false → files/rm (allowed)
                                                                   │
                                                                   └─ MFS read fails (no JSON-LD,
                                                                      pre-gate content, garbage)
                                                                      → skip remove (trace)
                                                                        Conservative: can't determine
                                                                        genesis → can't check hasAgreement
                                                                        → can't prove safe to remove.
```

Every `hasAgreement(bytes32)` read in this section is the module's one agreement boolean, asked by
`verifyPathAvailable`, `verifyRevocable` and the render revoke guard from bundle **0.1.2**; 0.1.0/0.1.1
ask for `hasDeal`, which the module does not expose.
The render revoke guard has two shapes. A publish asks `hasAgreement` alone, so an ended agreement
is a revoke. A preview asks `hasOffer` as well and revokes only when both are false, so an open offer
is not a revoke; it also keeps the page live when either read fails, as the publish guard does on its
one read.

### Execution order (structural invariant)

```
1. per-page gate in the copy loop: add needs canPublish ∧ isOwner, refresh is ungated
2. copy loop:  verifyProvenance() for each job → path gate → cp
3. remove loop: sanitizeRemovePath() → replacedBy | isOutOfForce → files/rm
4. assets copy → root txt mirror (every file in assets/txt → root; stale root txt cleared)
5. stat root → pin → setText on-chain
6. finally: rm temp MFS
```

Steps 2 and 3 are sequential: copy loop succeeds → jobGenesisSet is all-verified → remove loop
trusts it. If copy loop throws, remove loop never runs.

### Soundness subtleties

- **Check 2 (sha256) is mandatory, not optional.** The PKP signs the schema, not the HTML; `sha256`
  is what binds schema→bytes. Skip it → graft attack: stolen signed schema wrapped around junk HTML
  passes. 1+2 together = "PKP signed _this_ HTML claiming _this_ genesis."
- **`canonicalize` must be identical on both sides (GAP-2).** Top-level key sort, current quirk.
  Co-evolve or share the function; a one-sided GAP-2 "fix" silently breaks every sig.
- **A non-publishing tree is unsigned by design (INV-7/GAP-6).** The render action skips only
  the PKP key read when `unsigned` is true, so a page from `dev` or `preview` carries the full
  colophon with a proof that has no `proofValue`; a `dev` render through an older pinned action
  instead lets the shim's `getPrivateKey` throw, and the catch emits the same proof options. The
  update action therefore enforces the verify gate only on the Lit/publish path (`if (!preview)`),
  and the runner path copies pages unverified. Bonus: preview HTML can never enter the prod tree
  (OPEN-TASK-2's flip side).
- **Copy loop succeeds before remove loop runs.** If any job fails verification the entire update
  rejects, so `jobGenesisSet` always contains verified HTML. The rename guard
  `jobGenesisSet.has(replacedBy)` transitively proves the target is verified.
- **Remove-revoke (`!replacedBy`) checks `!hasAgreement` on-chain — not authorship.** Any caller,
  trusted or not, can remove any path that has no active deal. "Author A can only remove Author B's
  content when there is no deal — when B or the publication revoked the deal first." Deal revocation
  is an on-chain operation performed by the deal-striking author or publication admin before the
  update action runs.
- **Rename (`replacedBy`) does NOT check `hasAgreement`.** A rename changes the tree path but preserves
  the content — the deal references the genesis, not the path. Buyer still gets what they paid for
  at the new slug.
- **Pre-gate content (no JSON-LD schema) is conservatively skipped.** The MFS read
  fails, `verifyRevocable` throws, the remove is skipped (traced). Without a genesis to pass to
  `hasAgreement` the action can't confirm the content has no active deal, so it refuses the removal.
  Pre-gate content can be removed once a deal is revoked by calling `remove` with `replacedBy`
  set to a verified genesis arriving in the same update (rename the pre-gate path through
  verified content).
- **Slug-overwrite deal check (`verifyPathAvailable`):** before `rm`+`cp` for an existing path,
  the copy loop reads the existing HTML's JSON-LD, extracts its genesis, and calls `hasAgreement`
  on-chain. If a deal exists **and** the incoming genesis differs, the update throws. This
  prevents an author from overwriting deal-protected content with their own content. Same-genesis
  re-renders are exempt (the page just updated, deal unaffected). A non-publishing run
  (`!preview`: `dev`, `preview`) skips this check.

### What this does NOT need

- No new on-chain path→genesis index (sig carries genesis; contract already gates author; path is a
  render artifact per slug-override, not a content property — binding it on-chain fights the model).
- No re-verifying the PKP sig in the copy loop or remove loop (add loop gated the entry; remove
  loop parse-trusts it). Exception: the **copy loop** reads the existing entry's JSON-LD to check
  `hasAgreement` — but that reads genesis, not re-verifying a sig.
- No author signing of `jobs`/`remove` (PKP sig per-HTML is the stronger integrity proof and already
  exists; "sign the jobs" only binds who approved the list, not that the claims are true —
  superseded).

### Orthogonal hardening (implemented)

- **`..` path traversal:** `sanitizeRemovePath()` rejects any segment equal to `..` — splits on `/`
  and checks each component.
- **Reserved roots:** `sanitizeRemovePath()` blocks removal of `""`, `index.html`, and `assets` by
  name — the assets-copy runs after the remove loop and can't heal a missing root.

### Slug-change detection (auto — no client wiring needed)

Slug changes are detected automatically by prep, which reads the first version's CID from the
on-chain version log, fetches the content item from IPFS, and diffs the old slug against the
new one. No neutralpress changes needed. See §A1 Produces for details.

### Source files

| File                                      | Role                                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `protocol/actions/src/update/verify.ts`   | `verifyProvenance()`, `verifyPathAvailable()`, `sanitizeRemovePath()`, `readGenesisAtMfsPath()`, `verifyRevocable()` |
| `protocol/actions/src/update/main.ts`     | Caller — integrates checks into the job loop and remove loop                                                         |
| `protocol/actions/src/render/metadata.ts` | Produce side — `identifier` field added to JSON-LD schema                                                            |

---

## Ripples vs collections (two distinct mechanisms — do not conflate)

These are easy to confuse and are _not_ the same thing.

**Collection** = data pulled _into_ a page _while it renders_. Declared on a `templateConfig`
(`collections[]`), fetched in `single` by `fetchCollections` (e.g. the `home` template has a
`posts` collection via `queryByFeed`, so the rendered home page lists posts). A collection affects
the _content of one page_.

**Ripple** = a _cascade re-render rule_: when content of some `postType` is published, **other
pages must be regenerated** because their rendered output embeds/lists that content. A ripple
produces _additional jobs_, not in-page data. Example: publishing a `post` ripples to `home`,
because the home page shows the latest posts — so `home` must be re-rendered too.

`S2SRipple = { origins: string[]; destination: string; reference: string; query: {method,args} }`

- `origins` — the `postType`s that _trigger_ this ripple (selected in `getTaskConfig` via
  `ripples.filter(r => r.origins.includes(body.postType))`).
- `destination` — the `templateConfig.reference` to render the cascaded page with (e.g. `home`).
- `query` — how to locate the destination page(s) to re-render; the destination page is itself a
  Lens post (e.g. the home page has a fixed Lens `postId`), fetched via `fetchByQuery`.
- `reference` — present in the type/config but **unused** in `prep` (only `destination` + `query`
  are read); likely redundant/legacy — confirm before relying on it.

**How it runs (prep):** for the primary body, push its job; then _only if a single contentId was
requested_, for each matching rippleConfig: `fetchByQuery(query)` → destination page(s), look up
the `destination` template, push a job per destination page. Dedupe by `id`. The cascaded job then
flows through `single` like any other — and _its_ collections pull the now-current data (so the
freshly published post appears in home's `posts` collection). **Ripple + collection thus compose:**
the ripple says "re-render home"; home's collection says "list the latest posts."

**Behavioral gotcha to confirm:** ripples expand **only** for `contentIds.length === 1`. A bulk
render (multiple ids) skips cascade expansion — presumably because a full render already covers the
dependent pages, but it means publishing N>1 items in one batch will _not_ trigger a `home`
re-render on its own. Verify this is intended, not a stale-page hazard.

_Doc drift:_ `action-flow-diagram.md` describes ripples via `getRipplesOnce` from OrbisDB — stale
(Ceramic era), same drift noted in SPEC-00 Q5. The action-path data source has since moved again:
Lens `fetchByQuery` → `module.factory` (`getAgreements` / `fetchByPublication`, GAP-10 ✅). The
cascade/ripple expansion logic in `prep` needs re-confirmation against current code before this
section is relied upon.

---

## Library I/O (boundary descriptions for unit tests)

| fn                                                                                    | in              | out                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getManifest(dev, rpcs?)`                                                             | `boolean`, RPCs? | `S2SManifest` — one `getRecord('manifest')` on the `PROTOCOL_RECORDS_MODULE` constant, parsed as the JSON document, then one `VERSION()` the document's major and minor must equal; `publicationFactory` and `moduleFactory` are the same field of that document, so there is nothing left to reconcile                                                                                                              |
| `getDomainOwnerAndModules(pub, rpcs, factory)`                                        | `pub`, rpcs, factory | `{ multisig, configModule, publicationModule }` (null per kind the factory cannot name) — one `moduleAddress(safe, kind)` per kind, kept only when `evmGetCode` finds code; a throwing factory read propagates                                                                                              |
| `getConfig(configCid?, configModule)`                                                 | cid?/addr       | `S2SPublicationConfig` (parsed JSON)                                                                                                                                                                                                                                                                        |
| `getTaskConfig(config, body)`                                                         | config, body    | `{ templateConfig, rippleConfigs }` (throws if no mapping)                                                                                                                                                                                                                                                  |
| `fetchById(genesis, pubModule, rpcs, gateway)`                                        | bytes32 genesis | `S2SBody \| undefined` — `getLatest` → IPFS cat → `toBody` (`module.factory`, GAP-10 ✅)                                                                                                                                                                                                                    |
| `fetchByPublication(pubModule, rpcs, gateway)`                                        | module addr     | `S2SBody[]` — `getAgreements` (paginated) → cat each → `toBody`                                                                                                                                                                                                                                                  |
| `getAgreements(pubModule, rpcs, pageSize=100)`                                        | module addr     | `Entry[]` — enumerates the publication's agreements, the module read being `getAgreements(offset, limit)`, which the helper asks for by that name from bundle 0.1.2 (0.1.0/0.1.1 ask for `getDeals`); `pageSize` defaults to **100** (was 200, briefly 10) to keep each RPC response minimal inside the Lit fetch budget                                                                                                                                                        |
| `initTemplateData(protocolInfo, authorSafe, signer, templateConfig, body, pubModule)` | —               | templateData `{ ...body, assets_gateway, path, content(unescaped), revoked }`                                                                                                                                                                                                                               |
| `fetchCollections(templateConfig, pubModule, rpcs, gateway)`                          | templateConfig  | `{ [slug]: items[] }` — calls `fetchByPublication` **once**, caches in `allDeals`, filters per-collection in-memory (Lit fetch-budget fix; previously one `getAgreements` call per collection)                                                                                                                        |
| `renderHTML(config, templateConfig, templateData)`                                    | —               | `string` (HTML)                                                                                                                                                                                                                                                                                             |
| `addAndSignMetadata(id, html, protocolInfo, contentInfo?)`                            | —               | `string` (HTML + signed JSON-LD)                                                                                                                                                                                                                                                                            |
| `canPublish(authorSafe, pubModule, signer)`                                           | —               | `boolean` (canPublish ∧ `isOwnerAt` with no block) — the **add** gate, asked per page: a destination path that does not yet carry the incoming genesis                                                                                                                                                                        |
| `canRead(contentId, safe, pubModule, signer)`                                         | —               | `boolean` (the publication's `canRead(genesis, safe)` ∧ either `canAuthor`: ownership at the append block of the manuscript's last version, live `isOwner` when the log records no height, refusal when the Safe's modules cannot be resolved, **or** live `isOwner` of the reader Safe the publication admitted, for the publication Safe and reviewers) |
| `canPreview(contentId, pubModule, signer, rpcs?)` | — | `boolean` — the preview decrypt gate, which requires `hasAgreement` or `hasOffer` for every path and refuses before any further read when neither holds: the contract's `canReview(genesis, signer)`, a listed reviewer under an offer or an agreement; **or** the manuscript's author, whose Safe the module's `authorOf(genesis)` records and whose drafts log must name that same Safe, judged by `canAuthor` at the append block; **or** live `isOwner` of the publication Safe the module's `safe()` getter names. The author path comes before the owner path. Fail-closed: a throw or a non-`true` answer refuses the question it was asked, an `authorOf` that is not a usable address or a drafts log naming another Safe refuses the author path, and a `safe()` that is not a usable address refuses the owner path |
| `canAuthorVerdict(genesis, safe, signer)`                                             | bytes32 genesis | `CanAuthorVerdict` — `ok` plus what the answer was read from: `block`, `ownerSet` (`append-block` \| `live`), `modules`, `modulesError`, `author`. One call for the whole author question; the decrypt action reads the entry from it                                                                          |
| `isOutOfForce`                                                                        | `bytes32 genesis` | `boolean` — no deal in force for the genesis. The **remove** limit: a page whose genesis is out of force may come off the tree, and no gate asks who is asking                                                                                                                                                |
| `decrypt(pkpId, body, authorSafe, pubModule, signer, rpcs?, { preview })`                                 | —               | decrypted obj \| false (gated by `canRead`, or `canPreview` when `preview` is true)                                                                                                                                                                                                                                                                 |
| `evmRead(chain, addr, abi, method, args, rpcs?)`                                      | —               | call result — **catch-all failover**: tries each URL in `rpcs[]`, collects every failure in `failures[]`, throws one aggregated `Error` (`.failures` attached) on total failure. No transport-vs-revert distinction (attempted & reverted — ethers v5 wraps `SERVER_ERROR` as `CALL_EXCEPTION`; see GAP-15) |
| `evmWrite(chain, pkp, addr, abi, method, args, confirm?)`                             | —               | `{ success, hash, ... }` (PKP-signed)                                                                                                                                                                                                                                                                       |
| `toHexString(cid)`                                                                    | CIDv0 or CIDv1  | `0xe30101…` contenthash, **always CIDv1** (INV-6); a CIDv0 root is normalised with `toV1()` (same multihash)                                                                                                                                                                                                                                                                               |
| `contenthashToIPFS(hex)`                                                              | contenthash hex | CIDv0 string (INV-6)                                                                                                                                                                                                                                                                                        |
| `uploadFile(str)` / `catFile(cid)`                                                    | —               | CID / text (Kubo `add`/`cat`)                                                                                                                                                                                                                                                                               |

## Key data shapes (capture these as fixtures)

- **`S2SBody`** (from `formatSingle`): discriminated union — `S2SBodyPlain` (`encryption: false, content, title, slug, custom?`) / `S2SBodyEncrypted` (`encryption: true`, no plaintext fields). Common base: `id, author, locale, parent, position, postType, creationDate, modifiedDate, tags[]`.
- **`S2SJob`**: `{ id, templateConfig: S2STemplateConfig, templateData?, html: string, path?, revoked? }`.
- **`S2STemplateConfig`**: `{ reference, path (may contain `{slug}`), collections?[], ... }`.
- **`S2SPublicationConfig`**: `{ mapping: { templateConfig[], ripples[] }, assetsCid?, ... }`.
  Canonical example: **`website-starter/mapping.json`** (the downloadable starter; the live
  showcase `s2s/sentiment` is an external repo). A `collection` is
  `{ slug, source:"lens", key, value, query:{method,args}, filters:[{...}] }`.
  ⚠ `mapping.json` embeds **publication-specific identifiers** (collection `feedAddress`, ripple
  destination `postId`). **Currently** the safe-app `ConfigBuilder` uses `mapping.json` verbatim, so
  they are author-owned in the publication's repo. **Planned (admin-app TODO):** `ConfigBuilder`
  should inject the `feedAddress` at build time. Until then, a copied `website-starter` carries
  someone else's values.
- **`S2SManifest`**: `{ addr, recordsModule, dataGateway, assetsGateway, lensApp, ensRecords,
pkp{ethAddress,publicKey,tokenId}, litActionPrep/Single/Cbor/RootUpdate }`.

---

## Invariants this component must preserve

INV-1 (auth string), INV-2 (record keys — see the duplicate-`getManifest` gotcha), INV-4
(module discovery through the factory), INV-5 (provenance canonicalization), INV-6 (contenthash
codec), INV-7 (runtime-agnostic), INV-8 (action CID ↔ group), INV-9 (Base/8453 hardcoded), INV-11
(assets→/assets).

## Local gotchas (component-specific, beyond SPEC-00 gaps)

- **Root txt mirror (update action, not an invariant).** The owner-controlled `assetsCid` may carry a
  `txt/` directory; every FILE in it is mirrored to the tree root, so the site answers both
  `/assets/txt/<name>` and `/<name>`. The directory is the opt-in, not an extension: `robots.txt` and
  `llms.txt` are the usual two, but any file in `assets/txt/` is mirrored. A name that is not a
  single path segment (`.`, `..`, or anything containing `/`) is refused before it touches a path,
  and a root `index.html` in any casing is never a target. Where a page's slug already owns the
  path — a directory at the root — the page wins: the file is skipped, and the path is never removed
  recursively. A copy failure is fatal; a publish must not silently keep last run's `robots.txt`. A
  root txt name the previous tree carried that the new `txt/` no longer holds is removed from the
  root — non-recursive, and a failed `rm` is a trace rather than a failure — so deleting the file
  upstream, or dropping `assetsCid` altogether, does not leave it published forever. The `ls` of
  `assets/txt` is fatal on any failure other than kubo's "file does not exist": only an absent
  directory may read as "no root txt", or a broken call would publish a site with no `/robots.txt`.
- **Shape mismatch (illustrative of the whole testing rationale):** `getManifest` returns
  `assetsGateway` (camelCase); `initTemplateData` reads `protocolInfo.assets_gateway` (snake) →
  silently `undefined`. Likely vestigial post the assets-into-`/assets` refactor (templates now use
  root-absolute `/assets/...`), but confirm. **This is exactly the bug class boundary fixtures catch.**
- **Two `getManifest`:** `libs/protocol.factory.ts` (ethers/evmRead, in-action) and
  `shared/src/protocol/index.ts` (viem, client). Same record-key _set_, but **different field
  _order_ in each destructure** — each is internally consistent, but the key set must stay in sync
  (INV-2). Both are typed `S2SManifest` (the action takes the type from
  `@s2s/soul2soul-shared/lit-actions`, never the viem reader), so a shape drift is a compile error
  rather than a silent `undefined`. Named *manifest* because the protocol is Polyphony and this is
  one implementation's list of references to code, not the code. The in-action one walks no ENS: it reads the `publication_factory` record on the
  constant and the records on the constant (see the records-module gotcha), so it has no `dev`
  branch and no `configModule` to check (cf. GAP-8).
- **Lit action ABI fragments (module.factory.ts):** the generated ABIs at
  `protocol/contracts/generated/abis/S2SPublicationModuleV2.ts` are not importable by esbuild Lit
  action bundles. Hand-copy only the needed function fragments into `module.factory.ts` using the
  full JSON `components` format (not human-readable ABI strings — ethers v5 in the Lit runtime can't
  decode struct returns from them). When the contract changes, update fragments in that one file.
- **The one ENS walk left (redundant-walk note, 2026-08-06; settled 2026-11-16).** `getManifest` walks
  nothing: both readers read the `manifest` record and `VERSION()` on `PROTOCOL_RECORDS_MODULE`, the
  action side with `getRecord` and the host side through the batched `getRecords` on that one key. The third
  walk (`parentDomainController`) and the records-only discovery path that used it are gone with it.
  What remains is `getDomainOwnerAndModules`' two-hop walk (`nameWrapper()`→`ownerOf()`) for the
  publication Safe, and the document read on the constant.
- **The document, not a key set (2026-11-17).** The manifest is one record, `manifest`, holding a
  JSON document with its own `version`. The keys it replaced (`data_gateway`, `lit_action_prep`, …)
  are gone: `update-protocol.ts` writes the document and its mirror and nothing else. The mirror is
  `manifest@x.y.z`, version history: a reader pinned to a release finds the document it was
  written for, and a retained version may name CIDs the Lit group has since removed — the group's
  action list decides what runs, not the record. The record and its `@` mirror are the records
  module's version of this, and they are a stopgap: the manifest module below replaces both with one
  document per version and no key convention, so the mirror is not carried forward.
- **Version agreement.** Three numbers, one meaning. The document names `x.y.z`: major changes when
  the document's shape changes, the second when an optional field is added, the third when a value
  moves, an action CID or an address. A CID change is a small bump, so it lands in the third digit.
  The contract carries the manifest version's major and minor and nothing else: `VERSION()` on
  `S2SRecordsModuleV0_1` returns `"0.1"`, and the suffix is that pair joined by an underscore,
  `V0_1`, never the patch and never `x.y.z`. A contract refactor moves that number; a document
  bump inside `0.1` does not, because the module is not redeployed when the document moves. Every
  reader compares the document's major and minor to `VERSION()` and throws on a difference rather
  than guessing.
  `update-protocol.ts` builds the document with a plain `MANIFEST_VERSION` constant and asserts it
  against `VERSION()` before the batch, which is what keeps the hardcoded address safe.
  The first document is `0.1.0`, and only `0.1` has ever been written: nothing is live, so there is
  no old document to read and no compatibility path from one.
- **The manifest has its own kind, and its own module (2026-11-17, written; not deployed).**
  `src/manifest/src/S2SManifestModuleV0_1.sol` is the document's contract, in its own package beside the
  contracts: `pnpm compile`, `pnpm test` and the four scripts (`deploy:impl`, `set:impl`,
  `create:module`, `upgrade:module`) live there, and nothing about it is in the publication package
  except the factory it is approved by. The three calls the safe has to make are proposed to it the
  way the writer proposes: `PROTOCOL_PRIVATE_KEY` signs a batch on the Safe Transaction Service and
  prints the transaction hash; `--json` and `--data` print the same call for a machine that cannot
  reach the service. `setManifest(version, json)` writes an `x.y.z` beside the
  JSON, `getManifest()` answers the live version and document in one call by reading
  `jsonByVersion[currentVersion]` (the document is stored once), `getManifest(version)` answers a
  published one, `getVersions()` enumerates them in publish order. `ManifestSet` carries
  `keccak256(version)` as an indexed topic and `keccak256(json)` as the data, so an indexer filters
  by version and fetches the document once.
  **One version, and it is the document's.** The module has no `VERSION()`: it cannot tell one
  document shape from another, so a constant claiming a major would have to be kept in step with
  stored history by every upgrade, and a mismatch would make a document unreadable. The document
  names its own major, a reader that only understands major 1 refuses a 2.x document itself, and a
  major bump is a new writer rather than a new contract. The name still carries the manifest's major
  and minor, `V0_1`, so a reader can pair the contract it found with the document it reads; the
  `x.y.z` itself lives in the document and in `setManifest`'s argument.
  **What the contract enforces:** `x.y.z` only, three digit segments, no leading zeros
  (`LeadingZero`), a version written once (`VersionExists`, so repointing a CID is a new third digit
  and a pinned read never changes answer), and strictly increasing across `(major, minor, patch)`
  (`VersionNotIncreasing`), so the last entry is always the live one.
  **The dev lane.** A version prefixed `d.` is a build under test: `d.x.y`, two numbers, ordered only
  against the other dev versions, never the live document, never in `getVersions()`. It is read by
  name or by a publication's pin, so a test is tried against the real deployment without consuming
  the release number that replaces it, and a release after it is compared with the release line and
  not with the test (`d.0.1`, then `0.1.5` is fine). Storage gained `devVersion` and its three
  numbers, appended after every earlier slot.
  `getVersionAt` refuses an index with `IndexOutOfBounds`, `initialize` refuses a zero Safe, and
  `supportsInterface` reports the module's own id plus ERC-165 because the interface inherits
  `IERC165`.
  **The upgrade is `upgradeTo`.** OZ 4.9's `upgradeToAndCall` force-calls the new implementation even
  with `0x`, and this module has no `receive` or `fallback`, so the empty form reverts
  `Address: low-level delegate call failed`; a Safe wraps that as GS013, which names nothing.
  `pnpm upgrade:module --simulate` runs the call from the Safe as a bare `eth_call` and prints the
  revert before anything is proposed.
  **Storage.** The proxy holds the document, its version and history; upgrades move code only, so a
  future implementation must append variables and never reorder them. The owning Safe cannot change;
  a migration is an upgrade.
  **State:** the contract compiles, has twelve node tests in `src/manifest/test`, and is in no
  deployment. The readers still read `manifest` from the records module; `PROTOCOL_RECORDS_MODULE`
  becomes `MANIFEST_MODULE` once the module exists on Base, and the two disagree only about where
  the document lives until then, not about its shape.
- **Read cost and gate ordering.** Every action starts with `getManifest` — one `getRecord('manifest')`
  and one `VERSION()` on the hardcoded module — and discovery takes its factory from that document,
  so there is no separate factory read and nothing to reconcile. An action that gates after
  discovery pays the document read before the gate: two requests, where `main` paid the full walk.
  A read costs one request per RPC URL tried, so a second URL adds a request only where the earlier
  one fails, and nothing is retried in-session. Most of these reads are L2 and the walk is L1. The
  isolated bounds below assume one URL per chain. `getDomainOwnerAndModules` at most 6 (2 walk, one
  `moduleAddress` per kind, one `evmGetCode` per non-zero answer); `getManifest` 2. Per action that
  is a fixed prologue, one URL per chain: prep, render, update, maintain-cache and repoint-archive
  8 each (the document read plus `VERSION`, at most 6 for discovery).
  Against `main`: prep 6 → 8, render 11 → 8, and update, maintain-cache and repoint-archive 12 → 8.
  `main` spent the difference on a module-list read plus role and `NAME()` probes, and on a
  five-request protocol path.
- **The manifest read from a hardcoded records module (2026-11-13):** `getManifest` calls
  `getRecord("manifest")` on `PROTOCOL_RECORDS_MODULE`
  (`0xBB0BBd828c19502a8fCFbF07f5ACEcd8E8641D29`, `libs/protocol.factory.ts`), the Base records
  module `update-protocol.ts` writes to. That constant is the one place a redeploy can drift: point
  it at a retired module and `getRecord` answers the empty string there, so **every action fails**
  with `manifest: no 'manifest' record` and no other trace. Change the constant with the
  records-module redeploy, and keep it in step with `press/scripts/lit/update-protocol.ts`
  (`RECORDS_MODULE_ADDRESS`).
- **Lit enclave fetch budget (fixed 2026-08-06):** Lit nodes have an internal fetch budget
  exhausted by **repeated identical RPC calls**, not response size. The enumeration read — named
  `getDeals` then, `getAgreements` from bundle 0.1.2 once the contract renamed the set — returns a
  dynamic `tuple[]`, and calling it 3+ times returned `"missing response"` (empty body) from both
  DRPC and Alchemy. `fetchCollections` previously called `fetchByPublication` (→ that enumeration)
  **once per collection**; it now fetches **once** and filters per-collection in-memory. The
  helper's `pageSize` (100, lowered from 200) supplies the read's `limit`: it is a helper
  parameter (`module.factory.ts`), not an argument of `getAgreements(offset, limit)`. Lesson:
  inside a Lit action, never issue N identical on-chain reads — fetch once and filter locally.
- **Hardcoded secrets (GAP-9) — action-side resolved 2026-08-07:** `libs/constants.ts` (and
  `renderer/constants.ts`) deleted; gateway + RPCs now arrive via the `endpoints` action input,
  not hardcoded. Zero secrets in `actions/src`. Remaining: orchestrator `rpcs` source unwired
  (handoff §6) + rotate the previously-exposed keys. See SPEC-00 GAP-9.
- **Lens gone from the action path (GAP-10 ✅):** `api.testnet.lens.xyz` is no longer called by
  actions (`lens.factory.ts` → `module.factory.ts`). Lens remains only on the authoring side.
- **Provenance (GAP-1):** `render/main.ts` builds the metadata from real signed data (`author.address`
  from the signed `S2SPublicContent`, `contentCid = body.id`, `isBasedOn.genesis = toBytes32Id(body.parent)`);
  PKP-signed in `render/metadata.ts`. The author identifier is a JSON-LD `PropertyValue` node
  naming a CAIP-10 account id: `propertyID: 'CAIP-10'`, `name: 'Safe smart account'`,
  `value: 'eip155:8453:<authorSafeAddress>'` — the address exactly as the item carries it, chain
  id from one constant in `render/metadata.ts` (the same one the PKP `verificationMethod` uses).
  The `publication` node mirrors it: one `propertyID: 'CAIP-10'` PropertyValue naming the
  publication Safe (the `multisig` `getDomainOwnerAndModules` returns), plus `name` holding the
  publication's ENS name. The render signer appears nowhere on the `publication` node — it is the
  proof's `verificationMethod`; the retired `address` / `address:safe` pair is gone, and the node
  key that was `publisher` is now `publication` (old pages keep the retired key; nothing reads the
  term).
  `update/verify.ts` reads the author identity through
  shared's `accountAddress()` and selects by value shape, not by term, so a page pinned before
  either change still reads as the same address. GAP-1's only remaining tail is the
  `S2SContentInfo` type-rename.
  The A3 trust TODO plans adding the genesis as an explicit signed field (currently implicit via
  `contentUrl`'s `body.cid || body.id` fallback).
- **Canonicalization (GAP-2):** `render/metadata.ts` sorts only top-level keys.
- **Dead code:** `__renderer/`, most dag/cbor helpers in `ipfs.factory.ts`,
  `processBase`/commented base-merge in `render/data.ctrlr.ts`.

## Safe-to-change vs do-not-touch

- 🟢 Handlebars templates/helpers, RPC URLs, timeouts, log lines, dead code removal.
- 🔴 The `"lit actions auth"` string; record-key names/set; the contenthash
  codec; the canonicalization in `metadata.ts`; anything that makes an action depend on a Node
  built-in (breaks INV-7); writing a CIDv0 root as-is (`0xe3010070…`), which no standard contenthash parser accepts, so
  eth.limo refuses the name.

---

## Test coverage (seam/invariant → test → status)

> The I/O tables in §A are fixture definitions; this section records **which tests exist and their
> status**, so gaps surface in the spec rather than only at runtime. Statuses: ✅ covered, ⚠ stale,
> ⛔ missing, ⊘ skipped. **The action tag ≠ dir ≠ config name** (see §Sub-component map): dir/config
> `render`/`update` emit tags `'single'`/`'evm-update'` — tests assert the tag.

| Seam / invariant                                                               | Test file                                | Status                | Note                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ---------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --------------------------------------------------------- | ------------------------- | --------- | --------------------------------------------------------------------------------------- |
| `ActionResult` envelope (ok/action/trace; fatal-vs-non-fatal; `requireFields`) | `shared/src/rendering/action-io.test.ts` | ✅                    | shape-only, Lens-era fixtures but value-agnostic                                                                                                                                                                                                                                                                                                                                                                  |
| dev `prep→single→update` sequence (Bun runner, no gates)                       | `shared/src/rendering/sequence.test.ts`  | ⚠ **stale + blocked** | (1) hardcodes Lens-era `SINGLE_POST` (decimal post id) but `prep` now calls `fetchById(genesis)`→`getLatest(bytes32)` — a decimal id breaks ABI encoding; (2) ignores the `TEST_CONTENT_IDS` env var `.env` already provides; (3) `MAINNET_RPC_URL`/`BASE_RPC_URL` absent from `.env` → `chainReady=false` → live tests **silently skip**. Fix: read `TEST_CONTENT_IDS`, set RPC env, use a real bytes32 genesis. |
| dev sequence shape contract (prep→single input handoff)                       | `sequence.test.ts` “seam contract”       | ⚠ stale               | inherits the same `SINGLE_POST` fixture                                                                                                                                                                                                                                                                                                                                                                           |     | non-fatal trace survives (ok:true + trace, no error join) | `sequence.test.ts` Test 3 | ⊘ skipped | `describe.skip` — TODO, never authored. The fatal-vs-non-fatal rule (§I/O) is untested. |
| stage-failure envelope (ok:false, string error, no throw)                      | `sequence.test.ts` Test 4                | ✅ (gated)            | runs only when `chainReady`; covers a no-modules publication                                                                                                                                                                                                                                                                                                                                                      |
| stage transport per render mode + preview capability gate                     | `sequence.test.ts` (mode blocks)         | ✅                    | mocked `runAction`: runner/Lit per stage for `dev`, `preview`, `publish`; `preview`/`unsigned` input values; `preview` without `capabilities.unsignedRender` throws before any dispatch |
| preview decrypt gate + preview revoke guard                                       | `press/actions/src/libs/decrypt.test.ts`, `render/revoke-guard.test.ts` | ✅                    | `decryptRaw` asks `canPreview` in a preview and `canRead` otherwise, and refuses on either answer; the guard asks only `hasAgreement` on a publish, keeps an offer-only genesis in a preview, revokes a preview only when both reads are false, and keeps the page live when either fails. `canPreview`'s three paths and its fail-closed reads are covered in `shared/src/gates/index.test.ts` |
| INV-append / `makeOffer` / `hasAgreement` on-chain gating (the trust boundary)      | —                                        | ⛔ **missing**        | no `.t.sol`, no Hardhat tests under `protocol/`. The genesis-author append gate (INV-append) is entirely untested on-chain.                                                                                                                                                                                                                                                                                       |
| INV-8 desync (records-updated-but-group-not, and inverse)                      | —                                        | ⛔ missing            | flagged as a contract test in §Test seams; not authored                                                                                                                                                                                                                                                                                                                                                           |
| GAP-2 canonicalization (nested-key sort → verify fail)                         | —                                        | ⛔ missing            | flagged; not authored                                                                                                                                                                                                                                                                                                                                                                                             |
| determinism (frozen clock: `metadata.ts` `new Date()`, `update` `Date.now()`)  | —                                        | ⛔ missing            | output CIDs non-deterministic; no clock injection                                                                                                                                                                                                                                                                                                                                                                 |

### Fixture requirement (dev-path test unblock)

`contentIds` is a **bytes32 genesis**, not a Lens post id. Live fixture (from a real publish on
`s3nl.soul2soul.eth`, makeOffer tx `0x6d10f033…`):

- **publication:** `s3nl.soul2soul.eth` (`.env: TEST_PUBLICATION`, len 18)
- **genesis / contentId:** `0x9a1600a648241726b0470d0b0b85df1d166e0aa74b88789b5f569294baa5a063`
- **env vars present in `.env`:** `TEST_PUBLICATION`, `TEST_PRIVATE_KEY`, `TEST_AUTHOR_SAFE`, `TEST_CONTENT_IDS` (set, but **not read** by the test)
- **env vars MISSING from `.env`:** `MAINNET_RPC_URL`, `BASE_RPC_URL` → must be added or the live tests skip silently (`describe.skipIf(!chainReady)`)

**Code-edit handoff (specs can't touch code):**

1. `shared/src/rendering/sequence.test.ts` — replace the hardcoded `SINGLE_POST` with
   `env('TEST_CONTENT_IDS')` (split on comma), fallback to the genesis above; pass it as
   `contentIds` in the prep + seam-contract tests.
2. `shared/src/rendering/fixtures/inputs.ts` — `sampleJob.id` and `validPrepInput.contentIds` use
   `'lens-post-1'`; update to a genesis-shaped id for consistency (value-agnostic for the local
   shape tests, but stops misleading readers).
3. `.env` — add `MAINNET_RPC_URL` + `BASE_RPC_URL` (L1/L2 endpoints) so `chainReady` is true.

### Tests hit live infra — hermeticity gap

The live sequence test fetches CIDs from the chain, calls the real Bun runner
(`run.transport-union.dev`), and (in `preview:true` merged) **pins to the shared Kubo node** (skips
only the on-chain write). There is **no unit test with mocked IPFS/RPC/runner** — runs are flaky and
mutate shared state. A mocked-transport unit layer is the next step after the fixture unblock.

---

## Test seams (for the per-action → sequence plan)

- **Determinism:** freeze the clock — `metadata.ts` `new Date().toISOString()` and `updateDagItem`
  `Date.now()` make output CIDs non-deterministic. Inject a test key for `getPrivateKey` to make
  signatures reproducible (and to verify INV-5 round-trip / expose GAP-2).
- **Endpoints:** `IPFS_URL`, RPC URLs, and the run URL are hardcoded — parameterize
  to point unit/integration runs at ephemeral infra. (Lens is gone from the action path — GAP-10.)
- **Per-action fixtures:** capture one real `S2SManifest`, `S2SPublicationConfig`, encrypted +
  unencrypted `S2SBody`, and a `S2SJob`. Assert output shapes per the tables above.
- **Sequence test:** prep.jobs → single(job) → update(renderedJobs); assert the shape handed
  across each boundary (this is where the camelCase/snake class of bug surfaces first).
- **Negative tests that prove invariants:** path-gateway serve → `/assets` breaks (INV-11);
  reordered nested metadata keys → signature verify fails (GAP-2); records-updated-but-group-not
  (INV-8) as a contract test.
