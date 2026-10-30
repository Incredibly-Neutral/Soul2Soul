# SPEC-author-publishing — neutralpress (publication lifecycle, content authoring, render triggering)

> **Parent:** [SPEC-author](../SPEC-author.md) — the authoring front door. Basis sibling:
> [SPEC-author-identity](./SPEC-author-identity.md) (`oxo-core`), which this package runtime-depends on.
>
> **Audited against live code:** 2026-08-03; **partial re-audit 2026-08-06** for the frontmatter
> `slug` override and the (still-unwired) `remove[]` population for the update action (see
> handoff `handoff-actions-fixes-and-remove.md`).
>
> Component spec for `neutralpress/` — the Obsidian plugin for **publication lifecycle, content
> authoring/encryption, and render triggering**. Read **SPEC-00** first; types from **SPEC-shared**.
> Runtime-depends on **SPEC-author-identity** (`oxo-core`). The richest front-end — it wires authoring to
> the publish pipeline (SPEC-protocol-actions) and deploys the per-publication contracts
> (../SPEC-publication.md, ../SPEC-contracts-ens.md). Follows SPEC-00 §7.
>
> Invariants touched: INV-1 (passes the author signature), INV-2/INV-4 (`getProtocolInfo`, module
> discovery), INV-8 (holds/passes the `litUsageKey`), the **cross-chain same-address** Safe
> requirement (implemented here), and Q5 feed-per-publication.

## Responsibility

Owns the **publishing workflow**: create a publication (Safe×2 + ENS subdomain + modules + Lens feed
+ config), author notes (parse → encrypt → store on Lens), manage licenses, and **trigger the render
pipeline**. Delegates identity/wallet to `oxo-core` and rendering/signing to the Lit Actions.

## Runtime context

Obsidian plugin, **esbuild**-built. Depends on `oxo-core` — `initializeOxo()` waits up to 10s for
`app.plugins.plugins["oxo-core"]`, then reads the active user, `initChains(["ETH_MAINNET","BASE"])`,
and `getProtocolInfo(dev, L1, L2)`. No active oxo user → init stops.

## Boundary interfaces

**Consumes (from `oxo-core`):** active `IOXOUser` (signer/EOA, author Safe), per-chain
`PermissionlessSafeService` (L1/L2), `lit`, `lens`, `pinata`, and `oxo.settings.litUsageKey`.
**Consumes (chain/Lens):** ENS registry, NameWrapper, the publication modules, Lens.
**Produces:** a deployed publication (Safe×2, ENS subnode, both modules enabled, Lens feed, config
CID, records); Lens posts (content, `contentId` written back to note frontmatter); license txs;
render-pipeline invocations.

## Shared surface consumed (bundled into the esbuild output)

Entry point: **`@s2s/soul2soul-shared`** (full index). Imports: `getProtocolInfo`,
**`renderwithLitActions`** (the orchestrator), `pinCidFromRemote`, `postToLens`/`updateToLens`,
content types `S2SPublicContent`/`S2SToEncrypt`/`S2SContentItem`, `S2SProtocolInfo`,
**`runFilecoinLeg`** (Filecoin durability-leg runner: lifecycle logging + timeout +
`onFailure` callback — relocated from `publication/filecoin.ts`, see SPEC-shared), and the
new-publication surface **`newPublicationSafe`** + **`buildNewPublicationDeps`** (deps
assembly, see below) + **`createL1Runner`/`createL2Runner`** (oxo→`TxRunner` bridge,
relocated from `publication/tx-runner.adapter.ts`). This is the package that drives the
pipeline, so most of shared's *orchestration* surface lands here.

## Sub-component map (from FLOW.md Component Index)

| path | role |
|---|---|
| `main.ctrlr.ts` | `MainController` — `newPublication`, `proposeContent`, `publishToPublication`, `renderCalls`, `grantLicense`, `revokeLicense`, `initializeOxo` |
| `publication/publication.service.ts` | `PublicationService` — init, L1/L2 Safe instances, `getModuleAdresses` (NAME discovery, INV-4), `makeOffer`/`retract`, `getMultiSig` |
| `publication/new.ts` | `newPublicationSafe` — thin obsidian/oxo glue: reads plugin/oxo settings + private key + lens, injects protocol ABIs, calls shared `buildNewPublicationDeps` + shared orchestration |
| `publication/new.modal.ts`, `ui/revoke.modal.ts` | UI: new publication, revoke |
| `publication/ens.ts` | `isAvailableEnsName`, `getPublicationMultiSig` |
| `content/content.ctrlr.ts` | `parseNote`, `storeNoteOnLens`, `encryptContent` |
| `content/images.ts` | image distribution |
| `preview.ctrlr.ts` | preview rendering |

## Key flows (condensed from FLOW.md)

