# SPEC-protocol-actions

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
(neutralpress), config/asset *production* (safe-app), or the trust enforcement itself (Lit/Chipotle
enclave + on-chain groups — this code only *runs inside* that).

Runtime: each action is a self-contained `main({...inputs})` function bundled to one file, fetched
by CID, executed either on Lit nodes (prod) or the Bun runner (preview). Globals: `ethers@5`,
`Lit.Actions.*` (see `action_globals.ts`). **No Node built-ins** beyond the shim (INV-7).

---

## Sub-component map

| Path | Role | State |
|---|---|---|
| `prep/main.ts` | Stage 1 — build `jobs[]` from contentIds (cheap, no signing) | live |
| `single/main.ts` | Stage 2 — per-job: gate → decrypt → render → sign → upload HTML | live |
| `updateEvm/main.ts` | Stage 3 (merged) — assemble MFS tree, pin, write root | live |
| `cbor/main.ts` | old root-builder | **dead** — merged into updateEvm (GAP-5); still group-permitted |
| `renderer/` | Handlebars render (`renderHTML`) | live |
| `__renderer/` | older renderer copy | **dead** — duplicate (GAP-4) |
| `single/config.ctrl.ts` | `getConfig`, `getTaskConfig` | live |
| `single/data.ctrlr.ts` | `initTemplateData`, `fetchCollections`, path helpers | live |
| `single/metadata.ts` | `addAndSignMetadata` (provenance) | live (see GAP-1, GAP-2) |
| `libs/protocol.factory.ts` | in-action `getProtocolInfo` | live (dup of shared, see Gotchas) |
| `libs/ens.factory.ts` | `getDomainOwnerAndModules`, `getProtocolControllerAndModules` | live |
| `libs/lens.factory.ts` | `fetchById`, `fetchByQuery` (Lens GraphQL) | live (testnet, GAP-10) |
| `libs/evm.ts` | `evmRead`, `evmWrite`, `toHexString` | live |
| `libs/ipfs.factory.ts` | IPFS cat/add/dag/MFS + `contenthashToIPFS` | live (dag/cbor helpers mostly dead) |
| `libs/gates.ts` | `canPublish`, `canRead`, `extractSignerAddress` | live |
| `libs/decrypt.ts` | `decrypt` (gated `Lit.Actions.Decrypt`) | live |
| `libs/constants.ts` | endpoints + **hardcoded API keys** | live ⚠ GAP-9 |
| `libs/helpers.ts` | `fetchWithTimeout`, `addressToUserId` | live |

---

## Shared surface consumed (bundled INTO the action files)

Entry point: **`@s2s/soul2soul-shared/lit-actions`** — **types + ABIs only, no runtime** (INV-7).
Imports: types `S2SJob`, `S2STemplateConfig`, `S2SBody`, `S2SRipple`, `S2SPublicationConfig`,
`S2SProtocolInfo`, `PKP`, `S2SContentInfo`; and the contract ABIs (`Abi_S2SRecordsModule`, etc.).
These compile into each bundled action — they are this package's code, not an external service.
**Constraint:** nothing imported here may pull in a runtime/Node dep (would break the bundle). The
zod validators in shared are deliberately *not* exported through this entry.

## I/O contract (generic — the per-action contracts in §A are instances of this)

The **definition** of conformant action I/O. The `lit-actions-io` skill is the *procedure* to
produce it; **if skill and spec disagree, this section wins.** The Consumes/Produces tables in
§A1–A3 are the per-action instances.

