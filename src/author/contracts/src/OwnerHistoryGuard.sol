// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title OwnerHistoryGuard
 * @notice Safe 1.4.1 transaction guard that keeps `OwnerHistoryModuleV1`
 *         current. Installed with the Safe's own `setGuard` (which is
 *         `onlySelf`, so a Safe transaction installs it).
 *
 * What this is, in one line: **a best-effort hook, not the primary path.**
 *
 * This is the only tap the Safe offers. `execTransaction` calls
 * `checkTransaction` before the execution and `checkAfterExecution` after it.
 * Every owner mutation — `addOwnerWithThreshold`, `removeOwner`, `swapOwner` —
 * is `onlySelf`, i.e. it must go through `execTransaction`, so a guard *sees*
 * every rotation. Seeing is not the same as recording, and the difference
 * matters enough to state up front (see "Best-effort, measured" below).
 *
 * What it does NOT cover — two holes, both real:
 *   1. **A module can act as the Safe.** `execTransactionFromModule` is a
 *      self-call that skips guards entirely, so an enabled Safe module can
 *      rotate owners, and can also call `setGuard(address(0))` to uninstall
 *      this contract. The guard covers *transactions*, not a malicious (or
 *      merely broken) module. That is a property of Safe 1.4.1, not of this
 *      design, and `sync()` being permissionless is why the history is still
 *      repairable afterwards.
 *   2. **The hook can be missed.** See "Best-effort" below. Every miss leaves
 *      a visible scar: `SyncFailed(blockNumber)` here plus `lastSyncedBlock()`
 *      lagging the rotation on the module.
 *
 * Why this contract is separate from the module, and why it is this small:
 *   A reverting guard **bricks the Safe permanently**. Removing it needs a Safe
 *   transaction, and the broken guard would block that transaction. So the
 *   guard holds no storage, has no owner, is not upgradeable, and no path out
 *   of it reverts:
 *     - `checkTransaction` has an empty body: it reads no calldata and no
 *       storage. Nothing *inside* it can revert. (It is not literally
 *       revert-proof — the ABI decoder in front of it rejects an out-of-range
 *       `Operation` (`uint8 > 1`) and a `value`-bearing call to a non-payable
 *       function — but a genuine Safe never sends either. A guard *can* veto;
 *       this one does not.)
 *     - `checkAfterExecution` returns unless the caller is the Safe, and calls
 *       the module with a low-level call whose result it ignores, so a broken
 *       or greedy module is a *skipped sync*, never a blocked Safe.
 *   The module is where bugs are allowed to live, because a broken module is
 *   repairable: `sync()` is permissionless and the Safe can upgrade or replace
 *   the module without the guard's help.
 *
 * The one decode that would have bricked it, and is gone:
 *   This called `try IOwnerHistory(module).sync{gas: g}() returns (bool) {}`.
 *   If `module` is an address with no code the *call* succeeds with empty
 *   returndata, and the decode of the declared `bool` then reverts **in the
 *   guard's own frame, outside the `catch`** — `execTransaction` reverts, and so
 *   does the `setGuard(address(0))` that would remove the guard. Permanent and
 *   unrecoverable. The call below is therefore low-level, and the return data is
 *   never decoded — only measured (a word is the least a `bool` could be).
 *   Reachable exactly the ways a hand-made deploy gets wrong: the
 *   implementation address instead of the proxy, a typo, a proxy deployed later.
 *   `module.code.length == 0` is a cheap belt for the codeless case. It is not
 *   enough on its own: a *proxy* whose implementation slot is still empty has
 *   code, and its `delegatecall` to address(0) succeeds with no returndata — the
 *   low-level call survives that (no decode, no revert) and the length check is
 *   what makes it visible instead of a silent success.
 *
 * Best-effort, measured — why the hook is not the primary path:
 *   The gas limit of the Safe transaction is chosen *before* the transaction
 *   runs, and the guard forwards a bounded amount (`SYNC_GAS`) out of what is
 *   left at the tail, keeping `SYNC_RESERVE` back for the event, for the ABI
 *   encoding and cold-account charge of the call, and for the Safe's own
 *   epilogue (`ExecutionSuccess`, `handlePayment` when `gasPrice > 0`, return).
 *   A gas limit equal to the transaction's true cost is exactly what
 *   `eth_estimateGas` produces, and at that limit the sync is starved by the
 *   reserve and skipped. This is not fixable in the contract: no contract can
 *   know the execution cost that follows it, and reverting to force a floor
 *   would turn a missed sync into a blocked Safe.
 *
 *   So the operating rule, for anyone proposing a transaction on a guarded
 *   author Safe:
 *     - to make the hook fire, add at least `SYNC_GAS + 40_000` of headroom to
 *       the gas limit, **or** include an explicit `sync()` call in the
 *       transaction (as the Safe web app user would, by adding it to the
 *       batch), which needs no headroom at all because it is the call itself;
 *     - to confirm it fired, check that `SyncFailed` did not appear and that
 *       `lastSyncedBlock()` moved.
 *   The guard's job is the safety net for rotations that arrive through other
 *   clients — the Safe web app, a hardware wallet flow, a script — where nobody
 *   thought about the hook at all. The primary path for a rotation proposed by
 *   this project's own tooling should be an explicit `sync()`.
 *
 * Gas bound on the module call:
 *   `sync()` is cold-storage work: it closes an era, opens one, and opens or
 *   closes a tenure pair per changed address. Measured on this build as the
 *   execution gas of a direct `sync()` transaction (gas used minus the 21k
 *   transaction base), at era size N:
 *
 *     N = 2,  one owner added ........... 305,895
 *     N = 3,  one owner added ........... 337,617
 *     N = 4,  one owner added ........... 369,688
 *     N = 10, one owner added ........... 569,421   fits
 *     N = 11, one owner added ........... 603,928   MISSES SYNC_GAS
 *     N = 12, one owner added ........... 638,784
 *     N = 2,  no change .................  28,784
 *     N = 13, no change .................  96,991
 *
 *   An add at N = 13 measures 673,987. A swap or a removal is *not* dearer in a
 *   way worth a row: at N = 13 a removal is 490,859 and a swap 679,053, and the
 *   spread between two measurements of the same row (some thousands) comes from
 *   whether the changed address is new to `ownersEver` — a fresh entry pays a
 *   zero-to-nonzero slot and an array push, a returning one does not. Neither is
 *   near the ceiling at that size, so the add is the binding cost and the table
 *   keeps to it. (The `sync()` in question here is the module's; measure it
 *   yourself with a direct `sync()` transaction and subtract the 21k base.)
 *
 *   Fit: `~239k + 33.5k * N` for an add, `~16.4k + 6.2k * N` for the no-op (two
 *   cold arrays are walked: the Safe's list and the era's copy). The per-owner
 *   cost creeps up with N because the era's owner array is copied on open, which
 *   is why the fit is approximate and why the ceiling is stated for an add:
 *   **an era of ten gaining one owner fits (569,421) and an era of eleven does
 *   not (603,928)**. Past the ceiling the sync is skipped and repaired by the
 *   next permissionless `sync()` — and the era is then stamped at the repair
 *   block, not the rotation block, so the gap shows up as `SyncFailed` here plus
 *   `lastSyncedBlock()` lagging on the module.
 *
 *   `SYNC_GAS = 600_000` is a ceiling, not a cost (a sync that needs 306k spends
 *   306k), so a larger bound would only widen the window in which a compromised
 *   module can burn the Safe's gas. `SYNC_RESERVE = 20_000` is sized against
 *   measurement, not taste: measured across three different transaction gas
 *   limits, 17,050 of it is actually retained at the module call — the rest goes
 *   to the `code.length` read (2,600, cold, and it is that read that warms the
 *   account so the call itself is free of the charge) and to the call and its
 *   encoding (~350). The Safe's `handlePayment` needs ~12k of that back when
 *   `gasPrice > 0`, which is why the reserve is 20k and not 15k.
 *
 *   The guard runs on *every* transaction, not only on owner changes, and the
 *   no-op sync is not free: 29k on a two-owner era, 104k on a thirteen-owner
 *   one. That is the standing price of a history with no gaps, paid by the Safe
 *   on every transaction it executes, and it is the strongest argument for
 *   keeping author Safes at a normal owner count.
 *
 * The ABI, verified rather than assumed:
 *   `Enum.Operation` from the Safe's `IGuard` cannot be imported (no Safe
 *   dependency), and its ABI type is `uint8`, so a local two-member enum gives
 *   the identical encoding. The selector the Safe calls is
 *   `checkTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,address)`,
 *   asserted in the test suite against the ABI this file compiles to.
 */
