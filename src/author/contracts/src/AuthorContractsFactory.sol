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
        moduleProxy = _deployProxy(implementation, safe);
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
        moduleProxy = _deployProxy(implementation, safe);
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
    function _deployProxy(address implementation, address safe) private returns (address) {
        bytes memory initializer = abi.encodeWithSignature("initialize(address)", safe);
        return address(new ERC1967Proxy(implementation, initializer));
    }
}
