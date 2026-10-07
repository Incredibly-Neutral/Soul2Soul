# Archive-cache security — content-integrity gap in the cache pointer path

- **date:** 2026-10-06
- **trigger:** s3nl cache-loss incident; recovery plan (repoint the cache pointer) surfaced
  that the repoint capability is the same capability a fake-cache injection would abuse.
- **status:** finding recorded; mitigation deferred (format-level change).
- **cross-refs:** `brain/threat-model/publication.md` (archive section),
  `protocol/actions/src/libs/archive.factory.ts`, `protocol/actions/src/render/data.ctrlr.ts`,
  `brain/reviews/render-50-request-budget-2026-08-31.md`.

## Question under test

> Was there a check to see that content follows cid and that cid has a deal on-chain?

Two sub-questions:
1. Does the read path verify the **CID ↔ on-chain deal** binding?
2. Does the read path verify the **content ↔ CID** binding (i.e. the served bytes actually hash
   to the claimed CID)?

## Findings

### 1. CID ↔ on-chain deal: VERIFIED (enforced)

`reconcile(deals, archive)` in `archive.factory.ts`:
- For each on-chain deal it requires an archive entry where `entry.cid === deal.cid` **and** the
  item passes `s2sContentItemSchema` (`isValidItem`).
- Any entry that does not match the current on-chain deal cid → `needsFetch` → refetched from
  `deal.cid` (`getDeals` is the freshness/correctness oracle).
- Cold (no-archive) path: items are fetched *by* the deal cid from `getDeals` directly.

So no item is ever served under a cid that is not the current on-chain deal cid for its genesis.

### 2. Content ↔ CID: NOT VERIFIED in the archive path

- When an archive entry passes reconcile, the **body is served from the archive's stored `item`**
  (`bodiesFromReconcile` → `toBody(deal, entry.item)`), not from `catFile(deal.cid)`.
- The only checks on that stored item are (a) string equality `entry.cid === deal.cid` and
  (b) structural schema validity. **No byte-for-byte content-addressing check.**
- `public.plaintextHash` exists in the item metadata but is **never verified** anywhere in the
  render path (grep: no consumer in `render/`).

**Consequence:** a forged archive `{ cid: <real on-chain deal cid>, item: <fake but
schema-valid item> }` is served as fresh and its fake body renders. The cache is only as
trustworthy as whoever can write the pointer (`content_cache_<publication>`), which today is:
records contract `onlyAuthorized` → PKP → Lit actions (`update`, `maintain-cache`) gated by
`canPublish`/`canReset` signature recovery. The trust boundary is the signer + the usage key
that can invoke the actions in the group.

### Why the honest path still passes / why the cold path is safe

- Cold path: `catFile(deal.cid)` returns content-addressed bytes by construction (modulo a
  malicious gateway, which is out of scope — it could serve wrong bytes for any cid).
- The rebuilt archive for s3nl was verified: every staged item's bytes were hashed with
  `typestub-ipfs-only-hash` and all 37 match their on-chain deal cids (sample shown in the
  incident log; the rebuild script now does this for all 37 by default).

## Mitigation direction (deferred — format-level change)

The archive currently stores the *parsed* item (re-serialized by `JSON.stringify` when the
archive is serialized), so a naive `ipfsHash(storedItem) === entry.cid` check would
**false-fail honest archives** (original IPFS payload bytes ≠ re-serialized JSON). Options:

- **A. Store the original item bytes** (or keep `cid` = the hash of the *stored serialized
  item* rather than the deal cid, and verify the deal binding separately). Then `reconcile` can
  cheaply verify content-addressing (sha256, no HTTP) before serving fresh.
- **B. Keep format, verify on refetch/sample** — weaker; verification would need a cat per item
  (defeats the budget) or sampling (probabilistic).
- Recommend **A** with a format bump `s2s-publication-archive/3`; `parseArchive`/`reconcile`
  keep consuming `/2` and `/3` so old archives don't break the read path.

## Guardrails for the recovery tooling (option B — repoint-archive action)

The repoint action must not widen this gap further:
- Gate: `canReset` (publication Safe owner) — the strictest existing gate, publication-scoped.
- Before writing, validate the seed archive: cat → `parseArchive` → `getDeals` → `reconcile`
  must yield `needsFetch.length === 0` (full coverage), else reject.
- The off-chain rebuild must verify content-addressing (hash each staged item against its deal
  cid) before the archive is uploaded — this closes "content follows cid" for the rebuild even
  though the runtime read path still trusts cid-string-equality.
