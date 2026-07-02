// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @notice Minimal factory that creates ERC1967 proxies pointing to a
 * given S2SPublicationModuleV2 implementation. Unlike the embedded
 * factory in S2SPublicationModuleV2.sol, this one accepts the impl
 * address in the constructor — keeps bytecode small enough to deploy.
 */
contract S2SPublicationModuleV2Factory {
    address public latestImplementation;

    event ModuleCreated(address indexed safe, address indexed moduleProxy, address implementation);

    constructor(address _implementation) {
        latestImplementation = _implementation;
    }

    function createModule(
        address safe,
        address[] memory _authors,
        address[] memory _devs
    ) public returns (address moduleProxy) {
        bytes memory initializer = abi.encodeWithSignature(
            "initialize(address,address[],address[])",
            safe, _authors, _devs
        );
        moduleProxy = address(new ERC1967Proxy(latestImplementation, initializer));
        emit ModuleCreated(safe, moduleProxy, latestImplementation);
        return moduleProxy;
    }

    function createModuleEmpty(address safe) external returns (address) {
        address[] memory empty = new address[](0);
        return createModule(safe, empty, empty);
    }

     /**
     * @notice Point the factory at a new implementation. Existing proxies
     * are UUPS and upgrade themselves independently via _authorizeUpgrade;
     * this only affects future createModule calls.
     */
    function setImplementation(address _implementation) external {
        latestImplementation = _implementation;
        emit ModuleCreated(address(0), address(0), _implementation);
    }
}
