// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OwnerHistoryGuard} from "./OwnerHistoryGuard.sol";

/// @dev The declarations `setRecordsImplementation` reads from a candidate
///      records implementation. Each is a one-function interface so a reverting
///      or malformed answer is caught rather than propagated.
interface IAuthorRecordsModuleKind {
    function factory() external view returns (address);
    function moduleKind() external view returns (bytes32);
}

interface IAuthorRecordsUUPS {
    function proxiableUUID() external view returns (bytes32);
}

/// @dev The initializer the factory calls on the proxy it just deployed. It
///      cannot go in the proxy constructor: the records module requires the
///      factory as `msg.sender`.
interface IAuthorRecordsModuleInit {
    function initialize(address safe, bytes calldata params) external;
}

// ===== Factory =====

/**
 * @title AuthorFactory
 * @notice The author side's one deploy path: a UUPS proxy per author Safe for
 *         the drafts log, one for the owner history plus the
 *         `OwnerHistoryGuard` wired to that proxy, and one for the records
 *         module.
 *
 *         One factory rather than three, because the modules are installed
 *         together on the same Safe and a reader that has this address has
 *         every author proxy it can verify against. The implementations keep
 *         separate version histories — moving one must never silently repoint
 *         another.
 *
 * Trust model, stated because both halves are easy to get backwards:
 *   - `setDraftsImplementation` / `setOwnerHistoryImplementation` /
 *     `setRecordsImplementation` are `onlyDeployer`. Without that gate anyone
 *     could repoint the `*Implementation()` pointer and the next
 *     `create*Module` would hand an author a proxy that, once installed,
 *     executes as the Safe. The deployer is an immutable set at construction,
 *     so there is no admin to rotate and none to compromise.
 *   - all three `create*Module` stay open **deliberately**: deploying a proxy
 *     costs the caller gas and installs nothing on any Safe. Nothing this
 *     contract does reaches the Safe's storage — no `enableModule`, no
 *     `setGuard` — so a proxy (and, for the history, a guard) is just two
 *     addresses until the Safe adopts them in its own transaction. Gating
 *     creation would buy nothing and would put a trusted party between an
 *     author and their own module.
 *   - `draftsModules` / `ownerHistoryModules` / `guards` are **indexes, not
 *     proof**. `create*Module` is permissionless, so anyone can append an entry
 *     for any Safe, and `guardFor` records what *this* factory made — it does
 *     not prove the Safe installed it. Intersect the Safe's one real adoption
 *     record (the guard slot) before treating an entry as installed.
 *   - `recordsModule` is different in one way: it holds one module per Safe,
 *     written once and never appended to. It is still not proof of
 *     installation — a proxy exists before any Safe enables it — but it is the
 *     module `createRecordsModule` will return on every later call, so a
 *     reader can rely on the address not moving.
 *   - `protocolSafe` is not an authority here. It is the address the records
 *     implementation compares its own constructor argument against, so it
 *     answers that sanity check and nothing else. The gate that decides which
 *     implementations this factory deploys and approves is `deployer`.
 */