**Envelope — every action returns one shape.** `ActionResult<T>` (`shared/src/lit/actions/types.ts`):
```ts
type ActionResult<T> =
  | { ok: true;  action: string; data: T;       trace: any[] }
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

**Dispatch — `preview` chooses transport, nothing else (SPEC-00 §3.1).** One helper is the only place
`preview` appears; everything after is uniform (validate-in → dispatch → check `ok` → validate-out →
consume `data`/`trace`), once per stage, never per branch:
```ts
async function runAction<T>(preview, lit, cid, inputs, litUsageKey): Promise<ActionResult<T>> {
  if (preview) { const w = await fetch('https://run.transport-union.dev/run',
               {method:'POST',headers:{'Content-Type':'application/json'},
                body:JSON.stringify({cid,inputs})}).then(r=>r.json());
             if (w.success === false) throw new Error(`runner: ${w.error ?? 'transport'}`);
             return w.response; }                              // Bun wraps {success,response}
  const code = await fetch(`https://neutralpress.mypinata.cloud/ipfs/${cid}`).then(r=>r.text());
  return (await lit.executeAction(code, inputs, litUsageKey)).response;   // Lit: response IS the ActionResult
}
```
**Two error levels, verified:** a thrown action error returns `success:true, response:{ok:false}`, so
runner `success:false` means **transport/crash only**, action `ok:false` means **logic failure**.
The runner wrapper exists on the Bun path only; `runAction` absorbs it so callers see one shape.
**prep is runner-only** (no signing → never on Lit, dev *and* prod); `single`/`merged` use
`runAction(preview)`. A separate prod branch that returns `success:true` on `ok:false` is the bug this
structure forbids.

## Action contracts (= test fixtures)

### A1 — `prep` `main({ protocolInfo, authorSafeAddress, publication, configCid, contentIds })`

**Consumes**

| field | type | source | notes |
|---|---|---|---|
| `protocolInfo` | `S2SProtocolInfo` | caller (`renderwithLitActions`) | passed in; prep does *not* re-fetch |
| `authorSafeAddress` | `address` | caller | author's Safe |
| `publication` | ENS name | caller | e.g. `alice.soul2soul.eth` |
| `configCid` | `string?` | caller | if absent, `getConfig` reads `config` record |
| `contentIds` | `string[]` | caller | Lens post ids |

**Produces** `{ success: true, jobs: S2SJob[] }` — deduped by `id`. For a **single** contentId
(`contentIds.length === 1`), also expands **ripples** — i.e. appends *additional re-render jobs*
for pages whose output depends on the published content (see "Ripples vs collections" below).

**Network/chain:** `getDomainOwnerAndModules` (ETHEREUM + BASE reads); `getConfig` (BASE read +
IPFS cat); `fetchById`/`fetchByQuery` (Lens testnet). No signing, no PKP. **Runs on Bun runner.**

**Invariants:** INV-4 (module discovery). **Gotcha:** returns `undefined` (not an error) if modules
missing — caller must treat falsy `jobs` as failure.

---

### A2 — `single` `main({ job, signature, authorSafeAddress, configCid, publication })`

**Consumes**

| field | type | source | notes |
|---|---|---|---|
| `job` | `S2SJob` | prep output | `{ id, templateConfig, templateData?, html }` |
| `signature` | hex sig over `hashMessage("lit actions auth")` | caller | INV-1; recovered to `signerAddress` |
| `authorSafeAddress` | `address` | caller | |
| `configCid` | `string?` | caller | |
| `publication` | ENS name | caller | |

**Produces** `{ success, timestamp, job, html, logz, errors? }` where `job.html` = CID of the
uploaded page, `job.path` = interpolated slug path, `job.revoked` set if decrypt/permission failed.

**Sequence (each step is an assertion point for tests):**
1. `extractSignerAddress(hashMessage("lit actions auth"), signature)` → `signerAddress` (INV-1)
2. `getProtocolInfo(false)` (in-action; re-fetches — unlike prep) → `S2SProtocolInfo`
3. `getDomainOwnerAndModules(publication)` → `{ multisig, configModule, publicationModule }` (INV-4)
4. `fetchById(job.id)` → body
5. `getConfig(configCid, configModule)` → config
6. `initTemplateData(...)` → decrypts body if `body.encryption` (gated `canRead`); sets `revoked`
7. if not revoked: `fetchCollections` → per-item `decrypt` (gated) → `renderHTML` → `addAndSignMetadata` (PKP sign, INV-5) → `uploadFile` → CID
8. else: `job.revoked = true`, empty html/path

**Network/chain:** ETHEREUM+BASE reads (modules, config, gates), Lens testnet (body/collections),
IPFS add/cat, **PKP** for `Lit.Actions.Decrypt` and the metadata signature. **Runs on Lit (prod) /
Bun (preview, unsigned).**

**Invariants:** INV-1, 5, 7, 9, and the gates (`canRead` = author whitelisted/licensed **AND**
signer is author-Safe owner). **Gotchas:** GAP-1 (metadata `S2SContentInfo` is hardcoded
placeholder — provenance currently fictional); the `assets_gateway` shape mismatch (see Gotchas);
**GAP-13** (informational) — the Bun shim has no `Lit.Actions.Decrypt`, but this is moot by design:
preview content is mock and never encrypted, so `decrypt.ts` is never called on that path.
Encrypted-content editorial review runs through a separate, real Lit decrypt action instead
(SPEC-00 OPEN-TASK-4/GAP-13).

---

### A3 — `updateEvm` (merged) `mergedMain({ signature, authorSafeAddress, publication, jobs, preview })`

**Consumes**

| field | type | source | notes |
|---|---|---|---|
| `signature` | hex sig | caller | INV-1 |
| `authorSafeAddress` | `address` | caller | |
| `publication` | ENS name | caller | |
| `jobs` | `S2SJob[]` | single outputs (`renderedJobs`) | each has `path` + `html` (CID) |
| `preview` | `boolean` | caller | true ⇒ skip on-chain write |

**Produces** `{ success, cid?, response?, logz }` — `cid` = new site root.

**Sequence:** recover signer (INV-1) → modules (INV-4) → `canPublish` gate → `getProtocolInfo` →
read prev `contenthash_wrapped` via `getText` on `protocolInfo.ensRecords` → `contenthashToIPFS`
(INV-6) → copy prev root into temp MFS → `cp` each job's html CID to `{path}/index.html` → `cp`
`config.assetsCid` → `/assets` (INV-11) → `files/stat` new root → `pin/add` → **if `!preview`**:
`toHexString(root)` + `evmWrite setText(node,"contenthash_wrapped")` with the **PKP** (INV-10) →
`finally` rm temp MFS.

**Network/chain:** Kubo MFS/pin on `ipfs.transport-union.dev`; BASE read (`getText`) + BASE write
(`setText`, PKP-signed). **Runs on Lit (prod) / Bun (preview, no write).**

**Invariants:** INV-1, 4, 6, 8, 9, 10, 11. **Gotchas:** Kubo `files/cp` does not overwrite — code
`rm`s first; CID is CIDv0 (INV-6 / OPEN-TASK-1).

---

## Ripples vs collections (two distinct mechanisms — do not conflate)

These are easy to confuse and are *not* the same thing.

**Collection** = data pulled *into* a page *while it renders*. Declared on a `templateConfig`
(`collections[]`), fetched in `single` by `fetchCollections` (e.g. the `home` template has a
`posts` collection via `queryByFeed`, so the rendered home page lists posts). A collection affects
the *content of one page*.

**Ripple** = a *cascade re-render rule*: when content of some `postType` is published, **other
pages must be regenerated** because their rendered output embeds/lists that content. A ripple
produces *additional jobs*, not in-page data. Example: publishing a `post` ripples to `home`,
because the home page shows the latest posts — so `home` must be re-rendered too.

`S2SRipple = { origins: string[]; destination: string; reference: string; query: {method,args} }`
- `origins` — the `postType`s that *trigger* this ripple (selected in `getTaskConfig` via
  `ripples.filter(r => r.origins.includes(body.postType))`).
- `destination` — the `templateConfig.reference` to render the cascaded page with (e.g. `home`).
- `query` — how to locate the destination page(s) to re-render; the destination page is itself a
  Lens post (e.g. the home page has a fixed Lens `postId`), fetched via `fetchByQuery`.
- `reference` — present in the type/config but **unused** in `prep` (only `destination` + `query`
  are read); likely redundant/legacy — confirm before relying on it.

**How it runs (prep):** for the primary body, push its job; then *only if a single contentId was
requested*, for each matching rippleConfig: `fetchByQuery(query)` → destination page(s), look up
the `destination` template, push a job per destination page. Dedupe by `id`. The cascaded job then
flows through `single` like any other — and *its* collections pull the now-current data (so the
freshly published post appears in home's `posts` collection). **Ripple + collection thus compose:**
the ripple says "re-render home"; home's collection says "list the latest posts."

**Behavioral gotcha to confirm:** ripples expand **only** for `contentIds.length === 1`. A bulk
render (multiple ids) skips cascade expansion — presumably because a full render already covers the
dependent pages, but it means publishing N>1 items in one batch will *not* trigger a `home`
re-render on its own. Verify this is intended, not a stale-page hazard.

*Doc drift:* `action-flow-diagram.md` describes ripples via `getRipplesOnce` from OrbisDB — stale
(Ceramic era), same drift noted in SPEC-00 Q5; the mechanism is now `fetchByQuery` on Lens.

---

## Library I/O (boundary descriptions for unit tests)

| fn | in | out |
|---|---|---|
| `getProtocolInfo(dev)` | `boolean` | `S2SProtocolInfo` (camelCase fields + `pkp{}`) |
| `getDomainOwnerAndModules(pub)` | ENS name | `{ multisig, configModule, publicationModule }` (any may be null) |
| `getConfig(configCid?, configModule)` | cid?/addr | `S2SPublicationConfig` (parsed JSON) |
| `getTaskConfig(config, body)` | config, body | `{ templateConfig, rippleConfigs }` (throws if no mapping) |
| `fetchById(id)` | Lens post id | `S2SBody \| undefined` |
| `fetchByQuery(method, args)` | query name + vars | `S2SBody[]` |
| `initTemplateData(protocolInfo, authorSafe, signer, templateConfig, body, pubModule)` | — | templateData `{ ...body, assets_gateway, path, content(unescaped), revoked }` |
| `fetchCollections(templateConfig)` | templateConfig | `{ [slug]: items[] }` (lens-sourced, tag-filtered) |
| `renderHTML(config, templateConfig, templateData)` | — | `string` (HTML) |
| `addAndSignMetadata(id, html, protocolInfo, contentInfo?)` | — | `string` (HTML + signed JSON-LD) |
| `canPublish(authorSafe, pubModule, signer)` | — | `boolean` (canPublish ∧ isOwner) |
| `canRead(contentId, safe, pubModule, signer)` | — | `boolean` (canPublish ∧ isOwner ∧ isLicensed) |
| `decrypt(pkpId, body, authorSafe, pubModule, signer)` | — | decrypted obj \| false (gated by `canRead`) |
| `evmRead(chain, addr, abi, method, args)` | — | call result (tries RPC fallbacks) |
| `evmWrite(chain, pkp, addr, abi, method, args, confirm?)` | — | `{ success, hash, ... }` (PKP-signed) |
| `toHexString(cidV0)` | base58 CID | `0xe301…` contenthash (INV-6) |
| `contenthashToIPFS(hex)` | contenthash hex | CIDv0 string (INV-6) |
| `uploadFile(str)` / `catFile(cid)` | — | CID / text (Kubo `add`/`cat`) |

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
  they are author-owned in the publication's repo. **Planned (SPEC-safe-app TODO):** `ConfigBuilder`
  should inject the `feedAddress` at build time. Until then, a copied `website-starter` carries
  someone else's values.
- **`S2SProtocolInfo`**: `{ addr, recordsModule, dataGateway, assetsGateway, lensApp, ensRecords,
  pkp{ethAddress,publicKey,tokenId}, litActionPrep/Single/Cbor/RootUpdate }`.

---

## Invariants this component must preserve

INV-1 (auth string), INV-2 (record keys — see the duplicate-`getProtocolInfo` gotcha), INV-4
(module NAME discovery), INV-5 (provenance canonicalization), INV-6 (contenthash codec), INV-7
(runtime-agnostic), INV-8 (action CID ↔ group), INV-9 (Base/8453 hardcoded), INV-11 (assets→/assets).

## Local gotchas (component-specific, beyond SPEC-00 gaps)

- **Shape mismatch (illustrative of the whole testing rationale):** `getProtocolInfo` returns
  `assetsGateway` (camelCase); `initTemplateData` reads `protocolInfo.assets_gateway` (snake) →
  silently `undefined`. Likely vestigial post the assets-into-`/assets` refactor (templates now use
  root-absolute `/assets/...`), but confirm. **This is exactly the bug class boundary fixtures catch.**
- **Two `getProtocolInfo`:** `libs/protocol.factory.ts` (ethers/evmRead, in-action) and
  `shared/src/protocol/index.ts` (viem, client). Same record-key *set*, but **different field
  *order* in each destructure** — each is internally consistent, but the key set must stay in sync
  (INV-2). The in-action `getProtocolControllerAndModules` has **no `dev` branch** (cf. GAP-8).
- **Hardcoded secrets (GAP-9):** `libs/constants.ts` exposes Pinata key+secret, Alchemy, DRPC in
  public action code. Rotate + inject.
- **Lens testnet (GAP-10):** `api.testnet.lens.xyz`.
- **Provenance placeholder (GAP-1):** `single/main.ts` builds `S2SContentInfo` from literals.
- **Canonicalization (GAP-2):** `metadata.ts` sorts only top-level keys.
- **Dead code:** `cbor/`, `__renderer/`, most dag/cbor helpers in `ipfs.factory.ts`,
  `processBase`/commented base-merge in `data.ctrlr.ts`.

## Safe-to-change vs do-not-touch

- 🟢 Handlebars templates/helpers, RPC URLs, timeouts, log lines, dead code removal.
- 🔴 The `"lit actions auth"` string; record-key names/set; module NAME() strings; the contenthash
  codec; the canonicalization in `metadata.ts`; anything that makes an action depend on a Node
  built-in (breaks INV-7); emitting CIDv1 from updateEvm (breaks INV-6 / `toHexString`).

---

## Test seams (for the per-action → sequence plan)

- **Determinism:** freeze the clock — `metadata.ts` `new Date().toISOString()` and `updateDagItem`
  `Date.now()` make output CIDs non-deterministic. Inject a test key for `getPrivateKey` to make
  signatures reproducible (and to verify INV-5 round-trip / expose GAP-2).
- **Endpoints:** `IPFS_URL`, the Lens URL, RPC URLs, and the run URL are hardcoded — parameterize
  to point unit/integration runs at ephemeral infra.
- **Per-action fixtures:** capture one real `S2SProtocolInfo`, `S2SPublicationConfig`, encrypted +
  unencrypted `S2SBody`, and a `S2SJob`. Assert output shapes per the tables above.
- **Sequence test:** prep.jobs → single(job) → updateEvm(renderedJobs); assert the shape handed
  across each boundary (this is where the camelCase/snake class of bug surfaces first).
- **Negative tests that prove invariants:** path-gateway serve → `/assets` breaks (INV-11);
  reordered nested metadata keys → signature verify fails (GAP-2); records-updated-but-group-not
  (INV-8) as a contract test.