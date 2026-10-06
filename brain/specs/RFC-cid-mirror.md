# RFC — cid-mirror: content-addressed → location-addressed static site mirror

> **Type:** design proposal / forward work (an RFC, not a spec). Captures the required behavior
> for a small, standalone, dockerized Node service that mirrors an IPFS/ENS website (a
> content-addressed tree) onto host disk as a plain static web root (location-addressed) so nginx
> can serve it. **Implemented and independently reviewed (2026-09-02) — APPROVED**.
> HISTORY: PR https://github.com/Joera/S2S-monorepo/pull/79 was merged by the human at head
> `27b75fd` (2026-09-02). The two later fixes — the Base-L2 records-contract resolution
> (`359c0e7`) and the `getRecords` string[] ABI fix (`4f808de`) — landed AFTER that merge and so
> are **not in main**; they are carried by follow-up PR https://github.com/Joera/S2S-monorepo/pull/80
> (`feat/cid-mirror` → `main`, independently reviewed APPROVE, pending human merge).
> When that PR is merged, fold the settled outcome into a new SPEC and strike here.
>
> **Pick-up contract:** `handoffs/handoff-cid-mirror.md` — the executing session starts there;
> this RFC is the durable proposal + acceptance contract.
>
> **Origin:** joera direction (2026-09-02): build a separate folder inside the s2s repo, dockerized,
> that gets the root CID from an ENS publication name, traverses the IPFS tree, downloads every
> file into a folder structure, and shares that folder with the host for nginx — with an API to
> trigger a refresh. Reuse existing project code where sensible.

---

## Problem

s2s publishes websites as content-addressed IPFS trees addressed by an ENS name
(`<sub>.soul2soul.eth`) whose `contenthash` points at the root CID. To serve such a site as a
plain location-addressed static web root (nginx `root /path/to/webcontent`), something must:
resolve the ENS name → root CID, walk the DAG, download every leaf to disk preserving the URL
path structure, and keep that copy up to date. That "gateway-to-disk" worker does not exist yet.

## Required behavior

A self-contained Node (TypeScript) app in `cid-mirror/` at the repo root, run under Docker, that:

1. **Resolve ENS → root CID.** From `PUBLICATION_URL` in `.env` (e.g. `https://xxx.soul2soul.eth`
   or a bare `xxx.soul2soul.eth`), extract the ENS name, then `namehash` it and read the root CID
   using the **canonical s2s mechanism** (verified on-chain — s2s does NOT store the root CID as a
   standard ENS contenthash on mainnet):
   - **L2 (Base, chainId 8453):** call `getText(node, 'contenthash_wrapped')` on the s2s
     `ensRecords` records contract, then decode the `0xe3 01 <cid>` envelope → root CID.
   - **Records-contract discovery** (L1 leg, only when `RECORDS_CONTRACT` is unset): mirror
     `protocol/actions/src/libs/protocol.factory.ts` / `ens.factory.ts` — L1 `nameWrapper()` →
     `ownerOf(namehash('soul2soul.eth'))` → `parentDomainController()` → L2
     `getModulesPaginated` scan → `configModule.getRecords(...)` (decoded as **`string[]`**)
     → `ens_records` element (index 1).
   - **`RECORDS_CONTRACT` env override** skips discovery and reads `getText` straight off that
     address.
   If `PUBLICATION_URL` is itself a bare CID, use it directly (no ENS lookup).
2. **Traverse the tree.** From the root CID, list links via the kubo RPC
   (`api/v0/ls`, or `dag/get` for node inspection); recurse into directories; treat leaves as
   files. Concurrency-limited (reuse the `mapWithLimit` pattern).
3. **Download to disk.** Write each file under `webcontent/<relative path>`, preserving the URL
   structure (root → `webcontent/index.html`). Use `api/v0/cat` (bytes, not JSON) for content so
   binary assets survive.
