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

/**
 * @dev The three declarations a records module publishes. `safe()` is on
 *      `S2SRecordsModuleV0_1`; `moduleKind()` and `factory()` are the pair the
 *      publication factory already uses to judge a module, reused here so a stub
 *      that only echoes `safe()` cannot impersonate one.
 */
interface IAuthorRecordsModule {
    function safe() external view returns (address);
    function moduleKind() external view returns (bytes32);
    function factory() external view returns (address);
}

/**
 * @dev The one fact `AuthorFactory` can prove and a module cannot: that factory
 *      records the module it created for each Safe. `factory()` is answered by
 *      the implementation behind the proxy, so it is a claim; this mapping is
 *      written only by `createRecordsModule`.
 */
interface IAuthorFactory {
    function recordsModule(address safe) external view returns (address);
}

/**
 * @title S2SAuthorGate
 * @notice Answers whether an address is an author Safe holding `recordsModule`
 *         as its records module.
 *
 *         Four values are fixed at construction and there is no admin:
 *         `singletons` (Safe singleton implementations), `proxyCodehashes` (the
 *         runtime code hash of Safe's proxy), `authorFactories` (the factories
 *         allowed to have made the records module), and
 *         `moduleProxyCodehash` (the runtime code hash of the module proxy).
 *         Verify all four against the chain this gate is deployed to, not by
 *         guessing: a wrong code hash rejects every real Safe or module, and a
 *         wrong singleton accepts a proxy pointed at a fake implementation.
 *
 *         The Safe side. The code hash anchors the proxy: a plain contract can
 *         answer `masterCopy()`, but it cannot have the proxy's runtime code.
 *         That is still not provenance — anyone can deploy a contract with that
 *         code, including a working Safe proxy built outside the canonical
 *         factory — so the hash proves "Safe proxy code", not "a Safe someone
 *         vetted". The proxy answers `masterCopy()` from its own dispatcher, so
 *         a contract that passed the hash test cannot lie about which singleton
 *         it is proxying onto.
 *
 *         The module side. A Safe can enable any contract, including a stub it
 *         just deployed, and a stub can answer `safe()` with the Safe that made
 *         it. The runtime code must be the module proxy code and `moduleKind()`
 *         the records kind, but `factory()` is answered by the implementation
 *         behind the proxy, so anyone can deploy the same proxy runtime over an
 *         implementation naming an allowlisted factory. The proof is the
 *         factory's own index: `IAuthorFactory(factory).recordsModule(safe)`
 *         must return this module, and only the factory writes that mapping.
 *         Only then is the module accepted as enabled and bound to this Safe.
 *
 *         No try/catch. A contract that passed the Safe proxy hash test cannot
 *         revert on `masterCopy()`, and a module proxy whose implementation
 *         reverts on these reads fails the registration rather than being
 *         treated as a no.
 */
contract S2SAuthorGate {

    /// @dev `keccak256("s2s.module.records")`, the kind `S2SRecordsModuleV0_1`
    ///      publishes and the publication factory approves upgrades against.
    bytes32 public constant RECORDS_KIND = keccak256("s2s.module.records");

    mapping(address => bool) private _singleton;
    mapping(bytes32 => bool) private _proxyCodehash;
    mapping(address => bool) private _authorFactory;
    bytes32 private immutable _moduleProxyCodehash;

    /**
     * @param singletons The Safe singleton implementations this chain's proxies
     *        may point at.
     * @param proxyCodehashes The keccak256 of Safe's proxy runtime code as
     *        deployed on this chain. Compare with `keccak256(eth_getCode(proxy))`
     *        for a Safe you trust, and re-verify after any Safe release.
     * @param authorFactories The factories allowed to have deployed the records
     *        module. `AuthorFactory` is one; a module naming any other factory is
     *        refused even when its code and kind are right. A listed factory must
     *        also answer `recordsModule(safe)` with this module.
     * @param moduleProxyCodehash The keccak256 of the runtime code of the proxy
     *        `AuthorFactory` deploys for a records module — OpenZeppelin's
     *        `ERC1967Proxy`, not `S2SModuleProxy`. Every records module the
     *        factory deploys shares that runtime code. Read it from a records
     *        module the factory created; a creation-code hash is not this value.
     */
    constructor(
        address[] memory singletons,
        bytes32[] memory proxyCodehashes,
        address[] memory authorFactories,
        bytes32 moduleProxyCodehash
    ) {
        for (uint256 i = 0; i < singletons.length; i++) {
            _singleton[singletons[i]] = true;
        }
        for (uint256 i = 0; i < proxyCodehashes.length; i++) {
            _proxyCodehash[proxyCodehashes[i]] = true;
        }
        for (uint256 i = 0; i < authorFactories.length; i++) {
            _authorFactory[authorFactories[i]] = true;
        }
        _moduleProxyCodehash = moduleProxyCodehash;
    }

    /// @notice True only when `safe` is Safe proxy code, proxies onto an allowed
    ///         singleton, and holds a module that is module-proxy code from an
    ///         allowed factory, of the records kind, enabled on that Safe and
    ///         bound to it.
    function isAuthor(address safe, address recordsModule) external view returns (bool) {
        if (safe.code.length == 0) return false;
        if (!_proxyCodehash[safe.codehash]) return false;
        if (!_singleton[ISafeProxy(safe).masterCopy()]) return false;

        if (recordsModule.code.length == 0) return false;
        if (recordsModule.codehash != _moduleProxyCodehash) return false;
        IAuthorRecordsModule module = IAuthorRecordsModule(recordsModule);
        if (module.moduleKind() != RECORDS_KIND) return false;
        address factory = module.factory();
        if (!_authorFactory[factory]) return false;
        if (IAuthorFactory(factory).recordsModule(safe) != recordsModule) return false;
        if (!ISafeModuleManager(safe).isModuleEnabled(recordsModule)) return false;
        return module.safe() == safe;
    }
}
