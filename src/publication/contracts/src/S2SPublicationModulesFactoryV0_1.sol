// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {S2SModuleProxy} from "./S2SModuleProxy.sol";

/// @dev What an implementation must answer for the factory to accept it. Both
///      are read as raw words: `abi.decode` would revert on a malformed answer,
///      turning a refusal into a panic.
interface IS2SModuleKind {
    function moduleKind() external view returns (bytes32);
    function factory() external view returns (address);
}

/// @dev The initializer the factory always calls on a new module. The Safe comes
///      from the factory, never from the caller, so the module's owner and its
///      record cannot disagree.
interface IS2SModuleInit {
    function initialize(address safe, bytes calldata params) external;
}

/// @dev UUPS implementations answer this. A module whose implementation does not
///      answer it, or answers a different slot, has no upgrade door, so every
///      module that moved to it would be frozen there.
interface IS2SUUPS {
    function proxiableUUID() external view returns (bytes32);
}

/**
 * @notice Deploys and identifies protocol modules, one kind at a time.
 *
 * Provenance, not self-description. A module cannot be recognised because it
 * says what it is; any contract can answer a name. It is recognised because this
 * factory deployed it, for this Safe, as this kind. `recordOf` is that
 * statement, written at creation and never overwritten, and it is the only
 * answer a client or another contract needs.
 *
 * The Safe in the record is also the Safe the module is initialised with. The
 * factory calls `initialize(safe, params)` itself, passing the address it just
 * recorded, so there is no argument through which a module could be tied to a
 * different publication, and no path that leaves a module uninitialised for the
 * first caller to take.
 *
 * The address of a module is a function of (factory, safe, kind) and nothing
 * else. The proxy takes no constructor arguments, so its creation code is a
 * constant; the salt is `keccak256(abi.encode(kind, safe))`. Setting a new
 * implementation for a kind therefore moves nothing: every address stays what it
 * was, and a client computes it offline instead of reading it back.
 *
 * Kinds are separate in three places, because one shared set would let a module
 * of one kind upgrade to another kind's implementation and collide with it in
 * storage: implementations are approved per kind, `latestImplementation` is per
 * kind, and an implementation declares its kind, which `setImplementation`
 * checks against the kind it is being set for.
 *
 * The protocol adds upgrade targets and never moves a publication: it sets an
 * implementation, and each publication's Safe decides when to move its own
 * modules. A target can also be withdrawn: `revokeImplementation` clears its
 * approval, so no module can move onto it afterwards, and the withdrawal is
 * permanent, because the reason to revoke a build is a flaw in that build.
 */
