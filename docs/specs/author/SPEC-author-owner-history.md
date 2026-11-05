# SPEC-author-owner-history — who was an owner, and when

> **Parent:** [SPEC-author](SPEC-author.md) — the authoring front door.
> **Siblings (context):** [SPEC-author-identity](SPEC-author-identity.md) — the author Safe, its owners,
> and the EOA that signs; [SPEC-publication-account](../publication/SPEC-publication-account.md) — how a
> module is installed on a Safe, and INV-3; [SPEC-author-drafts](SPEC-author-drafts.md) — the other module
> on the same Safe, and the shape this file copies.
>
> **Type:** component spec. It owns two contracts in `src/author/contracts` — `OwnerHistoryModuleV1` (UUPS,
> one proxy per Safe) and `OwnerHistoryGuard` (non-upgradeable, storage-free) — and the meaning of the
> history they keep between them.
>
> **Status:** spec-first. Neither contract exists yet; `src/author/contracts/src` holds `DraftsModuleV1`
> and its factory and nothing else. The interface below is the frozen target, and everything under
> [open questions](#open-questions) is undecided and must not be read as a guarantee.

---

## Responsibility

A gate asks whether a signer is an owner **now**. The question that matters is whether the signer was an
owner **when the artifact was signed** — a manuscript offered in March and checked in September was
offered by whoever held the keys in March, and a Safe that has since rotated its signers must not silently
re-attribute or lose that. This package answers the second question.

`OwnerHistoryModuleV1` mirrors the Safe's owner set and keeps every past set with the block and timestamp
at which it held. `OwnerHistoryGuard`, installed on the Safe, tells it when to look.

It does not hold manuscripts, deals, offers, config, or identity. It holds one fact, versioned by time:
**the owner set, and its intervals.**

## Does the Safe offer a hook on owner rotation?

No, and the design is entirely downstream of that. Safe 1.4.1 — the version the author Safe is created
with ([SPEC-author-overview](SPEC-author-overview.md), `SafeL2 v1.4.1`) — has no callback, no receiver,
and no extension point on an owner mutation. `addOwnerWithThreshold`, `removeOwner`, `swapOwner` and
`changeThreshold` emit `AddedOwner` / `RemovedOwner` / `ChangedThreshold` and nothing else; those events
are indexable off-chain and invisible on-chain. A contract cannot be called by them.

Four facts turn that absence into a design:

- **Every owner mutation is `onlySelf`.** It can only arrive through `execTransaction`.
- **`setGuard` is also `onlySelf`**, and `execTransaction` calls `guard.checkTransaction(...)` before the
  call and `guard.checkAfterExecution(txHash, success)` after it. A guard therefore sees every owner
  rotation, because every rotation is a Safe transaction. That is the only on-chain tap on the Safe, and
  it is why this is a guard plus a module rather than a listener or an oracle.
- **The guard is read once, at the start of `execTransaction`**, into a local. A transaction that
  replaces the guard is still checked by the old one — `setGuard(address(0))` is itself checked by the
  guard it removes. **This is a version-specific claim and the completeness argument leans on it alone:
  re-verify it on any Safe upgrade before trusting anything below.**
- **Modules do not get this call.** `execTransactionFromModule` has no guard hook in 1.4.1. The blunt
  form of that statement is false — a module can reach `authorized` by calling the Safe itself (see
  [completeness](#completeness--the-one-thing-that-can-be-wrong)) — but no owner mutation travels the
  ordinary module path, and no module in this tree exposes an arbitrary self-call.

The install is one Safe transaction: `enableModule(module)`, then `setGuard(guard)`, both `onlySelf`. Order
matters only in that the guard must be live before the first rotation, not before the module.

## Storage

Per instance, exactly six declaration-ordered storage variables. The order is the upgrade contract, as on
every module here (INV-3) — read it here rather than from a diff:

| declaration | type | holds |
|---|---|---|
| `safe` | `address` | the Safe this history is about; set once by `initialize` |
| `eras` | `Era[]` | one entry per owner set, in order of taking effect; `eras[0]` is opened by `initialize`, the last is current |
| `tenureBlocks` | `mapping(address => uint256[])` | per address, interleaved `[start0, end0, start1, end1, …]` in block numbers; `end == 0` means open |
| `tenureTimes` | `mapping(address => uint256[])` | the same endpoints in `block.timestamp` values, index for index |
| `ownersEver` | `address[] public` | every address that has ever been an owner of `safe`, insertion order, deduped |
| `seen` | `mapping(address => bool)` | the dedupe flag behind `ownersEver` |

```solidity
struct Era {
    address[] owners;    // the whole set, as of startBlock
    uint256 startBlock;  // first block in which this set held
    uint256 startTime;   // block.timestamp of that block
    uint256 endBlock;    // first block in which it did not hold; 0 = current
    uint256 endTime;     // block.timestamp of endBlock's block; 0 = current
}
```

`Era` holds the full set because two readers need it: a reader asking what the Safe's signers were at a
point in time, and `sync` itself, which diffs against it. Membership reads do not touch it — they binary
search `tenureBlocks`, which is per address and therefore short.

`tenureBlocks[who]` and `tenureTimes[who]` are always the same length, and index `i` in one describes the
same endpoint as index `i` in the other. That pairing is load-bearing: extending one without the other
breaks every read. `end == 0` is the open tenure, and it is always the last pair, because an address can
hold at most one open tenure — it is either an owner now or it is not.

`ownersEver` is a public array, so the read is the per-index getter `ownersEver(uint256)` and the
enumeration is `count()`. It cannot also be a no-arg `ownersEver()`: a state variable and a function may
not share a name.

## The era model

An era is a half-open interval of blocks, `[startBlock, endBlock)`, and of times, `[startTime, endTime)`.
`endBlock == 0` marks the current era. Eras tile the chain from `initialize` forward with no gaps and no
overlap. Blocks before `eras[0].startBlock` are outside the history and read `false`.

**The boundary belongs to the new set.** A rotation executed in block N closes the old era with
`endBlock = N` and opens the new one with `startBlock = N`. Half-open means the old owner is **not** an
owner at block N and the new owner **is**. This is the post-state rule, and it is a choice, not a
consequence: the chain's state at the end of block N is the new set, and the alternative — letting the
pre-state win, or refusing to answer for a boundary block — would make the read depend on transaction
order inside the block, which no contract can see.

What it implies for a gate is stated plainly because it is a real semantic decision: **an artifact signed
in the same block as a rotation is judged by the rotation.** A signature from the outgoing owner in block
N is refused; a signature from the incoming owner in block N is accepted. `isOwnerAt` cannot tell whether
the signature came before or after the owner change within that block, and does not pretend to.

## Reads

| call | answers |
|---|---|
| `isOwner(address who) -> bool` | live `staticcall` to the Safe's own `isOwner(who)`; **`false` if the call fails**, so a dead or wrong `safe` never reads as an owner |
| `isOwnerAt(address who, uint256 blockNumber) -> bool` | **the gate's call.** `false` before `eras[0]`; answered from the tenures for any block earlier than `block.number`; for a `blockNumber` at or after `block.number` — which is how a caller asks "owner now" — the live `isOwner` answer, falling back to era membership if the staticcall fails |
| `wasOwnerAt(address who, uint256 timestamp) -> bool` | the same on the timestamp axis |
| `tenuresOf(address who) -> Tenure[]` | assembled on read from the two arrays; `{startBlock, startTime, endBlock, endTime}` per tenure, `0` for open |
| `eraCount() -> uint256` | number of eras |
| `eraAt(uint256 index) -> Era` | one era; **reverts outside `0..eraCount-1`** |
| `currentEra() -> Era` | the last era |
| `ownersEver(uint256 index) -> address` | per-index getter on the public array |
| `lastSyncedBlock() -> uint256` | `currentEra().startBlock` — the block of the last *observed rotation*, not of the last call |
| `count() -> uint256` | `ownersEver.length` |

### Why there is no "current or past" convenience

A function answering `isOwner(who) || isOwnerAt(who, blockNumber)` was written and removed. It is recorded
here as a **rejected API**, so nobody adds it back.

It is wrong in the direction that matters. A present owner who joined in era 2 satisfies a query about a
block in era 1, so a check built on it cannot establish point-in-time membership at all — the exact hole
this module exists to close. "Was this signer an owner when they signed" is a question about a block, and
a disjunction with the present answers a different and weaker question while looking like an answer.

It is also unnecessary. `isOwnerAt(signer, block.number)` is how a caller asks "owner now", and it routes
to the Safe's live `isOwner` instead of to stored history. One entry point, two questions, distinguished
by the argument.

The live branch exists for staleness: a module whose guard was removed, or whose `sync` never ran, must
not claim an address is an owner now, and the present is the one place a better source than its own
storage exists. The module can be wrong about the past; it should not compound that by being wrong about
the present.

Reads never revert on an address it has not seen, a block it never covered, or a timestamp before the
history. Indexed reads (`eraAt`) revert out of range — they are enumeration, not query.

## Blocks and timestamps

Both axes are recorded, from the same observation, and they are not interchangeable.

- **The block number is authoritative for on-chain checks**, because `block.timestamp` is coarse — one
  value per block, and a proposer can shift it within a small window — so a boundary expressed in seconds
  is only as sharp as the block it came from.
- **A timestamp is what an artifact carries.** A content item's `createdAt` is a unix second and nothing
  else, so `wasOwnerAt` exists and will be the call most readers actually make.

**Same-second ambiguity, stated rather than smoothed over:** two rotations in one second, or a signature
and a rotation in the same second, cannot be ordered by the timestamp axis. Half-open makes the boundary
instant belong to the new set, which is the best available answer and is not an ordering. A reader that
needs certainty uses a block number; a reader holding only a timestamp gets a decision, not a proof.

## `sync()`

```solidity
function sync() external
```

Permissionless, and it takes no arguments deliberately — nothing can tell it what to record.

It reads `ISafe(safe).getOwners()`, compares the set against `currentEra().owners`, and:

- unchanged → **writes nothing, emits nothing.** `sync` is idempotent in the strict sense: a second call
  in the same block is a no-op, and it costs only the reads.
- changed → close the current era at `block.number` / `block.timestamp`, open a new one after it, write
  the `end` of each removed address's open tenure pair, push a pair for each added address, push any
  address not in `seen` onto `ownersEver` and set its flag, emit
  `OwnersSynced(uint256 indexed era, address[] owners, uint256 blockNumber)`.

There is no auth to get wrong because the outcome is a pure function of chain state. Anyone may call it,
at any time, and the same call at the same block produces the same history. It is also **the repair
path**: a rotation the guard missed — a guard installed late, a guard transaction that ran out of gas, a
`sync` that reverted — is recorded by the next call, and `SyncFailed` from the guard is the signal to make
it.

`sync` reverts rather than record a lie: if `getOwners()` fails, or `safe` has no code, the call reverts
and no era is opened. That is why the guard must swallow the failure and emit instead.

**Observation granularity is the transaction, not the call.** `sync` runs once, in `checkAfterExecution`.
An owner added and removed inside one Safe transaction leaves the set unchanged and is never recorded —
correctly, since no interval had it — and a set that transiently contained one address twice is
invisible for the same reason.

## Completeness — the one thing that can be wrong

The history is complete **while a guard is installed, from the moment it is installed.** Nothing earlier
is recoverable. Precisely:

- Owner changes before installation are **simply absent.** There is no era for them and no way to
  reconstruct one on-chain; the events exist and are readable off-chain, which is exactly the thing this
  design exists to avoid depending on.
- A `sync()` after an unobserved rotation stamps the boundary at **sync time**, not at rotation time. The
  previous owner's tenure then stretches to that later block, and anyone who stopped being an owner in
  between reads as one. The module cannot tell the difference: it sees two sets, not the transaction
  between them.
- The guard is what makes it accurate, and it is why removing the guard is a real change in guarantee,
  not a change in mechanism.
- A Safe that never installs the guard still gets a genesis era from `initialize` and whatever `sync`s
  happen. That is a weaker guarantee — best effort, at call time — and must be described as one wherever
  it is offered.

**One hole in the argument, and it is a 1.4.1 one.** `authorized` accepts `msg.sender == address(this)`,
and `execTransactionFromModule` executes a call with the Safe as `msg.sender`. So a module calling
`execTransactionFromModule(safe, 0, addOwnerWithThresholdCalldata, 0)` reaches owner management with no
guard hook anywhere in the path. It requires an enabled module that will make an arbitrary self-call on
demand, which none in this tree does — but the guard-plus-module design does not prove it away, and a
reader must not treat "the guard sees every rotation" as a theorem. The escape from a broken guard
([below](#the-guard)) is the same property read the other way: it is the one path that can also help.

## The guard

`OwnerHistoryGuard` is a separate, **non-upgradeable, storage-free** contract whose only job is to call
`sync` at the moment a Safe transaction finishes. Immutable: the module address, and the gas cap.

The reason it must be separate, tiny, and unremovable-by-nothing-but-the-Safe is a specific failure:

> A revert in `checkAfterExecution` reverts the Safe transaction. Removing a guard requires `setGuard`,
> which is `onlySelf`, which requires `execTransaction`, which the broken guard then reverts. **The brick
> is permanent.** (Strictly, an enabled module can bypass it — see the completeness hole — and nobody
> should plan a recovery on that.)

So the guard's rules are non-negotiable:

- **Never revert.** Nothing in `checkAfterExecution` may be able to fail the Safe's transaction.
- **`try/catch` — effectively a low-level call — around `sync`, with a constant gas bound** (300 000 in
  the target implementation, sized so a rotation of ~10 owners fits with room). A hostile or broken module
  must not be able to drain a Safe transaction's gas, and a broken module must not be able to revert it.
- On failure, **emit `SyncFailed(uint256 blockNumber)`** and continue. The rotation is then unrecorded
  until someone calls `sync()`; the event is the only on-chain notice that the history has a gap.
- `checkTransaction` returns its own selector and does nothing. `checkModuleTransaction` and
  `supportsInterface` exist for `BaseGuard` compatibility and do nothing either.

Two hazards the Safe itself does not close, both worth knowing when installing: `setGuard` in 1.4.1
checks neither that the guard has code nor that it is not the Safe, so installing a codeless or wrong
address bricks the Safe permanently on the next transaction. And the guard is not `onlySelf`-installed by
this package — it is installed by the Safe, so there is nothing here to authorise.

## What the gate does with it

`canRead` / `canPublish` today ask `isOwner(signer)` — the present only. The owner-history read replaces
the signer term with a question about a block:

```ts
const wasOwner = await read(ownerHistoryModule, ABI, 'isOwnerAt', [signer, blockOfTheArtifact])
return canPublish(publication, authorSafe) && wasOwner && hasDeal(genesis)
```

That is the single call, and there is no `isOwnerOrWasOwnerAt` to reach for: the present tense is
`isOwnerAt(signer, block.number)`, and the disjunction of the two is the bug
([above](#why-there-is-no-current-or-past-convenience)).

Two independent reads on two contracts, and **nothing on-chain links them**: `hasDeal` says a deal covers
this genesis, the owner-history read says this signer held the author Safe's keys at a block, and no
record binds the two together — the publication module does not store who signed anything, and this
module does not know a manuscript exists. A gate that needs both facts reads both and asserts each.

`blockOfTheArtifact` is the underspecified half of that call and belongs to the caller:

- for a chain fact — the offer, the deal, the transaction that wrote it — the block of that transaction
  is on-chain and is the right argument;
- for the author's signature, the only datum is the content item's `createdAt`, which the signer chose.
  `wasOwnerAt` will answer it, and it accepts a backdated claim. Where the block matters, pin it from the
  transaction that carried the artifact or do not read this module for it.

## Invariants

- **Append-only.** No function removes an era, a tenure, or an `ownersEver` entry. A closed era is never
  rewritten; the only mutation to a written tenure is the `end` of an open pair, once.
- **The boundary is post-state and half-open** — `[start, end)`, `end == 0` meaning open. Every read
  agrees with it, in blocks and in seconds.
- **Only the Safe installs and removes the module and the guard** (both `onlySelf` on the Safe). The
  module's own upgrade is `onlySafe`; the guard has no upgrade path at all. As on the drafts module, the
  empty-calldata upgrade is `upgradeTo` — OZ 4.9.6's `upgradeToAndCall(impl, "0x")` forces the
  delegatecall and reverts on a contract with no fallback.
- **`sync` has no auth because it needs none.** Its result is a function of chain state; a caller can
  neither skip a rotation nor invent one.
- **Reads never revert on unknown input** — unknown address, uncovered block, pre-history timestamp. Only
  indexed enumeration reverts.
- **The module cannot act on the Safe.** It reads `getOwners` and `isOwner`; it holds no module
  permission, no delegatecall, no owner rotation, no upgrade of the Safe.
- **History is complete only from guard installation** — [completeness](#completeness--the-one-thing-that-can-be-wrong),
  and the module does not claim otherwise anywhere.
- **One instance, one Safe, one chain.** The author Safe exists at one address on L1 and L2 with two
  independent owner lists; two chains are two histories and nothing reconciles them.

## What V1 does not do

- **No threshold history.** Only membership. A threshold change writes no era, and `isOwnerAt` says
  nothing about how many signatures were required. Recording it would mean a
  third axis — the value read in the same `sync`, per era, in its own append-only array — and it would be
  incomplete for the same reason membership is: no guard, no observation.
- **No per-owner metadata.** No labels, no ENS name, no `AddedOwner`-height, no removal reason. An
  address is in a set or it is not.
- **No revocations, no re-additions semantics beyond membership.** An address removed and re-added has
  two tenures and `ownersEver` keeps one entry; nothing distinguishes "returns" from "never left".
- **No off-chain indexer, no event replay, no backfill.** The events are emitted for readers; nothing
  consumes them to repair the contract's own state.
- **No reorg handling.** The log is whatever the chain said at the block the observe happened in. A
  reorged rotation leaves an era for something that did not happen; nothing detects or undoes it.
- **No signature history.** The module knows who was an owner, never who signed what. There is no
  `didSignAt` and there cannot be one here.
- **No factory.** One proxy per Safe, deployed directly; `NAME()` is the discovery string and is
  `"S2S Owner History Module V1"`.

## Open questions

1. **Package placement.** It sits in `src/author/contracts` because the author Safe is what a gate asks
   about today, but publication Safes have owners too and would want the same history. A shared contracts
   package is the alternative; nothing in the design is author-specific except the name.
2. **Threshold history.** Is membership enough for a gate, or does a signer count need the threshold too?
   The tap exists (`getThreshold()` is readable at the same moment), the completeness argument is
   identical, and the cost is one more axis. Undecided.
3. **The 1.5.0 module guard.** Safe 1.5.0 adds module guards (`setModuleGuard`, `checkModuleTransaction`),
   which would close the self-call hole in [completeness](#completeness--the-one-thing-that-can-be-wrong).
   Whether to require one on upgrade, and whether the same contract can serve both hook kinds, is open.
4. **A set that briefly holds one address twice.** `seen` keeps `ownersEver` deduped, and the set diff is a
   set diff, so the history survives it; whether 1.4.1 can produce such a state at all
   (`addOwnerWithThreshold` on an existing owner, `swapOwner` to the same address) is unverified here, and
   the tenure pairing assumes a set, not a multiset.
5. **Block or timestamp at the gate.** Pin the block from the transaction that carried the artifact, or
   accept the item's `createdAt` and its backdating risk? This is a gate question, not a module question,
   and it decides how useful `wasOwnerAt` is.

## Safe-to-change vs do-not-touch

- 🟢 the reads and the events; the guard's gas cap and its `SyncFailed` shape; a factory and a discovery
  index; new axes appended after `seen` (threshold, label) that reorder nothing; installing `sync` on
  further hooks as later Safe versions add them.
- 🔴 the declaration order (`safe`, `eras`, `tenureBlocks`, `tenureTimes`, `ownersEver`, `seen`) — never
  reorder, never insert; the `Era` and `Tenure` field order once an ABI has been generated and consumed;
  the `tenureBlocks`/`tenureTimes` index pairing; the interleaved pair encoding and `end == 0`; the
  boundary rule, **once a gate reads it** — changing it re-judges history that has already been judged;
  `initialize` opening `eras[0]` from `getOwners()` (a module installed on a Safe with no code has no
  genesis era and every read lies); the guard being storage-free and unable to revert; `NAME()`.

## Test seams

- Genesis: `initialize(safe)` opens one era with the Safe's current owners, `eraCount() == 1`,
  `endBlock == 0`, `count() == owners.length`; `initialize(address(0))` reverts; a Safe address with no
  code reverts.
- Idempotence: `sync()` with an unchanged set writes nothing — assert `eraCount`, `lastSyncedBlock` and
  the tenure arrays are untouched, and that no event is emitted.
- Observed rotation: install the guard, `addOwnerWithThreshold` through the Safe → guard's
  `checkAfterExecution` records it, `eraCount() == 2`, old era's `endBlock == block.number`, the removed
  owner's open pair closed with the same block, the added owner pushed with a new pair.
- Boundary, both directions: at block N, the outgoing owner reads `false` and the incoming owner `true`
  from `isOwnerAt`, and the same on the timestamp axis (`wasOwnerAt`, same-second). This is the test that
  encodes the semantic choice, so it must assert the block, not a range around it.
- Rejected disjunction, the regression test: an owner added in era 2 reads `false` from
  `isOwnerAt(who, b)` for a block `b` in era 1, while `isOwnerAt(who, block.number)` reads `true`. A
  later joiner must never satisfy a query about an earlier block.
- Removal then re-addition: two tenures, one `ownersEver` entry, `tenuresOf` ordered, and the second pair
  is the open one.
- Pre-history: a block before `eras[0].startBlock` reads `false` from every membership call, without
  reverting.
- Unobserved rotation: remove the guard, rotate, `sync()` — the boundary is the sync block, and the
  previous owner reads as an owner for the stretched interval. Assert the wrongness explicitly; it is the
  documented guarantee, not a bug to be fixed later.
- Stale era, live read: `isOwnerAt(who, block.number)` returns the live `isOwner` answer even when the
  era's array disagrees; with `safe` set to something that fails the staticcall, it falls back to era
  membership and does not revert. A block earlier than `block.number` still answers from the tenures.
- Guard resilience: a `safe` whose `getOwners()` reverts, or a module that consumes all forwarded gas,
  still lets the Safe transaction succeed — `SyncFailed` emitted, `sync()` afterwards is the repair.
- Guard install hazards, asserted as documentation-in-code: `execTransaction` with a codeless guard
  address reverts, and `setGuard` accepts it anyway.
- `eraAt(eraCount())` and `eraAt(type(uint256).max)` revert; `eraAt(0)` is the genesis era.
