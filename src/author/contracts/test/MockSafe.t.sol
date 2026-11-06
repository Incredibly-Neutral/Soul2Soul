// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * NOTE ON THE FILE NAME: `.t.sol`, not `.sol`. `hardhat-deploy`'s
 * `generateTypedArtifacts` hook walks `artifacts/` and skips every path ending
 * in `.t.sol`, and that hook has no include/exclude option. This file is the
 * only place these fixtures are declared, so the suffix keeps `MockSafe`,
 * `RevertingSync`, `IGuard` and the proxy below out of `generated/abis/index.ts`
 * — which is the package's `main` and would otherwise publish test fixtures as
 * if they were part of the ABI surface. Hardhat still compiles it and resolves
 * the contracts by name, which is all the suite asks for.
 */

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

    /**
     * @dev A Safe that loses every owner at once — which a real Safe cannot do
     *      (`removeOwner` refuses to go below the threshold, and the threshold
     *      is at least one). Exists so the module's refusal to record an empty
     *      set is testable: `sync()` must revert `ZeroOwners`, not open an empty
     *      era and close every tenure.
     */
    function dropAllOwners() external {
        for (uint256 i = 0; i < _owners.length; i++) {
            delete _isOwner[_owners[i]];
            emit RemovedOwner(_owners[i]);
        }
        delete _owners;
    }

    // ── Guard plumbing (on a real Safe this is `authorized`) ───────

    /**
     * @dev The real installation gate, copied from Safe 1.4.1's
     *      `GuardManager.setGuard`: an ERC-165 check before the address is
     *      stored. Reproducing it is the point of this fixture — a permissive
     *      `setGuard` is what let `OwnerHistoryGuard` ship without
     *      `supportsInterface` and still pass a green suite, while the same
     *      bytes reverted `GS300` on a real Safe.
     *
     *      Two ways a non-guard fails here, and they are not the same revert: a
     *      contract that answers `supportsInterface` with `false` is rejected by
     *      the `require` with `GS300`, while one with no such function at all
     *      reverts inside the call itself (no reason string) — as on the real
     *      Safe.
     */
    function setGuard(address newGuard) external {
        require(
            newGuard == address(0) || IERC165(newGuard).supportsInterface(0xe6d7a83a),
            "GS300"
        );
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

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
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
 * @title NotAGuard
 * @notice A contract with code that answers ERC-165 — with `false` for every
 *         interface, which is a conforming answer. Pointed at `setGuard` it is
 *         rejected by the `require` with `GS300`, the case that matters: it is
 *         what `OwnerHistoryGuard` was before `supportsInterface` existed.
 */
contract NotAGuard {
    function supportsInterface(bytes4) external pure returns (bool) {
        return false;
    }
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

/**
 * @title EmptyImplementationProxy
 * @notice A proxy-shaped contract whose ERC-1967 implementation slot was never
 *         written, i.e. a proxy deployed before (or without) its implementation.
 *
 *         The point is what it returns to a caller expecting a bool: the
 *         `delegatecall` goes to address(0), which *succeeds* with empty
 *         returndata. A caller decoding that returndata as `bool` reverts in its
 *         own frame — the shape of the bug that would brick a Safe whose guard
 *         was wired to a module that was not there yet.
 *
 *         It reads the real slot rather than assuming zero, so the fixture stays
 *         honest if someone later sets an implementation.
 */
contract EmptyImplementationProxy {

    /// @dev `keccak256("eip1967.proxy.implementation") - 1`.
    bytes32 private constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function implementation() external view returns (address impl) {
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly {
            impl := sload(slot)
        }
    }

    fallback() external {
        address impl;
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly {
            impl := sload(slot)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}

/**
 * @title BareProxy
 * @notice The smallest ERC-1967-shaped proxy that delegates everything, with no
 *         initializer call. Deploy a module implementation behind it and you
 *         have the one unreachable-by-factory state the module has to survive:
 *         a proxy whose storage was never initialised, so there is no era 0.
 */
contract BareProxy {

    bytes32 private constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    constructor(address implementation) {
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly {
            sstore(slot, implementation)
        }
    }

    fallback() external {
        address impl;
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly {
            impl := sload(slot)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}

/**
 * @title LyingSafe
 * @notice A Safe-shaped contract that answers `isOwner` with a word that is not
 *         0 or 1. `abi.decode(bytes, (bool))` reverts on such a word, so this is
 *         the fixture that proves the module's live read cannot be made to
 *         revert by the contract it reads.
 */
contract LyingSafe {
    address private immutable _owner;

    constructor(address owner_) {
        _owner = owner_;
    }

    function getOwners() external view returns (address[] memory owners) {
        owners = new address[](1);
        owners[0] = _owner;
    }

    function isOwner(address) external pure returns (uint256) {
        return 2;
    }
}

/**
 * @title NoSync
 * @notice A contract with code, a right-looking deployment, and no `sync()`:
 *         the call to it reverts in the dispatcher (no fallback either). The
 *         guard must swallow that the same way it swallows a revert.
 */
contract NoSync {
    uint256 public answer;
}
