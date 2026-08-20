# Handoff — Website Tree tab in safe-app

**Status:** IMPLEMENTED 2026-08-20 — PR #48 (`feat/website-tree-tab`, commit `cdc2964`) on
`origin/feat/website-tree-tab`. Gates verified green (type-check, build, feature files
lint-clean). Independent review truncated by a deployment-wide worker failure; a bounded
orchestrator self-review found no blocking issues (see Working notes). The settled behavior
should be folded into `specs/SPEC-safe-app.md` (sub-component map + key flows) after the PR
merges, then this handoff can be struck.

## TL;DR

Add a new nav item (tab) + component to `safe-app/` that **fetches the published website tree**
from the ENS records contract (the `contenthash_wrapped` site-root read path) and renders all of
its contents as a tree, so the publisher can see what pages have been rendered and **monitor
retractions and slug renames**. Needs a **sync button**. Follow the structure of the other
safe-app components.

This is a **read-only view** — it never proposes Safe transactions, never writes to the publish
path, contracts, or actions.

## Facts the implementer needs (verified against live code 2026-08-20)

### Site-root read path (already exists in safe-app)
`safe-app/src/components/s2s-app.ts` (`fetchFreshData`) reads the root CID and puts it in the
store:
- `evmRead(8453, protocolInfo.ensRecords, RECORDS_CONTRACT_ABI, 'getText', [node, 'contenthash_wrapped'])`
  where `node = window.ethers.namehash(publication)` and `publication = store.getRecord('name')`.
- Decodes: `hex = onchainHash.slice(6)` (strip `0x` + ipfs-ns `0xe3` + contenthash-version `0x01`);
  `bytes = window.ethers.getBytes('0x' + hex)`; `rootCid = CID.decode(bytes).toV1().toString()`.
- `store.setRoot(rootCid)`.

So the new tab can read `store.getRoot()` for the current root CID and `store.getRecord('name')`
for the publication. `RECORDS_CONTRACT_ABI` is defined locally in s2s-app.ts — mirror it in the
new tab/lib if the tab re-reads the contract itself (the sync button should re-read fresh).

### What the published site tree IS (crux)
The site root CID is an **MFS directory tree** assembled by `protocol/actions/src/update/main.ts`
(evm-update action):
- Root directory contains: `index.html` (the home job, `job.path === 'index.html'`), one
  directory per page path — `<slug>/index.html` — and `assets/` (copied from
  `config.assetsCid`). Templates may also be present at the root.
- A **retraction/revoke** = a `remove` entry with no `replacedBy` → `files/rm` on
  `${mfsPath}/${cleanPath}` → the page's directory is **deleted from the tree**.
