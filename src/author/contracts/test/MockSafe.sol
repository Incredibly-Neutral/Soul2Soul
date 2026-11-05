// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title MockSafe
 * @notice Just enough of Safe 1.4.1's owner surface to exercise
 *         OwnerHistoryModuleV1 and OwnerHistoryGuard: `getOwners`, `isOwner`,
 *         `guard` / `setGuard`, and an `execOwnerChange` entry point that
 *         reproduces the two calls a real Safe makes around an `onlySelf`
 *         owner mutation — `checkTransaction` before, `checkAfterExecution`
 *         after — with the same ABI (the enum operation is `uint8` on the wire).
 *
 * Deliberately NOT the Safe package: the point of this suite is the hook and
 * the index, and the module only ever needs `getOwners()`/`isOwner()` from the
 * Safe. Everything else a real Safe does (thresholds, signatures, nonce) is
 * orthogonal to what is under test here.
 */
contract MockSafe {

    address[] private _owners;
    mapping(address who => bool) private _isOwner;

    /// @notice The installed transaction guard; zero = none.
    address public guard;

    event AddedOwner(address indexed owner);
    event RemovedOwner(address indexed owner);
    event GuardChanged(address indexed guard);

    error AlreadyOwner(address who);
    error NotOwner(address who);
    error LastOwner();
    error UnknownChange(uint8 kind);

    constructor(address[] memory initialOwners) {
        for (uint256 i = 0; i < initialOwners.length; i++) {
            _owners.push(initialOwners[i]);
            _isOwner[initialOwners[i]] = true;
        }
    }

    // ── The module's whole view of the Safe ────────────────────────

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function isOwner(address who) external view returns (bool) {
        return _isOwner[who];
    }

    function ownerCount() external view returns (uint256) {
        return _owners.length;
    }

    // ── Guard plumbing (on a real Safe this is `onlySelf`) ─────────

    function setGuard(address newGuard) external {
        guard = newGuard;
        emit GuardChanged(newGuard);
    }

    /**
     * @dev One `onlySelf` owner mutation, wired the way Safe 1.4.1 wires it:
     *      the guard is read once, `checkTransaction` runs before the mutation,
     *      `checkAfterExecution(txHash, true)` after it. `kind`: 0 = add(a),
     *      1 = remove(a), 2 = swap(a → b).
     */
    function execOwnerChange(uint8 kind, address a, address b) external {
        address g = guard;
        if (g != address(0)) {
            IGuard(g).checkTransaction(
                address(this),
                0,
                "",
                0,
                0,
                0,
                0,
                address(0),
                payable(address(0)),
                "",
                msg.sender
            );
        }

        if (kind == 0) {
            _addOwner(a);
        } else if (kind == 1) {
            _removeOwner(a);
        } else if (kind == 2) {
            _swapOwner(a, b);
        } else {
            revert UnknownChange(kind);
        }

        if (g != address(0)) {
            IGuard(g).checkAfterExecution(bytes32(0), true);
        }
    }

    /// @dev Execute an arbitrary call as the Safe — the `execTransaction`
    ///      shape minus signatures, which is how a real Safe upgrades its own
    ///      module or calls an `onlySelf` target.
    function execCall(address target, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    /// @dev Call the guard's post-execution hook as the Safe, without an owner
    ///      change. Used to prove the sender gate and the catch.
    function pokeGuard(bytes32 txHash, bool success) external {
        address g = guard;
        if (g != address(0)) IGuard(g).checkAfterExecution(txHash, success);
    }

    // ── Mutation ───────────────────────────────────────────────────

    function _addOwner(address a) private {
        if (_isOwner[a]) revert AlreadyOwner(a);
        _isOwner[a] = true;
        _owners.push(a);
        emit AddedOwner(a);
    }

    function _removeOwner(address a) private {
        if (!_isOwner[a]) revert NotOwner(a);
        if (_owners.length == 1) revert LastOwner();
        _isOwner[a] = false;
        for (uint256 i = 0; i < _owners.length; i++) {
            if (_owners[i] == a) {
                _owners[i] = _owners[_owners.length - 1];
                _owners.pop();
                break;
            }
        }
        emit RemovedOwner(a);
    }

    function _swapOwner(address oldOwner, address newOwner) private {
        if (!_isOwner[oldOwner]) revert NotOwner(oldOwner);
        if (_isOwner[newOwner]) revert AlreadyOwner(newOwner);
        _isOwner[oldOwner] = false;
        _isOwner[newOwner] = true;
        for (uint256 i = 0; i < _owners.length; i++) {
            if (_owners[i] == oldOwner) {
                _owners[i] = newOwner;
                break;
            }
        }
        emit RemovedOwner(oldOwner);
        emit AddedOwner(newOwner);
    }
}

interface IGuard {
    function checkTransaction(
        address to,
        uint256 value,
        bytes memory data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures,
        address msgSender
    ) external;

    function checkAfterExecution(bytes32 txHash, bool success) external;
}

/**
 * @title RevertingSync
 * @notice A module stand-in whose `sync()` reverts, for the guard's catch.
 */
contract RevertingSync {
    error Broken();

    function sync() external pure returns (bool) {
        revert Broken();
    }
}
