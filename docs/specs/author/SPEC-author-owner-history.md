# SPEC-author-owner-history — who was an owner, and when

> **Parent:** [`SPEC-author.md`](SPEC-author.md)
> **Siblings:** [`SPEC-author-identity.md`](SPEC-author-identity.md),
> [`SPEC-author-drafts.md`](SPEC-author-drafts.md)
> **Type:** branch — a part of the author side, not a domain in its own right.
> **Status:** built. `OwnerHistoryModuleV1`, `OwnerHistoryModuleV1Factory` and
> `OwnerHistoryGuard` are in `src/author/contracts/src`, with `test/OwnerHistory.test.ts`,
> `test/MockSafe.t.sol` and 40 passing tests in the package;
> `scripts/deploy-owner-history.ts` is the deploy path and `src/author/contracts/README.md`
> carries the guard's gas-headroom rule. The ABI under `generated/abis/` is the frozen
> surface: a signature change there is a breaking change for every gate and reader. Nothing
> is deployed.

## Responsibility

Two contracts, one job: after a piece of content is read, answer **“was this address an
owner of the author Safe at the block (or time) that content was signed?”** — and keep
the raw history that answer is computed from, so a reader can check it rather than trust
it.

- `OwnerHistoryModuleV1` (UUPS; one proxy per author Safe, made by
  `OwnerHistoryModuleV1Factory`). It mirrors the Safe's owner set and records a new *era*
  every time that set changes. It is the store and the read surface.
- `OwnerHistoryGuard` (non-upgradeable, storage-free, ERC-165-answering, installed with
  `setGuard`). It is a **best-effort** tap that calls the module's `sync()` inside the Safe's
  own transaction, so the era boundary is the rotation's block and not a later one. It is the
  only thing in this design that can be skipped, and the spec says exactly how often and how
  visibly.

Neither contract gates anything on its own. `canPublish` stays in
[`SPEC-gates.md`](../gates/SPEC-gates.md); this package supplies one more read a gate may
compose with. The gap this closes is stated in
[`SPEC-author-identity.md`](SPEC-author-identity.md): “the signer must be an owner of the
author Safe” is present tense, and content outlives the key that signed it.

## Does the Safe offer a hook on owner rotation?

This is the question the design turns on, and the answer is **no**, for Safe v1.4.1:

- `addOwner`, `removeOwner`, `swapOwner`, `changeThreshold`, `setGuard`, `enableModule` and
  the rest are `onlySelf`. They execute as `execTransaction(self, 0, data, …)`, so they
  arrive in the Safe as an ordinary self-call.
- Those functions emit `AddedOwner` / `RemovedOwner` / `ChangedThreshold` / … and stop
  there. **There is no callback, no hook contract and no post-change notify** for an owner
  mutation, and a module gets no notification in 1.4.1 either.
- `execTransaction` reads `guard` **once** into a local at the top
  (`address guard = getGuard();`), calls `guard.checkTransaction(...)` before executing, and
  calls `guard.checkAfterExecution(txHash, success)` after. That read is the Safe's own:
  `getGuard()` is **`internal` in 1.4.1**, with no public getter (bytecode size), so a reader
  cannot ask a Safe for its guard — the address is only recoverable with
  `getStorageAt(0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8, 1)` (the
  guard-manager slot, one word, low 20 bytes) or `eth_getStorageAt`, and nothing in this
  package pretends to query it. Because the read is once, a transaction that replaces the
  guard is still checked by the *old* guard, and a guard installed by transaction *N* is not
  consulted for transaction *N*.
- The only on-chain place a rotation can be observed inside the same transaction is
  therefore a guard, and specifically `checkAfterExecution` — the one call that runs after
  the mutation has landed.

The evidence for the above is a mock written to that description (`test/MockSafe.t.sol`), not a
run against the canonical singleton: there is no Safe dependency and no fork test. Treat it as
a claim to re-verify against Safe 1.5.x, and see *Test seams* for what that costs.

## The install

Two Safe transactions, because the guard is deployed against the module proxy's address:

1. `createModule(safe)` → the proxy address, then deploy `OwnerHistoryGuard(safe, proxy)`.
2. `enableModule(proxy)` and `setGuard(guard)` in one batch.

`enableModule` is not needed for the module to work — the guard calls it and `sync()` is
permissionless — but it is the only on-chain proof that *this Safe* adopted *this* module.

