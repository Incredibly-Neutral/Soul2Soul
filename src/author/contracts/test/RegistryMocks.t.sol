// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * NOTE ON THE FILE NAME: `.t.sol`, not `.sol`. `hardhat-deploy`'s
 * `generateTypedArtifacts` hook skips every artifact path ending in `.t.sol`,
 * so these fixtures are compiled and resolvable by name in tests without being
 * published as part of the package ABI surface. See `MockSafe.t.sol`.
 *
 * This file is the Safe fixture for the registry suite. A real Safe 1.4.1 is a
 * proxy whose runtime answers `masterCopy()` and whose implementation answers
 * `isModuleEnabled()`. `MockSafeProxy` keeps that shape in one contract: the
 * gate reads `masterCopy()` and `isModuleEnabled()` off the same address, which
 * is exactly what a Safe proxy exposes to a caller.
 *
 * The gate's constructor takes allowed proxy code hashes, so the suite deploys
 * a probe proxy, reads `keccak256(eth_getCode(probe))`, and passes that value in
 * — no Safe address or code hash is hard-coded anywhere.
 */

/// @notice The singleton a `MockSafeProxy` points at. The gate only checks
///         membership; this contract is never called.
contract MockSingleton {
    uint256 public answer;
}

/**
 * @title MockSafeProxy
 * @notice A Safe-shaped author address: `masterCopy()` (what the gate reads to
 *         identify the singleton), `isModuleEnabled()` (what it reads to find
 *         the records module), plus `enableModule` for test setup and
 *         `execCall` so the Safe itself can be the caller of a registry write.
 */
contract MockSafeProxy {

    /// @dev Public so the compiler emits `masterCopy()`, the Safe proxy getter.
    address public masterCopy;

    mapping(address => bool) private _modules;

    constructor(address singleton) {
        masterCopy = singleton;
    }

    function isModuleEnabled(address module) external view returns (bool) {
        return _modules[module];
    }

    function enableModule(address module) external {
        _modules[module] = true;
    }

    function disableModule(address module) external {
        _modules[module] = false;
    }

    /// @dev Execute a call as the Safe, the way `execTransaction` would with
    ///      signatures already checked.
    function execCall(address target, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }
}

/**
 * @title MockRecordsModule
 * @notice `S2SRecordsModuleV0_1`'s one declaration the gate reads: `safe()`.
 *         Bound at construction, so a test can deploy a module claiming a Safe
 *         it is not installed on.
 */
contract MockRecordsModule {

    address public safe;

    constructor(address safe_) {
        safe = safe_;
    }
}

/**
 * @title MockGovernance
 * @notice Governance must have code (the registry's constructor checks), and
 *         governance functions are `msg.sender == governance`. This forwards a
 *         call so the fixture can act as governance from a test.
 */
contract MockGovernance {

    function execute(address target, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }
}