- **New publication** (`newPublicationSafe`): salt = `"publication_safe_"+name` → `connectToFreshSafe`
  on **L1 and L2 (same salt ⇒ same address)** → **L1** `registerSubdomain(subdomain, addr1)` →
  **L2** deploy `S2SRecordsModule` + `S2SPublicationModule(authors)` → `enableModule`×2 → verify
  (poll ≤20×) → `uploadConfig` → `lens.createFeed` → set records (name/config/repo/branch/feed) →
  add owners + **remove temp creation signer**. Long async background job.
|- **Publish** (`proposeContent` → `publishToPublication`): `parseNote` → `{contentId, publicContent,
  toEncrypt}` → if `encryption`, `encryptContent` (shared `lit.encrypt(litUsageKey, pkp.ethAddress,
  toEncrypt)`) → `storeNoteOnLens` (posts to the publication **feed**; if no `contentId`, a mock post
  yields the Lens id, written back to note frontmatter as `content_id`) → **dual storage**:
  **Kubo** `uploadToKubo(signedItem, kuboUrl)` (instant gateway availability) → **Filecoin**
  `uploadJson(signedItem)` (CAR builder → SPs, durable) → **CID verify** (`kuboCid === rootCid?`
  → `[cid-ok]` or Notice warning) → check/`grantLicense` → `renderCalls` →
  **`renderwithLitActions(... litUsageKey, signature ...)`** → `pinCidFromRemote`.
- **License:** `grantLicense`/`revokeLicense` → L2 Safe call on the publication module.

## Invariants this component preserves

- **Cross-chain same-address (implemented here):** the same CREATE2 salt yields one address used as
  the ENS subnode owner (L1) and the module host (L2). **Critical assumption:** identical Safe
  factory + initializer on both chains, or `publicationAddress1 != publicationAddress2` and the
  L1-owner/L2-modules split breaks (SPEC-contracts-ens topology). Worth an explicit equality assert.
- **INV-1:** passes the author signature (from the oxo signer) into `renderwithLitActions`.
- **INV-2/INV-4:** `getProtocolInfo`; `getModuleAdresses` discovers modules by `NAME()`.
- **INV-8:** holds the `litUsageKey` (oxo settings) and passes it to encrypt + render.
- **Q5 feed-per-publication:** `lens.createFeed` per publication; content posted to that feed.

## Local gotchas / gaps (incl. single-source-of-truth violations)

- **Duplicate config path (RESOLVED 2026-10-17):** the neutralpress `publication/config.ts`
  (`uploadConfig`/`getTaskConfig`) duplicate was deleted; config-shaping now lives only in
  safe-app's `ConfigBuilder` (no diverging neutralpress copy remains).
- **Duplicate ABIs (RESOLVED 2026-10-17):** the neutralpress `protocol.abi.ts`/`publication/abi.ts`
  copies were deleted — ABIs now come only from `shared/contracts` + `protocol/contracts`. Lens is
  called via `oxo.ctrlr.lens` (0xobsidian-side, commented-out — see SPEC-author-identity); reconcile
  whether lens is fully dead across the authoring path.
- **`litUsageKey` in plugin settings** with a `// hardcoded?` note — it's the INV-8 group credential
  that authorizes execution; treat its provisioning deliberately (and it's a secret at rest like the
  author key — low stakes per SPEC-author-identity, but it gates publishing).
- **Publication creation is a long multi-step background job** (Safe×2, ENS, modules, enable, verify,
  config, feed, records, owners, remove-temp-signer). Partial failure leaves a half-built publication;
  the **remove-temp-signer** step is especially delicate (lose it wrong → lockout). Needs idempotent
  re-run / recovery story.
- **`contentId` ⇄ frontmatter contract:** the note's genesis/objectId (bytes32) is written back
  to frontmatter as `content_id` (the Lens post-id era is over — `main.ctrlr.ts:313`
  `genesis = signedItem.objectId`); the render pipeline fetches by it as a genesis (`prep`
  `fetchById`→`getLatest(bytes32)`). Don't break this round-trip — a non-bytes32 value breaks ABI
  encoding at `getLatest`.
- **Slug override:** `content/content.ctrlr.ts:parseNote` reads `frontmatter?.slug` and uses it
  in preference to `slug(title)`. The chosen slug propagates as `body.slug` through the pipeline
  into the Lit render action's `createPath` (which interpolates `{slug}`). A changed `slug`
  frontmatter therefore moves the page to a new path — and leaves the old path in the IPFS tree
  unless the update action's `remove[]` is populated (see next).
- **`remove[]` not yet populated (2026-08-06):** the update action now accepts
  `remove?: { path; replacedBy? }[]` to delete stale MFS paths (slug renames via `replacedBy`
  genesis, or revocations). **neutralpress does not yet build this list** — on a slug change or a
  revoked render it must emit the old path (with `replacedBy` = the superseding job genesis for a
  rename). Until wired, slug changes leave orphan paths in the published tree. Cross-ref
  SPEC-protocol-actions A3.