The batch has one precondition that is easy to miss and fatal to skip: `setGuard` is
`authorized` — a self-call, the Safe's own `execTransaction` or an enabled module's
`execTransactionFromModule` — and validates ERC-165 before it stores the address:
`require(Guard(guard).supportsInterface(type(Guard).interfaceId), "GS300")`. A contract that
does not answer the guard interface id (`0xe6d7a83a`) cannot be installed at all: the
transaction reverts `GS300` and the previous guard stays. `OwnerHistoryGuard.supportsInterface`
answers `0xe6d7a83a` and `0x01ffc9a7`, so the batch lands.

Nothing else in the install is required: there is no registry to join and no name to claim,
the proxy answers only to the Safe, and the factory is a deployer with an index.

A rotation proposed by this project's tooling carries its own `sync()` in the batch; the guard
is the safety net for rotations that arrive through other clients — the Safe app, a hardware
wallet, a script. Either way a proposal built with the Safe's own `eth_estimateGas` can come
back self-consistent with “no sync”; see *The guard*.

## Storage

Deployment is UUPS, so storage is append-only forever; the order below is the order in the
implementation and is not rearranged by any later version.

```solidity
address public safe;                                  // slot 0: the one Safe this proxy mirrors
Era[] private eras;                                   // slot 1: every distinct owner set, in order
mapping(address => Tenure[]) private tenureBlocks;    // slot 2: per address, block-axis spells
mapping(address => Tenure[]) private tenureTimes;     // slot 3: per address, time-axis spells
address[] private ownersEverSet;                      // slot 4: one entry per address ever seen
mapping(address => bool) private seen;                // slot 5: the dedupe behind slot 4
```

```solidity
struct Era {
    uint64 startBlock;
    uint64 endBlock;      // 0 = still current
    uint64 startTime;
    uint64 endTime;       // 0 = still current
    address[] owners;     // the whole set, not a diff
}

struct Tenure {
    uint64 start;
    uint64 end;           // 0 = open
}
```

Four `uint64`s are 32 bytes, so an era's fixed fields are one slot and the set is one more;
a `Tenure` is 16 bytes packed into one slot, so a spell costs one `SLOAD` and a scan of
`k` spells costs `k`. The narrowing cast `uint64(block.number)` truncates silently — harmless
in practice (2^64 is ~1.8 × 10^19, and both axes are eight orders of magnitude below it
today), but it is a cast, so any code that ever reads these numbers must widen rather than
assume.

`eras` is private and enumerable only through `eraAt(index)` / `eraCount()`; `tenure*` is
private and reachable only through `tenuresOf(who)`. `ownersEverSet` is private with the
read `ownersEver()` — an array and a no-argument function cannot share a name, so the state
variable carries the `Set` suffix and the ABI carries the clean one.

🔴 **Upgrade contract.** `Era.startBlock` / `endBlock` are `uint64` on disk. A future
version that wants wider numbers needs a *new* struct and a migration, not an edit to this
one; and `Era.owners` is a dynamic array inside an array — reordering or rewriting an era
already written is not something any version may do. Eras are append-only, and only the last
one is ever modified (to close it).

## The era model, and the boundary

An **era** is one distinct owner set and the interval it was in force. Eras are numbered
from 0, in order, and never change once a later era exists.

- Era 0 is written by `initialize(address _safe)` from `getOwners()`, at the block the proxy
  was created. It refuses `address(0)` (`ZeroAddress`), a `safe` that cannot answer
  `getOwners()` (`SafeCallFailed`, i.e. no code or no such function) and an owner-less Safe
  (`ZeroOwners`) — an empty era 0 would mean nobody ever held a tenure and the whole history
  would be silently useless. Pointing at a contract that merely looks like a Safe fails here,
  at deploy time, rather than on the first `sync()` behind the guard's catch.
- Every later era is written by `sync()`, which closes the previous era at the current block
  and opens the next one in the same transaction.
- An interval is **half-open**: `[startBlock, endBlock)`. The end block belongs to the era
  that follows, so **the boundary block belongs to the new set**. A remove in block `N`
  means the address is not an owner at `N`, though it was at `N-1`. This is the same
  convention as the rest of the author specs and it is what makes a rotation win a tie.
- `endBlock == 0` / `endTime == 0` means *current*. Zero is safe as a sentinel because no
  era can end in genesis.
- A reordered set is not a new era: `sync()` compares sets order-insensitively, so a
  `getOwners()` that returns the same owners in a different order changes nothing. `Era.owners`
  keeps whatever order the Safe reported, so two eras may show the same set in different
  orders.
- A swap is one era, not two. `sync()` diffs against the last era's set, so `swapOwner`
  produces a single new era with the old owner removed and the new one added.

`eraAt(index)` returns an **empty era** (`0, 0, 0, 0, []`) for any index at or past
`eraCount()`, and `currentEra()` returns the same when a proxy was never initialised: no
read in this contract reverts, so a reader can walk indices until it sees an empty era
instead of pre-checking `eraCount()`. Callers that want to tell “no such era” from “era with
zeroed fields” must compare index against `eraCount()`; there is no other signal.

