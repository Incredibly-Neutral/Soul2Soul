# SPEC-author-owner-history — who was an owner, and when

> **Parent:** [`SPEC-author.md`](SPEC-author.md)
> **Siblings:** [`SPEC-author-identity.md`](SPEC-author-identity.md),
> [`SPEC-author-drafts.md`](SPEC-author-drafts.md)
> **Type:** branch — a part of the author side, not a domain in its own right.
> **Status:** built. `OwnerHistoryModuleV1`, `OwnerHistoryGuard` and the package's one factory,
> `AuthorContractsFactory`, are in `src/author/contracts/src`, with `test/OwnerHistory.test.ts`,
> `test/MockSafe.t.sol` and 44 passing tests in the package;
> `scripts/deploy-author-contracts.ts` is the deploy path and `src/author/contracts/README.md`
> carries the guard's gas-headroom rule. The ABI under `generated/abis/` is the frozen
> surface: a signature change there is a breaking change for every gate and reader. Deployed on
> Base: `OwnerHistoryModuleV1` implementation `0x72AEa9722fe3d615F36c2b28dd77117459078Bd0` behind
> `AuthorContractsFactory` `0xC70eEA1E873DDa4D260f080e3b1698fBC8BD9f2E`; the per-Safe proxy and
> guard are installed by `s2s author new` / `s2s author init` (see *The install*).

## Responsibility

Two contracts, one job: after a piece of content is read, answer **“was this address an
owner of the author Safe at the block (or time) that content was signed?”** — and keep
the raw history that answer is computed from, so a reader can check it rather than trust
it.

- `OwnerHistoryModuleV1` (UUPS; one proxy per author Safe, made by
  `AuthorContractsFactory.createOwnerHistoryModule`). It mirrors the Safe's owner set and records a new *era*
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

The normal path is the CLI: `s2s author new` installs on the author it just created, and
`s2s author init` does the same for an author that already exists (a key filed before these
contracts were deployed). Adoption is read from the two records only the Safe can write. The
module is found by role: every address on the Safe's enabled-module list is asked
`supportsInterface(0xee855023)`, and the one that answers true is the module this Safe adopted.
The guard is found in its slot, because a guard is not an enabled module: `getStorageAt(safe,
0x4a204f…34c8)` → `G`, then `G.module()` → `M`, `G.safe() == safe`, `M.safe() == safe` — three
immutables, no factory in the proof. A re-run that finds both reports `already`, and only calls
`createOwnerHistoryModule(safe)` when one is missing. It then sends the Safe transaction below,
re-reads the list and the slot, and calls itself `installed` only when the Safe carries the module
and guard it sent. On a multisig Safe, where one key cannot execute that transaction, it stops at
`pending-safe` and prints the `to`/`data` for the owners to propose. A guard someone else already
installed is never overwritten, and no `safeTx` is offered to replace it: replacing a guard is
allowed only for this package's own guard, proven the same way — `guard.module()` and `guard.safe()`
name the module and the Safe. Any other guard is the Safe's policy, and the owners remove it
themselves. The same steps by hand are the manual path.

Three steps, and only the last one is a Safe transaction:

1. `createOwnerHistoryModule(safe)` on the factory — **permissionless**, deploys the proxy *and*
   the guard bound to it, returns `(moduleProxy, guard)`, and installs nothing. The factory
   cannot install: `setGuard` and `enableModule` are `onlySelf`, and nothing in this package
   writes the Safe's storage.
2. Read the address the factory would deploy to, if a preview is wanted:
   `ownerHistoryModuleAddress(safe)`. The factory deploys with CREATE2 from
   `keccak256(abi.encode(role, safe, nonce))`, so the answer is exact until another caller takes the
   nonce or `setOwnerHistoryImplementation` moves the pointer. The guard is a plain CREATE and has
   no predicted address.
3. One Safe transaction carrying the batch: `enableModule(moduleProxy)`, `setGuard(guard)`.

