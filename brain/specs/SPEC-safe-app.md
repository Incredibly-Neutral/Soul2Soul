# SPEC-safe-app

> **Audited against live code:** 2026-08-03. **CID-inventory + storage-monitoring re-audit
> 2026-10-11** — the Storage-tab CID inventory, retrievability monitor (ipfs-check), s2s-check /
> s2s-table / s2s-button atoms, and the `lib/cid-view/` wiring landed 2026-10-08→10-11 (see
> `brain/worktrees.md` + SPEC-shared § cid-view).
>
> Component spec for `safe-app/` — the **publisher's control panel**, a Safe{Wallet} app that runs
> inside the Safe web UI iframe. Read **SPEC-00** first; types come from **SPEC-shared**; it drives
> the contracts in **SPEC-contracts-publication / -ens**. Follows SPEC-00 §7.
>
> Invariants touched: INV-2 (records), INV-4 (module discovery), INV-6 (reads contenthash + preview
> link), INV-10 (all writes are Safe proposals → satisfies `onlySafe`), INV-11 (assets → `assetsCid`).

## Responsibility

Owns the **publication owner's** UI: manage licenses, whitelists, and config records, build the
publication config (templates + assets) from a GitHub repo, and **monitor storage** — a read-only
CID inventory of everything the publication uses plus a per-CID retrievability check (ipfs-check),
alongside Filecoin Storage/Data-Sets management. Config/license/whitelist mutations are **proposed
as Safe transactions** (multisig), never executed directly; storage-tab mutations go through the
session-key `FilecoinStorage` instead (see Boundary interfaces). Does not render content, sign, or
write the site root (that's the actions/PKP).

## Runtime context

Vite-built **vanilla Web Components** (Custom Elements + Shadow DOM + `adoptedStyleSheets`), embedded
in the Safe UI via `@safe-global/safe-apps-sdk` (+ `safe-apps-provider`), `allowedDomains:
[/app\.safe\.global$/]`. `window.ethers` (ethers **v6**) is set in `main.ts`. Imports the lean
`@s2s/soul2soul-shared/safe-app` entry (SPEC-shared).

## Boundary interfaces

**Consumes:** Safe info via `SafeAppsSDK.safe.getInfo()` (address, owners, threshold, modules);
the two modules' ABIs (`Abi_S2SRecordsModule`, `Abi_S2SPublicationModule` from `protocol/generated`);
from shared `@s2s/soul2soul-shared/safe-app`: `getProtocolInfo` + `LitService` +
`renderwithLitActions` + `toBytes32Id` + `ConfigBuilder`/`AssetsBuilder`/`S2SIPFSMethods` + the
whole `cid-view/` surface; from `@s2s/soul2soul-shared/filecoin`: `FilecoinStorage`; the ipfs-check
batch endpoint (`IPFS_CHECK_ENDPOINT`); GitHub API + Pinata + Kubo for config/asset building.

**Produces:** **Safe transaction proposals** (`safeSdk.txs.send`) for every records/licenses/whitelist
mutation; a built `S2SPublicationConfig` (→ Pinata + IPFS → `configCid`); an `assetsCid`
(AssetsBuilder). Storage-tab mutations (piece delete, dataset terminate) are **NOT** Safe proposals —
they go through the session-key `FilecoinStorage` (`initWithSessionKey`) as direct Filecoin Onchain
Cloud transactions (`deletePiece`/`terminateDataSet`).

## Sub-component map

| path | role |
|---|---|
| `components/s2s-app.ts` | root element; **5 tabs (Deals/Whitelists/Records/Storage/Website Tree)**; two-phase render (cache→fetch); reads site root via `getText(node,"contenthash_wrapped")`; boots `FilecoinStorage` (`initWithSessionKey`) |
| `components/s2s-deals-tab.ts` | Filecoin deals/offers via `getAllDealsAndOffers`; maps deals → list (replaces the old `s2s-licences-tab.ts`) |
| `components/s2s-storage-tab.ts` | storage tab: **CID inventory** (`s2s-cid-view-section`) + Filecoin Storage/Data-Sets tables, cost summary, piece delete + dataset terminate |
| `components/s2s-cid-view-section.ts` | read-only **CID inventory + retrievability monitor** (see Key flows) |
| `components/s2s-check.ts` | generic single-action check pill (whitelist "can publish", deals "genesis has a deal") — parent drives `.result` |
| `components/s2s-table.ts`, `table-filter.ts`, `toggle-button.ts` | reusable table (sort/filter chrome), filter dropdown, toggle atom |
| `components/s2s-button.ts`, `s2s-sliding-add-button.ts` | gradient-border button atom + sliding add (deals/website-tree row actions) |
| `components/s2s-whitelist-tab.ts` | author/dev whitelist management |
| `components/s2s-records-tab.ts` | view/edit config records; config/asset build entry |
| `components/copy-*.ts` | UI atoms (clipboard, copy-hash, etc.) |
| `state/store.ts` + `observable.ts` + `*.store.ts` + `storage.ts` | observable store, **localStorage-backed**, slice subscriptions |
| `lib/cid-view/` (`context.ts`, `cache.ts`, `ipfs-check.ts`, `index.ts`) | safe-app wiring of the shared cid-view surface: `buildSafeAppCidViewContext` (adapter), localStorage retrievability cache, ipfs-check batch wrapper (batch size 3) |
| `lib/safe-integration.ts` | Safe SDK wrapper: discover modules (INV-4), read records/licenses, **propose** mutations |
| `lib/protocol-integration.ts` | `getProtocolInfo(false, L1, L2)` via **viem** clients |
| ~~`lib/config-builder.ts`~~ | ~~`ConfigBuilder`~~ — **moved to `shared/src/publication/config-builder.ts`** (GAP-12 consolidation); safe-app imports from shared |
| ~~`lib/assets-builder.ts`~~ | ~~`AssetsBuilder`~~ — **moved to `shared/src/publication/assets-builder.ts`** (GAP-12 consolidation); safe-app imports from shared |
| `lib/ipfs.factory.ts`, `ipfs-fs.factory.ts`, `evm.ts` | IPFS add/dag/MFS + RPC helpers |

## On-chain interaction model

- **Reads:** direct RPC (ethers `JsonRpcProvider` in SafeIntegration; **viem** `createPublicClient`
  in ProtocolIntegration) — modules by `NAME()` (INV-4), records, licenses, and the site root from
  the ENS records contract (INV-6).
- **Writes:** **always** `safeSdk.txs.send({txs:[{to,value,data}]})` → queued at
  `app.safe.global/transactions/queue` for owner confirmation. So `setRecord`, `deleteRecord`,
  `grantLicense`, `acceptLicense`, `revokeLicense` are *proposals*; `onlySafe`/whitelist gates are
  satisfied because the Safe itself executes (INV-10).

## Key flows

- **Config build:** `AssetsBuilder` (GitHub → `assetsCid`) → `ConfigBuilder.buildConfig(owner, repo,
  branch, name, contract, assetsCid)`: fetch `templates/` (→ per-file IPFS CIDs + `templatesCid`
  DAG), fetch **`mapping.json` verbatim**, assemble `{assetsCid, contract, dataGateway, mapping,
  name, templateCid}` → upload to Pinata + IPFS → `configCid` → stored as the `config` record (Safe
  proposal). The actions later read it via `getConfig`.
- **Two-phase render:** Phase 1 paint from localStorage cache; Phase 2 fetch fresh, update store,
  re-render via slice subscriptions.
- **CID inventory + retrievability monitoring (Storage tab):** `s2s-cid-view-section` runs the shared
  coordinator (`buildPublicationCidView`, SPEC-shared § cid-view) over a `CidViewReadContext` built
  by `lib/cid-view/context.ts` (SafeIntegration → deals/offers/versions; store `config` record +
  Kubo → config/templates/assets; L2 ENS records + Kubo gateway → site tree/archive).
  - Stale-while-revalidate: last-good view per publication in localStorage (`s2s.cidview.<pub>`),
    zod-validated on load; incremental rebuild passes the cached view as `prev` (coordinator
    self-degrades to cold when `prev.meta.complete !== true`); manual Refresh forces cold.
  - Offers + version CIDs are excluded from the table AND the retrievability pass
    (`HIDDEN_CATEGORIES`/`VERSION_CATEGORIES`, PR #131 — ~415 version CIDs were genuinely 0-provider
    live) but the FULL view stays the incremental cache baseline.
  - Retrievability pass: stalest-first, **unfresh-only** auto pass (15-min window
    `RETRIEVABILITY_AUTO_FRESH_MS`) resumed from the localStorage map; manual Recheck forces a full
    pass. Batch endpoint via `lib/cid-view/ipfs-check.ts` (batch size 3 vs the shared default 50) →
    shared `checkRetrievability` → `s2s.cidview.<pub>.retrievability` + a bounded raw `/batch` debug log.
  - Health buckets: 0 copies = lost · 1 = danger · 2–4 = needs healing · ≥5 = healthy; an
    inconclusive/failed pass never reads as "lost" (overloaded check node ≠ data loss). Type + health
    chips are toggle filters; the flat table is risk-sorted (fewest copies first).
  - Storage-blocked probe: a sandboxed/private iframe that refuses localStorage surfaces
    `⚠ browser storage unavailable` instead of silently degrading.

## Invariants this component preserves

INV-4 (module discovery by NAME), INV-2 (`getProtocolInfo` + the `config`/record keys it sets),
INV-11 (`assetsCid` producer), INV-6 (reads contenthash; emits the preview link), INV-10 (mutations
as Safe proposals).

## Shared surface consumed (bundled into the Vite build)

Entry point: **`@s2s/soul2soul-shared/safe-app`** (the lean one). Imports: `getProtocolInfo(false,
L1, L2)` (viem-based), `LitService`, the types `S2SProtocolInfo`/`S2SPublicationConfig`, plus the
**whole `cid-view/` surface** (`buildPublicationCidView`, `parsePublicationCidView`,
`createCidViewContext`, collectors, retrievability core, retrieval-parser, ipfs-check client) and
`S2SIPFSMethods`/`ConfigBuilder`/`AssetsBuilder`. The Storage tab also pulls
**`@s2s/soul2soul-shared/filecoin`** (`FilecoinStorage`). These compile into the safe-app bundle —
treat them as this package's code. (Contract ABIs come from `protocol/generated`, not shared.)

## Publisher actions (workflow + cross-system effects, not contract semantics)

On-chain **semantics** live in SPEC-contracts-publication (don't duplicate). What follows is the
operator-facing layer the contract spec can't carry — origin, preconditions, and downstream effects:

| action | who initiates (from safe-app) | precondition | downstream effect |
|---|---|---|---|
| grant license | publisher Safe | — | immediate license (safe == msg.sender); a *non-whitelisted author* calling `grantLicense` elsewhere instead creates a **pending offer** |
| approve pending license (`acceptLicense`) | publisher Safe | a pending offer exists (from a non-whitelisted author) | offer → active license |
| revoke license | publisher Safe (or the license author) | active license | license=false → on the **next render** the content is `revoked` and its page removed → **implies a rebuild** to take effect |
| whitelist **author** | publisher Safe | — | author passes `canPublish` and may grant licenses directly (no offer step). Content contributor |
| whitelist **dev** | publisher Safe | — | dev passes `canPublish`; operationally the technical/template role. Both author & dev are distinct lists/caps |
| remove whitelisted author/dev | publisher Safe | listed | removed from `canPublish` — **does NOT revoke existing licenses** (deliberate; revoke separately) |
| update records (`setRecord`/`deleteRecord`) | publisher Safe | records module present | changes config the actions read; updating `config`/`name`/gateways changes what renders |

All rows are proposed as Safe transactions (multisig); none execute directly.

## Local gotchas / gaps

- **`useDefineForClassFields: false` is load-bearing.** With it `true` (the
  ES2022 default), Lit's experimental decorators (`@state`/`@property`)
  compile to `Object.defineProperty` in the constructor, shadowing the reactive
  accessors on the prototype — every `@state` assignment silently stops calling
  `requestUpdate()`. This broke tab switching across all 13 components after the
  Lit refactor. **Never re-enable it.**
- **`//` comments inside `css` template literals break the rule they precede**
  (the garbage token swallows the next declaration — hit on `--font-mono-family`
  in `fonts.ts`). Use `/* */` or no comment.
- **Monospace is Fira Code, period.** `--font-mono-family` defaults to `'Fira
  Code'` — there is no other mono (DM Mono/IBM Plex Mono toggle classes are
  inert). The QA type = `var(--font-mono)` + `.85rem` + `.75px` tracking +
  uppercase. `h1.title` is DM Serif Display 2.8rem/1.2, margin 0 (the element is
  an `<h1 class="title">`, not `<h2>`).
- **`mapping.json` is used verbatim — the builder does NOT inject publication-specific values.**
  (`mapping = JSON.parse(mappingContent)`.) Today the author must set the correct `feedAddress`
  (collections) and page `postId` (ripples) in *their repo's* `mapping.json` — an onboarding sharp
  edge (a copied starter carries someone else's feed/postIds). **DECISION (TODO): inject the
  `feedAddress` in `ConfigBuilder`** — it is known at build time (the publication's own feed,
  `S2SPublication.feed`), so the builder should write it into `mapping` rather than rely on the
  author. (Page `postId` injection is harder — pages are Lens posts; revisit.) See SPEC-website-starter.
- **Bare preview scheme:** the UI links `https://<rootCid>.preview.transport-union.dev` (bare, no
  `.ipfs.` label). OPEN-TASK-1's Kubo-native subdomain gateway yields the **namespaced** form — so
  either the gateway needs a custom bare proxy or the UI link needs `.ipfs.` inserted. Latent
  inconsistency to reconcile with OPEN-TASK-1.
- **Mixed ethers + viem in one package:** SafeIntegration uses `window.ethers` (v6);
  ProtocolIntegration uses viem. Candidate for consolidation (SPEC-00 Q7 / single-source rule).
- **Client-exposed secret:** `VITE_GITHUB_TOKEN` is a `VITE_`-prefixed env var → **bundled into the
  shipped client** and visible. Same class as GAP-9. Move GitHub fetches behind a backend or use a
  scoped/short-lived token.
- **`insertStylesheetLink` / `insertAssetImageCids`** in ConfigBuilder are **dead** (calls commented
  out; superseded by the assets-into-`/assets` refactor) — prune.
- **iframe constraints:** clipboard (`copy-hash.ts`) is subject to the Safe iframe's permissions
  policy; store `connectedCallback` must avoid double-subscribe render loops (watch slice subs).
- **ipfs-check discovery blind spots (live, PR #131):** Filecoin + Pinata copies are INVISIBLE to
  ipfs-check discovery (0 filecoin agents returned for any publication CID) — the `filecoin` source
  flag therefore relies on the Addr-host → `FILECOIN_SP_HOSTS` heuristic, and "copies" undercounts
  real provider copies. Follow-up gap, not a recognition fix here.
- **Two batch sizes:** shared `checkRetrievability` defaults to 50 cids/POST; the app pins 3
  (`lib/cid-view/ipfs-check.ts`) to keep the UI incremental. Deliberate — keep them in sync.
- **inconclusive ≠ lost:** `statusFromCheckLine` preserves last-known sources/copies/checkedAt on an
  inconclusive/failed pass and does NOT advance freshness, so those CIDs are retried next pass — an
  overloaded check node must never look like lost data.
- **The ipfs-check server** (`ipfs-check/` in the monorepo, Bun) is the self-hosted batch proxy
  (`POST /batch {cids}` → NDJSON stream, global concurrency semaphore, `httpRetrieval=on`); the app's
  `IPFS_CHECK_ENDPOINT` (`https://ipfs-check.transport-union.dev`) points at it.
- **Exclude-version gate:** `HIDDEN_CATEGORIES`/`VERSION_CATEGORIES` (empty set re-enables) drive the
  offer/version exclusion — don't bypass it without revisiting the live 0-provider evidence.

## Build, deploy & QA

**Preferred deploy: `./deploy.sh`** (the package.json `deploy` script delegates to it
— it is the single source of truth): `pnpm build` (tsc type-check → vite build →
pnpm sass) then `rsync -avz --delete dist/ joera:/srv/publication-module/`. The
`--delete` keeps the remote identical to `dist/`; verify the remote bundle hash
matches `dist/main.*.js` after deploying.

**Verify the build headlessly with `pnpm qa`** (`qa/qa.mjs`, see `qa/README.md`):
spawns a `--no-open` vite preview of `dist/`, mocks the Safe iframe
`getSafeInfo` handshake (real Safe address + modules, chainId 8453), and asserts
all 5 tabs navigate (active tab + rendered component swap) with no page errors.
This is the regression net for the "tabs don't switch" class of bug — run it
after any component/build-config change, before `./deploy.sh`.

Reality checks:
- `pnpm dev` is **broken** (ethers v5/v6 dedupe — see gotchas). Production build
  is unaffected; always validate against `pnpm build` + preview/QA.
- `vite preview` auto-opens a browser (`preview.open: true`) — use `--no-open` headless.

## Safe-to-change vs do-not-touch

- 🟢 UI/styles/tabs; store internals; caching; prune dead ConfigBuilder helpers.
- 🟢 CID-inventory UI (chips/filters/health buckets, columns); retrievability-pass tuning (freshness
  window, batch size); cache-format extensions (still zod-validated).
- 🔴 module discovery by `NAME()` (INV-4); the `config`/record key names (INV-2); proposing via the
  Safe SDK rather than direct send (INV-10); the `contenthash_wrapped` read key (INV-6); injecting
  values into `mapping.json` silently (would diverge from the author-owned model — decide explicitly).
- 🔴 the shared cid-view classification/parser semantics (SPEC-shared); the incremental `meta` +
  full-view cache contract (offers/versions must stay in the baseline); routing storage mutations
  through `safeSdk.txs` instead of `FilecoinStorage` (different transaction path).

## Test seams

- SafeIntegration: mock `SafeAppsSDK` → assert mutations produce the right `{to,data}` (encoded
  `setRecord`/`grantLicense`/…) and never a direct send.
- ConfigBuilder: fixture a GitHub repo (templates + mapping.json) → assert the emitted
  `S2SPublicationConfig` shape (parses against the shared zod `publicationConfigSchema`) and that
  `mapping` is passed through unchanged.
- AssetsBuilder: fixture a repo → assert `assetsCid` + the js/css-always-overwrite vs
  fonts/img/svg-reconcile sync policy.
- Store: subscribe/notify + localStorage round-trip; guard against the connectedCallback re-render loop.
- CID inventory: `tests/components/s2s-cid-view-section.test.ts` + `tests/components/s2s-storage-tab.test.ts`
  fake the `CidViewReadContext` + localStorage + a fake ipfs-check batch; `tests/lib/cid-view.test.ts`
  covers the adapter. The shared core carries its own suite (SPEC-shared § cid-view).