## Reads

All of these are `view` and none of them revert for any input, including an unknown address
and an out-of-range index.

| ABI | Answers |
|---|---|
| `safe() → address` | the Safe this proxy mirrors; the module's only link to it |
| `NAME() → string` | `"S2S Owner History Module V1"` (pure; not a trust signal — see *What the gate does with it*) |
| `isOwner(address) → bool` | **live**: staticcalls the Safe's `isOwner`, `false` if the call fails or returns fewer than 32 bytes, and compares the raw word to `1` rather than `abi.decode(…, (bool))` — decoding reverts on a word that is neither 0 nor 1, and the Safe must not be able to make this read revert |
| `isOwnerAt(address,uint256 blockNumber) → bool` | `blockNumber >= block.number` → the live `isOwner` answer. Otherwise the tenure scan below |
| `wasOwnerAt(address,uint256 timestamp) → bool` | same, on the timestamp axis (`timestamp >= block.timestamp` → live) |
| `tenuresOf(address) → (Tenure[] blocks, Tenure[] times)` | every spell, index-paired; empty for an unknown address. `end == 0` on the last pair means “open” |
| `eraCount() → uint256` | number of eras; `>= 1` once initialised |
| `eraAt(uint256) → Era` | the era, or an empty era |
| `currentEra() → Era` | the last era, or an empty era |
| `ownersEver() → address[]` | every address that has ever been in a set, in first-seen order, deduplicated |
| `count() → uint256` | `ownersEverSet.length`; the O(1) form of the above |
| `lastSyncedBlock() → uint256` | `currentEra().startBlock`, i.e. the block of the last **observed change**, not the last call; 0 on an uninitialised proxy |

The tenure scan for a past block is: walk `tenureBlocks[who]` and answer `true` on the first
pair with `start <= blockNumber && (end == 0 || blockNumber < end)`. There is **no**
fallback to era membership when `who` has no tenure — an address that never held a key is
`false` at every block, and an address that holds one today is `false` at a block before it
joined. The two axes are stored, not derived: `tenureTimes` is written from
`block.timestamp` at the same moment as `tenureBlocks`, so a late sync puts both boundaries
at sync time.

Three consequences the caller has to hold:

- **Neither axis is pinned by this contract.** A gate decides which axis a piece of content
  claims; the module answers both and endorses neither. Timestamps are cheaper to compare
  and are attacker-friendlier (see *Blocks and timestamps*).
- **`currentEra()` may lag one sync while `isOwnerAt` is live.** If the guard's hook missed,
  `currentEra().owners` is stale until someone calls `sync()`, but any query at or past
  `block.number` is answered by the Safe and is already correct. A reader that wants one
  consistent view must say which it wants: the recorded history (`eraAt` / `currentEra`) or
  the truth about now (`isOwner` / `isOwnerAt`).
- **A head query is not reproducible.** `isOwnerAt(who, N)` with `N >= block.number` is the
  live answer; the same query asked after block `N` takes the stored-history path and can
  disagree with it if a sync was missed. A gate that will re-check the same `(who, N)` later
  must use `N < block.number` — one block of waiting — or record the answer beside the block
  it was taken at.

### Why there is no “current or past” convenience

`isOwner(who) || isOwnerAt(who, b)` was considered as a single call and is **rejected**. It
answers a question nobody should ask: an owner who joined in era 2 would pass a query about
a block in era 1 — the exact substitution this module exists to prevent. `isOwnerAt` already
answers the present tense (`isOwnerAt(who, block.number)` is the live answer), so the
convenience adds a footgun and no capability. No such function exists in the ABI, and none
may be added.

## Blocks and timestamps

Both axes are recorded and they are not interchangeable.

- A block number is **unambiguous and ordered**; what it cannot do is match a timestamp that
  content asserts.
- A timestamp is what off-chain content carries and it is **ambiguous**: `block.timestamp` has
  one-second resolution, so N transactions in one second share a value and a rotation and an
  artifact signed in the same second cannot be ordered at all. `wasOwnerAt` answers `true` for
  such a pair regardless of which came first.
- The gate prefers blocks where it has a choice, and only falls back to the time axis when the
  claim it is checking is itself a timestamp.

## `sync()`

```solidity
function sync() external returns (bool)
```

Permissionless — no `onlySafe`, no role, callable by any address in any block. It reads the
Safe's `getOwners()`, compares the set against the last era order-insensitively, and:

- **unchanged** → writes nothing, emits nothing, returns `false`. This is why it is safe to
  call at any time, and why `lastSyncedBlock()` is the last *change* and not the last call.
