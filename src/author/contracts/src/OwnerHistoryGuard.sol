// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @dev The one call the guard makes, declared locally because the Safe package
///      is not a dependency of this repo. `sync` returns a bool; the guard does
///      not look at it.
interface IOwnerHistory {
    function sync() external returns (bool);
}

/**
 * @title OwnerHistoryGuard
 * @notice Safe 1.4.1 transaction guard that keeps `OwnerHistoryModuleV1`
 *         current. Installed with the Safe's own `setGuard` (which is
 *         `onlySelf`, so a Safe transaction installs it).
 *
 * This is the hook, and the Safe has no other one. `execTransaction` calls
 * `checkTransaction` before the execution and `checkAfterExecution` after it.
 * Every owner mutation — `addOwnerWithThreshold`, `removeOwner`, `swapOwner`,
 * `changeThreshold` — is `onlySelf`, i.e. it must go through `execTransaction`,
 * so a guard sees all of them. There is deliberately no other tap: the Safe
 * emits `AddedOwner`/`RemovedOwner` but emits nothing an off-chain or on-chain
 * listener can *act* on, and 1.4.1 has no owner-rotation callback.
 *
 * Why this contract is separate from the module, and why it is this small:
 *   A reverting guard **bricks the Safe permanently**. Removing it needs a Safe
 *   transaction, and the broken guard would block that transaction. So the
 *   guard holds no storage, has no owner, is not upgradeable, and every path
 *   out of it is a no-op:
 *     - `checkTransaction` has an empty body. It never reads, never reverts,
 *       never can be made to. (A guard *can* veto; this one refuses to.)
 *     - `checkAfterExecution` returns unless the caller is the Safe, and calls
 *       the module inside `try/catch`, so a broken module is a skipped sync, not
 *       a blocked Safe.
 *   The module is where bugs are allowed to live, because a broken module is
 *   repairable: `sync()` is permissionless and the Safe can upgrade or replace
 *   the module without the guard's help.
 *
 * Gas bound on the module call:
 *   `sync()` is cold-storage work: it closes an era, opens one, and opens or
 *   closes a tenure pair per changed address. Measured on this build as the
 *   execution gas of a direct `sync()` transaction (gas used minus the 21k
 *   transaction base), on a Safe growing from 2 owners:
 *
 *     add one owner, era of 2 ............ 306k
 *     add one owner, era of 3 ............ 337k
 *     add one owner, era of 4 ............ 369k
 *     swap one owner, 5 owners ........... 394k
 *     remove one owner, 5 owners ......... 211k
 *     no change at all ................... ~45k
 *
 *   ~32k per owner, because each era stores its owner array. So the ceiling is
 *   600k: comfortably above a rotation on any realistic Safe (2-5 owners) and
 *   below the point where a compromised module could drain a Safe transaction's
 *   budget. A call's gas limit is a ceiling, not a cost — a sync that needs
 *   306k spends 306k — so an over-generous bound would only widen the griefing
 *   window. A rotation too large for 600k (a dozen owners gaining several at
 *   once) misses its sync and is repaired by anyone calling `sync()`: stale for
 *   one block beats a blocked Safe, which is the whole trade of this contract.
 *
 *   Correctness at the edge is defended separately:
 *     - `SYNC_RESERVE` (15k) is kept back from what is available before the
 *       call, so the `catch` and the Safe's own epilogue (emit `ExecutionSuccess`,
 *       pay the refund, return true) always have gas. EIP-150's 63/64 rule alone
 *       is not enough here: with little gas left it leaves a few hundred, and an
 *       out-of-gas epilogue reverts `execTransaction` — and a guard that makes
 *       `execTransaction` revert is the one thing that bricks a Safe.
 *     - Consequence, stated because a test pins it: a Safe transaction whose
 *       gas limit is tight enough that the module cannot finish simply skips
 *       the sync. The Safe's own call still succeeds. The proposer adding a
 *       little headroom to the gas limit is what makes the hook fire.
 *     - The guard is installed on every transaction, not only on owner
 *       changes, and a no-op `sync()` still reads `getOwners()` and compares
 *       the sets: ~45k gas. That is the standing price of a history with no
 *       gaps, and it is paid by the Safe, not by the author's readers.
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
    ///      slice of the remaining gas kept back for the catch and the Safe.
    uint256 internal constant SYNC_GAS = 600_000;
    uint256 internal constant SYNC_RESERVE = 15_000;

    error ZeroAddress();

    constructor(address _safe, address _module) {
        if (_safe == address(0) || _module == address(0)) revert ZeroAddress();
        safe = _safe;
        module = _module;
    }

    /// @dev Intentionally empty. Named parameters are omitted so nothing here
    ///      can even tempt a future edit into reading calldata.
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

    /// @dev Called by the Safe after every execution. A no-op unless a genuine
    ///      Safe is calling, and even then a module failure is swallowed.
    function checkAfterExecution(bytes32, bool) external {
        // Only the Safe's own `execTransaction` may drive the module: without
        // this gate anyone could call `sync` through the guard, and (worse) a
        // future module with side effects would be callable by anyone.
        if (msg.sender != safe) return;

        uint256 available = gasleft();
        if (available <= SYNC_RESERVE) return;
        uint256 budget = available - SYNC_RESERVE;
        if (budget > SYNC_GAS) budget = SYNC_GAS;

        try IOwnerHistory(module).sync{gas: budget}() returns (bool) {
            // The answer (changed / unchanged) is not the guard's business.
        } catch {
            // A missed sync is repaired by anyone calling `sync()` directly.
            // Never bubble: this frame has no right to fail the Safe.
        }
    }
}
