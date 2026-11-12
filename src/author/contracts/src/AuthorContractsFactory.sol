// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OwnerHistoryGuard} from "./OwnerHistoryGuard.sol";

// ===== Factory =====

/**
 * @title AuthorContractsFactory
 * @notice The author side's one deploy path: a UUPS proxy per author Safe for
 *         the drafts log, and a UUPS proxy per author Safe for the owner
 *         history plus the `OwnerHistoryGuard` wired to that proxy.
 *
 *         One factory rather than two, because the two modules are installed
 *         together on the same Safe and a reader that has this address has
 *         every author proxy it can verify against. The two implementations
 *         keep separate version histories — moving one must never silently
 *         repoint the other.
 *
 * Trust model, stated because both halves are easy to get backwards:
 *   - `setDraftsImplementation` / `setOwnerHistoryImplementation` are
 *     `onlyDeployer`. Without that gate anyone could repoint the
 *     `*Implementation()` pointer and the next `create*Module` would hand an
 *     author a proxy that, once installed, executes as the Safe. The deployer
 *     is an immutable set at construction, so there is no admin to rotate and
 *     none to compromise.
 *   - both `create*Module` stay open **deliberately**: deploying a proxy costs
 *     the caller gas and installs nothing on any Safe. Nothing this contract
 *     does reaches the Safe's storage — no `enableModule`, no `setGuard` — so a
 *     proxy (and, for the history, a guard) is just two addresses until the
 *     Safe adopts them in its own transaction. Gating creation would buy
 *     nothing and would put a trusted party between an author and their own
 *     module.
 *   - `draftsModules` / `ownerHistoryModules` / `guards` are **indexes, not
 *     proof**. `create*Module` is permissionless, so anyone can append an entry
 *     for any Safe, and `guardFor` records what *this* factory made — it does
 *     not prove the Safe installed it. Intersect the Safe's one real adoption
 *     record (the guard slot) before treating an entry as installed.
 */
contract AuthorContractsFactory {

    /// @notice The account that deployed the factory; the only address allowed
    ///         to move either implementation pointer.
    address public immutable deployer;

    /// @notice The implementation the next `createDraftsModule` proxies onto.
    address public draftsImplementation;
    /// @notice The implementation the next `createOwnerHistoryModule` proxies onto.
    address public ownerHistoryImplementation;

    address[] private draftsImplementationHistory;
    address[] private ownerHistoryImplementationHistory;

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

    /// @dev Salt domains. One constant per role so a drafts proxy and a history
    ///      proxy for the same Safe, on the same nonce, never collide.
    bytes32 private constant DRAFTS_ROLE = keccak256("s2s.author.drafts");
    bytes32 private constant OWNER_HISTORY_ROLE = keccak256("s2s.author.ownerHistory");

    /// @dev Creates started so far, per Safe and role. A counter, not a
    ///      nonce that a caller can choose: `create*Module` takes the next
    ///      value and increments it once the deployment has succeeded.
    mapping(address => mapping(bytes32 => uint256)) private createNonce;

    event DraftsImplementationDeployed(address indexed implementation, uint256 version);
    event OwnerHistoryImplementationDeployed(address indexed implementation, uint256 version);
    event DraftsModuleCreated(address indexed safe, address indexed moduleProxy, address implementation);
    event OwnerHistoryModuleCreated(
        address indexed safe,
        address indexed moduleProxy,
        address guard,
        address implementation
    );

    error OnlyDeployer();
    error InvalidVersion();

    modifier onlyDeployer() {
        if (msg.sender != deployer) revert OnlyDeployer();
        _;
    }

    constructor(address _draftsImplementation, address _ownerHistoryImplementation) {
        deployer = msg.sender;

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

    // ── Prediction ─────────────────────────────────────────────────

    /**
     * @dev Three facts about both prediction views below, because a predicted
     *      address is easy to misread as a promise.
     *
     *      1. Exactness. The returned address is exact for every case this
     *         factory can produce, provided nothing intervenes between the read
     *         and the create. Two things make it stop being the next deployment,
     *         and both are conditions, not branches: another caller runs
     *         `create*Module` for the same Safe first and takes the nonce, and
     *         `set*Implementation` lands between the prediction and the create
     *         and changes the code hash. No case this factory can produce is
     *         inexact, so no branch returns `address(0)` today. If a later
     *         change makes one inexact, it must return `address(0)` with a
     *         comment saying why: a wrong address is worse than no address.
     *      2. Front-running. `create*Module` is permissionless by design, so a
     *         predicted address is a hint, not a reservation. Anyone can call
     *         the create for that Safe and take the address the caller
     *         predicted. Read it, then let the Safe check what it was actually
     *         handed; do not pre-commit to the hint.
     *      3. Zero Safe. `create*Module(address(0))` reverts inside `initialize`
     *         with `ZeroAddress`, so no address is ever realised for it, while
     *         the prediction still answers the arithmetic result.
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

    // ── Internal ───────────────────────────────────────────────────

    /// @dev Both modules share the `initialize(address)` shape: one proxy, one
    ///      Safe, set once. Written as a signature string rather than through a
    ///      local `interface`, which would add ABI entries only to be called.
    ///
    ///      The initializer comes back beside the init code rather than being
    ///      rebuilt at either call site, so the create path and the prediction
    ///      hash the same bytes. It is *part of* the init code (the proxy
    ///      constructor argument), so it is inside the CREATE2 hash: two
    ///      different Safes can never collide on one address, and the salt does
    ///      not have to carry that weight alone.
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

    /// @dev keccak256(abi.encode(role, safe, nonce)): the role keeps the two
    ///      module kinds apart, the Safe and the counter keep every create
    ///      apart. A caller cannot choose a salt, so it cannot grind one.
    function _salt(bytes32 role, address safe, uint256 nonce) private pure returns (bytes32) {
        return keccak256(abi.encode(role, safe, nonce));
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
}