- **changed** → in one transaction: close the last era (`EraClosed`), close the tenure of
  every removed address (`OwnerRemoved` per address), open the new era (`EraOpened`), open a
  tenure for every added address (`OwnerAdded` per address), append newly seen addresses to
  `ownersEver()`. Returns `true`.

Its reverts are `SafeCallFailed` — `getOwners()` failed, or answered with nothing (a proxy
with no `era 0`, i.e. never initialised, or `safe == address(0)`) — and `ZeroOwners` when the
Safe answers with an empty set. It never records a set it could not read: an empty read would
silently close every tenure and open an empty era, so failure is a revert and the caller
retries. A `safe` that answers with malformed returndata can also fail inside the ABI decoder;
that is the Safe's fault and not a supported state.

Closing is idempotent: a tenure already closed is skipped, not asserted. That is what lets a
repair after a missed rotation walk the same address twice without corrupting the pair.

`sync()` is also **the repair path** for a missed hook, and the honest statement of its cost
is in the next section but one: it stamps the boundary at the block it runs in, not at the
block the Safe actually rotated in.

## Events, and upgrading

| Event | Emitted by | Fields |
|---|---|---|
| `EraOpened(uint256 indexed eraIndex, uint64 startBlock, uint64 startTime, address[] owners)` | `initialize`, `sync` | the new era, in full |
| `EraClosed(uint256 indexed eraIndex, uint64 endBlock, uint64 endTime)` | `sync` | the era just ended |
| `OwnerAdded(address indexed owner, uint256 eraIndex)` | `initialize`, `sync` | the era the address entered in |
| `OwnerRemoved(address indexed owner, uint256 eraIndex)` | `sync` | the era the address left in (the one the rotation produced) |
| `ContractUpgraded(address indexed implementation)` | `upgradeTo` / `upgradeToAndCall` | the module's own, so a reader is not left with the proxy's |

Log order within a `sync` transaction is `EraClosed`, `OwnerRemoved`…, `EraOpened`,
`OwnerAdded`… — an indexer may rely on it. `initialize` emits `OwnerAdded` for every founding
owner with `eraIndex = 0`.

