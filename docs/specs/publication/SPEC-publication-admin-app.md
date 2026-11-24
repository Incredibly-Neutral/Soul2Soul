# SPEC-publication-admin-app — `safe-app`, the holder's control panel

> **Parent:** [SPEC-publication](SPEC-publication.md) — the publication front door.
> **Siblings:** [SPEC-publication-agreements](SPEC-publication-agreements.md),
> [SPEC-publication-storage](SPEC-publication-storage.md) (the tree and availability model the Storage
> tab monitors), [SPEC-publication-look](SPEC-publication-look.md) (what it builds a config _from_).
>
> **Type:** component spec. It owns the operator surface: what a holder can see and propose from inside
> Safe{Wallet}.
>
> **Audited against live code:** 2026-08-03; re-audited 2026-10-11 for the CID inventory and
> retrievability monitor; **folded and corrected 2026-10-30** (the folded text still used the V1
> `grantLicense`/`acceptLicense` vocabulary — see [corrections](#corrections)).
>
> **Folded from:** `SPEC-safe-app` (all sections).

---

## Responsibility

`safe-app/` is a Safe{Wallet} app: a Vite build of vanilla Web Components, loaded in the Safe UI iframe,
holding **no key and no server**. It reads chain state directly over RPC and **proposes** every mutation
as a Safe transaction. It renders nothing, signs nothing on the publication's behalf, and never writes
the site root.

Five tabs: **Agreements · Whitelists · Records · Storage · Website Tree**. The tab is named
Agreements; its ids keep the older word (`deals-tab`, `s2s-deals-tab`, `currentTab: 'deals'`) because
links, tests and the e2e helper key off them.

## Runtime context

- Web Components (Custom Elements + Shadow DOM + `adoptedStyleSheets`), no framework.
- Embedded via `@safe-global/safe-apps-sdk` (+ `safe-apps-provider`), `allowedDomains: [/app\.safe\.global$/]`.
- `window.ethers` is **ethers v6**, set in `main.ts`.
- Imports the lean shared entry `@s2s/soul2soul-shared/safe-app`; types and cid-view machinery compile
  into the bundle and are, for practical purposes, this package's code.
- Two-phase render everywhere: paint from the localStorage cache, then fetch, update the store, and
  re-render through slice subscriptions.

## Boundary interfaces

**Consumes:** `SafeAppsSDK.safe.getInfo()` (address, owners, threshold, modules); the two modules' ABIs
from `protocol/generated`; from shared — `getManifest`, `LitService`, `renderwithLitActions`,
`toBytes32Id`, `ConfigBuilder`, `AssetsBuilder`, `S2SIPFSMethods`, the whole `cid-view/` surface,
`heal/`; from `@s2s/soul2soul-shared/filecoin` — `FilecoinStorage`; GitHub + Kubo for config building;
the ipfs-check batch endpoint.

**Produces:**

| output                                          | path                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Safe transaction proposals (`safeSdk.txs.send`) | every records / agreement / whitelist mutation                                                   |
| a built `S2SPublicationConfig` → `configCid`    | config tab → `setRecord('config')`                                                               |
| an `assetsCid`                                  | `AssetsBuilder`                                                                                  |
| **direct** Filecoin transactions                | piece delete / dataset terminate, via the session-key `FilecoinStorage` — **not** Safe proposals |

That last row is the one asymmetry in the write model, and it is deliberate: Filecoin Onchain Cloud has
its own transaction path and its own key. Do not "fix" it by routing it through `safeSdk.txs`.

## Sub-component map

| path                                                                                                                           | role                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `components/s2s-app.ts`                                                                                                        | root element; five tabs; reads the site root via `getText(node, "contenthash_wrapped")`; boots `FilecoinStorage` |
| `components/s2s-deals-tab.ts`                                                                                                  | deals and offers (`getAllDealsAndOffers`), row actions, Bulk Render + preview, per-row Preview in a new tab      |
| `components/s2s-whitelist-tab.ts`                                                                                              | author/dev lists                                                                                                 |
| `components/s2s-records-tab.ts`                                                                                                | view/edit records; config + asset build entry; alias editing                                                     |
| `components/s2s-storage-tab.ts`                                                                                                | CID inventory + Filecoin storage/Data-Sets tables, piece delete, dataset terminate                               |
| `components/s2s-cid-view-section.ts`                                                                                           | read-only CID inventory + retrievability monitor + per-row heal                                                  |
| `components/s2s-website-tree-tab.ts`                                                                                           | site tree walk, snapshot diff ("Sync"), reset                                                                    |
| `components/s2s-check.ts`, `s2s-table.ts`, `table-filter.ts`, `toggle-button.ts`, `s2s-button.ts`, `s2s-sliding-add-button.ts` | atoms reused across tabs                                                                                         |
| `state/store.ts`, `observable.ts`, `*.store.ts`, `storage.ts`                                                                  | observable store, localStorage-backed                                                                            |
| `lib/safe-integration.ts`                                                                                                      | Safe SDK wrapper: module discovery, reads, **proposal** encoding                                                 |
| `lib/publication-init.ts`                                                                                                      | the two-batch initialisation and the teardown batch ([account child](SPEC-publication-account.md))               |
| `lib/protocol-integration.ts`                                                                                                  | `getManifest(L1, L2)` via viem, then `getManifest(L1, L2, pinned)` once the records are in                   |
| `lib/cid-view/`                                                                                                                | safe-app adapter over the shared cid-view surface                                                                |
| `lib/ens-registration.ts`                                                                                                      | L1 subname registration, NameWrapper branch                                                                      |

`lib/config-builder.ts` and `lib/assets-builder.ts` **no longer exist here** — they moved to
`shared/src/publication/` (GAP-12 consolidation). The app imports them from shared.

**The document is the one the publication pinned.** `ProtocolIntegration.initialize()` reads the
current document only because the module factory it carries is what finds the publication's records
module at all; `runFetchFreshData` then reads `manifest_version` from those records and re-reads the
manifest at that version. A pinned read is a snapshot and never falls back, so a pin this module does
not hold logs and leaves the current document in place rather than running different code under the
same name.

## On-chain interaction model

- **Reads:** direct RPC. `SafeIntegration` uses ethers v6 `JsonRpcProvider`; `ProtocolIntegration` uses
  viem `createPublicClient`. Which one a given read uses is historical, not principled.
- **Writes:** always `safeSdk.txs.send({ txs: [{ to, value, data }] })` → queued at
  `app.safe.global/transactions/queue`. Every `to` comes from the contract wrapper's `target`, never from
  `safeInfo` — this was a real crash (a `to: ''` on a half-initialised publication) and the rule that
  fixed it.
- `onlySafe` is satisfied because the Safe itself is `msg.sender` — the whole write model is a
  consequence of the contracts' access control, not a preference.

**Module discovery asks one factory and reads its answers as they are.** A module's address is
`moduleAddress(safe, kind)` on the factory the `publication_factory` record names, read on the Safe's
chain; the same call answers before a create and after it, so the address is never predicted, scanned
for in logs, or matched against a `NAME()` string, and a second factory is never consulted. The rule
has a stated consequence, and it is not a gap: a Safe whose modules came from an earlier factory has
no module at the address this app asks for, so the app reports that the recorded factory names no
module for the kind and says that publications created by an earlier factory are not managed here. It
offers no legacy lookup and repairs nothing silently. Creating a fresh pair over a Safe that already
carries one is therefore an explicit act by its holders: the app proposes a create only for a kind
whose recorded address has no code, and a create for an (safe, kind) that exists returns the module the
factory already recorded.

## Key flows

**Initialisation (existing Safe):** two proposals — one create batch naming both kinds, then one
merged enable-and-name batch — each address read back from the factory and accepted only once it has
code, then a 10-minute human wait. Detailed in
[the account child](SPEC-publication-account.md#route-b--admin-app).

**Accept / refuse / revoke:** `admit(genesis)` accepts an offer, `reject(genesis)` declines an offer or
demotes a deal back to one; the contract distinguishes the two by whether the genesis is in the deal set,
and `reject` is reversible. Both are `onlySafe`. The author's `retract` is not the app's verb at all: it is
the genesis author's and terminal, so an app that sent it would revert `NotAuthorized()`. **Revoke proposes
no render**, so a revoked page stays live until something renders it as a removal — that is a known gap,
not behaviour to rely on.

**One kind, one surface.** The ABI follows the module's KIND, never a probed version string: the
publication kind binds `S2SPublicationModuleV0_1` and is called `admit`/`reject` by name, the records kind
binds `S2SRecordsModuleV0_1`. The kind also decides the address, `moduleAddress(safe, kind)` on the factory,
asked before the create as well as after, so `src/lib/safe-integration.ts` needs no `NAME()` read and no
version table. A factory that answers nothing is refused, not worked around: the tab names the address it
expected and stops. Nothing in the app reads a version and nothing falls back to an older module's
verb set.

**Bulk Render / preview:** one button, two behaviours, the same `renderwithLitActions` call with
`preview` flipped. The item list is `store.deals` (the app's cache, not the module), a preview filters out
encrypted items, and the result is `console.log`ged — no root is set, no header refresh. Details in
[the storage child](SPEC-publication-storage.md#rendering-and-what-it-leaves-behind) and
[the front door §render](SPEC-publication.md).

**Per-row preview:** every offer and deal row carries its own Preview button, independent of the preview
toggle (which changes only what the bulk Sync site call does). It renders that one genesis with
`preview` true and opens `previewLink(cid, path)` in a new browser tab: the tab is opened inside the
click gesture and navigated once the render answers, because a popup raised after the awaits is blocked,
with an "Open preview" link left beside the button when the browser blocks it anyway. A failed render
closes the tab and names the error. An encrypted row's button is rendered but disabled — the render has
no key, and `renderIds()` already drops those items from a preview.

**Config build:** `AssetsBuilder` (GitHub → `assetsCid`) → `ConfigBuilder.buildConfig(...)` → one
`setRecord('config')` proposal. The build itself belongs to
[SPEC-publication-look](SPEC-publication-look.md#from-repository-to-config).

**Storage monitoring:** the Storage tab builds a CID inventory and probes retrievability; the Website
Tree tab walks the site DAG and diffs snapshots. Model and semantics in
[SPEC-publication-storage](SPEC-publication-storage.md#observing-availability).

## Corrections

The folded text named V1 functions throughout its workflow table (`grantLicense`, `acceptLicense`,
`revokeLicense`) with V1 semantics. Corrected:

| folded claim                                                                          | code                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "grant license → immediate license (safe == msg.sender)"                              | `makeOffer` from the Safe → immediate **deal**; from a whitelisted author → also immediate deal; from anyone else → offer                                                                                                                                                                                                                                        |
| "a _non-whitelisted author_ calling `grantLicense` elsewhere creates a pending offer" | true, and also true for a **whitelisted developer** — the list that decides is the author list                                                                                                                                                                                                                                                                   |
| "approve pending license (`acceptLicense`)"                                           | `admit(genesis)` on the bound V0_1 module, called by name; the app holds no V2 alias and no version branch                                                                                                                                                                                                                                                         |
| "revoke license → license=false → next render removes the page → implies a rebuild"   | `reject` from the Safe **demotes** a deal to an offer, and the author's later `admit` can re-strike it; the app proposes no render, so no rebuild is implied by the action itself. (`retract` is the author's own terminal verb, not the Safe's: on a V2 publication the Safe's demotion is still spelled `retract`, which is why the two must not be conflated) |
| "remove whitelisted author/dev — does NOT revoke existing licenses"                   | true, and stronger: it does not touch deals, offers, or the log                                                                                                                                                                                                                                                                                                  |

## Local gotchas / gaps

- **`useDefineForClassFields: false` is load-bearing.** With the ES2022 default (`true`), Lit's
  experimental decorators compile to `Object.defineProperty` in the constructor, shadowing the prototype's
  reactive accessors — every `@state` assignment silently stops calling `requestUpdate()`, and tab
  switching breaks across all components. Never re-enable it.
- **`//` inside a `css` template literal breaks the next declaration.** Use `/* */`.
- **`mapping.json` is used verbatim**; the builder injects nothing. A copied starter carries someone
  else's `feedAddress`/`postId`. See [the look child](SPEC-publication-look.md#mappingjson).
- **Bare preview subdomain:** the UI links `https://<rootCid>.preview.transport-union.dev` (no `.ipfs.`
  label) while a Kubo-native subdomain gateway yields the namespaced form. One of the two has to change;
  it is unresolved (OPEN-TASK-1).
- **Mixed ethers + viem in one package.** Consolidation candidate.
- **`VITE_GITHUB_TOKEN` is bundled into the client** and visible to anyone with devtools — same class as
  GAP-9. GitHub reads should move behind a backend or a scoped short-lived token.
- **`insertStylesheetLink` / `insertAssetImageCids` in `ConfigBuilder` are dead** (superseded by the
  assets-into-`/assets` model) — prune.
- **iframe constraints:** clipboard is subject to the Safe iframe's permissions policy; a store
  `connectedCallback` that double-subscribes causes render loops.
- **Storage-blocked probe:** a sandboxed iframe that refuses localStorage surfaces
  `⚠ browser storage unavailable` rather than degrading silently.
- **`pnpm dev` is broken** (ethers v5/v6 dedupe). Production build is unaffected; validate against
  `pnpm build` + `vite preview --no-open` + `pnpm qa`.
- **ABANDONED — in-browser helia verification.** Do not add `helia` / `@helia/unixfs` / libp2p for
  client-side block verification; the direction was dropped on 2026-10-14 and the unused dependency was
  removed.

## Build, deploy, QA

`pnpm deploy:safe-app` from the repo root (or `./deploy.sh` in `safe-app/`) is the single source of
truth: `pnpm build` (tsc → vite → sass) then `rsync -avz --delete dist/ <host>:/srv/publication-module/`.
The `--delete` makes the remote identical to `dist/`; verify the remote bundle hash against
`dist/main.*.js` afterwards.

`pnpm qa` (`qa/qa.mjs`) spawns a headless `--no-open` preview, mocks the Safe iframe handshake with a
real Safe address and modules, and asserts all five tabs navigate with no page errors. It is the
regression net for the "tabs don't switch" class of bug — run it after any component or build-config
change.

## Invariants this component preserves

INV-4 (module discovery by `NAME()`), INV-2 (record keys), INV-6 (reads `contenthash_wrapped`, emits the
preview link), INV-10 (mutations are proposals), INV-11 (`assetsCid` producer).

## Safe-to-change vs do-not-touch

- 🟢 tabs, styles, store internals, caching UI, CID-inventory presentation, column sets, tuning the
  retrievability pass.
- 🟢 prune the dead `ConfigBuilder` helpers; add a render trigger after Revoke (additive, but see the
  ownership question in the storage child).
- 🔴 discovery by `NAME()`; record key names; proposing instead of sending; the `contenthash_wrapped`
  read key; silently injecting values into `mapping.json` (the mapping is author-owned — decide
  explicitly, do not sneak it); routing Filecoin mutations through `safeSdk.txs`.

## Test seams

- `SafeIntegration`: mock the SDK → assert each mutation produces the right `{ to, data }` and never a
  direct send.
- `ConfigBuilder`: fixture a repo → assert the emitted config parses against the shared zod
  `publicationConfigSchema` and that `mapping` passes through unchanged.
- `qa/qa.mjs`: five tabs, no page errors (already the regression net).
- Row rendering: a gateway that 404s one item leaves a present-but-blank row, not a failed table.
