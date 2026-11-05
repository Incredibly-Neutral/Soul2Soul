// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

// ===== Factory =====

/**
 * @title DraftsModuleV1Factory
 * @notice Deploys one UUPS proxy per AUTHOR Safe, all pointing at the current
 *         implementation. The Safe enables the proxy as a module itself; this
 *         contract only records which proxies it created for which Safe.
 */
contract DraftsModuleV1Factory {

    address public latestImplementation;
    address[] public implementationHistory;
    mapping(address => address[]) public safeModules;

    event ImplementationDeployed(address indexed implementation, uint256 version);
    event ModuleCreated(address indexed safe, address indexed moduleProxy, address implementation);

    constructor(address _implementation) {
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

    function setImplementation(address _implementation) external {
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
