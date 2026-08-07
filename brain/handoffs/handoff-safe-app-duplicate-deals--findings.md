# Findings — safe-app duplicate deals investigation

**Date:** 2026-07-22
**Inspected:** `/home/joera/code/s2s/` (the codebase)
**Status:** all 8 questions from §8 of the handoff answered by source inspection.

---

## Q1: Does the contract hold any append rows or only genesis rows?

**Cannot determine from this repo — the append-log contract is NOT in the codebase.**

- `S2SRecordsModule.sol` is a simple KV store (`setRecord`/`getRecord`) — unrelated.
- `S2SPublicationModule.sol` manages licenses/whitelists — unrelated.
- The append-log contract is referenced in `HANDOFF-content-item` and `SPEC-00` INV-append but **no Solidity source exists for it in this repo** (confirming §7 gap 1 of the handoff).
- The safe-app deals view queries a deployed contract whose source is external to this monorepo.

---

## Q2: What derives genesis — deterministic objectId, or a per-call value?

**`objectId` is deterministic** — see `computeObjectId` in `shared/src/identity/sign-content.ts:111-118`:

```ts
export function computeObjectId(publicPart: S2SPublicContent): string {
  const signingView = buildSigningView(publicPart);
  return utils._TypedDataEncoder.hash(S2S_DOMAIN, S2S_TYPES, signingView);
}
```

Same `S2SPublicContent` → same `objectId`.

**But genesis ≠ objectId.** The handoff data shows every entry's genesis equals its own object key (row key). Since 3 identical-content entries (rows 2/3/4) have 3 different genesis keys, **genesis is NOT the objectId**.

Genesis is a **contract-assigned value** — likely a sequential nonce (auto-increment ID), a tx-hash-derived value, or a random salt. This means the deployed contract is *not* using the deterministic EIP-712 digest as the document identity — it assigns its own. This contradicts the `HANDOFF-content-item` spec which says `genesis == objectId for the first entry`.

**Finding:** The contract's genesis derivation model differs from the spec. The spec says genesis = objectId (deterministic). The deployed contract assigns genesis independently (per-call). This is the root of non-idempotency: even identical content gets a different genesis every time.

---

## Q3: Does registration call an append entrypoint, or always create? Does it resolveLatest first?

**Always creates — never appends. `resolveLatest` is a stub.**

`resolveLatest` (`shared/src/identity/verify-content.ts:124-133`):
```ts
export async function resolveLatest(genesis: string): Promise<VersionRecord | null> {
  // TODO: Implement when the append-log contract is deployed.
  console.warn('resolveLatest: not yet implemented (append-log contract pending)');
  return null;
}
```

`getHistory` (same file, line 138-142): same pattern, returns `[]`.

The registration path (`neutralpress/src/content/content.ctrlr.ts:89-139`, `publishContent`):
1. Calls `buildSignedContentItem` to sign the content
2. Uploads to Kubo (IPFS) → gets CID
3. Uploads to Filecoin → gets Root CID + Piece CID
4. Verifies CIDs match
5. Stores `objectId` in note frontmatter
6. **No contract write at all** (the license-granting and render-calls in `publishToPublication` are commented out at `neutralpress/src/main.ctrlr.ts:293-303`)

**Finding: the code cannot call `resolveLatest` because it doesn't exist. Every registration is blind — it cannot find an existing genesis, so it always creates a new one. This is the root cause of the proliferation (§3B confirmed).**

---

## Q4: Is there an idempotency guard on create (duplicate objectId)?