That transaction has one precondition that is easy to miss and fatal to skip: `setGuard` is
`authorized` — a self-call, the Safe's own `execTransaction` or an enabled module's
`execTransactionFromModule` — and validates ERC-165 before it stores the address:
`require(Guard(guard).supportsInterface(type(Guard).interfaceId), "GS300")`. A contract that
does not answer the guard interface id (`0xe6d7a83a`) cannot be installed at all: the
transaction reverts `GS300` and the previous guard stays. `OwnerHistoryGuard.supportsInterface`
answers `0xe6d7a83a` and `0x01ffc9a7`, so the transaction lands.

**`enableModule` is part of the install, and it is safe because the module has no powers to
use.** Enabling a module lets it call `execTransactionFromModule`, i.e. execute anything as the
author Safe, so the question is whether this module ever would. It does not: it writes its own
storage and answers views, and nothing in it calls `execTransactionFromModule`. Enabling grants
no execution power, and it buys the one thing the guard slot cannot give — the Safe's own
enabled-module list, which is the authoritative index a gate reads a role from. The proxy's
implementation pointer is fixed at creation and moves only through the Safe's own `upgradeTo`, so
an enabled proxy cannot be repointed behind the Safe's back.

The guard stays in the slot regardless, because a guard is what sees writes: it is called inside
every `execTransaction`, and an owner rotation is an ordinary `execTransaction` with a self-call
in it. The two records answer different questions — the enabled list says which module is adopted,
the slot says what watches the Safe.

Nothing else in the install is required: there is no registry to join and no name to claim,
the proxy answers only to the Safe, and the factory is a deployer with an index. `NAME()`
(`"S2S Owner History Module V1"`) is a diagnostic, not a way to find anything.

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
| `NAME() → string` | `"S2S Owner History Module V1"` (pure; a diagnostic, not a trust signal) |
| `supportsInterface(bytes4) → bool` | `true` for `0xee855023` (`IOwnerHistoryModule`: `sync`, `isOwner`, `isOwnerAt`, `wasOwnerAt`, `eraCount`) and `0x01ffc9a7`; false for everything else. In the source; the deployment at `0xD830…` predates it and answers nothing |
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
2. **A migration starts a new history.** Adopting a new module keeps the Safe and gives it a
   fresh proxy, whose era 0 is the block of that proxy. The eras the old proxy recorded stay in
   the old proxy; nothing in the new one points at them, so the Safe's history begins again.
   Content written before the migration therefore has no block this module can check, and the
   drafts log answers `blockNumber` 0 for the versions it imported for the same reason.
3. **A missed rotation stretches a tenure.** `sync()` records the boundary at the block it
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
   This is indistinguishable from (3) except that it leaves `SyncFailed(blockNumber)` in the
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
// The module is found by role on the Safe's own enabled-module list.
const history = await moduleWithRole(authorSafe, '0xee855023')

