# Handoff: cid-mirror — content-addressed → location-addressed static mirror (2026-09-02)

**Date:** 2026-09-02
**Scope:** Build a standalone, dockerized Node (TypeScript) app in a NEW folder
`cid-mirror/` at the s2s repo root. It resolves an ENS publication name to a root CID,
traverses the IPFS tree, downloads every file to a `webcontent/` folder structure, shares that
folder with the host for nginx, and exposes an API to trigger a refresh. Reuse existing project
code. Open its own PR.
**Spec / acceptance contract:** `brain/specs/RFC-cid-mirror.md` (read it first — it is the
durable proposal + the reviewer's acceptance contract).
**Status:** Implemented + independently reviewed (2026-09-02) — APPROVED after three review
rounds. PR #79 was **merged by the human at head `27b75fd`** (main has the base cid-mirror +
re-resolve fix). The two post-merge fixes — Base-L2 records-contract resolution (`359c0e7`) and
the `getRecords` string[] ABI fix (`4f808de`) — were pushed to `feat/cid-mirror` AFTER that merge
and are **NOT in main**: they are carried by follow-up **PR #80** (`feat/cid-mirror` → `main`,
independently reviewed APPROVE, pending human merge). Post-merge: add `cid-mirror/` to
`brain/code-map/MAP.md` (done in MAP already) and fold the RFC into a SPEC.
**ENS mechanism correction (post-review, verified on-chain):** s2s does NOT store the root CID as
a standard ENS contenthash on mainnet. The root CID lives as text record
`contenthash_wrapped` on an `ensRecords` records contract on **Base L2 (8453)**. The app reads it
there (records-contract address discovered via the L1 nameWrapper → controller → L2 module →
`getRecords` flow, with a `RECORDS_CONTRACT` env override). Requires `L2_RPC_URL` in `.env`;
`L1_RPC_URL` is used only for the discovery leg. `getRecords` returns `string[]` (NOT `address[]`)
— decode accordingly (offset/length/utf8).

## What to build

Follow the RFC's "Required behavior" section exactly. In short:

1. **ENS → root CID.** `.env` `PUBLICATION_URL` (e.g. `xxx.soul2soul.eth` or a full URL). Extract
   the ENS name, `namehash` it, then read the root CID via the **s2s L2 mechanism**: on Base L2
   (8453) call `getText(node, 'contenthash_wrapped')` on the `ensRecords` records contract and
   decode the `0xe3 01 <cid>` envelope. Discover the records-contract address by mirroring
   `protocol.factory.ts`/`ens.factory.ts` (L1 `nameWrapper()` → `ownerOf` →
   `parentDomainController()` → L2 `getModulesPaginated` → `configModule.getRecords(..., 'ens_records')`
   decoded as `string[]`, element index 1) — or skip discovery via `RECORDS_CONTRACT` env override.
   If `PUBLICATION_URL` is a bare CID, use it directly.
2. **Traverse + download.** From the root CID, list links via kubo RPC (`api/v0/ls`, or
   `dag/get`), recurse into dirs, `api/v0/cat` (bytes) each leaf into `webcontent/<path>`.
   Concurrency-limited.
3. **Atomic swap.** Download to a staging dir, then swap into `webcontent` so nginx never sees a
   partial tree. Track root CID / last refresh / file count.
4. **API:** `POST /api/refresh`, `GET /api/status`, `GET /healthz`.
5. **Docker:** `Dockerfile`, `docker-compose.yml` with `env_file: .env` and a bind-mount
   `./webcontent:/app/webcontent` **shared with the host** for nginx, `healthcheck`,
   `.dockerignore`. `.env.example` with every key (no real secrets).

## Reuse (required, this is the point)

- **Vendor the dependency-free contenthash module** verbatim from
  `shared/src/ipfs/contenthash.ts` into `cid-mirror/src/ipfs/contenthash.ts` — keep the
  attribution header; do NOT reimplement the CID/base58/base32 math. Re-export
  `decodeContenthashWrapped` / `parseCID`. Add `contenthashToIPFS` (from
  `protocol/actions/src/libs/ipfs.factory.ts`) on top of the vendored primitives if helpful.
- **Mirror the kubo RPC patterns** from `S2SIPFSMethods` (`shared/src/ipfs/index.ts`) and
  `ipfs.factory.ts` (`api/v0/cat`, `api/v0/dag/get`, timeout handling).

## Key repo context (verified)

- Reusable source: `shared/src/ipfs/contenthash.ts` (pure, dependency-free, already exports the
  decode helpers); `shared/src/ipfs/index.ts` (`S2SIPFSMethods`, gateway POST patterns);
  `protocol/actions/src/libs/ipfs.factory.ts` (`contenthashToIPFS`, `catFile`, `getDag`);
  `protocol/actions/src/libs/ens.factory.ts` + `shared/src/ens/index.ts` (ENS resolution patterns;
  note `shared/src/ens` uses `text('contract.address')` — for a generic site use the resolver's
  `contenthash()` instead).
- Root package manager is **pnpm** but do NOT add `cid-mirror` to `pnpm-workspace.yaml` — keep the
  root lockfile stable; `cid-mirror` is standalone with its own `package.json` + lockfile.
- Repo is a pnpm monorepo; work in YOUR OWN git worktree on a feature branch and open a PR. Do not
  touch the root `pnpm-lock.yaml`.

## Gates (must be green before PR)

- App typechecks (`tsc`) and its unit tests pass (`vitest`/`node --test`). Tests must cover:
  ENS-name extraction from a URL, contenthash → CID decode, path mapping (root → `index.html`),
  and traversal against a stubbed kubo client.
- `docker compose config` validates; document (in the app README) the run + nginx mount steps.
- Vendored contenthash module matches its source (a reviewer will diff it).

## Notes

- Pick the traversal primitive (`ls` vs `dag/get` vs `get`) that is most robust for arbitrary
  unixfs trees and note the choice in the README. Auto-refresh interval is optional and off
  unless `REFRESH_INTERVAL_MS` is set.
- The `.env` in the repo has `MAINNET_RPC_URL` / `IPFS_URL` — use those as hints for the app's
  `.env.example` key names, but never copy secrets.
- After the PR is reviewed and merged, `cid-mirror/` gets a line in `brain/code-map/MAP.md` and the
  RFC is folded into a SPEC. Do not do that in your PR.
