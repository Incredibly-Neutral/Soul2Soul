// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @dev The one call this factory makes on a module it has just deployed. Kept
///      local and tiny on purpose: importing the module's ABI would tie the
///      factory to one implementation, and the whole point of
///      `implementationHistory` is that implementations are replaceable.
interface IPublicationModuleInitializer {
    function initialize(address safe, address[] calldata authors, address[] calldata devs) external;
}

/// @dev The getter every gated implementation answers, and the only thing this
///      factory asks of a candidate implementation. V4 declares it; V3 and
///      earlier have no such function and fail the staticcall. Declared local
///      and by capability rather than imported, so a later module version that
///      keeps the field passes without this file knowing its name.
interface IPublicationModuleUpgradeGate {
    function factory() external view returns (address);
}

/**
 * @notice Factory for S2SPublicationModule proxies, version 4, deployed at a
 *         predictable address.
 *
 * Same trust model as `S2SPublicationModuleV3Factory`: `protocolSafe` is the
 * only address that can set the implementation, and `createModule` may only be
 * called by the safe it names, or by the protocol safe on that safe's behalf.
 * The difference is the deploy path — `CREATE2` instead of `CREATE` — so a
 * publication's module address is computable from its safe, not found by
 * scanning module names or reading logs back.
 *
 * V4 adds one thing: `isApprovedImplementation`, and every implementation this
 * factory has ever been set to is approved. `S2SPublicationModuleV4` refuses an
 * upgrade to anything else, reading that predicate through the address it
 * recorded at `initialize`. Approval therefore has one writer (the protocol
 * safe, via `setImplementation`) and it is append-only: a superseded
 * implementation stays legal, so a publication can roll back without asking
 * anyone.
 *
 * Approving the whole history is only sound because everything in it carries the
 * gate, so the constructor and `setImplementation` refuse an implementation that
 * does not answer `factory()`. Approving a module without the field would
 * approve the way around it: a publication's safe could upgrade to that
 * implementation, and from there name anything at all.
 *
 * Why the address is predictable:
 *
 *   - The init code carries no arrays. `ERC1967Proxy` is constructed with empty
 *     data and `initialize(safe, authors, devs)` is a separate call in the same
 *     transaction. A proxy's `CREATE2` address is a hash of the deployer, the
 *     salt and the init code; the init code is the proxy's creation code plus
 *     `abi.encode(implementation, "")`, which no caller-supplied list can
 *     change. The prediction therefore depends on the safe alone, and both
 *     `createModule` and `createModuleEmpty` land on the same address for the
 *     same safe.
 *   - The salt is fixed per safe: `keccak256(abi.encode(MODULE_ROLE, safe))`,
 *     with no counter and no caller input. One publication has one module, so
 *     there is exactly one address per safe per implementation, and a caller
 *     cannot grind a salt to choose where its module lands.
 *   - Because the address is one per safe, `createModule` is idempotent per
 *     safe: if the factory has already created a module for it, the recorded
 *     proxy is returned and nothing is deployed. Re-running a route that
 *     creates modules is harmless, and the authors/devs arguments of a repeat
 *     call are ignored rather than silently applied — `initialize` cannot run a
 *     second time on a live proxy.
 *
 * What `setImplementation` does to a module's address. The implementation is
 * part of the init code, so the prediction moves when the implementation does.
 * `moduleAddress(safe)` is the address `createModule(safe)` answers with right
 * now: the module already recorded for that safe if there is one, and the
 * prediction under the current implementation otherwise. A publication created
 * earlier therefore keeps reporting the address it was born at. Where a create
 * under a given implementation would have landed is the other question, and
 * `moduleAddressForVersion(safe, version)` answers it: 1-based over
 * `implementationHistory`, so version 1 is the implementation this factory was
 * constructed with. Neither view is a record of what the safe has enabled; that
 * stays the safe's own module list.
 *
 * A revert in `initialize` reverts the whole create, including the proxy
 * deployment, so a failed create leaves no code at the predicted address and a
 * retry with the same safe succeeds.
 */
