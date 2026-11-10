// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @notice Factory for S2SPublicationModule proxies, version 3.
 *
 * The protocol safe is the only address that can set the implementation.
 * `latestImplementation` decides which logic every later `createModule` proxy
 * runs, so a permissionless setter is a permissionless takeover of every
 * publication created from then on. V2 left `setImplementation` unguarded; V3
 * gates it on `protocolSafe`, fixed at construction and never changeable.
 *
 * The V2 factory already deployed on Base cannot be patched: it has no admin,
 * no proxy and no initializer, so its `setImplementation` stays open forever.
 * It must be superseded by this contract, not repaired. `createModule` callers
 * must point at this factory's address; modules already deployed are untouched.
 *
 * Existing publication module proxies are UUPS. They upgrade themselves one at
 * a time, authorised by their own safe, and are not affected by this factory or
 * by any implementation change here. This contract only governs future
 * `createModule` calls and which implementation those new proxies point at.
 *
 * `createModule` is also gated: a module may only be created by the safe it
 * names, or by the protocol safe on that safe's behalf. Without this, anyone
 * could mint a proxy initialised with somebody else's safe and spoof the
 * on-chain module list returned by `getModulesForSafe`.
 */
contract S2SPublicationModuleV3Factory {
    /// @notice The only address allowed to set the implementation.
    address public immutable protocolSafe;

    /// @notice Implementation used by proxies created from now on.
    address public latestImplementation;

    /// @notice Every implementation ever set, oldest first. Version 1 is index 0.
    address[] public implementationHistory;

    /// @notice Modules created per safe, in creation order.
    mapping(address => address[]) public safeModules;

    event ImplementationDeployed(address indexed implementation, uint256 version);
    event ModuleCreated(address indexed safe, address indexed moduleProxy, address implementation);

    error ZeroAddress();
    error NotAContract(address account);
    error OnlyProtocolSafe(address caller);
    error NotSafeOrProtocolSafe(address caller, address safe);

    modifier onlyProtocolSafe() {
        if (msg.sender != protocolSafe) revert OnlyProtocolSafe(msg.sender);
        _;
    }

    constructor(address _protocolSafe, address _implementation) {
        if (_protocolSafe == address(0)) revert ZeroAddress();
        if (_implementation == address(0)) revert ZeroAddress();
        // A safe without code (an EOA) would let a single leaked key set the
        // implementation, which re-opens the hole this factory exists to close.
        if (_protocolSafe.code.length == 0) revert NotAContract(_protocolSafe);
        if (_implementation.code.length == 0) revert NotAContract(_implementation);

        protocolSafe = _protocolSafe;
        latestImplementation = _implementation;
        implementationHistory.push(_implementation);
        emit ImplementationDeployed(_implementation, implementationHistory.length);
    }

    /**
     * @notice Set the implementation used by future `createModule` calls.
     * @dev Only the protocol safe. Existing proxies are unaffected.
     */
    function setImplementation(address _implementation) external onlyProtocolSafe {
        if (_implementation == address(0)) revert ZeroAddress();
        if (_implementation.code.length == 0) revert NotAContract(_implementation);

        latestImplementation = _implementation;
        implementationHistory.push(_implementation);
        emit ImplementationDeployed(_implementation, implementationHistory.length);
    }

    /**
     * @notice Deploy a publication module proxy for `safe`.
     * @dev Callable by `safe` itself, or by the protocol safe on its behalf.
     */
    function createModule(
        address safe,
        address[] memory _authors,
        address[] memory _devs
    ) public returns (address moduleProxy) {
        if (safe == address(0)) revert ZeroAddress();
        if (msg.sender != safe && msg.sender != protocolSafe) {
            revert NotSafeOrProtocolSafe(msg.sender, safe);
        }

        bytes memory initializer = abi.encodeWithSignature(
            "initialize(address,address[],address[])",
            safe,
            _authors,
            _devs
        );
        moduleProxy = address(new ERC1967Proxy(latestImplementation, initializer));
        safeModules[safe].push(moduleProxy);
        emit ModuleCreated(safe, moduleProxy, latestImplementation);
        return moduleProxy;
    }

    function createModuleEmpty(address safe) external returns (address moduleProxy) {
        address[] memory empty = new address[](0);
        return createModule(safe, empty, empty);
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
