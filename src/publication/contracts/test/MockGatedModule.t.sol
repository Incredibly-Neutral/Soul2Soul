// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Upgrade.sol";

/**
 * NOTE ON THE FILE NAME: `.t.sol`, not `.sol`. The artifact generator skips
 * paths ending in `.t.sol`, which keeps this fixture out of the package's ABI
 * surface. Hardhat still compiles it and resolves it by name.
 *
 * @notice A module that carries the two things the factory asks of an
 * implementation, and a working upgrade gate, so the suite can prove what the
 * factory and the gate refuse rather than only what the factory accepts.
 *
 * `upgrade` checks approval for its OWN kind. That is the storage-collision
 * guard: a module of kind A cannot be moved to an implementation approved only
 * for kind B, because the check asks about A.
 */
interface IS2SModuleFactoryApprovals {
    function isApproved(bytes32 kind, address implementation) external view returns (bool);
}

contract MockGatedModule is ERC1967Upgrade {
    address public immutable FACTORY;
    bytes32 public immutable KIND;

    address public safe;
    bytes32 public paramsHash;
    uint256 public counter;

    error OnlyFactory();
    error AlreadyInitialized();
    error OnlySafe();
    error NotApproved(address implementation);

    constructor(address factory, bytes32 kind) {
        FACTORY = factory;
        KIND = kind;
    }

    function factory() external view returns (address) {
        return FACTORY;
    }

    function moduleKind() external view returns (bytes32) {
        return KIND;
    }

    /// @dev Called by the factory only, with the Safe the factory recorded. The
    ///      second guard is what a real module's `initializer` gives it: a module
    ///      cannot be initialised twice through this path either.
    function initialize(address _safe, bytes calldata params) external {
        if (msg.sender != FACTORY) revert OnlyFactory();
        if (safe != address(0)) revert AlreadyInitialized();
        safe = _safe;
        paramsHash = keccak256(params);
    }

    /// @dev What a UUPS implementation answers, so the factory's UUPS check
    ///      accepts this fixture.
    function proxiableUUID() external pure returns (bytes32) {
        return _IMPLEMENTATION_SLOT;
    }

    function bump() external {
        counter += 1;
    }

    /// @dev Runs in the proxy's context, so the write lands in the proxy's
    ///      ERC-1967 slot and its storage survives.
    function upgrade(address target) external {
        if (msg.sender != safe) revert OnlySafe();
        if (!IS2SModuleFactoryApprovals(FACTORY).isApproved(KIND, target)) {
            revert NotApproved(target);
        }
        _upgradeToAndCall(target, "", false);
        counter = counter + 1000;
    }
}
