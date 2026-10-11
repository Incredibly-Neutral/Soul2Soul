# SPEC-shared

> **Audited against live code:** 2026-08-03; **partial re-audit 2026-08-06** for the
> `EvmUpdateInput.remove` field + its zod schema (see handoff `handoff-actions-fixes-and-remove.md`).
> **cid-view re-audit 2026-10-11** — the publication CID inventory + ipfs-check retrievability
> wave (2026-10-08→10-11; see brain/worktrees.md).
>
> Component spec for `shared/` (`@s2s/soul2soul-shared`) — the common library every other package
> imports. Read **SPEC-00** first. This spec is the **canonical type catalog** the front-end specs
> (safe-app, 0xobsidian, neutralpress) point at instead of re-deriving shapes. Follows SPEC-00 §7.
>
> Invariants carried/owned here: INV-2 (record-key set in `getProtocolInfo`), INV-5 type
> (`S2SContentInfo`), INV-7 (the action-bundle entry point must stay runtime-free), plus the
> canonical shapes behind every other INV.

## Responsibility

Owns: the shared **types**, **ABIs**, and **client-side services** (Lit V3 REST, Lens GraphQL, IPFS
/pin, ENS resolution, config building, validation) used across apps. Does **not** run inside Lit
(that's `protocol/actions`, which imports only the type/ABI subset) and does not own UI.

## Single source of truth (the point of this package)

`shared` exists so nothing is defined twice. **Any code/type/constant that would otherwise be
duplicated across packages must live here** — including resolving the incongruences this spec notes
(consolidate them *into* shared, don't mirror). The zod validators and orchestrator in
`shared/src/rendering/` **do** have a standalone test target (`vitest` in shared/); the bundled-into-consumers *types* are validated only through consumers.

**Shared is part of each consumer's code, not a service.** Its functions are *bundled* into each
consumer's build via that consumer's entry point. So the authoritative "what of shared matters here"
list lives in **each consumer spec's _Shared surface consumed_ section** (SPEC-protocol-actions,
SPEC-safe-app, SPEC-0xobsidian, SPEC-neutralpress) — this spec is the catalog/source of truth; the
consumer specs say which slice each one compiles in.

## Dependency placement (pnpm workspace rule, extends the entry-point contract)

`zod` (and any dependency shared by multiple consumers) belongs on **`shared`'s own
`package.json`**, not duplicated into neutralpress/0xobsidian/safe-app's. Consumers receive it
transitively through the pnpm workspace link to `shared`. **Exception, and the one that matters:**
the `/lit-actions` entry must stay reachable by **zero** import path into `zod` — not direct, not
transitive through another `shared` module — because it is bundled into the action file fetched by
CID (INV-7's bundle-size constraint, which is *why* zod was rejected for in-action validation in the
first place). Verify this against the actual resolved bundle when adding anything to `shared`, not
just the direct import list (see SPEC-00 §10 for the full agent-environment framing).

## Entry points (this is a real contract — wrong import = wrong bundle)

The multiple entry points exist **because the consumers use different bundlers** and a single source
of truth must serve all of them: the Obsidian plugins (`0xobsidian`, `neutralpress`) build with
**esbuild**, the safe-app with **Vite**, and the Lit Actions through their own bundler (which must
get a runtime-free subset). Each entry tailors the surface to one build context:

| import path | surface | who uses it (bundler) | rule |
|---|---|---|---|
| `@s2s/soul2soul-shared` (`index.ts`) | **everything** (services + types + ABIs + identity) | neutralpress, 0xobsidian (**esbuild**) | full runtime OK |
| `@s2s/soul2soul-shared/lit-actions` (`lit-actions.ts`) | **types + ABIs only**, no runtime | `protocol/actions` (**action bundler**) | **INV-7:** never add runtime/Node deps; zod validators intentionally commented out (bundle size) |
| `@s2s/soul2soul-shared/rendering/action-io` (`rendering/action-io.ts`) | **zod runtime schemas** for action I/O (e.g. `s2sContentItemSchema`) | `protocol/actions` — only the action that needs runtime validation (currently `render` via `archive.factory`) | **narrow, deliberate:** carries zod into exactly one action bundle; added 2026-08-19 to fix the 413 (root-barrel import had dragged the whole shared graph into `render/main.js`, 2.6 MB → 341 KB). Do NOT re-export these schemas from `lit-actions` (keeps it zod-free, INV-7); do NOT import them from the root barrel inside action code. |
| `@s2s/soul2soul-shared/safe-app` (`safe-app.ts`) | `getProtocolInfo`, `LitService`, types + **the whole `cid-view/` surface** + `ConfigBuilder`/`AssetsBuilder`/`S2SIPFSMethods` | safe-app (**Vite**) | "no Lit/Lens/CCIP baggage" — the cid-view addition is deliberate (safe-app is its only consumer) |

## Canonical type catalog (single source of truth)

### Content-item types (NEW — identity/provenance, replaces old Lens-era types)

These types are the **single source of truth** for stored content items. They live in
`protocol/types.ts` (not rendering/types.ts, which has been removed).

| type | file | shape |
|---|---|---|
| `DidEthr` | `protocol/types.ts` | template literal `did:ethr:0x${string}` — canonical author form |
| `S2SPublicContent` | `protocol/types.ts` | signed public metadata: `specVersion, author(DidEthr), postType, mediaType, parent, position, publication, locale, createdAt(number unixts), base?, tags[], attributes?(Record), plaintextHash` |
| `S2SProof` | `protocol/types.ts` | EIP-712 author sig: `type("eip712"), signer(0x), signature(0x)` |
| `S2SContentItem` | `protocol/types.ts` | **flat stored object** (no union): `public(S2SPublicContent), objectId, proof(S2SProof), encryption(boolean), secret(string)` |
| `S2SSecretBody` | `protocol/types.ts` | what goes inside `.secret`: `title, slug, content, custom?(Record)` |

Key design decisions (from HANDOFF-content-item):
- **No discriminated union.** Both readings of `secret` are `string` (ciphertext when `encryption=true`, stringified JSON when `false`).
- **No unsigned public field.** Every field in `S2SPublicContent` is signed via EIP-712.
- **`secret` is not signed.** `plaintextHash` commits the plaintext instead.
- **`objectId` = EIP-712 digest** of `public`, available pre-upload, pre-CID.
- **`author` is `DidEthr`**, not bare 0x address.
- **`tags`/`attributes`** live in the signed public part. **`title`/`slug`/`content`/`custom`** live in the secret.

### Identity modules (NEW)

| module | file | exports | role |
|---|---|---|---|
| `identity/` | `sign-content.ts` | `buildSignedContentItem`, `computeObjectId`, `TypedDataSigner`, `noOpEncrypt` | Produce a signed S2SContentItem from raw inputs + EOA signer |
| `identity/` | `verify-content.ts` | `verifyAuthorship`, `verifyPlaintextHash`, `resolveLatest`, `getHistory`, `VersionRecord` | Verify authorship + resolve append log |
| `identity/` | `jcs.ts` | `jcs`, `keccakOfJson` | RFC 8785 canonical JSON + keccak256 |

### Legacy types (DEPRECATED, keep for action compatibility)

| type | file | shape (abbrev) | status |
|---|---|---|---|
| `S2SBody` | `protocol/types.ts` | **discriminated union**: `S2SBodyBase` + `S2SBodyPlain` (`encryption: false`, `content`, `title`, `slug`, `custom?`) / `S2SBodyEncrypted` (`encryption: true`, no plaintext fields) | 🔸 Lens-era — superseded by `S2SContentItem` (`protocol/types.ts`). Actions still use it. |
| `S2SPublicContent` | `content/types.ts` | Lens-era shape (`creationDate`, `modifiedDate`, `language`, ...) | 🔸 Deprecated — replaced by `protocol/types.ts` version |
| `S2SContentItem` | `content/types.ts` | empty extension of Lens-era `S2SPublicContent` | 🔸 Deprecated — no purpose |
| `S2SContentInfo` | `metadata/types.ts` | provenance metadata for rendered HTML (`author.lens`, `publisher`, `contentCid`, `license`, `isBasedOn`) | 🟢 Still active — rendered provenance is separate from stored content item |

### Active types (unchanged)

| type | file | shape (abbrev) |
|---|---|---|
| `S2STemplateData` | `protocol/types.ts` | render-time view: `id, controller, tags, language, position, encrypted, postType, publications[], collections?, path, base?, custom, content, dates` |
| `S2SCollection` | `protocol/types.ts` | `source, query, filters?, key, value, slug` |
| `S2SRipple` | `protocol/types.ts` | `origins[], destination, reference, query` |
| `S2STemplateConfig` | `protocol/types.ts` | `reference, file, path, collections?, filters?` |
| `S2SJob` | `protocol/types.ts` | `id, templateConfig, path?, templateData?, html?, revoked?` |
| `PKP` | `protocol/types.ts` | `tokenId, publicKey, ethAddress` — **tokenId/publicKey vestigial (GAP-11)** |
| `S2SProtocolInfo` | `protocol/types.ts` | `addr?, recordsModule, dataGateway, assetsGateway, lensApp, ensRecords, pkp, litAction{Prep,Cbor,Single,RootUpdate}` |
| `S2SPublicationConfig` | `publication/types.ts` | `assetsCid, contract, dataGateway, mapping, name, templateCid` |
| `S2SPublication` | `publication/types.ts` | `name, owners[], authors[], contract?, configCid?, feed?, devRepository, branch` (← GitHub repo+branch for templates/assets) |

## Module map (services)

| module | role | notes |
|---|---|---|
| `protocol/` | `getProtocolInfo` (viem), `getRecords`, `getProtocolControllerAndModules`, constants + **content-item types** | **mirror of the in-action `libs/protocol.factory.ts`** — same record-key set (INV-2), different stack (viem vs ethers); has the `dev`→`dev.soul2soul.eth` branch (GAP-8, vestigial). Content-item types (`S2SContentItem`, `S2SPublicContent`, `S2SProof`, `DidEthr`, `S2SSecretBody`, `S2S_DOMAIN`, `S2S_TYPES`) are the canonical identity/provenance types, replacing the old S2SBody. |
| `rendering/` | `renderwithLitActions` (client orchestrator: prep→single→merged) + helpers + **action-io schemas** | drives the pipeline; selects Bun (preview) vs Lit (prod). Content-item types now live in `protocol/types.ts`, not rendering. Zod schemas (`s2sContentItemSchema` etc.) remain in action-io.ts. |
| `lit/` | `LitService` (Chipotle REST client), `actions/encrypt`, `compactAction`, gates `can_publish`/`can_read` | `LitService` base URL = `api.chipotle.litprotocol.com/core/v1` (prod) / `api.dev…` (dev); `X-Api-Key`; `poolKeys` map (poolId→usageKey). Backs `swap-action`/`deploy-group`/`update-protocol` |
| `publication/` | `config-builder` (S2SConfigBuilder: GitHub repo→config), `types`, **`validation` (zod)** | validation schemas live here (client-side); `bodySchema` mirrors the deprecated `S2SBody` |
| `lens/` | Lens GraphQL client (`fetchById`, queries) | mirrors in-action `lens.factory`; Lens testnet (GAP-10) |
| `contracts/` | ABIs: `ens`, `records_module`, `safe_factory`, `safe_implementation` | the ABI source of truth |
| `ens/` | ENS abi + helpers (namehash, node) | shared `node` convention (INV-6) |
| `ipfs/`, `pin/` | IPFS add/cat/dag + pinning | client-side counterpart to in-action `ipfs.factory` |
| `metadata/` | `S2SContentInfo` type (+ client-side provenance helpers) | signing itself is in the action (`render/metadata.ts`, INV-5) |
| `identity/` | **NEW** — sign-content, verify-content, JCS canonical JSON | EIP-712 signing and authorship verification. The `TypedDataSigner` interface is implemented by `PermissionlessSimpleService` in 0xobsidian (which already has `signTypedData`). `signContentItem` method wraps `buildSignedContentItem` for the publish pipeline. |
| `helpers/` | `withRetry`, `callWithTimeout` | |
| `eth-rpc/` | RPC helpers |
| `cid-view/` | **NEW** — the unified "all CIDs a publication uses" inventory + per-CID retrievability monitoring (dedicated section below) | exported wholesale via the `./safe-app` entry; collectors + coordinator + parser + ipfs-check client |
| `filecoin/` | **NEW** — `FilecoinStorage` (Synapse + filecoin-pin CAR builder): upload/retrieve/delete/terminate, `uploadWithMinCopies`, `estimateMonthlyCost` | entry `@s2s/soul2soul-shared/filecoin`; browser CAR builder injected by the consumer (safe-app `src/filecoin/car-builder.ts`) |

## cid-view — the publication CID inventory + retrievability monitoring (NEW)

A sub-package under `shared/src/cid-view/`, exported wholesale via the `@s2s/soul2soul-shared/safe-app`
entry (safe-app is the only consumer so far). It answers two questions for a storage operator:
**every CID a publication uses** (deals/offers + version history, config/templates/assets, the site
tree, the archive) and **which platforms currently hold a copy of each** (kubo / pinata / filebase /
filecoin). Built 2026-10-08→10-11 (see brain/worktrees.md): T1 collectors → T2 incremental
coordinator → T3 safe-app SWR cache → T4a retrievability core → PR #126 parser → #127–#129 Type
column + chips + health buckets → #130 resume/persist → #131 exclude-version-CIDs.

| file | role |
|---|---|
| `types.ts` | canonical **zod-free** types (INV-7 discipline): `CidCategory` (13 values), `CidEntry`, `CidViewSummary`, `CidViewMeta` (incremental baseline), `PublicationCidView`, `DealRead`, `VersionRead` |
| `context.ts` | `CidViewReadContext` — transport-agnostic read contract: `getDeals`/`getOffers`/`getVersions`(+`getVersionsRange`)/`getConfig`/`getEnsText`/`dagGet`/`ls`/`cat` |
| `adapter.ts` | `createCidViewContext(deps)` — thin 1:1 delegate factory; the consumer (safe-app) supplies chain/IPFS transports |
| `deals.ts` | deal/offer/version collector + `DealCidSnapshot`/`dealFingerprint`/`collectDealCidsIncremental` (fingerprint fast-path → 0 version calls when unchanged; per-genesis count+tail diff; revoked-history retention) |
| `config.ts` | config/template-DAG/assets collector (`configCid` → `templateCid` DAG → `assetsCid` unixfs tree walk, depth/entry caps) |
| `tree.ts` | site tree + archive collectors (`contenthash_wrapped` via `decodeContenthashWrapped`, ENS `content_cache_<pub>` archive JSON → `archive-item` CIDs) |
| `coordinator.ts` | **composition root** — `buildPublicationCidView(ctx, pub, {prev})`: COLD (all four collectors, stable merge order + cross-collector dedupe) vs INCREMENTAL (when `prev.meta.complete === true`, per-layer root-diff/reuse, zero version/RPC calls on unchanged layers); attaches the `meta` block; self-heals to cold on incomplete; validates via `parsePublicationCidView` |
| `retrievability.ts` | per-CID retrievability core (T4a): `RETRIEVABILITY_SOURCES` (kubo/pinata/filebase/filecoin), `CidRetrievabilityStatus` + `CheckState` (ok/no-providers/inconclusive/not-served/failed), `RetrievabilityReadContext.hasCopy`, `checkCidRetrievability` (fail-open per source, capped concurrency, clone-merge into `prev`), `cidsFromView`, `filecoinBackedCidsFromView`, `orderByCopiesAscending`/`orderByStaleness` (never-checked-first, stable) |
| `retrieval-parser.ts` | **ipfs-check `/batch` NDJSON parser** (PR #126) — pure, no fetch/zod (INV-7). `parseRow` → `ParsedCidRetrievability` (per-platform flags, copies 0–4, provider totals, error); `classifyProvider`; `parseBatchNdjson`; `aggregateRetrievability` (category rollups + missing/single-copy CID lists); `toCidRetrievabilityStatus` bridge. `FILECOIN_SP_HOSTS` (8 known SP gateways, mirrors `BROWSER_USABLE_PROVIDERS` in `filecoin/`) drives the filecoin flag |
| `ipfs-check-client.ts` | the ONLY network surface in cid-view (INV-7): `checkBatch` (POST /batch, streamed NDJSON line-by-line), `statusFromCheckLine` (classifies each provider probe serves/missing/unreachable → CheckState; inconclusive/failed keeps last-known result and does NOT advance freshness), `checkRetrievability` (chunked orchestration, merges into `prev`, persists via injected `IpfsCheckBatchCache`, fail-open, rethrows only on abort). Endpoint `https://ipfs-check.transport-union.dev` |
| `validation.ts` | zod schemas mirroring `types.ts` exactly: `cidCategorySchema`/`cidEntrySchema`/`cidViewMetaSchema`/`publicationCidViewSchema` + `parsePublicationCidView`; `parseCidRetrievabilityMap` (localStorage retrievability map) |
| `index.ts` | barrel |

Classification rules (empirical — do not invent others): served = Bitswap.Found OR HTTP.Found;
kubo by agent (`/kubo|go-ipfs/`), pinata/filebase by host string, filecoin by Addr-host ∈
`FILECOIN_SP_HOSTS`; a non-array `result` (e.g. MutableResolution for a non-CID) = no providers
(note the deliberate divergence: `parseRow` treats it as a hard error, the client's
`statusFromCheckLine` as `no-providers` — see the files). `FILECOIN_SP_HOSTS` and
`BROWSER_USABLE_PROVIDERS` must stay in sync.

### heal — pin a remote CID everywhere (NEW, 2026-10-11)

A sibling sub-package under `shared/src/heal/`, exported via the `@s2s/soul2soul-shared/safe-app`
entry (and the root barrel for other esbuild consumers). Given a CID already living on the remote
kubo node, spread it over a provider array so a copy is guaranteed across kubo ("remkubo"), pinata,
filebase and 2× filecoin.

| file | role |
|---|---|
| `heal.ts` | `HealProvider` (kubo/pinata/filebase/filecoin), `HEAL_PROVIDERS` default array, `HealConfig`, `HealFilecoinUploader`, `HealResult`/`HealOutcome`; `healCid(cid, config, providers?, {concurrency?})` — concurrency-limited (default 2), **fail-open per provider** (a throwing provider records its error and the rest still run; `healCid` never rejects), returns `ok`/`partial` + a `sources` map the UI flips availability dots from. kubo = `POST {source}/api/v0/pin/add` (Bearer kuboToken); pinata + filebase reuse the `pin/index.ts` `pinCidFromRemote` primitive; filecoin = injected `HealFilecoinUploader` (ok iff `copyCount >= 2` — the "2x filecoin" guarantee). Transport-agnostic (fetch + AbortSignal + performance only, no new deps, INV-7-safe). |
| `index.ts` | barrel |

## The validation module (directly relevant to the testing plan)

`publication/validation.ts` already defines **zod** schemas: `bodySchema`, `rippleSchema`,
`collectionSchema`, `templateConfigSchema`, `mappingSchema`, `publicationConfigSchema`, `jobSchema`,
`pkpSchema`, + `validateMapping`/`validateConfig`/`validateProtocol`. These are the boundary
validators the earlier testing discussion called for — **but client-side only**; `lit-actions.ts`
comments them out so they never enter the action bundle (INV-7 / the "zod is overkill in actions"
decision). 

**NEW:** `rendering/action-io.ts` now also exports zod schemas for the new content-item types:
`s2sPublicContentSchema`, `s2sProofSchema`, `s2sContentItemSchema`, `s2sSecretBodySchema`,
`didEthrSchema`. These are the single source of truth for the new flat content-item shape.

**2026-08-06:** `EvmUpdateActionInputSchema` (and the `EvmUpdateInput` interface in
`lit/actions/types.ts`) gained an optional `remove: { path: string; replacedBy?: string }[]` field —
the update action's stale-path-removal input (slug renames / revocations). The compile-time sentinel
`_AssertEvmUpdateInputMatches` (interface ↔ zod-inferred) still resolves to `true`. Semantics live
in SPEC-protocol-actions A3; client-side population is a neutralpress TODO (SPEC-neutralpress).

`bodySchema` in `publication/validation.ts` is now **only for backward-compatibility with the
S2SBody-driven actions** — new content-type validation should use `s2sContentItemSchema`.

## Invariants this component preserves

INV-2 (`getProtocolInfo` key set — keep in sync with the in-action copy), INV-5 type
(`S2SContentInfo`), INV-7 (the `lit-actions` entry stays runtime-free). Canonical shapes here back
INV-6/8/11 etc. in the consumers.

**NEW INV-append:** The publication/records contract gates every `append` to the genesis author
(or permitted publication owners), verified against the `did:ethr` identity recorded in the genesis
entry. This is the existing author/publication gate, extended to guard appends.

## Local gotchas / gaps

- **Two `getProtocolInfo`** (here viem; action ethers) — same key set, different field order;
  must co-evolve (INV-2). The `dev` branch here is vestigial (GAP-8).
- **PKP `tokenId`/`publicKey` vestigial** (GAP-11) — prune from `PKP`, `S2SProtocolInfo` pkp, and the
  record-key set.
- zod exists client-side but not in actions — *by design*, not a gap.
- **Two content-type systems coexist** during migration: the old Lens-era S2SBody/S2SPublicContent
  and the new S2SContentItem (protocol/types.ts). Actions still use the old; the identity modules
  use the new. Existing code not yet migrated.
- **contenthash codec homed here (GAP-14 — RESOLVED 2026-10-11).** `shared/src/ipfs/contenthash.ts`
  owns `parseCID` / `decodeContenthashWrapped` / `encodeContenthashWrapped` / `toPreviewLabel`,
  exported from BOTH the zod-free `lit-actions` entry (INV-7 — action libs such as
  `protocol/actions/src/libs/ipfs.factory.ts` import it from there) and the root barrel (safe-app
  `src/lib/contenthash.ts`). The old `contenthashToIPFS` trapped in `protocol/actions/src/libs` is
  gone; `cid-view/tree.ts` consumes `decodeContenthashWrapped` from here.
- **`isBasedOn` removed** from the new content-item shape. Edit history is the contract append log.
  Cross-document derivation is deferred.
- **No `license` field on the new content-item.** The permission model is the access gate —
  encryption on/off plus on-chain decrypt conditions. A declarative legal license would be
  unenforced text beside an enforced mechanism.

## Safe-to-change vs do-not-touch

- 🟢 add services/helpers behind `index.ts`; extend zod schemas (both old and new); add ABIs.
- 🟢 migrate action code from S2SBody to the new S2SContentItem (incremental).
- 🟢 extend `cid-view/` (new collectors, new retrievability sources/fields) — keep the INV-7 purity
  split (pure parser vs the single network client) and mirror any new zod schema in `validation.ts`.
- 🔴 add runtime/Node deps to `lit-actions.ts` (breaks INV-7 bundling); change the `getProtocolInfo`
  record-key set without mirroring the action copy (INV-2); fork the canonical types further.
- 🔴 change the ipfs-check classification rules (served/agent/host semantics, `FILECOIN_SP_HOSTS`)
  without re-validating against the live endpoint; break the parser↔client purity split; diverge
  `statusFromCheckLine` from `parseRow`'s non-array-`result` semantics without updating both.
- 🔴 change the `encryption` field treatment (the new flat shape's `boolean` vs the old
  discriminated union) without updating both the identity modules and the action-io schemas.

## Test seams

- **No standalone suite for `shared`** — except the `cid-view/` module, which carries its own vitest
  suite (~2,900 lines: retrieval-parser 495, ipfs-check-client 388, coordinator 678, deals 864,
  config 249, tree 382, retrievability 312, adapter 89 — run via `pnpm -C shared test`). Everything
  else is validated only as compiled into its consumers — the package builds (esbuild/Vite/action
  bundler) plus the consumers' unit/sequence tests are shared's test coverage. The right place to
  assert shared's contracts is at the consumer boundaries.
- **NEW test seam (cid-view):** fake `CidViewReadContext`s drive the collectors + coordinator; fake
  fetch streams drive the ipfs-check batch client; the parser is pure. The safe-app
  `s2s-cid-view-section` / `s2s-storage-tab` component tests exercise the same contracts through the
  app's `lib/cid-view/` wiring.
- The zod schemas **are** the boundary fixtures — assert real `getProtocolInfo`/`getConfig`/
  `fetchById` outputs parse against them at the consumer that calls them; the first failure names the field.
- **NEW test seam:** `identity/jcs.ts` is pure — unit test deterministic JSON + keccak round-trips.
- **NEW test seam:** `identity/sign-content.ts` + `verify-content.ts` can be tested as a
  sign→verify round-trip with a known test key.
- The zod schemas mirror the type shapes precisely (discriminated union for `bodySchema`,
  flat for `s2sContentItemSchema`).
- `renderwithLitActions` is the integration entry: drive it with fixtures through the Bun runner
  (same path as preview) for the prep→single→merged sequence test (SPEC-protocol-actions seams).