contract S2SPublicationModuleV4Create2Factory {
    /// @notice The only address allowed to set the implementation.
    address public immutable protocolSafe;

    /// @notice Implementation used by proxies created from now on.
    address public latestImplementation;

    /// @notice Every implementation ever set, oldest first. Version 1 is index 0.
    address[] public implementationHistory;

    /// @notice The set a V4 module accepts as an upgrade target.
    /// @dev Written only by the constructor and `setImplementation`, so it holds
    ///      every implementation in `implementationHistory` and nothing else.
    mapping(address implementation => bool) public isApprovedImplementation;

    /// @notice Modules created per safe. At most one: `createModule` is idempotent.
    mapping(address => address[]) public safeModules;

    /// @dev The salt domain. One module kind per factory, so the domain keeps
    ///      this address apart from any other CREATE2 deployer in the protocol.
    bytes32 private constant MODULE_ROLE = keccak256("s2s.publication.module");

    event ImplementationDeployed(address indexed implementation, uint256 version);
    event ModuleCreated(address indexed safe, address indexed moduleProxy, address implementation);

    error ZeroAddress();
    error NotAContract(address account);
    error ImplementationWithoutUpgradeGate(address implementation);
    error OnlyProtocolSafe(address caller);
    error NotSafeOrProtocolSafe(address caller, address safe);
    error InvalidVersion();

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
        _requireUpgradeGate(_implementation);

        protocolSafe = _protocolSafe;
        latestImplementation = _implementation;
        implementationHistory.push(_implementation);
        isApprovedImplementation[_implementation] = true;
        emit ImplementationDeployed(_implementation, implementationHistory.length);
    }

    /**
     * @notice Set the implementation used by future `createModule` calls.
     * @dev Only the protocol safe. Existing proxies are unaffected, and so is
     *      their address: `moduleAddress` moves, `moduleAddressForVersion` does
     *      not. The new implementation also becomes a legal upgrade target for
     *      every V4 module already deployed, without touching any of them.
     */
    function setImplementation(address _implementation) external onlyProtocolSafe {
        if (_implementation == address(0)) revert ZeroAddress();
        if (_implementation.code.length == 0) revert NotAContract(_implementation);
        _requireUpgradeGate(_implementation);

        latestImplementation = _implementation;
        implementationHistory.push(_implementation);
        isApprovedImplementation[_implementation] = true;
        emit ImplementationDeployed(_implementation, implementationHistory.length);
    }

    /**
     * @notice Deploy a publication module proxy for `safe`, at the address
     *         `moduleAddress(safe)` reported before the call.
     * @dev Callable by `safe` itself, or by the protocol safe on its behalf.
     *      Idempotent per safe: a second call returns the proxy already
     *      recorded, deploys nothing and emits nothing.
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
        if (safeModules[safe].length != 0) return safeModules[safe][0];

        address implementation = latestImplementation;
        moduleProxy = address(new ERC1967Proxy{salt: _salt(safe)}(implementation, ""));
        // The proxy's constructor was given no calldata, so this is the first
        // and only initializer run. It is a call on the proxy, not on the
        // implementation: the arguments are stored in the proxy's storage.
        IPublicationModuleInitializer(moduleProxy).initialize(safe, _authors, _devs);

        safeModules[safe].push(moduleProxy);
        emit ModuleCreated(safe, moduleProxy, implementation);
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
        if (version == 0 || version > implementationHistory.length) revert InvalidVersion();
        return implementationHistory[version - 1];
    }

    /// @notice The address `createModule(safe)` answers with right now: the
    ///         module already created for this safe, otherwise where the next
    ///         create would deploy.
    function moduleAddress(address safe) external view returns (address) {
        address[] storage created = safeModules[safe];
        if (created.length != 0) return created[0];
        return _predict(latestImplementation, safe);
    }

    /// @notice Where `createModule(safe)` would have deployed under `version`.
    /// @dev 1-based over `implementationHistory`; reverts `InvalidVersion`
    ///      outside `1..implementationCount()`. This answers for a generation,
    ///      not for the module the safe has: only `moduleAddress` follows the
    ///      module that exists.
    function moduleAddressForVersion(address safe, uint256 version) external view returns (address) {
        if (version == 0 || version > implementationHistory.length) revert InvalidVersion();
        return _predict(implementationHistory[version - 1], safe);
    }

    // ── Internal ───────────────────────────────────────────────────

    /**
     * @dev Refuse an implementation that does not carry the upgrade gate.
     *      `isApprovedImplementation` is true for everything ever set, and a V4
     *      module trusts this factory for its whole upgrade rule, so approving
     *      code whose `_authorizeUpgrade` is the publication-safe check alone
     *      would hand that right back to each publication, permanently: the
     *      module that took it no longer reads this factory. The set may
     *      therefore only hold implementations that answer `factory()`. A bare
     *      V4 implementation answers zero and passes; V3 and earlier have no
     *      such function and revert here. A presence test, not a proof of what
     *      the code does with the field.
     */
    function _requireUpgradeGate(address implementation) private view {
        (bool ok, bytes memory answer) = implementation.staticcall(
            abi.encodeWithSelector(IPublicationModuleUpgradeGate.factory.selector)
        );
        if (!ok || answer.length != 32) revert ImplementationWithoutUpgradeGate(implementation);
    }

    /// @dev keccak256(abi.encode(MODULE_ROLE, safe)). No counter and no caller
    ///      input: one publication, one module address, per implementation.
    function _salt(address safe) private pure returns (bytes32) {
        return keccak256(abi.encode(MODULE_ROLE, safe));
    }

    /// @dev The proxy's creation code plus its constructor arguments, which are
    ///      the implementation and an empty initializer. The same bytes
    ///      `new ERC1967Proxy{salt: ...}(implementation, "")` hashes, which is
    ///      what keeps the prediction and the deployment from drifting.
    function _initCode(address implementation) private pure returns (bytes memory) {
        return abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(implementation, bytes(""))
        );
    }

    function _predict(address implementation, address safe) private view returns (address) {
        bytes32 digest = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                _salt(safe),
                keccak256(_initCode(implementation))
            )
        );
        return address(uint160(uint256(digest)));
    }
}
