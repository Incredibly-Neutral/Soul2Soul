// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

// ===== Factory =====

/**
 * @title OwnerHistoryModuleV1Factory
 * @notice Deploys one UUPS proxy per author Safe, all pointing at the current
 *         implementation. Same shape and same trust model as
 *         DraftsModuleV1Factory — see that file for the long version:
 *   - `setImplementation` is `onlyDeployer`, because a rogue implementation
 *     behind a proxy the Safe enables would execute as the Safe.
 *   - `createModule` is permissionless on purpose: deploying a proxy installs
 *     nothing until the Safe itself enables it.
 *   - `safeModules` is an index, not a permission. Anyone can append an entry
 *     for any address; intersect it with the Safe's enabled-module list before
 *     treating an entry as installed.
 *
 * The initializer is `initialize(address)` — the same shape as the drafts
 * module, but read the module before assuming it: OwnerHistoryModuleV1 also
 * reads `safe.getOwners()` at init, so a proxy over a non-Safe reverts here
 * rather than being born stale.
 */
contract OwnerHistoryModuleV1Factory {

    /// @notice The account that deployed the factory; the only address allowed
    ///         to move `latestImplementation`.
    address public immutable deployer;

    address public latestImplementation;
    address[] public implementationHistory;

    /// @dev Proxies this factory created, per Safe — **an index, not proof**.
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