contract S2SPublicationModulesFactoryV0_1 {
    /// @notice The manifest's major.minor, which this build implements. The
    ///         factory is deployed once per protocol release; the number is what
    ///         a reader compares a document's prefix against.
    string public constant VERSION = "0.1";

    /// @notice The only address that may set or revoke an implementation.
    /// @dev Checked for code in the constructor, so a key alone cannot hold this
    ///      privilege at deploy time. That check is not a guarantee: under
    ///      EIP-7702 a code-bearing account's key can still delegate it, so the
    ///      address is trusted because of who controls it, not because it answers
    ///      `code.length`.
    address public immutable protocolSafe;

    /// @notice keccak256 of the proxy's creation code, computed once. The proxy
    ///      takes no constructor arguments, so this is the whole init code and
    ///      no implementation address enters the address formula.
    bytes32 public immutable proxyInitCodeHash;

    /// @dev The ERC-1967 implementation slot, which every UUPS implementation
    ///      returns from `proxiableUUID()`.
    bytes32 private constant ERC1967_IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    /// @dev Transient storage, so a create pays one transient write instead of a
    ///      persistent one, and nothing is left behind for a later reader to
    ///      mistake for the live implementation.
    bytes32 private constant BOOTSTRAP_SLOT =
        0x6e909fd6f96e7f8dd7757787c137a8fc6710483bda40407c97f5c38c6a5993aa;

    /// @notice Implementation `createModule` builds new modules of a kind over.
    /// @dev Not the only legal upgrade target: every approved implementation of
    ///      the kind is, so a module can move forward or back within the set.
    mapping(bytes32 kind => address implementation) public latestImplementation;

    /// @notice Which implementations each kind accepts as an upgrade target.
    mapping(bytes32 kind => mapping(address implementation => bool)) public isApproved;

    /// @notice Implementations withdrawn for good. A revoked build cannot be set
    ///      again, and cannot be an upgrade target.
    mapping(bytes32 kind => mapping(address implementation => bool)) public isRevoked;

    /// @notice 1-based position of an implementation in its kind's history.
    ///      Written when the implementation is first accepted, so a rollback
    ///      reports the version of the build it moves to, not the history length.
    mapping(bytes32 kind => mapping(address implementation => uint256)) public versionOf;

    /// @notice Every implementation ever accepted for a kind, oldest first.
    mapping(bytes32 kind => address[] implementations) public implementationHistory;

    /// @notice The module of this kind this factory deployed for this safe.
    mapping(address safe => mapping(bytes32 kind => address module)) public moduleOf;

    /// @notice A module's provenance: which Safe it was deployed for, and as
    ///         which kind. Zero for anything this factory did not deploy.
    struct Record {
        address safe;
        bytes32 kind;
    }

    mapping(address module => Record record) public recordOf;

    event ImplementationSet(bytes32 indexed kind, address indexed implementation, uint256 version);
    event ImplementationWithdrawn(bytes32 indexed kind, address indexed implementation, address latest);
    event ModuleCreated(
        address indexed safe,
        bytes32 indexed kind,
        address indexed module,
        address implementation
    );

    error ZeroAddress();
    error ZeroKind();
    error NotAContract(address account);
    error OnlyProtocolSafe(address caller);
    error NotSafeOrProtocolSafe(address caller, address safe);
    error NoImplementation(bytes32 kind);
    error ImplementationNotGated(address implementation, address gate);
    error ImplementationKindMismatch(address implementation, bytes32 kind, bytes32 declared);
    error NotUUPS(address implementation);
    error ImplementationRevoked(address implementation);
    error NotApproved(address implementation);
    error InitializerFailed(address module, bytes reason);
    error InvalidVersion();

    modifier onlyProtocolSafe() {
        if (msg.sender != protocolSafe) revert OnlyProtocolSafe(msg.sender);
        _;
    }

    /**
     * @param _protocolSafe The only address that may set or revoke an
     *        implementation. Must have code.
     */
    constructor(address _protocolSafe) {
        if (_protocolSafe == address(0)) revert ZeroAddress();
        if (_protocolSafe.code.length == 0) revert NotAContract(_protocolSafe);
        protocolSafe = _protocolSafe;
        proxyInitCodeHash = keccak256(type(S2SModuleProxy).creationCode);
    }

    /**
     * @notice Set the implementation for `kind`: what future modules of that kind
     *         are built over, and a legal upgrade target for existing ones.
     * @dev Only the protocol safe. Existing modules keep their address and their
     *      implementation; they gain the new one as a target.
     *
     *      The implementation must name this factory in its gate and declare the
     *      kind it is being set for. The first stops an implementation whose
     *      upgrades are judged by another set from entering this one. The second
     *      stops a module of one kind being handed another kind's code, which
     *      would run against the wrong storage layout.
     *
     *      The third check is that the implementation is UUPS: it must answer
     *      `proxiableUUID()` with this slot. It is a declaration like the other
     *      two, and a declaration is all the factory can read, but without it a
     *      module that moves to the implementation has no upgrade door and no
     *      way back.
     *
     *      Setting an implementation already in the kind's history moves the
     *      pointer and nothing else: no new entry, no new approval, one event
     *      naming the version that implementation already has. Rollback is
     *      therefore a normal call, and the address it returns to still carries
     *      the gate, so a module moved back can upgrade again.
     *
     *      A revoked implementation can never be set again.
     */
    function setImplementation(bytes32 kind, address implementation) external onlyProtocolSafe {
        if (kind == bytes32(0)) revert ZeroKind();
        if (implementation == address(0)) revert ZeroAddress();
        if (implementation.code.length == 0) revert NotAContract(implementation);
        if (isRevoked[kind][implementation]) revert ImplementationRevoked(implementation);

        address gate = _gateOf(implementation);
        if (gate != address(this)) revert ImplementationNotGated(implementation, gate);
        bytes32 declared = _kindOf(implementation);
        if (declared != kind) revert ImplementationKindMismatch(implementation, kind, declared);
        if (!_isUUPS(implementation)) revert NotUUPS(implementation);

        uint256 version = versionOf[kind][implementation];
        if (version == 0) {
            version = implementationHistory[kind].length + 1;
            versionOf[kind][implementation] = version;
            isApproved[kind][implementation] = true;
            implementationHistory[kind].push(implementation);
        }
        latestImplementation[kind] = implementation;
        emit ImplementationSet(kind, implementation, version);
    }

    /**
     * @notice Withdraw an implementation: modules of `kind` can no longer move
     *         onto it, and it can never be set for them again.
     * @dev Only the protocol safe. Permanent: a build is revoked because it is
     *      wrong, so re-admitting it silently would defeat the purpose.
     *
     *      If the withdrawn implementation was the newest, the pointer moves back
     *      to the most recent implementation of that kind still approved, or to
     *      zero when none is left. Modules already running it keep running it:
     *      this decides where they may move, not what they execute.
     *
     *      The gate of a module must read `isApproved` at the moment of the
     *      upgrade for this to bind, which is why the check lives there and not in
     *      the factory.
     */
    function revokeImplementation(bytes32 kind, address implementation) external onlyProtocolSafe {
        if (!isApproved[kind][implementation]) revert NotApproved(implementation);
        isApproved[kind][implementation] = false;
        isRevoked[kind][implementation] = true;

        if (latestImplementation[kind] == implementation) {
            latestImplementation[kind] = _lastApproved(kind);
        }
        emit ImplementationWithdrawn(kind, implementation, latestImplementation[kind]);
    }

    /**
     * @notice Deploy the module of `kind` for `safe` at `moduleAddress(safe,
     *         kind)`, or return the one already recorded for that pair.
     * @dev Callable by `safe` itself, or by the protocol safe on its behalf.
     *      Idempotent per (safe, kind): a retried transaction returns
     *      `(module, false)` instead of minting a second module, and `params` are
     *      not applied a second time.
     *
     *      The initializer is always called, by this contract, with the Safe that
     *      was just recorded. A module therefore cannot come into existence
     *      uninitialised, and cannot be initialised for a publication other than
     *      the one it is recorded for.
     */
    function createModule(
        address safe,
        bytes32 kind,
        bytes calldata params
    ) public returns (address module, bool created) {
        if (safe == address(0)) revert ZeroAddress();
        if (kind == bytes32(0)) revert ZeroKind();
        if (msg.sender != safe && msg.sender != protocolSafe) {
            revert NotSafeOrProtocolSafe(msg.sender, safe);
        }
        address existing = moduleOf[safe][kind];
        if (existing != address(0)) return (existing, false);

        address implementation = latestImplementation[kind];
        if (implementation == address(0)) revert NoImplementation(kind);

        // Read by the proxy's constructor, which runs inside this call. Cleared
        // immediately after, so no reader outside a create can see it.
        bytes32 slot = BOOTSTRAP_SLOT;
        assembly {
            tstore(slot, implementation)
        }
        module = address(new S2SModuleProxy{salt: _salt(kind, safe)}());
        assembly {
            tstore(slot, 0)
        }

        moduleOf[safe][kind] = module;
        recordOf[module] = Record({safe: safe, kind: kind});
        emit ModuleCreated(safe, kind, module, implementation);

        try IS2SModuleInit(module).initialize(safe, params) {} catch (bytes memory reason) {
            revert InitializerFailed(module, reason);
        }
        created = true;
    }

    // ── Views ──────────────────────────────────────────────────────

    /// @notice The implementation a proxy is told to run, while one is being
    ///         created. Zero at every other moment.
    function bootstrapImplementation() external view returns (address implementation) {
        bytes32 slot = BOOTSTRAP_SLOT;
        assembly {
            implementation := tload(slot)
        }
    }

    /// @notice The module of `kind` for `safe`, or the address `createModule`
    ///         would deploy at right now when it has none. Zero when no
    ///         implementation is set for the kind, because then there is no
    ///         address a create would use and a reader must not be handed one.
    /// @dev Computed from the init code hash and the salt, so the answer is the
    ///      same forever, and the same before and after any `setImplementation`.
    function moduleAddress(address safe, bytes32 kind) public view returns (address) {
        address existing = moduleOf[safe][kind];
        if (existing != address(0)) return existing;
        if (latestImplementation[kind] == address(0)) return address(0);
        return _predict(kind, safe);
    }

    /// @notice Which Safe a module was deployed for, and as which kind. Both zero
    ///         for anything this factory did not deploy.
    function provenance(address module) external view returns (address safe, bytes32 kind) {
        Record memory record = recordOf[module];
        return (record.safe, record.kind);
    }

    /// @notice The version of `implementation` for `kind`, or 0 when the kind
    ///         never accepted it. This is how a client turns the implementation
    ///         behind a proxy into the version that picks its ABI, without asking
    ///         the module what it is.
    function implementationVersion(bytes32 kind, address implementation) external view returns (uint256) {
        return versionOf[kind][implementation];
    }

    function implementationCount(bytes32 kind) external view returns (uint256) {
        return implementationHistory[kind].length;
    }

    function getImplementationByVersion(bytes32 kind, uint256 version) external view returns (address) {
        address[] storage history = implementationHistory[kind];
        if (version == 0 || version > history.length) revert InvalidVersion();
        return history[version - 1];
    }

    // ── Internal ───────────────────────────────────────────────────

    /// @dev The most recent implementation of `kind` that is still approved.
    function _lastApproved(bytes32 kind) private view returns (address) {
        address[] storage history = implementationHistory[kind];
        for (uint256 i = history.length; i > 0; --i) {
            address candidate = history[i - 1];
            if (isApproved[kind][candidate]) return candidate;
        }
        return address(0);
    }

    /// @dev The address an implementation answers `factory()` with, or zero when
    ///      it answers nothing, answers something that is not an address, or
    ///      reverts.
    function _gateOf(address implementation) private view returns (address) {
        (bool ok, bytes memory answer) = implementation.staticcall(
            abi.encodeWithSelector(IS2SModuleKind.factory.selector)
        );
        if (!ok || answer.length != 32) return address(0);
        uint256 word;
        assembly {
            word := mload(add(answer, 32))
        }
        // A word wider than an address is not an answer, it is noise: refuse it
        // rather than truncate it into looking like this factory.
        if (word > type(uint160).max) return address(0);
        return address(uint160(word));
    }

    /// @dev Whether the implementation answers `proxiableUUID()` with the
    ///      ERC-1967 implementation slot. Reading the slot from a proxy would
    ///      revert, so this is only ever asked of the implementation itself.
    function _isUUPS(address implementation) private view returns (bool) {
        (bool ok, bytes memory answer) = implementation.staticcall(
            abi.encodeWithSelector(IS2SUUPS.proxiableUUID.selector)
        );
        if (!ok || answer.length != 32) return false;
        bytes32 uuid;
        assembly {
            uuid := mload(add(answer, 32))
        }
        return uuid == ERC1967_IMPLEMENTATION_SLOT;
    }

    /// @dev The kind an implementation declares, or zero when it declares none.
    function _kindOf(address implementation) private view returns (bytes32) {
        (bool ok, bytes memory answer) = implementation.staticcall(
            abi.encodeWithSelector(IS2SModuleKind.moduleKind.selector)
        );
        if (!ok || answer.length != 32) return bytes32(0);
        bytes32 declared;
        assembly {
            declared := mload(add(answer, 32))
        }
        return declared;
    }

    /// @dev keccak256(abi.encode(kind, safe)). No counter and no caller input:
    ///      one publication, one module address per kind, for good.
    function _salt(bytes32 kind, address safe) private pure returns (bytes32) {
        return keccak256(abi.encode(kind, safe));
    }

    /// @dev CREATE2 derivation over the constant init code.
    function _predict(bytes32 kind, address safe) private view returns (address) {
        bytes32 digest = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), _salt(kind, safe), proxyInitCodeHash)
        );
        return address(uint160(uint256(digest)));
    }
}