contract OwnerHistoryGuard {

    enum Operation { Call, DelegateCall }

    /// @notice The Safe this guard is installed on; the only sender whose
    ///         post-execution call is honoured.
    address public immutable safe;
    /// @notice The owner-history module to keep current.
    address public immutable module;

    /// @dev See "Gas bound" above: measured ceiling for a rotation, and the
    ///      slice of the remaining gas kept back for the catch, the call's own
    ///      charges, and the Safe's epilogue.
    uint256 internal constant SYNC_GAS = 600_000;
    uint256 internal constant SYNC_RESERVE = 20_000;

    /// @dev `sync()` on the module, declared as a selector constant rather than
    ///      through an `interface`: an interface exists here only to be called,
    ///      and one would put a second ABI entry on the package's public surface
    ///      for no caller's benefit.
    bytes4 private constant SYNC_SELECTOR = bytes4(keccak256("sync()"));

    /// @notice Emitted whenever the hook did **not** record this transaction's
    ///         outcome. Four cases: no code at `module`; less gas left than
    ///         `SYNC_RESERVE`; the call failed; or it answered with less than a
    ///         word of returndata. The last one is not a curiosity — it is what
    ///         a proxy with an empty implementation slot does, successfully. It
    ///         is the only on-chain notice a gap ever gets; the next successful
    ///         `sync()` repairs it, and the scar shows up as `lastSyncedBlock()`
    ///         lagging the rotation.
    event SyncFailed(uint256 blockNumber);

    error ZeroAddress();

    constructor(address _safe, address _module) {
        if (_safe == address(0) || _module == address(0)) revert ZeroAddress();
        safe = _safe;
        module = _module;
    }

    /// @dev Deliberately empty: unnamed parameters so that nothing here can even
    ///      tempt a future edit into reading calldata, and no storage read. The
    ///      only reverts reachable through this function are the ABI decoder's,
    ///      which a genuine Safe never triggers.
    function checkTransaction(
        address,
        uint256,
        bytes calldata,
        Operation,
        uint256,
        uint256,
        uint256,
        address,
        address payable,
        bytes calldata,
        address
    ) external {}

    /**
     * @dev Called by the Safe after every execution. A no-op unless a genuine
     *      Safe is calling; even then a module failure is a skipped sync.
     *
     *      A revert here would be fatal to the Safe, so the only statement in
     *      reach that touches another contract is the low-level call, and its
     *      result is ignored except for the event.
     */
    function checkAfterExecution(bytes32, bool) external {
        // Only the Safe's own `execTransaction` may drive the module: without
        // this gate anyone could call `sync` through the guard, and (worse) a
        // future module with side effects would be callable by anyone.
        if (msg.sender != safe) return;

        uint256 available = gasleft();
        if (available <= SYNC_RESERVE) {
            emit SyncFailed(block.number);
            return;
        }

        // A codeless `module` is the deploy typo that `module` being immutable
        // makes permanent. Report it and stop; do not call.
        if (module.code.length == 0) {
            emit SyncFailed(block.number);
            return;
        }

        uint256 budget = available - SYNC_RESERVE;
        if (budget > SYNC_GAS) budget = SYNC_GAS;

        // Low-level, and the returndata is measured but never decoded:
        // `returns (bool)` reverts *here*, outside any catch, on empty
        // returndata, which would brick the Safe. See the docblock.
        //
        // `!ok` covers a revert and an out-of-gas module. `ret.length < 32`
        // covers the case the low-level call exists for: a proxy with an empty
        // implementation slot delegatecalls to address(0), which *succeeds* with
        // no returndata at all, so `ok` is true and nothing was recorded. A
        // length test is the whole point — a decode is the brick.
        (bool ok, bytes memory ret) =
            module.call{gas: budget}(abi.encodeWithSelector(SYNC_SELECTOR));
        if (!ok || ret.length < 32) emit SyncFailed(block.number);
    }
}
