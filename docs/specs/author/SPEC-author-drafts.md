# SPEC-author-drafts — the draft log on the author Safe

> **Parent:** [SPEC-author](SPEC-author.md) — the authoring front door.
> **Sibling (the log this mirrors):** [SPEC-publication-agreements](../publication/SPEC-publication-agreements.md) —
> the same append log plus the deal layer, which this one does not have.
> **Siblings (context):** [SPEC-publication-account](../publication/SPEC-publication-account.md) — how a
> module is installed on a Safe; [SPEC-author-shared](SPEC-author-shared.md) — where the genesis id comes
> from.
>
> **Type:** component spec. It owns the drafts half of one package — `src/author/contracts`,
> `DraftsModuleV1` and its side of `AuthorContractsFactory` — and the meaning of the log it keeps.
>
> **Status:** the package is written and tested (`src/author/contracts`, 15 node-test cases for this
> module); nothing is deployed. The interface below is frozen; anything under [open questions](#open-questions) is not
> decided and must not be treated as a guarantee.

---

## Responsibility

A UUPS module installed on an author Safe, keeping **drafts**: manuscripts uploaded but never offered to
a publication. Its storage, per instance, is exactly four declaration-ordered storage variables — the order
is part of the upgrade contract, so read it here rather than from a diff:

| declaration | type | holds |
|---|---|---|
| `safe` | `address` | the only writer, set once by `initialize` |
| `versions` | `mapping(bytes32 => Version[])` | the version log, per genesis; the count **is** the array length, there is no separate counter |
| `genesisAuthor` | `mapping(bytes32 => address)` | the binding, written once on a genesis's first append |
| `genesisList` | `bytes32[]` | every bound genesis, insertion order; its length is `count()` |

There is no `mapping(bytes32 => bool) isDraft` and no stored `authorOf` map: both are **view functions**
over `genesisAuthor` — `isDraft(g)` is `genesisAuthor[g] != address(0)`, `authorOf(g)` returns the
mapped address (or `address(0)`). `Entry` is assembled on read and never stored.

It does not hold content, encryption, deals, offers, whitelists, config, or the site root. It never
learns which publication a draft is for, because a draft has none — that is the whole difference from
the publication module, and it is what makes the module small.

`src/author/contracts` is the first contracts package in the author tree; the publishing contracts live
under `src/publication/contracts`. Same toolchain, same deployment shape: one implementation per version,
one ERC-1967 proxy per Safe, the factory tracking which proxy belongs to which Safe.

## The identifiers

| | what it is |
|---|---|
| `genesis` (`bytes32`) | the document's permanent identity — same convention as the publication module, `toBytes32Id(ref)` from `shared`: keccak256 of anything that is not `0x` + 64 hex, passthrough otherwise. Stable across revisions. |
| `cid` (`string`) | *this version's* bytes. Not stable. |
| `timestamp` (`uint256`) | block time at append. |

The genesis is **the same value** the note's frontmatter carries and the value `makeOffer` would use.
Nothing converts between the draft log and the publication log, because there is nothing to convert: it
is one id, kept in two places.

## `append` — the only write

```solidity
function append(bytes32 genesis, string calldata cid) external onlySafe
```

- `genesis == bytes32(0)` → `ZeroHash()`; `cid.length == 0` → `EmptyCid()`.
- `initialize(address(0))` → `ZeroAddress()`. A zero `safe` passes no caller check ever, so the module
  would be born dead — writes and upgrades both unreachable and nothing able to repair it. The guard is
  what stops `createDraftsModule(address(0))` from producing a proxy nobody can use.
- **First append of a genesis** — `genesisAuthor[genesis] = safe` and the genesis is pushed onto
  `genesisList`. Nothing else is written: `isDraft` and `authorOf` derive from that one map, so there is
  no second flag to keep in step.
- **Every append** — push `Version { cid, timestamp }`, emit
  `Appended(bytes32 indexed genesis, string cid, uint256 versionIndex, address indexed author)`.

The gate is `msg.sender == safe` and nothing else. There is no `canPublish`, no whitelist, no developer
list, no author EOA. Read that against `makeOffer`
([agreements](../publication/SPEC-publication-agreements.md)), which admits any `canPublish` address and
then sorts the caller into offer or deal: the draft log admits no one but the Safe, because a draft is
not a public act and there is no second party to admit.

INV-10 still holds — **the Safe acts, the EOA signs** — and it costs more here than it looks. The Safe's
owners must propose an `append` through the Safe, so on an N-of-M author Safe *recording a draft* is a
governance act. That is the price of putting the index on-chain at all; see AUTHOR-1 below.

## Reads

| call | answers |
|---|---|
| `fetchAll() -> Entry[]` | every draft, insertion order |
| `fetchAllPaged(uint256 offset, uint256 limit) -> Entry[]` | a window of the same list |
| `fetch(bytes32 genesis) -> Entry` | one draft; **unknown genesis returns a zeroed `Entry` with `versionCount == 0` and never reverts** |
| `history(bytes32 genesis) -> (uint256[] timestamps, string[] cids)` | parallel arrays, insertion order |
| `versionCount(bytes32 genesis) -> uint256` | versions logged for one genesis |
| `count() -> uint256` | number of drafts (the list length) |
| `isDraft(bytes32 genesis) -> bool` | bound to this Safe |
| `authorOf(bytes32 genesis) -> address` | the Safe that bound it, or `address(0)` |

```solidity
struct Version { string cid; uint256 timestamp; }
struct Entry   { bytes32 genesis; address author; string cid; uint256 timestamp; uint256 versionCount; }
```

`Entry` is assembled on read and never stored — as on the publication side. Its `cid` and `timestamp` are
the **latest** version's; `versionCount` is how many there are.

**Call `fetchAllPaged`, not `fetchAll`.** The paged read is what a UI should use: an unpaged `fetchAll`
builds and returns the whole log in one `eth_call` and fails once the log is big enough to matter. The
unpaged `fetchAll` and `history` are for scripts and small logs — `history` is per genesis and bounded by
that genesis's version count, `fetchAll` is bounded by `count()` and is not.

Paging never reverts: `offset >= count` or `limit == 0` returns an empty array, and a limit past the end
— including `type(uint256).max` — is clamped to `count - offset`, never overflowed.

The first four fields match the publication `Entry` (`genesis, author, cid, timestamp`) field for field;
this `Entry` appends `versionCount`. The two structs are still distinct types with distinct ABIs — a
decoder written against one must never be pointed at the other, and nothing catches it for you, but at
least the shared prefix reads identically.

## Events and upgrade

- `Appended(bytes32 indexed genesis, string cid, uint256 versionIndex, address indexed author)`
- `ContractUpgraded(address indexed implementation)`

UUPS. `initialize(address safe)` sets the Safe and rejects `address(0)`; `_authorizeUpgrade` is
`onlySafe` and the module's own `ContractUpgraded` is the record of the implementation swap. Assert the
module's event, not the base's — OZ's proxy also emits its own, and the two are not the same guarantee.

**The Safe upgrades with `upgradeTo`, not `upgradeToAndCall`.** OZ 4.9.6's `upgradeToAndCall` forces the
delegatecall (`forceCall = true`) and this module has no fallback, so `upgradeToAndCall(impl, "0x")`
reverts with `Address: low-level delegate call failed` even from the Safe. The empty-calldata upgrade is
`upgradeTo`.

`NAME()` returns `"S2S Drafts Module V1"`. It is the discovery string, as on the publication module:
never reuse it for a V2 that changes storage layout.

## The factory

One factory for the whole package — `AuthorContractsFactory(draftsImplementation, ownerHistoryImplementation)`,
shared with [owner history](SPEC-author-owner-history.md). The drafts half:

| member | behaviour |
|---|---|
| `createDraftsModule(address safe) -> address` | deploy an ERC-1967 proxy over `draftsImplementation()`, initialised with `safe`; push the proxy onto `getDraftsModulesForSafe(safe)` |
| `setDraftsImplementation(address)` | **`onlyDeployer`** — set `draftsImplementation()`, push onto the drafts implementation history |
| `getDraftsModulesForSafe(address) -> address[]` | every proxy anyone told this factory about for that Safe |
| `draftsImplementationCount() -> uint256` | history length |
| `getDraftsImplementationByVersion(uint256) -> address` | 1-based; reverts `InvalidVersion()` outside `1..count` |
| `deployer() -> address` | `immutable`, set to `msg.sender` at construction; the only address either `set*Implementation` admits (`OnlyDeployer()`) |

**`setDraftsImplementation` is gated because the ungated version is a takeover.** Whoever moves
`draftsImplementation()` decides what the next `createDraftsModule` deploys, and a proxy over an
attacker's implementation executes as the Safe the moment that Safe uses it. The gate is an immutable
constructor-set deployer rather than an owner: there is no admin slot to rotate, and none to compromise.
The owner-history pointer is a separate slot with a separate history, so moving one never silently moves
the other.

**`createDraftsModule` stays permissionless, deliberately.** Deploying a proxy costs the caller gas and
installs nothing on any Safe — the Safe must still call the module in its own transaction. Gating it would
buy nothing and would put a trusted party between an author and their own module.

One consequence of that openness, which readers get wrong:

- **`getDraftsModulesForSafe` is forgeable.** `createDraftsModule(victimSafe)` from any account pushes an
  entry into the index for `victimSafe`, so the list contains proxies that Safe never created and never
  used. A Safe's own record of use — an event it emitted, a call it made — is the only proof; treat an
  index entry as a lead, not as installation.

The factory is an index for readers, not a permission: neither `getDraftsModulesForSafe` nor the
implementation history authenticates anything.

## Two logs, one genesis

The draft log is the author's; the publication log is the publication's. A genesis that later becomes an
offer exists in **both**, and the second write is an **explicit copy** — the author calls `makeOffer`
with a CID — not a pointer, not a reference, not a shared row. Nothing in either contract reads the
other. What follows:

- **The two logs can disagree, and that is normal.** Append draft v3, offer v2, and each log has a
  different "latest". No function compares them, and no reader may assume they match.
- **The draft log is untouched by everything the publication does.** Retract, demote, revoke a
  whitelist entry, upgrade the publication module — the draft entry stays. That is AUTHOR-3 and AUTHOR-9
  working at the author's end of the relation.
- **`authorOf` here is not evidence of authorship for the publication.** The record a gate and a byline
  read is the publication-side `genesisAuthor`, written when the offer is made. The draft-side binding
  says only "this Safe kept this document here".
- **Being a draft is not a step in a state machine.** Nothing transitions; a genesis may be a draft
  forever, a draft and a deal at once, or a deal with no draft entry ever having existed.

## Invariants

- **Append-only.** No function removes a version, a draft, or a binding. `onlySafe` cannot delete either.
- **The genesis binding is write-once.** `genesisAuthor[genesis]` is set on the first append and never
  reassigned; there is no transfer, no re-bind, no adoption path. A later append to the same genesis
  writes only a `Version`, never the binding and never a second list entry. Scope caveat: the binding lives in one
  module instance, so a second drafts module installed on the same Safe has its own empty map. The
  invariant is **per instance**, not per account.
- **Only the Safe writes.** Every mutating function is `onlySafe`, including the upgrade.
- **Version order is insertion order** — within a genesis, and across the draft list. There is no
  swap-pop and no removal, so pagination is stable: appends only extend. The publication sets get their
  ordering hazard from removal; this log cannot have it.
- **The log is plaintext in V1.** No ciphertext, no key, no `encryption` flag. The chain publishes the
  CID; a public gateway serves the bytes. A draft is not private — it is a document whose address is
  public and whose index is public. This is the exact opposite of AUTHOR-2's encrypt-to-the-press rule,
  and it is a consequence of a draft having no press to encrypt to.
- **Reads never revert on unknown input.** `fetch`, `history`, `versionCount`, `isDraft`, `authorOf` all
  answer for a genesis that was never appended.
- **AUTHOR-1 holds by not being implemented.** Writing is local; `append` is a separate, deliberate,
  signed act by the Safe. The log is an index of what was uploaded, never the act of writing — so a host
  must not make saving a note depend on it.

## What V1 does not do

- **No dedupe.** Appending the CID that is already the latest one is not a no-op: it pushes another
  version with the same `cid` and a new `timestamp`, and `history` then shows it twice. A retried Safe
  proposal — the same `append` signed and submitted twice — is how it happens in practice, and the log
  cannot tell a retry from a deliberate re-record. Readers that care compare CID and timestamp.
- **No delete, no tombstone.** And no `tombstone` field at all — do not copy the publication module's
  dead one.
- **No encryption.** No ciphertext, no access control, no Lit gate, no collection.
- **No publication side.** No offer, no deal, no accept, no whitelist, no `publication` field anywhere.
- **No cross-log verification.** Nothing checks that a CID offered to a publication matches a CID in the
  draft log.
- **No metadata beyond `cid` and `timestamp`.** No title, slug, tags, or locale — those stay in the note
  and in the signed content item.
- **No host wiring.** No CLI or plugin command appends to this module; the package is contracts only.

## Open questions

1. **Writer auth beyond the Safe.** Today every draft is an N-of-M governance act. A scoped signer, or
   `append` reached through a 4337 userOp from the Safe, is the obvious relief — undecided.
2. **Encryption.** Plaintext is a V1 choice, not an argument. Options: encrypt to the author's own key
   (nothing renders a draft, so the cipher is passive), a future gated collection, or accept plaintext
   for the pre-offer window. Undecided.
3. **Deletion.** Append-only means a mistaken upload is in the index forever. A `tombstone` that means
   something, or an `onlySafe` hide flag, is undecided — and the publication module's dead field is the
   cautionary example of adding one without a feature.
4. **Should the CLI read drafts?** Listing a Safe's drafts would let a host resume local work, but it is
   a chain read per document and nothing in `author-cli` imports the module today.
5. **Is this the works list (AUTHOR-9)?** No — [RFC-001](../../rfc/RFC-001-portable-byline.md) is the
   byline and covers works that carry agreements. Whether the byline should also read drafts is open.
6. **Is a draft entry ever pruned?** Not in V1 (INV: append-only). If storage cost on Base becomes the
   complaint, an `onlySafe` prune that keeps the CID but drops the record is the first thing to weigh
   against the invariant that `history` is a complete trail.

Settled by the implementation, recorded here so it stops being a question: `versionIndex` is **0-based**
(the index the new version just took, i.e. the old length); a paged read returns an **empty array** when
`offset >= count` or `limit == 0`, and otherwise **clamps** the end at `count`; `fetch` on an unknown
genesis returns the zeroed `Entry` rather than reverting.

## Safe-to-change vs do-not-touch

- 🟢 read helpers; events; a `tombstone` that does something; explicit paging bounds; a second factory
  entry point.
- 🔴 append-only and the write-once binding; **per-draft metadata** — adding a field to the storage
  struct `Version` changes its element stride, so every existing `versions[genesis][i]` decodes shifted
  and every stored version is corrupted. `Entry` is a return type and may grow; `Version` may not.
  Nothing in the storage declarations may be reordered; the `onlySafe` gate; the `Entry` tuple order once
  an ABI is generated and consumed; the `NAME()` string; the plaintext statement in V1 (it is a claim the
  code has to keep true).

## Test seams

- `append` truth table: the Safe (happy path); the Safe's own owner EOA; another Safe; the module itself
  → all revert. `ZeroHash` on `bytes32(0)`; `EmptyCid` on `""`.
- First append binds, second append must not move `authorOf`; a genesis appended twice has
  `versionCount == 2` and `history` returns both cids in insertion order.
- `fetch(unknown)` → zeroed `Entry`, `versionCount == 0`, no revert; `fetchAll` order equals append
  order; paged windows tile `fetchAll` exactly.
- `history` returns arrays of equal length, same order, non-decreasing timestamps.
- Factory: two `createDraftsModule` calls for one Safe → two proxies, `getDraftsModulesForSafe`
  length 2; `setDraftsImplementation` then `createDraftsModule` → new proxy on the new implementation,
  old one untouched; `getDraftsImplementationByVersion(0)` and `(count + 1)` revert `InvalidVersion()`.
- Upgrade, all covered today against a second deployment of the same implementation (a V2 is not
  needed to exercise the gate): `upgradeToAndCall` from a non-Safe reverts `OnlySafe`; `initialize` on the
  bare implementation reverts `Initializable: contract is already initialized`; a second `initialize`
  on the proxy reverts the same; the Safe's `upgradeTo` succeeds, emits exactly one `ContractUpgraded`,
  and leaves `safe`, `count()` and the log readable afterwards.
- Factory auth: `setDraftsImplementation` from a non-deployer reverts `OnlyDeployer` and leaves
  `draftsImplementation()` unchanged; the deployer's call moves it, appends to the history, and the next
  `createDraftsModule` deploys over the new implementation. `createDraftsModule` from a stranger still
  succeeds and still lands in `getDraftsModulesForSafe` — the forgery is asserted, not assumed.
- `initialize(address(0))` through `createDraftsModule` reverts `ZeroAddress` and records no proxy.
- Paging edges: `offset + limit == count` returns a full page (not clamped short); `limit =
  type(uint256).max` returns to the end instead of overflowing; `offset >= count` and `limit == 0` return
  empty arrays.
- Repeat append: a second and third append to one genesis leave `authorOf`, `count()` and the binding
  untouched while `versionCount` and `history` grow — including two appends of the identical CID.