contract AuthorFactory {

    /// @notice The account that deployed the factory; the only address allowed
    ///         to move any implementation pointer.
    address public immutable deployer;

    /// @notice The protocol Safe. The records implementation's constructor
    ///         reads it back through `protocolSafe()` and compares it with its
    ///         second argument; this factory does not treat it as an authority.
    address public immutable protocolSafe;

    /// @notice The implementation the next `createDraftsModule` proxies onto.
    address public draftsImplementation;
    /// @notice The implementation the next `createOwnerHistoryModule` proxies onto.
    address public ownerHistoryImplementation;
    /// @notice The implementation the next `createRecordsModule` proxies onto.
    address public recordsImplementation;

    address[] private draftsImplementationHistory;
    address[] private ownerHistoryImplementationHistory;
    address[] private recordsImplementationHistory;

    /**
     * @dev Proxies this factory created, per Safe — **an index, not proof**.
     *      Creation is permissionless, so anyone can push an entry for any Safe
     *      here; read it only against the Safe's own adoption record.
     */
    mapping(address => address[]) private draftsModules;
    mapping(address => address[]) private ownerHistoryModules;

    /// @dev The guard this factory deployed for a history proxy, or
    ///      `address(0)`. An index again: it says what was deployed, not what
    ///      the Safe installed.
    mapping(address => address) private guards;

    /// @dev The records module this factory deployed for a Safe, or `address(0)`.
    ///      One per Safe: `createRecordsModule` returns this before it deploys,
    ///      so a retry costs nothing and the address never moves.
    mapping(address => address) public recordsModule;

    /// @dev Salt domains. One constant per role so a drafts proxy, a history
    ///      proxy and a records proxy for the same Safe never collide.
    bytes32 private constant DRAFTS_ROLE = keccak256("s2s.author.drafts");
    bytes32 private constant OWNER_HISTORY_ROLE = keccak256("s2s.author.ownerHistory");
    bytes32 private constant RECORDS_ROLE = keccak256("s2s.author.records");

    /// @notice The records module kind, in the one pattern every kind follows:
    ///         `s2s.module.records`. Must equal the implementation's
    ///         `moduleKind()`, and it is the kind this factory approves for a
    ///         module upgrade.
    bytes32 public constant RECORDS_KIND = keccak256("s2s.module.records");

    /// @dev Creates started so far, per Safe and role. A counter, not a
    ///      nonce that a caller can choose: `create*Module` takes the next
    ///      value and increments it once the deployment has succeeded.
    mapping(address => mapping(bytes32 => uint256)) private createNonce;

    /// @dev `keccak256("eip1967.proxy.implementation") - 1`, what every UUPS
    ///      implementation returns from `proxiableUUID()`.
    bytes32 private constant ERC1967_IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    event DraftsImplementationDeployed(address indexed implementation, uint256 version);
    event OwnerHistoryImplementationDeployed(address indexed implementation, uint256 version);
    event RecordsImplementationDeployed(address indexed implementation, uint256 version);
    event DraftsModuleCreated(address indexed safe, address indexed moduleProxy, address implementation);
    event OwnerHistoryModuleCreated(
        address indexed safe,
        address indexed moduleProxy,
        address guard,
        address implementation
    );
    event RecordsModuleCreated(address indexed safe, address indexed moduleProxy, address implementation);

    error OnlyDeployer();
    error InvalidVersion();
    error ZeroAddress();
    error NotAContract(address account);
    error NoImplementation();
    error ImplementationNotGated(address implementation, address gate);
    error ImplementationKindMismatch(address implementation, bytes32 kind, bytes32 declared);
    error NotUUPS(address implementation);
    error InitializerFailed(address module, bytes reason);

    modifier onlyDeployer() {
        if (msg.sender != deployer) revert OnlyDeployer();
        _;
    }

    /**
     * @param _draftsImplementation The first drafts implementation.
     * @param _ownerHistoryImplementation The first owner-history implementation.
     * @param _protocolSafe The safe the records implementation must answer. Not
     *        checked for code: it is an address the implementation compares,
     *        not an authority in this factory.
     */
    constructor(
        address _draftsImplementation,
        address _ownerHistoryImplementation,
        address _protocolSafe
    ) {
        deployer = msg.sender;
        protocolSafe = _protocolSafe;

        draftsImplementation = _draftsImplementation;
        draftsImplementationHistory.push(_draftsImplementation);
        emit DraftsImplementationDeployed(_draftsImplementation, draftsImplementationHistory.length);

        ownerHistoryImplementation = _ownerHistoryImplementation;
        ownerHistoryImplementationHistory.push(_ownerHistoryImplementation);
        emit OwnerHistoryImplementationDeployed(
            _ownerHistoryImplementation,
            ownerHistoryImplementationHistory.length
        );
    }

    // ── Create ─────────────────────────────────────────────────────

    /// @notice Deploy a drafts proxy for `safe`. Permissionless on purpose: see
    ///         the contract docblock — a proxy is not an installation.
    function createDraftsModule(address safe) external returns (address moduleProxy) {
        address implementation = draftsImplementation;
        moduleProxy = _deployProxy(implementation, DRAFTS_ROLE, safe);
        draftsModules[safe].push(moduleProxy);
        emit DraftsModuleCreated(safe, moduleProxy, implementation);
    }

    /**
     * @notice Deploy an owner-history proxy for `safe` and the guard bound to
     *         it. Permissionless on purpose, same as `createDraftsModule`: the
     *         guard is only live once the Safe calls `setGuard(guard)`, which
     *         installs nothing but the guard slot.
     */
    function createOwnerHistoryModule(address safe)
        external
        returns (address moduleProxy, address guard)
    {
        address implementation = ownerHistoryImplementation;
        moduleProxy = _deployProxy(implementation, OWNER_HISTORY_ROLE, safe);
        guard = address(new OwnerHistoryGuard(safe, moduleProxy));
        guards[moduleProxy] = guard;
        ownerHistoryModules[safe].push(moduleProxy);
        emit OwnerHistoryModuleCreated(safe, moduleProxy, guard, implementation);
    }

    /**
     * @notice Deploy the records module for `safe`, or return the module already
     *         recorded for it. Permissionless like the other two creates: a
     *         proxy is not an installation.
     * @dev One records module per Safe, which is why the salt carries no nonce:
     *      the address depends only on (this factory, role, safe) and the
     *      current implementation's init code. The mapping makes a retry
     *      idempotent — it returns the recorded module and writes nothing.
     *
     *      The proxy is deployed with an empty initializer because the records
     *      module requires the factory as `msg.sender` in `initialize`. The
     *      factory calls `initialize(safe, "")` immediately after, in the same
     *      transaction, so no uninitialised module can be left behind; a failed
     *      initializer reverts the whole create with `InitializerFailed`.
     *      Reverts `NoImplementation` when nothing is set.
     */
    function createRecordsModule(address safe) external returns (address moduleProxy) {
        moduleProxy = recordsModule[safe];
        if (moduleProxy != address(0)) return moduleProxy;

        if (safe == address(0)) revert ZeroAddress();

        address implementation = recordsImplementation;
        if (implementation == address(0)) revert NoImplementation();

        (bytes memory initializer, ) = _recordsInit(implementation);
        moduleProxy = address(
            new ERC1967Proxy{salt: _recordsSalt(safe)}(implementation, initializer)
        );
        recordsModule[safe] = moduleProxy;
        emit RecordsModuleCreated(safe, moduleProxy, implementation);

        try IAuthorRecordsModuleInit(moduleProxy).initialize(safe, "") {} catch (bytes memory reason) {
            revert InitializerFailed(moduleProxy, reason);
        }
    }

    // ── Implementations ────────────────────────────────────────────

    function setDraftsImplementation(address _implementation) external onlyDeployer {
        draftsImplementation = _implementation;
        draftsImplementationHistory.push(_implementation);
        emit DraftsImplementationDeployed(_implementation, draftsImplementationHistory.length);
    }

    function setOwnerHistoryImplementation(address _implementation) external onlyDeployer {
        ownerHistoryImplementation = _implementation;
        ownerHistoryImplementationHistory.push(_implementation);
        emit OwnerHistoryImplementationDeployed(_implementation, ownerHistoryImplementationHistory.length);
    }

    /**
     * @notice Set the records implementation and approve it as this module
     *         kind's upgrade target.
     * @dev Only the deployer. Three declarations are read from the candidate:
     *      `factory()` must name this factory, `moduleKind()` must equal
     *      `RECORDS_KIND`, and `proxiableUUID()` must answer the ERC-1967 slot.
     *      The first stops an implementation gated elsewhere from entering this
     *      set; the second stops another kind's code being handed to the
     *      records module; the third guarantees an upgrade door.
     *
     *      Existing modules keep their address and keep running their current
     *      implementation. The new one is where future creates go and a legal
     *      upgrade target for existing modules.
     */
    function setRecordsImplementation(address _implementation) external onlyDeployer {
        if (_implementation == address(0)) revert ZeroAddress();
        if (_implementation.code.length == 0) revert NotAContract(_implementation);

        address gate = _gateOf(_implementation);
        if (gate != address(this)) revert ImplementationNotGated(_implementation, gate);
        bytes32 declared = _kindOf(_implementation);
        if (declared != RECORDS_KIND) {
            revert ImplementationKindMismatch(_implementation, RECORDS_KIND, declared);
        }
        if (!_isUUPS(_implementation)) revert NotUUPS(_implementation);

        recordsImplementation = _implementation;
        recordsImplementationHistory.push(_implementation);
        emit RecordsImplementationDeployed(_implementation, recordsImplementationHistory.length);
    }

    // ── Prediction ─────────────────────────────────────────────────

    /**
     * @dev Three facts about both prediction views below, because a predicted
     *      address is easy to misread as a promise.
     *
     *      1. Exactness. The returned address is exact for every case this
     *         factory can produce, provided nothing intervenes between the read
     *         and the create. Two things make it stop being the next deployment,
     *         and both are conditions, not branches: another caller runs
     *         `create*Module` for the same Safe first and takes the nonce (for
     *         records, the recorded module makes the create a no-op), and
     *         `set*Implementation` lands between the prediction and the create
     *         and changes the code hash. No case this factory can produce is
     *         inexact, so no branch returns `address(0)` today, except
     *         `recordsModuleAddress` when no records implementation is set. If
     *         a later change makes one inexact, it must return `address(0)`
     *         with a comment saying why: a wrong address is worse than no
     *         address.
     *      2. Front-running. `create*Module` is permissionless by design, so a
     *         predicted address is a hint, not a reservation. Anyone can call
     *         the create for that Safe and take the address the caller
     *         predicted. Read it, then let the Safe check what it was actually
     *         handed; do not pre-commit to the hint.
     *      3. Inputs that never realise. The prediction answers for any input,
     *         because it is arithmetic over the salt and the init code — it is
     *         not a promise that anything exists there. Two kinds of input never
     *         reach a proxy: a zero Safe reverts `initialize` with `ZeroAddress`,
     *         and a non-Safe contract reverts `createOwnerHistoryModule` with
     *         `SafeCallFailed`, because the history module reads `getOwners()`
     *         inside `initialize` and a contract without it answers nothing (a
     *         contract that answers an empty list is `ZeroOwners`). The drafts
     *         module would accept an EOA on its own; the history one does not,
     *         so `ownerHistoryModuleAddress` is the view that answers for
     *         inputs no create can realise.
     */

    /// @notice The address the next `createDraftsModule(safe)` would deploy to,
    ///         for the current implementation and the current nonce. See the
    ///         three facts above.
    function draftsModuleAddress(address safe) external view returns (address) {
        return _predict(draftsImplementation, DRAFTS_ROLE, safe);
    }

    /// @notice The address the next `createOwnerHistoryModule(safe)` would deploy
    ///         its proxy to. The guard is a plain CREATE with no predicted
    ///         address, and it is deployed after the proxy, so it cannot move
    ///         the proxy. See the three facts above.
    function ownerHistoryModuleAddress(address safe) external view returns (address) {
        return _predict(ownerHistoryImplementation, OWNER_HISTORY_ROLE, safe);
    }

    /// @notice The recorded records module for `safe`, else the address
    ///         `createRecordsModule(safe)` would deploy at right now, else
    ///         `address(0)` when no implementation is set. See the three facts
    ///         above.
    function recordsModuleAddress(address safe) external view returns (address) {
        address existing = recordsModule[safe];
        if (existing != address(0)) return existing;

        address implementation = recordsImplementation;
        if (implementation == address(0)) return address(0);
        return _predictRecords(implementation, safe);
    }

    // ── Reads ──────────────────────────────────────────────────────

    /// @dev An index, not proof — see the contract docblock.
    function getDraftsModulesForSafe(address safe) external view returns (address[] memory) {
        return draftsModules[safe];
    }

    /// @dev An index, not proof — see the contract docblock.
    function getOwnerHistoryModulesForSafe(address safe) external view returns (address[] memory) {
        return ownerHistoryModules[safe];
    }

    /// @notice The guard deployed for `module`, or `address(0)` when this
    ///         factory deployed none. Answers zero rather than reverting: an
    ///         unknown module is a caller's mistake, not a reason a reader dies.
    function guardFor(address module) external view returns (address) {
        return guards[module];
    }

    /// @notice The records implementation for `kind`, or zero for any other kind.
    /// @dev Lets the records implementation's deploy script and any reader that
    ///      knows this factory and the kind hash ask the same question they ask
    ///      a multi-kind factory.
    function latestImplementation(bytes32 kind) external view returns (address) {
        if (kind != RECORDS_KIND) return address(0);
        return recordsImplementation;
    }

    /// @notice Whether `implementation` is this kind's current implementation.
    /// @dev Read by the records module's `_authorizeUpgrade` at the moment of an
    ///      upgrade, so a module can move only to what the deployer set. Exactly
    ///      one implementation is approved per kind at a time; setting a new one
    ///      makes it the only target.
    function isApproved(bytes32 kind, address implementation) external view returns (bool) {
        return
            kind == RECORDS_KIND &&
            implementation != address(0) &&
            implementation == recordsImplementation;
    }

    function draftsImplementationCount() external view returns (uint256) {
        return draftsImplementationHistory.length;
    }

    /// @notice 1-based; reverts `InvalidVersion` outside `1..count`.
    function getDraftsImplementationByVersion(uint256 version) external view returns (address) {
        if (version == 0 || version > draftsImplementationHistory.length) revert InvalidVersion();
        return draftsImplementationHistory[version - 1];
    }

    function ownerHistoryImplementationCount() external view returns (uint256) {
        return ownerHistoryImplementationHistory.length;
    }

    /// @notice 1-based; reverts `InvalidVersion` outside `1..count`.
    function getOwnerHistoryImplementationByVersion(uint256 version) external view returns (address) {
        if (version == 0 || version > ownerHistoryImplementationHistory.length) revert InvalidVersion();
        return ownerHistoryImplementationHistory[version - 1];
    }

    function recordsImplementationCount() external view returns (uint256) {
        return recordsImplementationHistory.length;
    }

    /// @notice 1-based; reverts `InvalidVersion` outside `1..count`.
    function getRecordsImplementationByVersion(uint256 version) external view returns (address) {
        if (version == 0 || version > recordsImplementationHistory.length) revert InvalidVersion();
        return recordsImplementationHistory[version - 1];
    }

    // ── Internal ───────────────────────────────────────────────────

    /// @dev The drafts and history modules share the `initialize(address)`
    ///      shape: one proxy, one Safe, set once, called by the proxy
    ///      constructor.
    ///
    ///      The initializer comes back beside the init code rather than being
    ///      rebuilt at either call site, so the create path and the prediction
    ///      hash the same bytes. It is *part of* the init code (the proxy
    ///      constructor argument), so it is inside the CREATE2 hash: two
    ///      different Safes can never collide on one address, and the salt does
    ///      not have to carry that weight alone.
    ///
    ///      Cost of the shared shape, measured: building the init code that only
    ///      the prediction reads costs 3,739 gas on `createDraftsModule` and
    ///      3,741 on `createOwnerHistoryModule` (Hardhat, warm second create:
    ///      209,843 -> 206,104 and 898,896 -> 895,155 with the build removed).
    ///      That is 1.8% of a drafts create, and it buys one place the create
    ///      path and the prediction both read, so the prediction cannot drift
    ///      from what is deployed. Kept deliberately; a future split must keep
    ///      both halves derived from the same bytes.
    function _init(address implementation, address safe)
        private
        pure
        returns (bytes memory initializer, bytes memory initCode)
    {
        initializer = abi.encodeWithSignature("initialize(address)", safe);
        initCode = abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(implementation, initializer)
        );
    }

    /**
     * @dev The records variant of `_init`. The initializer is empty on purpose:
     *      the records module's `initialize(address,bytes)` requires the factory
     *      as `msg.sender`, which the proxy constructor is not. The proxy is
     *      deployed with these exact bytes and the factory calls `initialize`
     *      itself, immediately after.
     *
     *      The empty `bytes` is still ABI-encoded into the init code (offset,
     *      then zero length), so the prediction hashes precisely the bytes the
     *      create deploys.
     */
    function _recordsInit(address implementation)
        private
        pure
        returns (bytes memory initializer, bytes memory initCode)
    {
        initializer = bytes("");
        initCode = abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(implementation, initializer)
        );
    }

    /// @dev keccak256(abi.encode(role, safe, nonce)): the role keeps the module
    ///      kinds apart, the Safe and the counter keep every create apart. A
    ///      caller cannot choose a salt, so it cannot grind one.
    function _salt(bytes32 role, address safe, uint256 nonce) private pure returns (bytes32) {
        return keccak256(abi.encode(role, safe, nonce));
    }

    /// @dev keccak256(abi.encode(RECORDS_ROLE, safe)). No nonce: one records
    ///      module per Safe is the goal, and `recordsModule` makes the create
    ///      idempotent. The address still moves with the implementation,
    ///      because the implementation is a constructor argument of the proxy
    ///      and therefore part of the init code hash.
    function _recordsSalt(address safe) private pure returns (bytes32) {
        return keccak256(abi.encode(RECORDS_ROLE, safe));
    }

    /// @dev The CREATE2 address for the next create, from the same bytes the
    ///      create deploys.
    function _predict(address implementation, bytes32 role, address safe)
        private
        view
        returns (address)
    {
        (, bytes memory initCode) = _init(implementation, safe);
        bytes32 salt = _salt(role, safe, createNonce[safe][role]);
        bytes32 digest = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(initCode))
        );
        return address(uint160(uint256(digest)));
    }

    /// @dev The records variant of `_predict`, over the records init code and
    ///      salt.
    function _predictRecords(address implementation, address safe)
        private
        view
        returns (address)
    {
        (, bytes memory initCode) = _recordsInit(implementation);
        bytes32 digest = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                _recordsSalt(safe),
                keccak256(initCode)
            )
        );
        return address(uint160(uint256(digest)));
    }

    /// @dev One CREATE2 deployment, then the counter moves. A revert anywhere in
    ///      the deployment (including `initialize` rejecting `address(0)`)
    ///      reverts the whole call, so the counter only advances on a proxy that
    ///      exists.
    function _deployProxy(address implementation, bytes32 role, address safe)
        private
        returns (address moduleProxy)
    {
        uint256 nonce = createNonce[safe][role];
        (bytes memory initializer, ) = _init(implementation, safe);
        moduleProxy = address(new ERC1967Proxy{salt: _salt(role, safe, nonce)}(implementation, initializer));
        createNonce[safe][role] = nonce + 1;
    }

    /// @dev The address an implementation answers `factory()` with, or zero when
    ///      it answers nothing, answers a word wider than an address, or reverts.
    function _gateOf(address implementation) private view returns (address) {
        try IAuthorRecordsModuleKind(implementation).factory() returns (address gate) {
            return gate;
        } catch {
            return address(0);
        }
    }

    /// @dev The kind an implementation declares, or zero when it declares none.
    function _kindOf(address implementation) private view returns (bytes32) {
        try IAuthorRecordsModuleKind(implementation).moduleKind() returns (bytes32 declared) {
            return declared;
        } catch {
            return bytes32(0);
        }
    }

    /// @dev Whether the implementation answers `proxiableUUID()` with the
    ///      ERC-1967 implementation slot.
    function _isUUPS(address implementation) private view returns (bool) {
        try IAuthorRecordsUUPS(implementation).proxiableUUID() returns (bytes32 uuid) {
            return uuid == ERC1967_IMPLEMENTATION_SLOT;
        } catch {
            return false;
        }
    }
}