const wasOwner = await read(history, HISTORY_ABI, 'isOwnerAt', [signer, blockOfTheArtifact])
return (
  (await read(publicationModule, CAN_PUBLISH_ABI, 'canPublish', [authorSafe])) &&
  wasOwner &&
  (await read(genesis, HAS_DEAL_ABI, 'hasDeal', [genesis]))
)
```

`isOwnerAt(signer, blockOfTheArtifact)` is *the* call. The block is the one the version was
recorded in — for a manuscript, the block its draft version was appended at, read from the drafts
log's `blocksOf`. It is not the block of the query and not the block of the signature.
`isOwnerAt(signer, block.number)` is “is an owner now” — the same function, answered live — and is
not what a gate wants for content older than the current block. The three reads are independent:
none feeds another.

One block value is special: `blockNumber == 0` means the version predates the field, or was carried
in by `absorb()`. There is no block to judge, so the gate answers with the Safe's live owner set
instead and reports that it did: the height that would make this a historical question was never
recorded, and the present tense is the only one left to ask. Such a version opens for a current
owner, not for the owner it was written under.

`canAuthor` in `src/shared/src/gates` is that gate, and `canRead` asks it as its ownership half:
it takes the height from the drafts log's `blocksOf` and puts `isOwnerAt` in place of the live read
on the append-block path, so a signer who has since been removed still reads what they wrote. The
write gates keep the live read, because a write is admitted now: `canPublish` and `canReset` ask
who owns the Safe today, which is why an old version is readable but not rewritable.

**The trust anchor is the Safe's enabled-module list, not the factory.** `createModule` is
permissionless: anyone can create a history proxy *claiming* any Safe, and `NAME()` (“S2S Owner
History Module V1”) is a string anyone can copy. `history.safe()` alone therefore proves only that
whoever made the proxy named that Safe. The rules:

1. A module is adopted when it is on the Safe's enabled-module list — a list only the Safe writes,
   because `enableModule` is `onlySelf` — and answers `supportsInterface(0xee855023)`. That pair is
   the proof: the factory index is a lead, an event is a lead, and a name is nothing. When more
   than one module answers, the reader either takes the one it was given out of band or reads both
   and keeps the log that holds the record; the list says adoption, not which instance holds a
   given era.
2. For the guard, the slot is the check, and it is a separate question: read the guard-manager
   word (`getStorageAt(0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8, 32)`,
   low 20 bytes) → `guard` → `guard.module() → the module`, and require that address to be the one
   the enabled list gave. Two records that must agree are stronger than either alone. Neither is
   required to find the other.
3. A failed comparison is `false` for the gate, never a fallback to a live `isOwner` — the present
   tense is reached only where the log records no height to compare at.

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
- **The role id does not move.** `supportsInterface(0xee855023)` answers true from a compile-time
  constant; no upgrade and no stored value can change it, because a reader that already holds the
  id would never see a new one. The id differs from the drafts module's and the guard's, which is
  what makes it tell the roles apart.

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

1. **The gate's shape.** Settled: `canAuthor` in `src/shared/src/gates` takes the author Safe,
   the signer and no block, reads the height from the drafts log itself, and is the ownership
   half of `canRead`. `canPublish` and `canReset` keep the live `isOwner`, because a write is
   admitted now.
2. **Which package owns the read helper?** Settled: the gate is in `@s2s/soul2soul-shared`
   (`src/shared/src/gates`), beside the other gates, which is where the trust-anchor rule above
   belongs. This package owns the ABI, the module and the deploy script.
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
- The factory's `getOwnerHistoryModulesForSafe` / `guardFor` index shapes; the deploy script;
  the TS read helper's location.

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
- **The role id `0xee855023`.** A reader that already holds it cannot be told about a new one,
  so a change makes every published module undiscoverable for good.
- **`_authorizeUpgrade` gated on `msg.sender == safe`.**

## Test seams

44 tests pass in `src/author/contracts` — 29 in `test/OwnerHistory.test.ts` (below) and 15 in
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
| `supportsInterface answers the history role id and no other` | `0xee855023` from `IOwnerHistoryModule`'s functions; the drafts id and the guard id answer false |
| `sync() on a proxy that was never initialized fails cleanly, not with a panic` | `SafeCallFailed` on no era 0 |
| `initialize refuses a Safe that has no owners yet` | `ZeroOwners`, and no proxy left in the index |
| `isOwner answers false when the Safe returns a word that is not 0 or 1` | the raw-word compare, not `abi.decode` |
| `factory createOwnerHistoryModule yields a working proxy for the Safe` | factory surface, two Safes get separate proxies |
| `createOwnerHistoryModule binds proxy, guard and Safe, and installs nothing` | the factory deploys both and returns them bound (`guard.module()`, `guard.safe()`, `history.safe()`); the Safe's guard slot is still zero until its own `setGuard` |
| `both indexes append, and neither create is gated to the deployer` | a stranger's create lands in both indexes, and still no `set*Implementation` for it |
| `guardFor answers zero for an unknown module instead of reverting` | the read a gate can use: zero, not a revert |
| `initialize rejects address(0) and a safe-less contract, at deploy time` | `ZeroAddress`, `SafeCallFailed` |
| `setOwnerHistoryImplementation is deployer-only; the UUPS gate is the Safe` | `OnlyDeployer`, `OnlySafe`, `ContractUpgraded`, storage survives an upgrade |

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