The proxy also emits OpenZeppelin's `Upgraded`, `AdminChanged`, `BeaconUpgraded` and
`Initialized` (they are in the ABI because the ABI is the implementation's). Assert the
module's own `ContractUpgraded` when a listener cares about a deliberate version change.

Upgrades are UUPS with `_authorizeUpgrade` gated on `msg.sender == safe` — the Safe proposes
its own module upgrade, exactly as it proposes everything else, and no other address can.
Use `upgradeTo(impl)` for an empty-calldata upgrade: on the OZ version this package pins,
`upgradeToAndCall(impl, "0x")` forces the delegatecall and this implementation has no
fallback, so it reverts.

## Completeness — the one thing that can be wrong

The module is a mirror, and a mirror is only as good as the last time it looked. Everything
below is a documented limit, not a defect, and every one of them is **visible on chain**.

1. **Before installation there is nothing.** Eras start at `initialize`. Owner changes made
   before the module existed are absent, and `isOwnerAt(who, b)` for a block before era 0
   answers `false` for everyone — including people who were owners. The honest reading of
   `false` is “not known to have been an owner”, not “was not one”.
2. **A missed rotation stretches a tenure.** `sync()` records the boundary at the block it
   runs in. If a rotation happened at block `N` and the repair runs at `M > N`, the era
   boundary is `M`: the removed owner keeps a `true` answer for `[N, M)` and the added owner
   gets a `false` answer for `[N, M)`. That gap is the cost, and it is why the guard exists.
   An address that left and rejoined entirely inside one gap keeps a single unbroken tenure.
3. **A Safe with no guard has only what `sync()` happened to observe.** The design is
   correct without the guard; it is merely lossy. The visible form is `lastSyncedBlock()`
   lagging the Safe's real history — `isOwner` disagreeing with `currentEra().owners`.
4. **The guard can be starved**, by the default proposal path (measured in *The guard*) or
   by design on a large era: `sync()` costs `≈ 239k + 33.5k × owners`, the guard forwards a
   fixed budget, and past that ceiling the hook misses every time until the set shrinks.
   This is indistinguishable from (2) except that it leaves `SyncFailed(blockNumber)` in the
   very transaction that missed — the only on-chain signal that the history has a hole, and
   it names the block.
5. **A missed sync is not a lost sync.** Any address may call `sync()` at any time. Nothing
   in this package schedules it, so a deployment that wants gaps closed promptly needs an
   off-chain caller; the spec says so rather than pretending the guard is sufficient.

Two things can put an era on chain that the guard did not intend, and both are Safe 1.4.1
properties rather than defects here:

- **`execTransactionFromModule` with owner calldata.** `msg.sender == address(this)` inside
  the Safe, which is what `onlySelf` checks, so an enabled module can execute
  `addOwner`/`removeOwner`/`swapOwner` with **no** `checkTransaction` / `checkAfterExecution`
  around it. This is why the spec never claims that no owner mutation can bypass the guard. It
  is also the only path that can reverse a bricked guard.
- **The guard itself.** The module never checks who called `sync()`, so a module can call it
  mid-MultiSend and write an era the batch then changes again. The next `sync()` records the
  real set; eras written this way are narrow, not wrong.

## The guard

`OwnerHistoryGuard` is deliberately the smallest possible thing: no storage beyond two
immutables (`safe`, `module`), no owner set, not upgradeable, `checkTransaction` an empty
body. It exists only because `checkAfterExecution` is the one call Safe 1.4.1 makes after a
mutation has landed, and only as a **safety net**: a rotation our tooling proposes carries its
own `sync()`, and the guard is what covers the ones it does not build.

**Why it is separate from the module.** A guard is called from inside `execTransaction`;
anything it reverts takes the Safe's transaction with it. And `setGuard` is itself a
self-call (`authorized` — normally an `execTransaction`). A guard that reverts on its own bug
therefore blocks the only transaction that could remove it: **a permanent brick of the author
Safe**, with no recovery but the module hole above. That single fact dictates the shape:

- it answers ERC-165 (`supportsInterface` for `0xe6d7a83a` and `0x01ffc9a7`) because
  `setGuard` refuses anything else with `GS300` — a guard that does not answer the interface id
  cannot be installed at all; the function is `pure` and reads nothing, so it adds no way to
  revert.
- the call to the module is a **low-level `call` with a gas cap**, never
  `try IOwnerHistory(module).sync{gas: …}() returns (bool)`. A `returns (bool)` decode of a
  callee that succeeds with empty returndata — a proxy whose implementation slot was never
  written, say — reverts in the *guard's* frame, outside any `catch`. That is the brick, and
  it is why nothing here decodes returndata.
- the result is not decoded: `ok` and the returndata **length** are the only things read from
  the call, and `ok == false` is a miss, not a revert.
- a sender other than `safe` is ignored (the Safe is the only legitimate caller).
- nothing is called on the module before the call — only `code.length` is read — so a
  module that answers badly cannot make the guard revert.
- the gas budget is a constant (`SYNC_GAS = 600_000`) with `SYNC_RESERVE = 20_000` kept back
  — ~17,050 of it actually survives the cold `code.length` read and the call's encoding — so
  the call and the Safe's own return path cannot starve the transaction.

**Four ways the hook is skipped, and all four are announced.** A miss is one of: less than
`SYNC_RESERVE` gas left before the call (the Safe's transaction needs the gas, not the hook);
`module.code.length == 0` (the deploy typo that `module` being immutable makes permanent, so
it is reported and not called); the call failed (`ok == false` — a revert or an out-of-gas
module); or the call succeeded and returned **no data** — a proxy whose implementation slot
was never written. That last one is caught by the returndata *length* and nothing else:
decoding a `bool` return there reverts in the guard's own frame, outside any catch, which is
the permanent brick. “Simplifying” it back to `try … returns (bool)` rebuilds the brick.

**What it does not guarantee.** It is best-effort, and on the default path it is measurably
lossy: `eth_estimateGas` for a `+1` rotation on a 2-owner era returns `381_972`, which leaves
`gasUsed 360_857` and **no sync**; the same transaction with a `1_200_000` limit spends
`381_972` and opens the era. The estimate is self-consistent with “no sync” — the simulation
itself is allowed to skip the hook — hence the operating rule, which is part of the install
and not a detail:

> A rotation this project proposes includes an explicit `sync()` in the batch. For any other
> rotation — the Safe app, a hardware wallet, a script — allow at least `SYNC_GAS + 40_000`
> (≈ 640k on a small era) and check afterwards that `SyncFailed` was not emitted.

Measured `sync()` cost for **one owner added**, by era size:

| era size | 2 | 3 | 4 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|
| gas | 305,895 | 337,617 | 369,688 | 569,421 | 603,928 | 638,784 |

which fits `≈ 239k + 33.5k × owner`. The ceiling is the number that matters: **an era of 10
gaining one owner fits under `SYNC_GAS`, an era of 11 does not**, so past that every rotation
misses until the set shrinks. At 13 owners a swap is 667,377 and a removal 492,947 — a swap is
not the expensive case it looks like; the set size is. A no-op `sync()` is the common case,
because the guard runs on **every** transaction the Safe executes: 28,784 at 2 owners, 96,991
at 13, i.e. about 6.2k more per owner, paid on every proposal, deal and upgrade.

**What it does guarantee**, and what makes the loss acceptable:

- it never reverts the Safe (low-level call, no returndata decode, empty `checkTransaction`);
- a miss is never silent: all four paths emit `SyncFailed(uint256 blockNumber)` in the
  transaction that missed, and `lastSyncedBlock()` stays behind the Safe's real state;
- the fix is always available and always permissionless: `sync()`.

**Sharp edges, stated not hidden:**

- A module installed on the Safe can call `setGuard(address(0))` through
  `execTransactionFromModule` and remove the guard unilaterally; the same hole can call it
  back. Guard presence is a policy of the Safe's owners, not a property this contract can
  enforce.
- A module can call `sync()` mid-MultiSend, writing a narrow era (see hole 2 above).
- The ABI decoder in front of `checkTransaction` is not literally revert-proof: the `uint8`
  operation is range-checked, and a value-bearing call cannot be routed to a non-payable
  receiver. A genuine Safe never sends either — a policy guard that is safe for a real Safe
  is the standard here, and it is not the same as a guard that is safe for arbitrary callers.

## What the gate does with it

This package supplies the read; using it is a change to the gates package, described below.

```ts
// `history` is pinned out of band (config), never resolved by a name or a factory index.
const history = ownerHistoryFor(authorSafe)

const wasOwner = await read(history, HISTORY_ABI, 'isOwnerAt', [signer, blockOfTheArtifact])
return (
  (await read(publicationModule, CAN_PUBLISH_ABI, 'canPublish', [authorSafe])) &&
  wasOwner &&
  (await read(genesis, HAS_DEAL_ABI, 'hasDeal', [genesis]))
)
```

`isOwnerAt(signer, blockOfTheArtifact)` is *the* call. `isOwnerAt(signer, block.number)`
is “is an owner now” — the same function, answered live — and is not what a gate wants for
content older than the current block. The three reads are independent: none feeds another.

One consequence the gate cannot dodge: `canPublish()` in `src/shared/src/gates` reads
`isOwner` **live** as its second half, so a historical check has to *replace* that half, not
sit beside it — otherwise a signer who has since been removed fails the live read and the
module buys nothing. That is the sketch above (`canPublish` split back into its publication
half), and it is a change to the gates package, not to this one. Until it lands, this package
is the store and the read; it is not yet a retrofit for old content.

**The trust anchor is the gate's job, not the module's.** `createModule` is permissionless:
anyone can create a history proxy *claiming* any Safe, and `NAME()` (“S2S Owner History
Module V1”) is a string anyone can copy. `history.safe()` alone therefore proves only that
whoever made the proxy named that Safe. The rules:

1. The gate must use an address supplied out of band (config / a registry the caller
   already trusts) and check `history.safe() == theSafeYouAlreadyTrust`. Never resolve a
   history module from a name, an event, or a factory index (`getModulesForSafe` is an index,
   not proof).
2. Where the install was made with `enableModule` (as above), `authorSafe.isModuleEnabled(history)`
   is the stronger check: only the Safe can set it, and the gate already reads the Safe in
   the same call. Prefer it when it is available.
3. Whichever is checked, a failed comparison is `false` for the gate, never a fallback to a
   live `isOwner`.

## Invariants

- **INV-1** Every write to `eras` is an append, or a one-time close of the last era. Written
  eras never change.
- **INV-2** Era intervals are half-open and contiguous: `eras[i].endBlock ==
  eras[i+1].startBlock`, and the last era is open (`endBlock == 0`).
- **INV-3** `Era.owners` for era `i` is the Safe's owner set **as observed at
  `eras[i].startBlock`** — inside the rotation's own transaction when the guard was not
  skipped, at the sync block otherwise. Never a set from between boundaries.
- **INV-4** `ownersEver()` is deduplicated and only grows; `count()` is its length.
- **INV-5** Tenures are index-paired across the two axes: `tenureBlocks[who][i]` and
  `tenureTimes[who][i]` describe the same spell, and at most one of an address's spells is
  open.
- **INV-6** No read reverts: not on an unknown address, not on an out-of-range era index, not
  on a Safe that answers with a non-boolean word, not on a `safe` with no code. (The one
  exception is gas: `isOwner`/`wasOwnerAt` staticcall the Safe unbounded, so a `safe` that
  burns everything forwarded can starve the read — the Safe is the trusted input, not the
  adversarial one.)
- **INV-7** For `b < block.number`, `isOwnerAt(who, b)` depends only on stored history; for
  `b >= block.number` it is the Safe's live answer. The post-state guarantee therefore holds
  only *below* the head: inside the rotation's own block the answer depends on how far the
  transaction has got, and a missed sync makes the same `(who, b)` answer differently before
  and after `b` becomes past.
- **INV-8** `sync()` writes nothing and returns `false` when the set has not changed.

## What V1 does not do

- **Threshold history.** Who could have signed, at a given block, is not recorded. The set
  is: an owner who was in the set could sign. If a gate ever needs “this needed 2 of these
  3”, that is a different store — `ThresholdEra[]` with the same half-open convention, written
  by the same `sync()` (the guard's hook already runs once per transaction, so it would cost
  one more `getThreshold()` read and one more era array).
- **Metadata** about owners: no labels, no ENS, no roles, no “this owner is a person”. The
  module records addresses and nothing about them.
- **Revocation, or any statement about content.** It answers a question about a key; what
  that means for a manifest is the gates' and the agreements' business.
- **An indexer.** `eraAt` is enumerated by a caller walking indices; a query like “which eras
  contained address X” is a scan over eras (or over that address's tenures, which is the
  cheap direction and the one the ABI offers).
- **Reorg handling.** Chain reorganisation is the chain's business; eras are written at real
  blocks and a reorg rewrites them the way it rewrites everything.
- **A back-fill.** Nothing recovers pre-installation history, and nothing pretends to.

## Open questions

1. **The gate's shape.** `canPublish` embeds the live `isOwner` read, so using this module
   needs a gate form that takes a block (`canPublishAt(…, block)`, or `canPublish` split into
   publication-admission plus a signer check the caller supplies). Which of those lands, and
   in which package, is unsettled — and it decides whether old content is actually covered.
2. **Which package owns the read helper?** `@s2s/author-contracts` owns the ABI and the
   deploy script; whether the TS read helper lives in the gates package or beside the ABI is
   unsettled. Whoever owns it owns the trust-anchor rule above, which argues for the gates.
3. **Threshold history** (above): wanted, out of scope, and the only addition that changes
   what a gate can assert rather than how finely it can date it.
4. **Safe 1.5.0 and module guards.** If a later Safe notifies modules on owner change, the
   guard — and its whole gas-budget problem — disappears. Re-check before building anything
   else on the guard hook.
5. **Duplicate address in a set.** A Safe cannot hold one, so this is defensive: `sync()`
   tolerates it (sets are compared order-insensitively and `seen` dedupes) but the stored
   era would then contain it. Left as is.
6. **Make the proposer ship `sync()`.** The package README already says the primary path for
   our own rotations is an explicit `sync()` in the batch, with the guard as the safety net;
   nothing in the tooling does it yet, and a rotation made through the Safe app cannot. Whether
   the answer for app-made rotations is padded gas, a `SyncFailed` monitor, or both is open.
7. **A minimum-gas floor instead of a reserve.** Considered and rejected: a `gasleft()`
   assertion in `checkAfterExecution` is exactly the revert that bricks the Safe, and a
   floor that only *reports* (`SyncFailed` when below `N`) is what the reserve-check already
   does. The reserve is a subtraction; a floor is a predicate on somebody else's gas.

## Safe-to-change vs do-not-touch

🟢 **Safe to change**

- `NAME()`'s string, and anything else cosmetic in the metadata surface.
- `SYNC_GAS` / `SYNC_RESERVE`, upwards. Lowering them trades a gas bill for a higher miss
  rate and needs the measured numbers re-taken.
- The factory's `getModulesForSafe` index shape; the deploy script; the TS read helper's
  location.

🔴 **Do not touch**

- **The storage layout and struct shapes.** UUPS, deployed proxies, `uint64` fields.
- **Half-open intervals and the boundary rule.** Every consumer's correctness is built on
  “the boundary block belongs to the new set”; flipping it silently makes historical answers
  wrong by one block, and there is no way to detect that from outside.
- **`isOwnerAt`'s two branches.** Removing the live branch breaks “present tense through the
  same function”; removing the tenure branch makes the whole module pointless.
- **The guard's low-level call, no-returndata-decode, and reserved gas.** This is the
  difference between a best-effort hook and a bricked Safe.
- **Permissionless `sync()`.** Any gate on it makes the repair path unreachable exactly when
  it is needed.
- **`_authorizeUpgrade` gated on `msg.sender == safe`.**

## Test seams

36 tests pass in `src/author/contracts` — 22 in `test/OwnerHistory.test.ts` (below) and 14 in
`test/DraftsModuleV1.test.ts`, which belong to [`SPEC-author-drafts.md`](SPEC-author-drafts.md).

| Test | Pins |
|---|---|
| `initialize writes era 0 from the Safe and isOwner mirrors the Safe live` | era 0 at the proxy block, `NAME()`, `safe()`, `ownersEver()`, `count()`, `lastSyncedBlock()`, nothing before era 0 |
| `a rotation through the guard hook opens era 1 and closes era 0` | the hook runs inside the Safe's transaction; `EraClosed`/`OwnerAdded` fields |
| `eras are half-open: the boundary block belongs to the new set, not the old` | INV-2, tenures carved at the boundary, re-add keeps one `ownersEver` entry and gains a second spell |
| `swapOwner keeps the count and records one era, not two` | order-insensitive diff |
| `an owner who joined in a later era is not an owner at an earlier block, though they are one today` | the rejected convenience: `isOwner(who) || history` would fail this |
| `wasOwnerAt answers on both sides of the rotation timestamp` | the time axis is stored, not derived |
| `sync is idempotent: unchanged set writes nothing and returns false` | INV-8, and that a real change returns `true` |
| `a missed hook is repaired by a permissionless sync, at the sync block` | the repair gap, in both directions |
| `the guard never reverts: a reverting module is swallowed` | the catch |
| `a module address with no code does not revert the Safe, and admits it` | the brick, and `SyncFailed`; `setGuard(0)` still works after |
| `a module with code but no sync() does not revert the Safe` | same, different failure shape |
| `a proxy whose implementation slot is empty does not revert the Safe` | the fourth skip path: `code.length > 0` cannot catch it, the miss is announced, and the `returns (bool)` decode that would have bricked is not there |
| `a gas-tight Safe transaction still succeeds, and the skip is visible` | the reserve; `SyncFailed` + `lastSyncedBlock` lagging |
| `the guard ignores calls from non-Safe senders` | the sender gate |
| `unknown address: every read answers false or empty instead of reverting` | INV-6, empty era for out-of-range |
| `the guard ABI is Safe 1.4.1 IGuard: the enum encodes as uint8` | the guard's selectors against a hardcoded 1.4.1 string |
| `setGuard enforces the ERC-165 gate: our guard installs, a plain contract reverts GS300` | the real installation gate: the guard answers ERC-165, `NotAGuard` does not, and the Safe keeps what it had |
| `supportsInterface answers the guard id derived from our own selectors, and nothing else` | `0xe6d7a83a` = `checkTransaction ^ checkAfterExecution` computed from the compiled selectors, plus `0x01ffc9a7`; `0xffffffff` is false |
| `sync() on a proxy that was never initialized fails cleanly, not with a panic` | `SafeCallFailed` on no era 0 |
| `initialize refuses a Safe that has no owners yet` | `ZeroOwners`, and no proxy left in the index |
| `isOwner answers false when the Safe returns a word that is not 0 or 1` | the raw-word compare, not `abi.decode` |
| `factory createModule yields a working proxy for the Safe` | factory surface, two Safes get separate proxies |
| `initialize rejects address(0) and a safe-less contract, at deploy time` | `ZeroAddress`, `SafeCallFailed` |
| `setImplementation is deployer-only; the UUPS gate is the Safe` | `OnlyDeployer`, `OnlySafe`, `ContractUpgraded`, storage survives an upgrade |

**What the fixtures are not.** `test/MockSafe.t.sol` is not the Safe package: it implements
`getOwners`, `isOwner`, `guard`/`setGuard`, and an `execOwnerChange` that calls the guard the
way 1.4.1 does (read the guard once, `checkTransaction` before, `checkAfterExecution` after,
`onlySelf` simulated by being the caller). `setGuard` there carries the real gate — the
ERC-165 `require` with its `GS300`, so a guard that does not answer
`type(Guard).interfaceId` cannot be installed in the fixture either, which is exactly the bug
a permissive mock hid. The claim “this is Safe 1.4.1's order and shape”
is **asserted by construction, not by a test against the real contract** — the ABI test pins
our side of that contract, not Safe's.

**Missing evidence**, in order of what would change confidence most:

1. A **fork test against the canonical SafeL2 1.4.1 singleton**: real `execTransaction`, real
   `onlySelf` owner mutation via signature, real `setGuard` inside it. That is the only test
   that can falsify the “guard is called after the mutation and the Safe can always be
   unbricked” claim, and the only one that can measure the epilogue the reserve is meant to
   leave room for.
2. A **same-block query test**: `isOwnerAt(who, b)` where `b` is the rotation block itself.
   The head-live branch makes the answer depend on whether the index path or the live path is
   taken, which today's suite never exercises in the rotation block.
3. **`sync` cost under a real fight for gas**, i.e. the ~11-owner ceiling measured rather than
   derived.
