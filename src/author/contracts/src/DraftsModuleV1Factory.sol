// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

// ===== Factory =====

/**
 * @title DraftsModuleV1Factory
 * @notice Deploys one UUPS proxy per AUTHOR Safe, all pointing at the current
 *         implementation. The Safe enables the proxy as a module itself; this
 *         contract only records which proxies it created for which Safe.
 *
 * Trust model, stated because both halves are easy to get backwards:
 *   - `setImplementation` is `onlyDeployer`. Without that gate anyone could
 *     repoint `latestImplementation` at an arbitrary contract and the next
 *     `createModule` would hand an author a proxy that, once enabled as a Safe
 *     module, executes as the Safe. The deployer is an immutable set at
 *     construction, so there is no admin to rotate and none to compromise.
 *   - `createModule` stays open **deliberately**: deploying a proxy costs the
 *     caller gas and installs nothing on any Safe, since only the Safe's own
 *     `enableModule` makes a proxy live. A Safe must therefore enable only a
 *     proxy it created itself or verified against a recorded implementation —
 *     `getModulesForSafe` is an index, not a permission, and any caller can
 *     append to it for any address (see `safeModules`). Intersect it with the
 *     Safe's actual enabled modules before treating an entry as installed.
 */
contract DraftsModuleV1Factory {

    /// @notice The account that deployed the factory; the only address allowed
    ///         to move `latestImplementation`.
    address public immutable deployer;

    address public latestImplementation;
    address[] public implementationHistory;

    /**
     * @dev Proxies this factory created, per Safe — **an index, not proof**.
     *      `createModule` is permissionless, so anyone can push an entry for any
     *      Safe here; read it only against that Safe's enabled-module list.
     */
    mapping(address => address[]) public safeModules;

    event ImplementationDeployed(address indexed implementation, uint256 version);
    event ModuleCreated(address indexed safe, address indexed moduleProxy, address implementation);

    error OnlyDeployer();

    modifier onlyDeployer() {
        if (msg.sender != deployer) revert OnlyDeployer();
        _;
    }

    constructor(address _implementation) {
        deployer = msg.sender;
        latestImplementation = _implementation;
        implementationHistory.push(_implementation);
        emit ImplementationDeployed(_implementation, implementationHistory.length);
    }

    function createModule(address safe) public returns (address moduleProxy) {
        bytes memory initializer = abi.encodeWithSignature(
            "initialize(address)",
            safe
        );
        moduleProxy = address(new ERC1967Proxy(latestImplementation, initializer));
        safeModules[safe].push(moduleProxy);
        emit ModuleCreated(safe, moduleProxy, latestImplementation);
        return moduleProxy;
    }

    function setImplementation(address _implementation) external onlyDeployer {
        latestImplementation = _implementation;
        implementationHistory.push(_implementation);
        emit ImplementationDeployed(_implementation, implementationHistory.length);
    }

    function getModulesForSafe(address safe) external view returns (address[] memory) {
        return safeModules[safe];
    }

    function implementationCount() external view returns (uint256) {
        return implementationHistory.length;
    }

    function getImplementationByVersion(uint256 version) external view returns (address) {
        require(version > 0 && version <= implementationHistory.length, "Invalid version");
        return implementationHistory[version - 1];
    }
}
