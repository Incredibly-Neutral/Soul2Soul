# SPEC-publication-storage — the site tree, its copies, and how a publication sees them

> **Parent:** [SPEC-publication](../SPEC-publication.md) — the publication front door.
> **Siblings:** [SPEC-publication-admin-app](SPEC-publication-admin-app.md) (the tabs that show this),
> [SPEC-publication-look](SPEC-publication-look.md) (what gets rendered into the tree).
> **The contract that writes the root:** [SPEC-contracts-ens](../SPEC-contracts-ens.md) (INV-6,
> INV-12).
>
> **Type:** component spec. It owns *where the site is and who can serve it* — the MFS tree, the copies,
> the preview roots, and the observability surfaces.
>
> **Audited against live code:** 2026-10-30 (`protocol/actions/src/update/main.ts`,
> `shared/src/ipfs/index.ts`, `shared/src/heal/heal.ts`, `shared/src/cid-view/*`, `cid-mirror/`).
>
> **Folded from:** the storage-lifecycle parts of `SPEC-safe-app`, plus the tree/root material in
> `SPEC-contracts-publication`'s ENS coupling section.

---

## Responsibility

Owns the **rendered tree**: the MFS directory under a root CID, the copies made of it, the pointers to it
(ENS `contenthash_wrapped`, aliases), and the tools a publication uses to check that it still exists
somewhere. It does not own rendering (the press) or the records contract (`ens_records`,
`contenthash_wrapped` encoding — [SPEC-contracts-ens](../SPEC-contracts-ens.md)).

## One tree, one node

A publication's site is not a directory that belongs to the publication. It is the MFS tree under a root
CID inside **one Kubo node** — the one named by the `data_gateway` protocol record — shared by every
publication on the deployment:

```
/  (root CID — the one in contenthash_wrapped)
├── index.html
├── <slug>/index.html
├── assets/css/main.css        copied wholesale, atomically, per render
├── assets/js/…
└── …                          whatever previous renders left behind
```

There is no per-publication node, credential, or storage configuration anywhere in the codebase. The
renderer writes with the token its caller supplies (`VITE_KUBO_TOKEN` for the app, the host's equivalent
for `neutralpress`), and reads through `protocolInfo.gateway` / `config.dataGateway`.

**The publication's pages are hosted by the operator.** A publication that leaves can take its CIDs and
its ENS name; it cannot take the hosting, because the hosting was never its own. `cid-mirror` exists
partly in anticipation of that.

## Rendering and what it leaves behind

The update action is the only thing that moves a root. In order:

1. read `contenthash_wrapped` from the canonical node (from `records.name`) and the `aliases` tracking
   record (a JSON array of names kept in sync);
2. create `/temp-<Date.now()>`, and unless `reset`, copy the previous root into it — the tree is
   **copy-forward**, so anything untouched survives;
3. per active job: `files/rm` the path, then `files/cp` the rendered HTML to `<path>/index.html`; per
   removal: `files/rm` recursively;
4. replace `/assets` from `config.assetsCid` (removed, then copied with `parents=true&flush=false`), so a
   stylesheet change is atomic with the pages that use it;
5. `files/stat` the temp tree → new root; `pin/add`;
6. **one** `batchSetRecords(...)` writing the EIP-1577 contenthash to the canonical node plus every
   alias, `""` to removed aliases, and the aliases JSON — one transaction, one nonce;
7. clean up the temp path in a `finally`.

Two mechanical details are load-bearing: the single batched write exists because issuing several writes in
a row hit a nonce race in `libs/evm.ts`; and clearing an alias writes `""` rather than skipping it, because
a skipped alias keeps pointing at an old root forever.

**Who signs the write:** not the publication. `msg.sender` on `ENSL2nRecords` must be an authorised caller,
and the authorised caller is the protocol's **PKP** — the press's own key, granted by
`authorizeCaller(pkp, true)` in `protocol/scripts/lit/update-protocol.ts`. The publication Safe is not on
that list and cannot add itself. Holders authorised the *render*; the protocol authorised the *write*.
That is INV-12 and it is the single most consequential coupling in the storage story.

**Contenthash encoding:** `0xe3` (ipfs-ns) + `0x01` (CIDv1) + raw CID bytes. Clients strip six hex
characters (`onchainHash.slice(6)`) before decoding.

**Nothing announces a render.** The only trace is a `TextChanged(node, "contenthash_wrapped", …)` event per
written node, and nothing subscribes to it — no webhook, no indexer, no notification to the authors whose
pages just changed.

## How many copies, and of what

Redundancy is a property of **which host published**, not of the publication's configuration:

| path | Kubo pin | Filebase | Pinata | Filecoin | copies |
|---|---|---|---|---|---|
| author-side publish (`neutralpress`) | yes | yes | yes | yes, ≥2 | up to 5 |
| admin-app Bulk Render | yes | no | no | no | 1 |
| preview (either host) | yes | no | no | no | 1 |

