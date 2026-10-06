# PR-A: Decode cache-pointer contenthash → CID before cat (render + maintain-cache)

**Date:** 2026-08-31
**Branch:** `fix/decode-contenthash-cid` (tracking `origin/main` @ 7a6313e)
**Worktree:** `/home/joera/s2s-decode-cache-cid`

## Problem

The render and maintain-cache **cache-READ paths** passed the RAW EIP-1577
contenthash envelope (e.g. `0xe30101551220274e…` = `0xe3 0x01` + CID bytes) read
from the on-chain `content_cache_<publication>` text record straight to
`catFile`. Observed in production: `cat?arg=0xe301…` → HTTP 500 → `'archive cat
failed, falling back to no-archive'` → the cache never worked, and the render
dropped to the expensive cold no-archive path (which blows Lit's 50-HTTP
request cap).

The write side was already correct: `toHexString(cid)` in
`protocol/actions/src/libs/evm.ts:252` = `encodeContenthashWrapped(parseCID(cid))`
(EIP-1577 envelope), the exact inverse of `contenthashToIPFS(hex)` in
`protocol/actions/src/libs/ipfs.factory.ts`. Only the two cache READ sites were
missing the decode.

## Changes

### 1. Shared helper — `protocol/actions/src/libs/ipfs.factory.ts`
Added `decodeArchiveCid(value: string): string` (after `contenthashToIPFS`):
- `''` → `''` (no-archive sentinel, passed through untouched).
- valid ipfs-ns contenthash → decoded raw CID (base32 CIDv1 / base58 CIDv0).
- anything else (decode throws) → `''`, logging a warning — so a malformed /
  non-ipfs record can never be handed to `catFile` as a garbage CID.

Both read sites collapse to `''` on a bad pointer, identical to the existing
no-archive sentinel.

### 2. Render read path — `protocol/actions/src/render/main.ts`
- Import (line 11): `import { uploadFile, decodeArchiveCid } from '../libs/ipfs.factory';`
- Decode (lines 123-129), **inside the existing try/catch** right after the
  `getText` read:
  ```ts
  archiveCid = decodeArchiveCid(archiveCid);
  ```
  Decode failure → `''` → preserves the existing `'archive pointer read
  failed, falling back to no-archive'` behavior; `''` remains the no-archive
  sentinel for `fetchCollections` (main.ts:127,234). Skip when `''`.

### 3. Maintain-cache read path — `protocol/actions/src/maintain-cache/main.ts`
- Import (line 12): `import { catFile, uploadFile, decodeArchiveCid } from '../libs/ipfs.factory';`
- Decode (line 108), **inside the existing try/catch** after the `getText` read
  and before `parseArchive(await catFile(gateway!, archiveCid))` (line ~114):
  ```ts
  archiveCid = decodeArchiveCid(archiveCid);
  ```
  `''` → `archive` stays `null` (no-archive).

### 4. Unit tests — `protocol/actions/src/libs/ipfs.factory.test.ts`
New `describe('decodeArchiveCid', …)` suite:
- decodes a CIDv1 contenthash pointer to the same CID (`bafy…`)
- decodes a CIDv0 contenthash pointer to the same CID (`Qm…`)
- round-trips through `encodeContenthashWrapped(parseCID(...))`
- passes through the empty string (no-archive sentinel)
- collapses a non-ipfs-ns value to the no-archive sentinel (`''`) instead of
  throwing

Tests import `toHexString` from `./evm` to exercise the real production write
helper (`toHexString(cid) → decodeArchiveCid → same cid`).

## Gates (run in worktree)

| Gate | Command | Result |
|---|---|---|
| actions build | `pnpm actions:build` | EXIT 0 — all 5 bundles: prep, update, maintain-cache, render, render-dev |
| shared build | `pnpm shared` | EXIT 0 (@s2s/soul2soul-shared@0.1.4, tsc) |
| protocol vitest | `pnpm -C protocol test -- --run src/libs/ipfs.factory.test.ts src/libs/evm.test.ts` (and full run) | **13 files / 164 tests passed** (full protocol suite incl. render, render-dev, ipfs.factory, evm) |
| prettier | `npx prettier --check` on 4 touched files | clean (ipfs.factory.ts reformatted via --write — its whole file was already non-compliant on main; the other 3 were clean) |

Note on the eslint gate: as documented in the task, eslint on
`protocol/actions/src/*` fails with a `Parsing error: … was not found by the
project service` because `actions/src` is not in any tsconfig — this is a
KNOWN NON-GATE and was not chased (no temp tsconfig created).

## Commit / PR

- Commit: `ea0c3cd` — `fix(actions): decode content_cache pointer contenthash -> CID before cat (render + maintain-cache)`
- PR: **#74** — https://github.com/Joera/S2S-monorepo/pull/74 (base: `main`, head: `fix/decode-contenthash-cid`)
- Pushed to `origin/fix/decode-contenthash-cid`. **Not merged** (per instructions).

## Explicitly NOT touched
`sequence.ts`, `data.ctrlr.ts`, the update action, `evm.ts`'s
`toHexString`/encode, and all write-path code (the write side is already
correct).