- A **slug rename** = a `remove` entry with `replacedBy` (the new job's genesis) → old path
  removed + new path added (new `<path>/index.html`).
- Therefore the **current tree alone cannot distinguish a rename from a retraction** — both leave
  the old path absent. To "monitor retractions / slug renames" the component must **diff the
  current tree against a previously-synced snapshot**: paths present before but absent now =
  removed (retraction, or the old side of a rename); paths present now but absent before = added
  (new page, or the new side of a rename).

### Walking the DAG from a root CID
- Kubo gateway: `https://ipfs.transport-union.dev` (hardcoded as `IPFS_URL` in
  `safe-app/src/lib/ipfs-fs.factory.ts`; `kuboMfsPost(path, timeoutMs)` is the low-level POST
  helper there).
- To list the children of a DAG directory **by CID** use `/api/v0/ls?arg=<cid>` (response:
  `Objects[0].Links[]` with `Name`, `Hash`, `Size`, `Type`) and recurse into directory links.
  (`files/ls` is MFS-path-only and is NOT what you want for a read-only CID walk.)
- Existing helpers to reuse/align with: `kuboMfsPost` (ipfs-fs.factory.ts), `fetchFromIPFS`
  (cat, ipfs.factory.ts). Note the shared `S2SIPFSMethods.mfsList` maps `data.Links` from
  `files/ls` — do not rely on it for a CID walk.
- Guard against unbounded recursion: cap depth and/or entry count; handle a root that is a file
  (not a dir) gracefully.

### Component/tab pattern (follow exactly)
- New file `safe-app/src/components/s2s-website-tree-tab.ts`, custom element
  `s2s-website-tree-tab`: `attachShadow({mode:'open'})`, `adoptedStyleSheets` from
  `@/styles/*` (typography, section, table, button — see `s2s-storage-tab.ts` for the import
  pattern), `connectedCallback` subscribes to the store slice(s) it needs
  (`store.subscribeToRoot(() => this.render())`), `disconnectedCallback` unsubscribes, render via
  `this.shadowRoot.innerHTML` template + `attachEventListeners()`.
- `safe-app/src/components/s2s-app.ts` edits (mirror the storage-tab wiring):
  1. `import './s2s-website-tree-tab.js';`
  2. add a tab `<button>` in the `.tabs` div (label e.g. "Website Tree"), with an
     `id="website-tree-tab"` and the same disabled-gating style as siblings (enable when the
     records/publication module is present — the root CID read needs `protocolInfo.ensRecords`).
  3. extend the `currentTab` union type (`'deals' | 'whitelist' | 'records' | 'storage' |
     'websiteTree'`) and the `switchTab` signature.
  4. add the click listener in `attachEventListeners`.
  5. add the `case 'websiteTree':` in `renderCurrentTab` that creates the element and passes
     what it needs (e.g. `protocolIntegration` for a fresh ENS read, or nothing if it reads the
     store + does its own fetch).
- The tab reads store state (`store.getRoot()`, `store.getRecord('name')`) and keeps its own
  transient state (tree, previous snapshot, syncing flag) as component fields — same as
  `s2s-storage-tab.ts` keeps `deleting`/`terminating` sets. A new store slice is NOT required;
  prefer component-local state unless it must survive tab switches (it need not — re-fetch on
  connect is fine and matches the two-phase pattern).

### Sync button
`s2s-storage-tab.ts`'s refresh button does `window.location.reload()` — do NOT copy that. The
website-tree tab should own its fetch: a **sync button** that (a) re-reads
`contenthash_wrapped` from the ENS records contract (fresh `evmRead` via
`protocolIntegration`/`evmRead`, same ABI+decode as s2s-app.ts), (b) walks the DAG from the new
root CID, (c) updates the tree + "last synced" timestamp, and (d) computes the diff against the
previous snapshot. Also fetch once on `connectedCallback`. Show a syncing/disabled state while in
flight; show errors inline (e.g. "failed to reach ENS/IPFS") without throwing.

### Build / gates
- `safe-app` package name: `s2s-records-safe-app`.
- Type-check: `pnpm --filter s2s-records-safe-app type-check` (`tsc --noEmit`).
- Build: `pnpm --filter s2s-records-safe-app build` (`tsc && vite build && pnpm sass`).
- Repo lint: `pnpm lint` (`eslint . --max-warnings 0`).
- There are NO vitest tests for safe-app (vitest covers shared/protocol). Do not add a test
  harness; the gates above are the contract.

## Acceptance contract

1. A new nav item "Website Tree" appears in the safe-app tab bar, wired exactly like the other
   tabs (button + `switchTab` + `renderCurrentTab` + `attachEventListeners`), gated like its
   siblings (disabled when the module needed for the root read is absent).
2. New component `s2s-website-tree-tab` renders the **full site tree** fetched from the ENS
   records contract + IPFS: the root and every entry reachable by walking the DAG from the
   `contenthash_wrapped` root CID — pages (`<slug>/index.html`), `index.html`, `assets/`, and any
   other entries — as a tree (indented/collapsible). Pages are identifiable as pages.
3. A **sync button** re-reads the ENS contract + walks the DAG fresh (no `window.location.reload`),
   updates the tree, and shows a "last synced" timestamp; in-flight state and inline errors are
   handled.
4. **Change detection**: the component keeps the previous snapshot and highlights what changed
   since the last sync — removed paths (retractions / old rename slugs) and added paths (new pages
   / new rename slugs) — so the publisher can monitor retractions and slug renames.
5. Follows the existing component structure: store reads via the `store` singleton, styles from
   `@/styles/*`, Shadow DOM, no writes to the publish path/contracts/actions, no Safe SDK
   proposals (read-only view).
6. Green gates: `pnpm --filter s2s-records-safe-app type-check`, `pnpm --filter
   s2s-records-safe-app build`, `pnpm lint` all pass; no regressions to the other tabs.

## Do-not-touch

- The publish path, contracts, and actions (`protocol/actions/**`).
- The `contenthash_wrapped` key / INV-6 read convention.
- Existing store slices and the `s2s-app.ts` two-phase fetch (only ADD the new tab wiring).
- No Safe transaction proposals from this tab (read-only).

## Working notes

- Worktree: `~/code/s2s-website-tree-tab` on branch `feat/website-tree-tab` (from `origin/main`).
- PR #48: https://github.com/Joera/S2S-monorepo/pull/48 — MERGED by human 2026-08-20 (feature
  WITHOUT the traversal fix; includes the typescript 5.9.3 pin — required for the repo lint
  gate; typescript-eslint 8.63.0 crashes under typescript 7.0.2).
- PR #51: https://github.com/Joera/S2S-monorepo/pull/51 — OPEN, the traversal fix follow-up
  (branch `feat/website-tree-tab` → main; diff vs main is exactly the fix: 1 file +9/−32).
  Fix commit `4c5d23a`. Gates green (type-check, build, component lint 0 problems).
- Review status: the builder worker truncated 9 autonomous runs in this deployment (boot →
  plan → die), including the independent reviewer. Orchestrator bounded self-review of the new
  component found it satisfies the acceptance contract; two non-blocking nits: (1) a gateway
  outage is surfaced as "Root is a file" rather than a network error (`listLinks` folds fetch
  failures into `isFile`); (2) the tree goes stale if the store root changes until the user
  hits Sync (acceptable for a read-only monitor).
- **Empirical gateway finding (2026-08-20, live probe of ipfs.transport-union.dev):** the
  `/api/v0/ls` `Type` field is INVERTED vs standard Kubo — `Type: 1` = DIRECTORY, `Type: 2` =
  FILE (verified on root bafybeibmshvbek536ryjxevx64f5gjw5qsqznhgxqwlabi7tctnxehbdiq: slug dirs
  are Type 1 / Size 0 / bafybei+Qm CIDs; index.html is Type 2 / Size 7557 / bafkrei raw CID).
  Also, `ls` on a FILE returns `Links: []` (empty array), not `null`. The v1 implementation
  assumed 1=file/2=dir → rendered every dir as a leaf and the root index.html as a phantom
  empty folder. Fix (v7) maps Type 1 = dir, treats empty Links as a leaf, and drops the
  redundant root-CID + publication/URL display (both already shown at the top of the app).
- Read `brain/specs/SPEC-safe-app.md` (sub-component map, two-phase render, tab wiring) and
  `brain/specs/SPEC-contracts-ens.md` (INV-6 read path) before coding.
- The diff snapshot should be persisted across syncs within the component's lifetime (component
  field). Optionally also persist to localStorage (the store is localStorage-backed) so a
  tab-switch doesn't lose the previous snapshot — but keep it simple.
- Commit on the feature branch with a clear message; open your own PR; drive the gates green;
  get an independent review before the human merges.
