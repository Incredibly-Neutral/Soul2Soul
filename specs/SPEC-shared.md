# SPEC-shared

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
| `@s2s/soul2soul-shared` (`index.ts`) | **everything** (services + types + ABIs) | neutralpress, 0xobsidian (**esbuild**) | full runtime OK |
| `@s2s/soul2soul-shared/lit-actions` (`lit-actions.ts`) | **types + ABIs only**, no runtime | `protocol/actions` (**action bundler**) | **INV-7:** never add runtime/Node deps; zod validators intentionally commented out (bundle size) |
| `@s2s/soul2soul-shared/safe-app` (`safe-app.ts`) | minimal: `getProtocolInfo`, `fetchById`, `LitService`, types | safe-app (**Vite**) | keep lean — "no Lit/Lens/CCIP baggage" |

## Canonical type catalog (single source of truth)

| type | file | shape (abbrev) |
|---|---|---|
| `S2SBody` | `protocol/types.ts` | **discriminated union**: `S2SBodyBase` + `S2SBodyPlain` (`encryption: false`, `content`, `title`, `slug`, `custom?`) / `S2SBodyEncrypted` (`encryption: true`, no plaintext fields) |
| `S2STemplateData` | `protocol/types.ts` | render-time view: `id, controller, tags, language, position, encrypted, postType, publications[], collections?, path, base?, custom, content, dates` |
| `S2SCollection` | `protocol/types.ts` | `source, query, filters?, key, value, slug` |
| `S2SRipple` | `protocol/types.ts` | `origins[], destination, reference, query` |
| `S2STemplateConfig` | `protocol/types.ts` | `reference, file, path, collections?, filters?` |
| `S2SJob` | `protocol/types.ts` | `id, templateConfig, path?, templateData?, html?, revoked?` |
| `PKP` | `protocol/types.ts` | `tokenId, publicKey, ethAddress` — **tokenId/publicKey vestigial (GAP-11)** |
| `S2SProtocolInfo` | `protocol/types.ts` | `addr?, recordsModule, dataGateway, assetsGateway, lensApp, ensRecords, pkp, litAction{Prep,Cbor,Single,RootUpdate}` |
| `S2SPublicationConfig` | `publication/types.ts` | `assetsCid, contract, dataGateway, mapping, name, templateCid` |
| `S2SPublication` | `publication/types.ts` | `name, owners[], authors[], contract?, configCid?, feed?, devRepository, branch` (← GitHub repo+branch for templates/assets) |
| `S2SContentInfo` | `metadata/types.ts` | provenance fields signed into the page (INV-5) |
| `S2SPublicContent` / `S2SToEncrypt` | `content/types.ts` | author-side content + the encrypted subset |
|
## Module map (services)

| module | role | notes |
|---|---|---|
| `protocol/` | `getProtocolInfo` (viem), `getRecords`, `getProtocolControllerAndModules`, constants | **mirror of the in-action `libs/protocol.factory.ts`** — same record-key set (INV-2), different stack (viem vs ethers); has the `dev`→`dev.soul2soul.eth` branch (GAP-8, vestigial) |
| `rendering/` | `renderwithLitActions` (client orchestrator: prep→single→merged) + helpers | drives the pipeline; selects Bun (preview) vs Lit (prod). Types re-exported from `protocol/types.ts` |
| `lit/` | `LitService` (Chipotle REST client), `actions/encrypt`, `compactAction`, gates `can_publish`/`can_read` | `LitService` base URL = `api.chipotle.litprotocol.com/core/v1` (prod) / `api.dev…` (dev); `X-Api-Key`; `poolKeys` map (poolId→usageKey). Backs `swap-action`/`deploy-group`/`update-protocol` |
| `publication/` | `config-builder` (S2SConfigBuilder: GitHub repo→config), `types`, **`validation` (zod)** | validation schemas live here (client-side) |
| `lens/` | Lens GraphQL client (`fetchById`, queries) | mirrors in-action `lens.factory`; Lens testnet (GAP-10) |
| `contracts/` | ABIs: `ens`, `records_module`, `safe_factory`, `safe_implementation` | the ABI source of truth |
| `ens/` | ENS abi + helpers (namehash, node) | shared `node` convention (INV-6) |
| `ipfs/`, `pin/` | IPFS add/cat/dag + pinning | client-side counterpart to in-action `ipfs.factory` |
| `metadata/` | `S2SContentInfo` type (+ client-side provenance helpers) | signing itself is in the action (`single/metadata.ts`, INV-5) |
| `helpers/` | `withRetry`, `callWithTimeout` | |
| `eth-rpc/` | RPC helpers | |

## The validation module (directly relevant to the testing plan)

`publication/validation.ts` already defines **zod** schemas: `bodySchema`, `rippleSchema`,
`collectionSchema`, `templateConfigSchema`, `mappingSchema`, `publicationConfigSchema`, `jobSchema`,
`pkpSchema`, + `validateMapping`/`validateConfig`/`validateProtocol`. These are the boundary
validators the earlier testing discussion called for — **but client-side only**; `lit-actions.ts`
comments them out so they never enter the action bundle (INV-7 / the "zod is overkill in actions"
decision). The zod schemas now mirror the type shapes precisely (discriminated union for `bodySchema`,
`jobSchema.html` optional, single-source `S2STemplateConfig`/`S2SCollection`). The split is clean:
**reuse these zod schemas for client/app + sequence tests;
mirror them as tiny dependency-free asserts at the action boundaries.**

## Invariants this component preserves

INV-2 (`getProtocolInfo` key set — keep in sync with the in-action copy), INV-5 type
(`S2SContentInfo`), INV-7 (the `lit-actions` entry stays runtime-free). Canonical shapes here back
INV-6/8/11 etc. in the consumers.

## Local gotchas / gaps

- **Two `getProtocolInfo`** (here viem; action ethers) — same key set, different field order;
  must co-evolve (INV-2). The `dev` branch here is vestigial (GAP-8).
- **PKP `tokenId`/`publicKey` vestigial** (GAP-11) — prune from `PKP`, `S2SProtocolInfo` pkp, and the
  record-key set.
- zod exists client-side but not in actions — *by design*, not a gap.

## Safe-to-change vs do-not-touch

- 🟢 add services/helpers behind `index.ts`; extend zod schemas; add ABIs.
- 🔴 add runtime/Node deps to `lit-actions.ts` (breaks INV-7 bundling); change the `getProtocolInfo`
  record-key set without mirroring the action copy (INV-2); fork the canonical types further.

## Test seams

- **No standalone suite for `shared`.** It is validated only as compiled into its consumers — the
  package builds (esbuild/Vite/action bundler) plus the consumers' unit/sequence tests are shared's
  test coverage. The right place to assert shared's contracts is at the consumer boundaries.
- The zod schemas **are** the boundary fixtures — assert real `getProtocolInfo`/`getConfig`/
  `fetchById` outputs parse against them at the consumer that calls them; the first failure names the field.
- Consolidate the duplicate types and resolve the `bodySchema` shape → **done** (SEE CURRENT: discriminated union at `protocol/types.ts`, matching `z.discriminatedUnion` at `publication/validation.ts`)
  consumer's fixtures encode one truth.
- `renderwithLitActions` is the integration entry: drive it with fixtures through the Bun runner
  (same path as preview) for the prep→single→merged sequence test (SPEC-protocol-actions seams).