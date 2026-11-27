// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

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
 * a probe Safe proxy and a probe module proxy, reads `keccak256(eth_getCode(...))`
 * from each, and passes those values in — no address or code hash is hard-coded
 * anywhere. Production values are read from the chain, not from this file.
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
 * @title MockModuleProxy
 * @notice An ERC-1967 proxy with the same runtime code for every deployment, so
 *         the gate's module code hash check can be exercised by reading one
 *         deployed fixture's code. The production value is the runtime code of
 *         the OpenZeppelin `ERC1967Proxy` `AuthorFactory` deploys, not this
 *         fixture's hash.
 */
contract MockModuleProxy is ERC1967Proxy {
    constructor(address logic, bytes memory data) ERC1967Proxy(logic, data) {}
}

/**
 * @title MockRecordsImpl
 * @notice The implementation behind a module proxy: the same shape the real
 *         `S2SRecordsModuleV0_1` presents to the gate. `FACTORY` is immutable in
 *         the implementation, like the real one; `safe` is storage, so it lives
 *         in the proxy and one implementation can serve many proxies.
 */
contract MockRecordsImpl {

    bytes32 public constant MODULE_KIND = keccak256("s2s.module.records");

    /// @dev Immutable, as `S2SRecordsModuleV0_1.FACTORY` is: read from the
    ///      implementation's own code through the delegatecall.
    address public immutable FACTORY;

    address public safe;

    constructor(address factory_) {
        FACTORY = factory_;
    }

    function moduleKind() external pure returns (bytes32) {
        return MODULE_KIND;
    }

    function factory() external view returns (address) {
        return FACTORY;
    }

    function initialize(address safe_, bytes calldata) external {
        safe = safe_;
    }
}

/**
 * @title MockRecordsStub
 * @notice Answers every read the gate makes, correctly, from a contract that is
 *         not module-proxy code. A Safe can deploy and enable this itself; the
 *         code hash check is what refuses it.
 */
contract MockRecordsStub {

    address public immutable safe;
    address public immutable factory;

    constructor(address safe_, address factory_) {
        safe = safe_;
        factory = factory_;
    }

    function moduleKind() external pure returns (bytes32) {
        return keccak256("s2s.module.records");
    }
}

/**
 * @title MockPermissiveGate
 * @notice Accepts every location, so a test can exercise a registry path that
 *         gate-checks a location without needing a second real module.
 */
contract MockPermissiveGate {
    function isAuthor(address, address) external pure returns (bool) {
        return true;
    }
}

/**
 * @title MockAuthorFactory
 * @notice A stand-in for `AuthorFactory` in the gate's allowlist. The gate only
 *         compares the address `module.factory()` returns; the fixture is never
 *         called.
 */
contract MockAuthorFactory {

    /// @dev The index the gate trusts: `AuthorFactory.recordsModule` in
    ///      miniature, written when a module is created for a Safe.
    mapping(address => address) public recordsModule;

    function setRecordsModule(address safe, address module) external {
        recordsModule[safe] = module;
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