`backupToProviders(cid, …)` is a `Promise.allSettled` over `['filebase','pinata']` plus a Filecoin leg,
returning `{ filebase, pinata, filecoin }` where filecoin is one of `'skipped' | 'ok' | 'mismatch' |
'failed'`. It never throws into the caller: a mirror failure is logged and the publish succeeds with fewer
copies. The Filecoin leg is wrapped in a 120-second timeout because a hung uplink used to be invisible —
the site was "fine" while nothing landed.

So "five-fold redundancy" is a **best case on one path**. The Filecoin leg only counts as durable when its
own retry loop committed two copies across provider pairs; `healToFilecoin` treats fewer than two copies as
failure and returns `{ copyCount: 0 }` rather than pretending. The admin app — the surface a publication
actually uses — mirrors nothing.

Manuscripts have the same shape from the author's side, which makes "page and manuscript are equally
redundant" approximately true when both went through the author host, and false when the page came from
the app.

## Preview roots

A preview root is pinned in the shared node, referenced by no ENS record and no alias, and unmirrored. It
survives until the node is rebuilt; then it is the first thing to disappear and nothing notices, because
nothing points at it. Previews accumulate: one per render, forever.

A preview is **not a dry run**: same action code, same templates, real CID, real pin — but executed by
`S2S_RUNNER_URL` (`https://run.transport-union.dev/run`, 10 s timeout) **outside** the enclave, so it is
exactly as private as that runner is, and it skips the record write via `if (!preview)`.

## Observing availability

Two tabs, one shared library (`shared/src/cid-view/`).

**Website tree** — reads `contenthash_wrapped`, decodes EIP-1577, walks the DAG with `ls` bounded at
depth 12 / 5 000 entries, and renders it. The footer shows the `content_cache_<publication>` pointer, so
the archive snapshot used for collections is visible. **Sync** diffs the previous snapshot: a path that
disappeared is a retraction; disappeared *and* appeared is a slug rename.

**Storage** — builds the CID inventory (config, deals, templates, assets, tree) and asks a separate
service whether each CID is retrievable:

```
POST https://ipfs-check.transport-union.dev/batch     (NDJSON)
```

Each probe classifies as `ok | no-providers | inconclusive | not-served | failed`, and the classification
is deliberately conservative in one way: **an unreachable checker or provider is `inconclusive`, never
"no copies"**. An overloaded check node must not read as data loss. Health buckets: 0 copies = lost,
1 = danger, 2–3 = needs healing, 4 = healthy.

**Heal** — `healCid` re-pins a CID across `kubo`, `pinata`, `filebase`, `filecoin`, fail-open, per-provider
error records, concurrency 2. It repairs *copies*; it cannot resurrect bytes the source node no longer has.

**Known blind spot:** ipfs-check discovery does not see Filecoin or Pinata copies (0 filecoin agents
returned for any publication CID), so "copies" undercounts real provider copies. A follow-up gap, not a
classification bug.

## Reset

`reset` clears the pages and keeps the assets: the temp tree starts empty instead of copy-forwarded, so
every path not re-rendered this run disappears. `canReset` is checked only when `reset` is set, and it is
stricter than `canRead` (publication-owner gated). The app exposes it in the Website Tree tab, optionally
followed by a bulk render.

## Serving from somewhere else

`cid-mirror/` is the location-addressed fallback: ENS name or bare CID → `contenthash_wrapped` → DAG walk
→ `webcontent/` → atomic directory swap, with `GET /healthz`, `GET /api/status`, `POST /api/refresh`. It
turns "your site is a CID in my node" into "your site is a directory any web server can serve". A mirror
can lie to its own visitors — it is a copy, and a copy can be stale or doctored — but it cannot trap the
name, because the ENS record still points at the CID.

## Invariants

- **One root at a time.** A publication has exactly one canonical node plus aliases, all written in the
  same transaction. There is no partial alias update in the success path.
- **Copy-forward by default; reset is explicit and destructive.**
- **The root is written by the PKP, never by the publication** (INV-12).
- **Inconclusive is not lost.** No UI path may render an inconclusive probe as data loss.
- **`/assets` is replaced atomically with the pages that reference it.**

## Safe-to-change vs do-not-touch

- 🟢 batch size and freshness windows in the retrievability pass; heal provider list; UI presentation;
  preview retention/GC (nothing collects previews today — an obvious addition).
- 🟢 mirror on the admin render path (closes the 1-copy case).
- 🔴 the EIP-1577 encode/decode and the six-char strip; the single batched alias write; the PKP as the only
  authorised caller; the `contenthash_wrapped` key; treating `inconclusive` as failure.

## Test seams

- `update/main.ts` with a fake MFS: assert copy-forward, `files/rm` before `files/cp`, `/assets` replacement,
  one `batchSetRecords` call, temp cleanup on throw.
- `preview=true` → assert no `batchSetRecords` call at all.
- Alias clear → assert `""` is written, not an omitted node.
- `healCid` with all providers failing → resolves, does not throw, records per-provider errors.
- `statusFromCheckLine` on an inconclusive line → preserves previous sources and does not advance
  freshness.