4. **Atomic publish.** Download into a staging dir, then swap it into `webcontent` so nginx never
   sees a half-written tree. Track the current root CID, last-refresh timestamp, and file count.
5. **API.**
   - `POST /api/refresh` — re-resolve → re-traverse → re-download → swap; returns
     `{ rootCid, files, durationMs, refreshedAt }`.
   - `GET /api/status` — publication, current root CID, last refresh, file count, next auto-refresh.
   - `GET /healthz` — liveness.
6. **`.env`** (with `.env.example`): `PUBLICATION_URL`, `L1_RPC_URL` (Ethereum mainnet RPC; used for
   the records-contract discovery leg only), `L2_RPC_URL` (Base mainnet 8453 RPC — where the root
   CID is actually read), optional `RECORDS_CONTRACT` (skip on-chain discovery),
   `IPFS_API_URL` (kubo RPC base), `PORT`, optional `REFRESH_INTERVAL_MS` (auto-refresh), and any
   auth the kubo RPC needs. Never commit real values.
7. **Docker.** `Dockerfile` (node LTS, build TS → `dist`, non-root), `docker-compose.yml` with
   `env_file: .env`, a bind-mount `./webcontent:/app/webcontent` **shared with the host** so a host
   (or sibling-container) nginx can serve it, and a `healthcheck`. `.dockerignore` to keep the
   image small.

### Reuse from the project (required)

- **Contenthash decode** — reuse the proven, dependency-free pure functions from
  `shared/src/ipfs/contenthash.ts` (`decodeContenthashWrapped`, `parseCID`) and
  `contenthashToIPFS` (in `protocol/actions/src/libs/ipfs.factory.ts`). Because the app is a
  self-contained Docker build, the preferred mechanism is to **vendor the exact module** into
  `cid-mirror/src/ipfs/contenthash.ts` (copy verbatim, keep the attribution header) rather than
  drag the whole monorepo into the image. Do **not** reimplement the CID/contenthash math from
  scratch.
- **Gateway RPC patterns** — mirror the kubo calls from `S2SIPFSMethods`
  (`shared/src/ipfs/index.ts`) and `ipfs.factory.ts` (`api/v0/cat`, `api/v0/dag/get`, timeout
  handling).
- **ENS/records-contract discovery** — mirror `protocol/actions/src/libs/ens.factory.ts` and
  `protocol.factory.ts` (`getProtocolInfo` → `getRecords(..., 'ens_records')`) for the L1→L2
  discovery leg; the app re-implements it with raw `eth_call` to keep dependencies minimal (no
  ethers contract abstraction).

## Non-goals

- No on-chain writes, no Lit actions, no PKP signing, no MFS tree assembly.
- Not a replacement for the render/update pipeline; it only *mirrors an already-published tree*.
- Not wired into the root pnpm workspace (keeps the root lockfile stable); standalone package.

## Acceptance contract (gate for the reviewer)

1. `docker compose up --build` starts the service; on startup it resolves `PUBLICATION_URL` from
   `.env` and populates `webcontent/` (host-visible).
2. `POST /api/refresh` re-fetches and atomically swaps the tree; `GET /api/status` reports the
   root CID + file count + last refresh.
3. `webcontent/` is bind-mounted to the host so nginx can serve it.
4. Vendored contenthash module matches the source it was copied from (reviewer checks).
5. Unit tests cover: ENS-name extraction from a URL, contenthash → CID decode, path mapping
   (root → `index.html`), and traversal against a stubbed kubo client.
6. App typechecks and its tests pass (the app's own gates). No change to the root pnpm lockfile.

## Open confirmations (all resolved during implementation)

- Exact kubo traversal primitive: **`ls` + `cat`** (typed links via `api/v0/ls`, recursive,
  concurrency-limited, `cat` for leaf bytes) — chosen over `dag/get` / `get`; rationale in the app
  README.
- Auto-refresh on an interval is optional and off unless `REFRESH_INTERVAL_MS` is set (confirmed;
  only manual `POST /api/refresh` by default).