- **Preview link uses the path gateway, not the preview subdomain gateway (OPEN-TASK-1, GAP-14).**
  `main.ctrlr.ts:389` emits `https://ipfs.transport-union.dev/ipfs/${res.cid}/${res.path}` with
  `res.cid` as CIDv0 (`Qm…` MFS root). Root-absolute `/assets/...` (INV-11) then drops the
  `/ipfs/<cid>` base → asset 404s in preview (the "MIME text/plain" refusal is the gateway's 404
  body). safe-app already wires the deployed `preview.transport-union.dev` subdomain gateway with
  CIDv0→v1 conversion (`s2s-app.ts:119/220`); neutralpress does neither. Fix: build
  `https://${toPreviewLabel(res.cid)}.preview.transport-union.dev/${res.path}` using the shared
  helper (GAP-14). The publish-time `.link` notice (`main.ctrlr.ts:393`) is unaffected.
- `tasks/migration.md` present → active migration; treat some paths as in-flux.

## Safe-to-change vs do-not-touch

- 🟢 UI/modals/notices, preview, note parsing details, dead-code/dup removal (into shared).
- 🔴 the Safe creation **salt** (cross-chain address determinism); module `NAME()` discovery (INV-4);
  the author signature passed to render (INV-1); the `content_id` frontmatter round-trip; the
  frontmatter `slug` override → `body.slug` → `createPath` contract (a changed slug moves the page
  path and must pair with a `remove[]` entry); the remove-temp-signer / owner-handover sequence.

## Test seams

- `parseNote`: note (`.md`/`.base`) → `{contentId, publicContent, toEncrypt}` is the cleanest unit
  test (pure-ish) — fixture notes, assert the split.
- **Encrypt↔decrypt round-trip:** `encryptContent` here vs the action's gated `decrypt` — assert a
  blob encrypted to the PKP decrypts only when `canRead` passes (cross-check publication/SPEC-publication-agreements
  + SPEC-protocol-actions).
- **Publication creation:** integration (chain fork + Lens testnet) — assert L1==L2 Safe address,
  both modules enabled + discoverable by NAME, feed created, records set, temp signer removed.
- `renderCalls`: drive `renderwithLitActions` through the Bun runner with fixtures (same path as
  preview) — the sequence test from SPEC-protocol-actions.

## Test coverage status (2026-10-12)

Vitest suite live in `neutralpress/test/` (harness: `vitest.config.ts` aliases obsidian/electron to
headless stubs + `@s2s/soul2soul-shared` to TS source; `test/mocks/{obsidian,electron}.ts`,
`test/helpers/main.ts`). `pnpm test` runs 143 unit tests; `build` gates on it. (Count dropped from
183 in 2026-10-12 — the dead-code sweep removed the dead-file tests: `_legacy`, `note.factory`,
`abi`, `config`, `github`; live-path coverage is unchanged.)

Covered:
- Content authoring: `parseNote` (title/slug/body, frontmatter-driven fields, custom bag,
  `<!--more-->`/`<!--split-->` summaries, markdown→HTML, `.base` embeds), `isValidForPublishing`,
  `distributeImages` (no-op + pinata rewrite), `ens-tags`.
- Publication pure logic: `intents` dispatch, `ens` (registry reads), `filecoin` (kubo/pinata
  config, `runFilecoinLeg` hang → time-boxed failure via the shared runner).
- Service/pipeline: `publication.service` (module discovery, `makeOffer`/`retract` genericTx
  dispatch, `getMultiSig`), `publish` (both render-gate branches), `revoke`.
- Shared-adjacent: the oxo→`TxRunner` bridge + `buildNewPublicationDeps` are covered from
  `shared/` (`tx-runner.test.ts`, `new.test.ts`) — the neutralpress-local copies are gone.
- Render/settings: `buildRpcEndpoints`, `pagePathFor` (CID digest compare), `DEFAULT_SETTINGS`,
  `DSGSettingsTab` wiring, `preview` seams.

Not covered (needs DOM/integration): `renderCalls` (Lit render pipeline), UI modals,
`main.ts`/`main.ctrlr.ts`, `publication/new.ts` Safe-deploy orchestration glue (the orchestration
itself is covered in `shared/new.test.ts`), encrypt↔decrypt round-trip
(cross-package).

The `PublicationService.getPublicationMultiSigAddresses` `.contains` bug noted in earlier revisions
is gone: the dead view-reads (`acceptOffer`, `hasDeal`, `getDeals`, `getOffers`,
`getPublicationMultiSigAddresses`, `getPublicationFeedAddress`) were pruned from the service in the
2026-10-17 dead-code sweep — none were reachable from `main.ts`.