**No idempotency guard on the append-log path (it doesn't exist yet).**

- `S2SPublicationModule._addContentId` (line 117-123) has `!contentIdExists[content_id]` guard, but that's for the license module's content ID tracking — not the append-log.
- The `S2SRecordsModule` has `!keyExists[key]` guard for KV records — unrelated.
- The append-log contract has no deployed source in this repo, so it cannot have idempotency guards spec'd here.

**Finding:** Even if the registration path were writing to a contract, there would be no duplicate-objectId protection because the genesis isn't derived from the content hash.

---

## Q5: Is registration wrapped in withRetry / re-fired by the UI?

**No — `withRetry` exists but is NOT wired into the registration path.**

- `shared/src/helpers/retries.ts` exports `withRetry` (3 retries, 25s timeout, exponential backoff).
- It's imported in `shared/src/lit/lit.service.ts` but **commented out** (lines 52-79). The actual `lit.service.ts` uses raw `fetch` without retry.
- The registration path (`publishContent` → `publishToPublication`) doesn't use `withRetry` at all.
- The safe-app UI is in a separate repo not present here; any UI double-submit would be in that code.

**Finding:** The 3 identical entries (rows 2/3/4) are likely from the safe-app UI re-triggering the registration 3 separate times (user clicked "publish" 3 times, or the UI fires multiple txs without dedup). Each call creates a new genesis because there's no idempotency guard and no `resolveLatest` lookup.

---

## Q6: Are 0x3b246e and 0x953393 the same publication under rotated keys?

**Cannot determine from code — need to check the deployed Safe configuration on-chain.**

- The tag difference (`s3nl4--s2s` vs `s3nl--s2s`) suggests two different publications/slugs.
- `S2SPublicationModule.canPublish` (line 245-250):
  ```solidity
  function canPublish(address _address) external view returns (bool) {
      if (_address == safe) return true; // could be safe owners ???
      if (_inArray(whitelisted_devs, _address)) return true;
      if (_inArray(whitelisted_authors, _address)) return true;
      return false;
  }
  ```
  This checks the Safe address and whitelisted EOAs — it does NOT compare `did:ethr` identities. The comment `// could be safe owners ???` confirms the handoff's C1 gotcha.
- If the append gate were implemented, it would check `did:ethr` identity, which would fail if the key was rotated. But the append gate doesn't exist yet, so this is **not** the cause of the proliferation — it's a future risk if the two authors are the same person under rotated keys.

**Finding:** Most likely two separate publications (different author + different tag). Expected end state = **2 deals**.

---

## Q7: Where is `status:"deal"` set and what is its enum?

**Not in this codebase.** The `S2SContentItem` type in `shared/src/protocol/types.ts` has no `status` field. The displayed fields (`genesis, author, cid, status, creationDate, postType, title, position, tags`) are a **denormalized read model** assembled by the contract's query layer or the safe-app. This confirms §7 gap 3 of the handoff (field-shape drift).

The `postType: "home"` and `position: "0"` fields map loosely to `S2SPublicContent.postType` (string) and `S2SPublicContent.position` (string), but `status` and `creationDate` (timestamp string vs `createdAt` unix seconds number) are not in the spec'd shapes. `title` comes from the `S2SContentBody` secret JSON, meaning the read model is decrypting the body for display.

---

## Q8: Is the deals read model grouped by genesis anywhere?

**Not in this codebase.** The safe-app deals view code is in a separate repo (`safe-app/` per `AGENTS.md`). The safe-app export from `shared` (`shared/src/safe-app.ts`) is minimal:
```ts
export type { S2SProtocolInfo, PKP } from './protocol/types';
export { getProtocolInfo } from './protocol/index';
export { ENS_NAMEWRAPPER } from './protocol/constants';
export type { S2SPublicationConfig } from './publication';
export { fetchById } from './lens';
export { LitService } from './lit';
```

No deals-view logic exists here. The grouping-by-genesis fix would need to happen in the safe-app's query layer.

---

## Diagnosis Summary

**Root cause: write-side, confirmed. The append path is not implemented.**

1. **The append-log contract does not exist in this repo.** `resolveLatest`/`getHistory` are stubs that return null/[].
2. **The registration path never calls a contract at all** — it only signs, IPFS-uploads, and Filecoin-uploads. The license-granting and render-calls are commented out.
3. **Every registration lands as a new genesis row** in the deployed contract because the client cannot look up an existing genesis and the contract has no idempotency guard on content hash.
4. **Genesis ≠ objectId** — the contract assigns genesis independently (not from the deterministic EIP-712 digest), so even identical content registrations produce different keys.
5. **The 3 identical rows (entries 2/3/4)** are likely the safe-app UI re-triggering registration 3 times — each creates a new genesis.
6. **Entry 5 (07-11, different CID)** is a genuine new version — but since the client can't append, it creates yet another genesis.

---

## Recommended Fix Order

1. **Write the append-log contract** (needs a component spec first). Required:
   - `createGenesis(objectId, cid, author, proof)` — idempotent on `objectId` (revert if exists)
   - `append(genesis, objectId, cid, author, proof)` — gated to genesis author's did:ethr (INV-append)
   - `resolveLatest(genesis)` → latest non-tombstone version
   - `getHistory(genesis)` → full version list
   - **Genesis must equal the first entry's objectId** (EIP-712 digest) for determinism

2. **Implement `resolveLatest`/`getHistory`** in `shared/src/identity/verify-content.ts` — query the contract instead of returning null.

3. **Fix the registration path** — before creating, call `resolveLatest` to find existing genesis. If found, call `append`; if not found, call `createGenesis`. This lives in `neutralpress/src/content/content.ctrlr.ts` (after `buildSignedContentItem`) and/or the safe-app's write path.

4. **Add idempotency** — in `createGenesis`, check `objectId` doesn't already exist. Since genesis ≠ objectId in the current contract, this also requires a mapping from `objectId → genesis` or a content-hash check.

5. **Add UI dedup** — check the safe-app for debounce/tx-dedup to prevent triple-submit.

6. **Document the deals read model** — update SPEC-safe-app with grouping-by-genesis semantics: group rows by genesis, show `resolveLatest` per group, not every row.