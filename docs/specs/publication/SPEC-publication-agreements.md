# SPEC-publication-agreements — offers, deals, and the version log

> **Parent:** [SPEC-publication](SPEC-publication.md) — the publication front door.
> **Sibling:** [SPEC-publication-account](SPEC-publication-account.md) — the Safe and modules that host
> this state machine. **Sibling (read gate):** [SPEC-publication-review](SPEC-publication-review.md) —
> what a holder may decrypt, which is a different question from what is a deal.
>
> **Type:** component spec. It owns the *state machine*: what an agreement is, how one is made, what
> accepting and retracting do, and what the version log means. Contract semantics only — the operator
> workflow that drives them is in [the admin app](SPEC-publication-admin-app.md).
>
> **Audited against live code:** 2026-10-30 (`S2SPublicationModuleV2.sol` at `85e9671`).
>
> **Folded from:** `SPEC-contracts-publication` — the C1 write/read API, the permissions matrix, and the
> V1→V2 migration table.

---

## Responsibility

`S2SPublicationModuleV2` holds, per publication:

- **the version log** — `versions[genesis]` append-only, `latestIndex[genesis]`, `genesisAuthor[genesis]`;
- **the deal set** — works this publication has agreed to publish;
- **the offer set** — works offered and not yet decided;
- **the whitelists** — authored in `authoring` terms on the account side
  ([whitelist mechanics](#whitelists) here, because they decide what `makeOffer` does).

It does not hold content, the site root, the config, or the name. Content is addressed by CID; the root
is in the ENS layer; config and name are records on the sibling module.

## The three identifiers

| | what it is | who computes it |
|---|---|---|
| `genesis` (`bytes32`) | the document's permanent identity — EIP-712 digest of the signed public envelope | the authoring host, before any upload |
| `cid` (`string`) | *this version's* bytes | the upload |
| `objectId` | the same digest, carried in the item for verification | the host |

Chain-side identifiers are `bytes32`. Off-chain code passes string refs and converts with
`toBytes32Id(ref)` in `shared`: keccak256 of anything that is not already `0x` + 64 hex, passthrough
otherwise. **`genesis` is stable across revisions; `cid` is not.** Everything a publication decides is
decided about a `genesis`; everything it renders is read from the `cid` at `latestIndex`.

## The state machine

### `makeOffer(bytes32 genesis, string cid)` — the only author-write

One function does two things in a fixed order:

```solidity
function makeOffer(bytes32 genesis, string calldata cid) external returns (bool dealt) {
    _append(genesis, cid, msg.sender);                                   // 1. log the version

    if (msg.sender == safe || _inArray(whitelisted_authors, msg.sender)) {
        if (_isOffer[genesis]) _removeOffer(genesis);                     // 2a. entitled → deal
        if (!_isDeal[genesis]) { _addDeal(genesis); emit DealStruck(...); }
        return true;
    }
    if (!_isDeal[genesis] && !_isOffer[genesis]) {                        // 2b. not entitled → offer
        _addOffer(genesis); emit OfferMade(genesis, genesisAuthor[genesis]);
    }
    return _isDeal[genesis];
}
```

`_append`'s gate is **not** `canPublish` in the plain sense:

- **first version of a genesis** — requires `canPublish(author)`, i.e. `safe ∨ whitelisted dev ∨
  whitelisted author`; else `OnlySafe()`. It then writes `genesisAuthor = author`.
- **later versions** — requires `author == genesisAuthor` **or** `author == safe`; else `OnlySafe()`.
- `genesis == 0` → `ZeroHash()`; empty cid → `EmptyCid()`.

**Consequence, and it is the one most often got wrong: a developer's new work becomes an offer.** A
developer passes `canPublish`, so `_append` lets them create a genesis, but entitlement is
`safe ∨ whitelisted_authors` — developers are not in that list. So a dev's first version is an
`OfferMade`, and it needs the Safe to accept it. The same holds for anyone the Safe has not put on the
author list. (The V1-era spec claimed the offer path was "only reachable through the publication Safe";
that is false in the code. See [corrections](#corrections-to-the-folded-spec).)

**Editing never yanks a live deal.** Entitlement is re-evaluated per call, but the not-entitled branch
only *adds* an offer when neither a deal nor an offer exists. So a whitelisted author whose listing is
later removed keeps their existing deal, and their next version appends to the log without touching the
deal set. Deals end by `retract`, not by losing a whitelist entry.

### `acceptOffer(bytes32 genesis)` — `onlySafe`

```solidity
require(_isOffer[genesis], "no offer");
_removeOffer(genesis);
if (!_isDeal[genesis]) _addDeal(genesis);
emit OfferAccepted(genesis, genesisAuthor[genesis]);
```

Offer → deal. One-sided: there is no author-side equivalent, which is the point — admission is the
publication's act alone.

### `retract(bytes32 genesis)` — asymmetric by caller

```solidity
require(_isDeal[genesis] || _isOffer[genesis], "not a deal or offer");

if (msg.sender == genesisAuthor[genesis]) {   // full withdrawal
    if (_isDeal[genesis])  _removeDeal(genesis);
    if (_isOffer[genesis]) _removeOffer(genesis);
} else if (msg.sender == safe) {             // demote or reject
    if (_isDeal[genesis]) { _removeDeal(genesis); if (!_isOffer[genesis]) _addOffer(genesis); }
    else                  { _removeOffer(genesis); }
} else revert NotAuthorized();
```

| caller | on a deal | on an offer |
|---|---|---|
| `genesisAuthor` | removed from deals; offer too if present | removed |
| `safe` | **demoted**: leaves deals, re-enters offers (`hasDeal` flips false) | rejected |
| anyone else | `NotAuthorized()` | `NotAuthorized()` |

**Nothing is ever deleted from the version log.** A withdrawn work keeps its versions, its CIDs, and its
`genesisAuthor`. Retraction is a statement about the sets, not about history — a publication that
retracts and re-accepts returns to the same log position.

The Safe's demote-instead-of-delete is a design statement: a publication can stop publishing something
and cannot erase it. That is why the admin app's "Revoke" leaves the page live until a render removes
it, and why the author's own withdrawal is the only path that takes a work out entirely.

## The sets are enumerable, unordered, and swap-popped

| | representation |
|---|---|
| membership | `mapping(bytes32 => bool) _isDeal / _isOffer` — one slot, the read the gate uses |
| list | `bytes32[] dealList / offerList` |
| position | `mapping(bytes32 => uint256) dealPos / offerPos` — `index + 1`, `0` = absent |
| removal | swap-with-last, pop, fix the moved element's position |

`getDeals(offset, limit)` / `getOffers(offset, limit)` return `Entry[]` assembled on read:

```solidity
struct Entry { bytes32 genesis; string cid; address author; uint256 timestamp; }
```

**`Entry` is not stored anywhere.** There is no `entries[]`. Each entry is built from
`versions[genesis][latestIndex[genesis]]` plus `genesisAuthor[genesis]`. Two consequences: (a) an
`Entry`'s `cid` is the *latest* version's, never a historical one; (b) pagination pages the **sets**,
not a log, and because removal swaps the last element into the hole there is **no ordering guarantee**
across pages — a render that pages while a retraction lands can double-count or miss an entry. Readers
that need a stable list should snapshot and diff (the app's tree tab does exactly this).

Historical versions are reachable per genesis: `getVersion(genesis, i)`, `getVersionCount(genesis)`,
`getLatest(genesis)`, `isGenesis(genesis)`, `authorOf(genesis)`.

## `tombstone` is a field without a feature

`Version { string cid; uint256 timestamp; bool tombstone; }` — and `tombstone` is written `false` on
every append. No function in the contract sets it to `true`. Three consumers in `shared/src/cid-view`
and the action's ABI binding carry the field anyway, so removing it is a coordinated change, not a
one-line delete.

Its intended meaning is legible from the shape: "this work was retracted and must not be re-admitted" —
the difference between an agreement that ended and a work the publication has refused. As of this
audit it means nothing.

## Whitelists

Two lists, both `onlySafe` to modify, both capped, both enumerable:

| | cap | constant | grants |
|---|---|---|---|
| authors | 100 | `MAX_WHITELISTED_AUTHORS` | `canPublish`, and `makeOffer` → immediate deal |
| developers | 20 | `MAX_WHITELISTED_DEVS` | `canPublish` only — a dev's work is an **offer** |

- `whitelistAuthor` / `removeWhitelistedAuthor`, `whitelistDev` / `removeWhitelistedDev`.
- Removal is **silent**: absent address → no revert, no event, swap-pop no-op. A caller cannot tell
  "removed" from "was not there".
- The cap is checked **before** the duplicate check, so re-adding someone who is already present while
  the list is full reverts on the cap.
- Removal does **not** revoke deals, retract offers, or affect the version log. It withdraws the
  privilege, not the history.
- `canPublish(addr)` = `addr == safe ∨ whitelisted dev ∨ whitelisted author`. It is an **address**
  check, so a Safe *owner* EOA does not pass. There is no reviewer list and no reviewer role.

## Corrections to the folded spec

Three claims in `SPEC-contracts-publication` did not survive this audit:

| claim | code |
|---|---|
| `retract` is `safe ∨ genesisAuthor` "withdraws fully" for the author **and** the safe demotes | correct in substance, but the spec listed `retract` under a row implying the Safe could also fully withdraw — it cannot; the Safe only demotes/rejects |
| "a whitelisted author's first version is still a deal, so the offer path is only reachable through the publication Safe" | **wrong**: a whitelisted **developer** passes `canPublish` and their genesis becomes an offer |
| `NAME() == "S2S Publication Module V2"` with V1 accepted "for backwards-compatible discovery" | true of `shared`, false of `safe-app` — see [the account child](SPEC-publication-account.md#what-is-hung-on-the-safe) |

## V1 → V2 migration (kept for readers of older material)

| V1 (deprecated) | V2 (current) | note |
|---|---|---|
| `grantLicense(pub, content_id)` | `makeOffer(genesis, cid)` | single author write; entitled caller → deal, else offer |
| `acceptLicense(content_id)` | `acceptOffer(genesis)` | `onlySafe` |
| `revokeLicense(content_id)` | `retract(genesis)` | asymmetric by caller |
| `isLicensed(string)` | `hasDeal(bytes32)` | the read the gate uses |
| `isLicensedBulk(string[])` | — | replaced by `getDeals(offset, limit)` |
| `getAllContentIds()` | `getDeals(offset, limit)` | `Entry[]`, not id arrays |
| `getLicenseAuthor(string)` | `authorOf(bytes32)` / `Entry.author` | |
| `hasPendingLicense(string)` | `hasOffer(bytes32)` | |
| `getPendingLicense(string)` | `getOffers(offset, limit)` | `Entry[]` |
| `append(genesis, objectId, cid)` | `makeOffer(genesis, cid)` | `objectId` dropped |
| `NAME() == "S2S Publication Module"` | `... V2` | discovery strings |

## Invariants

- **INV-3** — the storage layout above is the contract; `Entry` is a return type, never storage.
- **INV-10** — see the matrix below; anything not listed reverts.
- **`genesisAuthor` is written once and never changes.** The first writer owns the document forever,
  including the right to withdraw it. Transfers do not exist.
- **A deal is a bool, not a record.** `hasDeal` is one slot read; the human-readable history is the log.
- **`onlySafe`** is `msg.sender == safe`, and `safe` is a storage address, not an immutable — an upgrade
  that never touches it leaves it fixed.

## Permissions matrix

| target | `onlySafe` | also allowed |
|---|---|---|
| whitelist add/remove | ✓ | — |
| `acceptOffer` | ✓ | — |
| `upgradeToAndCall` | ✓ | — |
| `makeOffer` | ✓ (as entitled) | `genesisAuthor` for later versions; any `canPublish` address for a genesis's first version |
| `retract` | ✓ (demote/reject) | `genesisAuthor` (full withdrawal) |
| records writes | ✓ | — |

## Safe-to-change vs do-not-touch

- 🟢 add read helpers; add events (e.g. a real decline event); add a decision record keyed by genesis;
  make `tombstone` mean something; add pagination bounds.
- 🔴 change `_append`'s gate (it is the whole authoring contract); make `acceptOffer` author-callable;
  let the Safe delete log entries; reorder storage; remove the swap-pop unless every reader is fixed
  first (the tree tab depends on snapshot diffing *because* of it).

## Test seams

- Truth table for `makeOffer`: {safe, author, dev, stranger} × {new genesis, existing genesis, existing
  deal, existing offer} — 16 cases, of which the dev/offer and edit-a-live-deal rows are the ones that
  regress.
- `retract` matrix: author on deal+offer, safe on deal (demote), safe on offer (reject), stranger.
- Caps: add 100 authors then re-add an existing one at cap → reverts.
- Silent removal: `removeWhitelistedAuthor(absent)` → no revert, no event, list unchanged.
- Pagination with a concurrent retraction — the unordered-set hazard, asserted deliberately.
