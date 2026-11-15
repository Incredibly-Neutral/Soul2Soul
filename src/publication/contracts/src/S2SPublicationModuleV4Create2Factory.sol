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
 * This contract is the index of "the module this publication runs". A reader
 * asks it, by safe, instead of enumerating the Safe's modules and matching
 * `NAME()`. The identity in the index is address equality: `moduleAddress(safe)`
 * and `safeModules(safe)` name one address per safe, and nothing about that
 * address is read from a string the module publishes. Two proxies over the same
 * implementation are two modules, and a module that answers `NAME()` like
 * another is a different module, because the question is which address the
 * protocol recorded, not what the code calls itself.
 *
 * `registerModule` is how a module this factory did not deploy gets into the
 * index, and it is the protocol safe's write, never the publication's. A
 * publication's Safe may enable any module it likes; only the protocol safe can
 * make this contract say which one is the publication's module. A registered
 * module is permanent: the index is written once per safe and never overwritten,
 * so the answer cannot be moved out from under a reader by a later call.
 *
 * The legacy branch exists for publications that already exist. A V2 or V3
 * publication runs at a plain-CREATE address it cannot leave, and its proxy was
 * in most cases upgraded to V4 in place; the same publication re-created at its
 * CREATE2 address would be a different proxy with empty storage, not a move.
 * So the constructor takes the V2 and V3 implementations, and `registerModule`
 * takes the implementation alongside the module and refuses unless it is one of
 * them.
 *
 * That argument is named by the caller, not read here, and the reason is the
 * EVM: a contract cannot read another account's storage, so this one cannot
 * `sload` a proxy's ERC-1967 implementation slot
 * (`0x360894a1…382bbc`) and see what the proxy delegates to. Reading it is an
 * RPC question (`eth_getStorageAt`), which is what a caller does before it
 * builds the proposal. What this contract checks is that the protocol safe
 * named an implementation it recorded, for a module that does not answer this
 * factory. That is a recognition step, not a proof: it does not establish what
 * code runs behind the proxy, and it cannot, either for a proxy upgraded since
 * or for one built over a recorded implementation and left alone. Only the
 * factory-born branch, where the module answers `factory()` with this address
 * and the named implementation is in the approval set, ties a module to a code
 * path this contract governs.
 * *
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

    /// @notice Implementations recorded as legacy: the V2 and V3 code that
    ///         proxies created before this factory were built over.
    /// @dev Written once, by the constructor. No setter, so the set cannot grow
    ///      after deployment and no later call can widen what `registerModule`
    ///      recognises.
    mapping(address implementation => bool) public isLegacyImplementation;

    /// @notice The module this safe runs: the one `createModule` deployed for it
    ///         or the one `registerModule` adopted. At most one entry.
    mapping(address => address[]) public safeModules;

    /// @dev The salt domain. One module kind per factory, so the domain keeps
    ///      this address apart from any other CREATE2 deployer in the protocol.
    bytes32 private constant MODULE_ROLE = keccak256("s2s.publication.module");

    event ImplementationDeployed(address indexed implementation, uint256 version);
    event ModuleCreated(address indexed safe, address indexed moduleProxy, address implementation);
    event LegacyImplementationRecorded(address indexed implementation);
    event ModuleRegistered(address indexed safe, address indexed module, address implementation);

    error ZeroAddress();
    error NotAContract(address account);
    error ImplementationWithoutUpgradeGate(address implementation);
    error OnlyProtocolSafe(address caller);
    error NotSafeOrProtocolSafe(address caller, address safe);
    error InvalidVersion();
    error AlreadyRegistered(address safe, address existing);
    error ModuleNotRecognised(address module);

    modifier onlyProtocolSafe() {
        if (msg.sender != protocolSafe) revert OnlyProtocolSafe(msg.sender);
        _;
    }

    /**
     * @param _protocolSafe The only address that may set the implementation or
     *        register a module. Must have code.
     * @param _implementation The V4 implementation new proxies are created over.
     *         Must have code and answer `factory()`.
     * @param _legacyImplementations The V2 and V3 implementations existing
     *        proxies were built over. Each must have code. They are recorded as
     *        recognisable, not approved: they carry no upgrade gate, which is
     *        exactly why nothing is created over them here.
     */
    constructor(
        address _protocolSafe,
        address _implementation,
        address[] memory _legacyImplementations
    ) {
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

        for (uint256 i = 0; i < _legacyImplementations.length; ++i) {
            address legacy = _legacyImplementations[i];
            if (legacy == address(0)) revert ZeroAddress();
            // Recorded so a proxy's slot can be matched against it, which is a
            // fact about the code that exists, so the code must exist.
            if (legacy.code.length == 0) revert NotAContract(legacy);
            isLegacyImplementation[legacy] = true;
            emit LegacyImplementationRecorded(legacy);
        }
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
     *      recorded, deploys nothing and emits nothing. That includes a module
     *      recorded by `registerModule`: once a safe has an entry in the index,
     *      this function returns it and never deploys over it.
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

    /**
     * @notice Adopt `module` as the module `safe` runs, so `moduleAddress(safe)`
     *         answers it. The only way a module this factory did not deploy
     *         enters the index.
     * @dev The protocol safe's write, never the publication's: this is the
     *      protocol saying which module is a publication's module, and a
     *      publication's Safe cannot say it about itself.
     *
     *      Zero addresses and a module without code are refused. An existing
     *      entry is final: re-registering the same module returns quietly, and a
     *      different module reverts `AlreadyRegistered(safe, existing)`. Nothing
     *      overwrites the index, so a reader that resolved a module once cannot
     *      have it swapped under it.
     *
     *      A module is accepted on either of two facts:
     *
     *        a) it answers `factory()` with this address, and `implementation`
     *           is one this factory approved — a proxy deployed here, whose
     *           upgrades this contract governs; or
     *        b) it does not, and `implementation` is one the constructor
     *           recorded as legacy — a V2 or V3 publication at a plain-CREATE
     *           address it cannot leave, whose proxy was upgraded to V4 in place.
     *
     *      `implementation` is named by the caller because a contract cannot read
     *      another contract's storage: the ERC-1967 slot
     *      (`0x360894a1…382bbc`) is legible over RPC, not from inside this
     *      contract. So the legacy branch checks that the protocol safe named an
     *      implementation this factory recorded, for a module that does not claim
     *      this factory. It is a recognition step, not a proof of what the
     *      module's code does: a proxy upgraded since naming that implementation
     *      runs something else behind the same slot, and nothing here inspects
     *      it. A module that claims this factory is the only case where the
     *      approval set above actually governs the code.
     *
     *      `implementation` in `ModuleRegistered` is the argument, recorded so the
     *      index says which implementation the protocol was told to expect.
     */
    function registerModule(
        address safe,
        address module,
        address implementation
    ) external onlyProtocolSafe {
        if (safe == address(0)) revert ZeroAddress();
        if (module == address(0)) revert ZeroAddress();
        if (implementation == address(0)) revert ZeroAddress();
        if (module.code.length == 0) revert NotAContract(module);

        address[] storage registered = safeModules[safe];
        if (registered.length != 0) {
            address existing = registered[0];
            if (existing == module) return;
            revert AlreadyRegistered(safe, existing);
        }

        if (_answersThisFactory(module)) {
            if (!isApprovedImplementation[implementation]) revert ModuleNotRecognised(module);
        } else if (!isLegacyImplementation[implementation]) {
            revert ModuleNotRecognised(module);
        }

        registered.push(module);
        emit ModuleRegistered(safe, module, implementation);
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

    /// @notice The module `safe` runs: the address `createModule(safe)` answers
    ///         with right now, registered or created.
    /// @dev The index is `safeModules[safe]`, so this answers the entry no matter
    ///      how it got there: `createModule` pushes the proxy it deployed, and
    ///      `registerModule` pushes a module deployed elsewhere. Once there is an
    ///      entry, `createModule` returns it, deploys nothing and emits nothing,
    ///      so a registered module is the module for good and this view cannot
    ///      drift from it. With no entry it is the prediction under
    ///      `latestImplementation`, which names a create that has not happened.
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

    /// @dev Does `module` answer `factory()` with this address? That is true of
    ///      every proxy deployed here, because `initialize` records `msg.sender`,
    ///      which was this contract. Compared as a raw word: `abi.decode` would
    ///      revert on a malformed answer, turning a refusal into a panic.
    function _answersThisFactory(address module) private view returns (bool) {
        (bool ok, bytes memory answer) = module.staticcall(
            abi.encodeWithSelector(IPublicationModuleUpgradeGate.factory.selector)
        );
        if (!ok || answer.length != 32) return false;
        uint256 word;
        assembly {
            word := mload(add(answer, 32))
        }
        return word == uint256(uint160(address(this)));
    }

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
