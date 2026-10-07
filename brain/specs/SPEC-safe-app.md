# SPEC-safe-app

> **Audited against live code:** 2026-08-03.
>
> Component spec for `safe-app/` — the **publisher's control panel**, a Safe{Wallet} app that runs
> inside the Safe web UI iframe. Read **SPEC-00** first; types come from **SPEC-shared**; it drives
> the contracts in **SPEC-contracts-publication / -ens**. Follows SPEC-00 §7.
>
> Invariants touched: INV-2 (records), INV-4 (module discovery), INV-6 (reads contenthash + preview
> link), INV-10 (all writes are Safe proposals → satisfies `onlySafe`), INV-11 (assets → `assetsCid`).

## Responsibility

Owns the **publication owner's** UI: manage licenses, whitelists, and config records, and build the
publication config (templates + assets) from a GitHub repo. Mutations are **proposed as Safe
transactions** (multisig), never executed directly. Does not render content, sign, or write the site
root (that's the actions/PKP).

## Runtime context

Vite-built **vanilla Web Components** (Custom Elements + Shadow DOM + `adoptedStyleSheets`), embedded
in the Safe UI via `@safe-global/safe-apps-sdk` (+ `safe-apps-provider`), `allowedDomains:
[/app\.safe\.global$/]`. `window.ethers` (ethers **v6**) is set in `main.ts`. Imports the lean
`@s2s/soul2soul-shared/safe-app` entry (SPEC-shared).

## Boundary interfaces

**Consumes:** Safe info via `SafeAppsSDK.safe.getInfo()` (address, owners, threshold, modules);
the two modules' ABIs (`Abi_S2SRecordsModule`, `Abi_S2SPublicationModule` from `protocol/generated`);
`getProtocolInfo` + `fetchById` + `LitService` (`prod` → Chipotle) from shared; GitHub API + Pinata +
Kubo for config/asset building.

**Produces:** **Safe transaction proposals** (`safeSdk.txs.send`) for every mutation; a built
`S2SPublicationConfig` (→ Pinata + IPFS → `configCid`); an `assetsCid` (AssetsBuilder).

## Sub-component map

| path | role |
|---|---|
| `components/s2s-app.ts` | root element; **5 tabs (Deals/Whitelists/Records/Storage/Website Tree)**; two-phase render (cache→fetch); reads site root via `getText(node,"contenthash_wrapped")` |
| `components/s2s-deals-tab.ts` | Filecoin deals/offers via `getAllDealsAndOffers`; maps deals → list (replaces the old `s2s-licences-tab.ts`) |
| `components/s2s-storage-tab.ts` | storage management (new tab) |
| `components/s2s-whitelist-tab.ts` | author/dev whitelist management |
| `components/s2s-records-tab.ts` | view/edit config records; config/asset build entry |
| `components/copy-*.ts`, `toggle-button.ts` | UI atoms (clipboard, etc.) |
| `state/store.ts` + `observable.ts` + `*.store.ts` + `storage.ts` | observable store, **localStorage-backed**, slice subscriptions |
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

## Invariants this component preserves

INV-4 (module discovery by NAME), INV-2 (`getProtocolInfo` + the `config`/record keys it sets),
INV-11 (`assetsCid` producer), INV-6 (reads contenthash; emits the preview link), INV-10 (mutations
as Safe proposals).

## Shared surface consumed (bundled into the Vite build)

Entry point: **`@s2s/soul2soul-shared/safe-app`** (the lean one). Imports: `getProtocolInfo(false,
L1, L2)` (viem-based), `fetchById`, `LitService`, and the types `S2SProtocolInfo`/`PKP`/
`S2SPublicationConfig`. These compile into the safe-app bundle — treat them as this package's code.
(Contract ABIs come from `protocol/generated`, not shared.)

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
- 🔴 module discovery by `NAME()` (INV-4); the `config`/record key names (INV-2); proposing via the
  Safe SDK rather than direct send (INV-10); the `contenthash_wrapped` read key (INV-6); injecting
  values into `mapping.json` silently (would diverge from the author-owned model — decide explicitly).

## Test seams

- SafeIntegration: mock `SafeAppsSDK` → assert mutations produce the right `{to,data}` (encoded
  `setRecord`/`grantLicense`/…) and never a direct send.
- ConfigBuilder: fixture a GitHub repo (templates + mapping.json) → assert the emitted
  `S2SPublicationConfig` shape (parses against the shared zod `publicationConfigSchema`) and that
  `mapping` is passed through unchanged.
- AssetsBuilder: fixture a repo → assert `assetsCid` + the js/css-always-overwrite vs
  fonts/img/svg-reconcile sync policy.
- Store: subscribe/notify + localStorage round-trip; guard against the connectedCallback re-render loop.
