// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice The question `S2SRegistry` asks before it accepts a registration.
interface IAuthorGate {
    function isAuthor(address safe, address recordsModule) external view returns (bool);
}

/// @dev The two declarations a Safe proxy answers from its own code.
interface ISafeProxy {
    function masterCopy() external view returns (address);
}

interface ISafeModuleManager {
    function isModuleEnabled(address module) external view returns (bool);
}

/// @dev `S2SRecordsModuleV0_1` publishes `safe()`.
interface IAuthorRecordsModule {
    function safe() external view returns (address);
}

/**
 * @title S2SAuthorGate
 * @notice Answers whether an address is an author Safe holding `recordsModule`
 *         as its records module.
 *
 *         Two allowlists are fixed at construction and there is no admin:
 *         `singletons` (Safe singleton implementations) and `proxyCodehashes`
 *         (the runtime code hash of Safe's proxy). Both must be verified
 *         against the Safe deployments on the chain this gate is deployed to,
 *         not guessed — a gate with a wrong code hash rejects every real Safe,
 *         and a gate with a wrong singleton accepts a proxy pointed at a fake
 *         implementation.
 *
 *         The order matters. The code hash is the anchor: any contract can
 *         answer `masterCopy()`, but only Safe's proxy has the proxy runtime
 *         code. The proxy then answers `masterCopy()` from its own dispatcher,
 *         so a fake singleton contract cannot lie about which singleton a
 *         contract that passed the code-hash test is proxying onto. Only then
 *         is the module read: it must be enabled on the Safe, and the module
 *         must answer that *this* Safe is its own.
 *
 *         No try/catch. A contract that passed the code-hash test is Safe's
 *         proxy and its `masterCopy()` cannot revert; if the module's `safe()`
 *         reverts, the call reverts and the caller is not an authorised author.
 *         A module with no code is rejected before the call, so an EOA passed
 *         as `recordsModule` is `false`, not a revert from an empty call.
 */
contract S2SAuthorGate {

    mapping(address => bool) private _singleton;
    mapping(bytes32 => bool) private _proxyCodehash;

    /**
     * @param singletons The Safe singleton implementations this chain's proxies
     *        may point at.
     * @param proxyCodehashes The keccak256 of Safe's proxy runtime code as
     *        deployed on this chain. Compare with `keccak256(eth_getCode(proxy))`
     *        for a Safe you trust, and re-verify after any Safe release.
     */
    constructor(address[] memory singletons, bytes32[] memory proxyCodehashes) {
        for (uint256 i = 0; i < singletons.length; i++) {
            _singleton[singletons[i]] = true;
        }
        for (uint256 i = 0; i < proxyCodehashes.length; i++) {
            _proxyCodehash[proxyCodehashes[i]] = true;
        }
    }

    /// @notice True only when `safe` is Safe's proxy code, proxies onto an
    ///         allowed singleton, has `recordsModule` enabled, and that module
    ///         answers `safe()` with `safe`.
    function isAuthor(address safe, address recordsModule) external view returns (bool) {
        if (safe.code.length == 0) return false;
        if (!_proxyCodehash[safe.codehash]) return false;
        if (!_singleton[ISafeProxy(safe).masterCopy()]) return false;
        if (recordsModule.code.length == 0) return false;
        if (!ISafeModuleManager(safe).isModuleEnabled(recordsModule)) return false;
        return IAuthorRecordsModule(recordsModule).safe() == safe;
    }
}
