// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title S2SPublicationModuleV2
 * @notice Append-only version log per document, keyed by genesis objectId.
 *
 * Each document starts with a genesis objectId (content-derived hash). Every
 * edit appends a new version under the same genesis key. The contract is an
 * ordered, authorized index — actual content bytes live on Filecoin/Kubo.
 *
 * Access control: `onlySafe` (the publication Safe, a DID identity proxy
 * supporting key rotation). `canPublish` also allows whitelisted authors/devs.
 * See did:ethr:safe model — the Safe address is the stable identity.
 */
contract S2SPublicationModuleV2 is Initializable, UUPSUpgradeable {

    address public safe;

    // ── Constants ──────────────────────────────────────────────────

    uint256 public constant MAX_WHITELISTED_AUTHORS = 100;
    uint256 public constant MAX_WHITELISTED_DEVS = 20;

    // ── Storage: append log ────────────────────────────────────────

    struct Version {
        bytes32 objectId;   // content-derived hash
        string cid;         // root CID from Filecoin (IPFS-compatible)
        uint256 timestamp;
        bool tombstone;     // true = this version is retracted
    }

    struct Latest {
        uint256 index;      // position in versions[]
        bytes32 objectId;
        string cid;
    }

    /// Ordered version log per genesis document
    mapping(bytes32 genesis => Version[]) private versions;

    /// Author (Safe address) that created each genesis
    mapping(bytes32 genesis => address) private genesisAuthor;

    /// Fast lookup: does a given objectId exist under a genesis?
    /// Useful for the renderer to check without fetching all versions.
    mapping(bytes32 genesis => mapping(bytes32 objectId => bool)) private versionExists;

    // ── Whitelist storage (same layout as V1) ─────────────────────

    address[] private whitelisted_authors;
    address[] private whitelisted_devs;

    // ── Events ─────────────────────────────────────────────────────

    event Appended(
        bytes32 indexed genesis,
        bytes32 indexed objectId,
        string cid,
        uint256 versionIndex,
        address indexed author
    );

    event Retracted(
        bytes32 indexed genesis,
        uint256 versionIndex,
        address indexed author
    );

    event AuthorWhitelisted(address indexed author);
    event AuthorRemovedFromWhitelist(address indexed author);
    event DevWhitelisted(address indexed dev);
    event DevRemovedFromWhitelist(address indexed dev);
    event ContractUpgraded(address indexed implementation);

    // ── Errors ─────────────────────────────────────────────────────

    error OnlySafe();
    error MaxAuthorsReached();
    error MaxDevsReached();
    error InvalidAuthorAddress();
    error InvalidDevAddress();
    error EmptyCid();
    error ZeroHash();

    // ── Modifiers ──────────────────────────────────────────────────

    modifier onlySafe() {
        if (msg.sender != safe) revert OnlySafe();
        _;
    }

    // ── Constructor ────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ── Initializer ────────────────────────────────────────────────

    function initialize(
        address _safe,
        address[] memory _authors,
        address[] memory _devs
    ) public initializer {
        __UUPSUpgradeable_init();

        safe = _safe;

        for (uint i = 0; i < _authors.length; i++) {
            if (_authors[i] == address(0)) revert InvalidAuthorAddress();
            if (!_inArray(whitelisted_authors, _authors[i])) {
                whitelisted_authors.push(_authors[i]);
            }
        }

        for (uint i = 0; i < _devs.length; i++) {
            if (_devs[i] == address(0)) revert InvalidDevAddress();
            if (!_inArray(whitelisted_devs, _devs[i])) {
                whitelisted_devs.push(_devs[i]);
            }
        }
    }

    // ── UUPS ───────────────────────────────────────────────────────

    function _authorizeUpgrade(address newImplementation)
        internal
        onlySafe
        override
    {
        emit ContractUpgraded(newImplementation);
    }

    function NAME() external pure returns (string memory) {
        return "S2S Publication Module V2";
    }

    // ── Core: append / retract ─────────────────────────────────────

    /**
     * @dev Append a new version under a genesis document.
     *
     * The genesis MUST be a non-zero bytes32 value. If this is the first
     * version for this genesis, the caller becomes the genesis author.
     *
     * Access: msg.sender must pass `canPublish` (safe or whitelisted).
     *
     * @param genesis  Content-derived key that roots the version log.
     * @param objectId Content-derived hash for this specific version.
     * @param cid      Root CID from the storage pipeline (Filecoin + Kubo).
     */
    function append(
        bytes32 genesis,
        bytes32 objectId,
        string calldata cid
    ) external {
        if (genesis == bytes32(0)) revert ZeroHash();
        if (bytes(cid).length == 0) revert EmptyCid();

        if (genesisAuthor[genesis] == address(0)) {
            // creating a new document → whitelist may create
            if (!canPublish(msg.sender)) revert OnlySafe();
            genesisAuthor[genesis] = msg.sender;
        } else {
            // editing an existing document → only its author (or safe)
            if (msg.sender != genesisAuthor[genesis] && msg.sender != safe) revert OnlySafe();
        }

        versions[genesis].push(Version({
            objectId: objectId,
            cid: cid,
            timestamp: block.timestamp,
            tombstone: false
        }));
        versionExists[genesis][objectId] = true;

        emit Appended(genesis, objectId, cid, versions[genesis].length - 1, msg.sender);
    }

    /**
     * @dev Retract (tombstone) the latest non-tombstone version.
     *
     * Does not delete — appends a tombstone entry. The version history
     * is preserved; callers should interpret the latest non-tombstone
     * entry as the current active version.
     *
     * Access: genesis author or safe only.
     */
    function retract(bytes32 genesis) external {
        require(genesisAuthor[genesis] != address(0), "genesis not found");
        require(
            msg.sender == genesisAuthor[genesis] || msg.sender == safe,
            "not genesis author or safe"
        );

        Version[] storage log = versions[genesis];

        // Tombstone at the end of the log
        log.push(Version({
            objectId: bytes32(0),
            cid: "",
            timestamp: block.timestamp,
            tombstone: true
        }));

        emit Retracted(genesis, log.length - 1, msg.sender);
    }

    // ── Read APIs ──────────────────────────────────────────────────

    /**
     * @dev Total number of versions (including tombstones) for a genesis.
     */
    function getVersionCount(bytes32 genesis) external view returns (uint256) {
        return versions[genesis].length;
    }

    /**
     * @dev Get a specific version by index.
     */
    function getVersion(
        bytes32 genesis,
        uint256 index
    ) external view returns (Version memory) {
        require(index < versions[genesis].length, "index out of bounds");
        return versions[genesis][index];
    }

    /**
     * @dev Get the latest non-tombstone version for a genesis.
     * Reverts if no non-tombstone version exists.
     */
    function getLatest(bytes32 genesis) external view returns (Latest memory) {
        Version[] storage log = versions[genesis];
        require(log.length > 0, "no versions");

        for (uint256 i = log.length; i > 0; i--) {
            Version storage v = log[i - 1];
            if (!v.tombstone) {
                return Latest({
                    index: i - 1,
                    objectId: v.objectId,
                    cid: v.cid
                });
            }
        }

        revert("no active version");
    }

    /**
     * @dev Check if a genesis has at least one entry.
     */
    function isGenesis(bytes32 genesis) external view returns (bool) {
        return genesisAuthor[genesis] != address(0);
    }

    /**
     * @dev Check if a specific objectId exists under a genesis.
     */
    function versionExistsForGenesis(bytes32 genesis, bytes32 objectId) external view returns (bool) {
        return versionExists[genesis][objectId];
    }

    /**
     * @dev Get the author who created a genesis.
     */
    function authorOf(bytes32 genesis) external view returns (address) {
        return genesisAuthor[genesis];
    }

    // ── Permission checks (same as V1) ─────────────────────────────

    function canPublish(address _address) public view returns (bool) {
        if (_address == safe) return true;
        if (_inArray(whitelisted_devs, _address)) return true;
        if (_inArray(whitelisted_authors, _address)) return true;
        return false;
    }

    function isWhitelistedAuthor(address _address) external view returns (bool) {
        return _inArray(whitelisted_authors, _address);
    }

    function isWhitelistedDev(address _address) external view returns (bool) {
        return _inArray(whitelisted_devs, _address);
    }

    // ── Whitelist management (same as V1) ──────────────────────────

    function whitelistAuthor(address _author) external onlySafe {
        if (_author == address(0)) revert InvalidAuthorAddress();
        if (whitelisted_authors.length >= MAX_WHITELISTED_AUTHORS) revert MaxAuthorsReached();
        if (!_inArray(whitelisted_authors, _author)) {
            whitelisted_authors.push(_author);
            emit AuthorWhitelisted(_author);
        }
    }

    function removeWhitelistedAuthor(address _author) external onlySafe {
        for (uint i = 0; i < whitelisted_authors.length; i++) {
            if (whitelisted_authors[i] == _author) {
                whitelisted_authors[i] = whitelisted_authors[whitelisted_authors.length - 1];
                whitelisted_authors.pop();
                emit AuthorRemovedFromWhitelist(_author);
                return;
            }
        }
    }

    function whitelistDev(address _dev) external onlySafe {
        if (_dev == address(0)) revert InvalidDevAddress();
        if (whitelisted_devs.length >= MAX_WHITELISTED_DEVS) revert MaxDevsReached();
        if (!_inArray(whitelisted_devs, _dev)) {
            whitelisted_devs.push(_dev);
            emit DevWhitelisted(_dev);
        }
    }

    function removeWhitelistedDev(address _dev) external onlySafe {
        for (uint i = 0; i < whitelisted_devs.length; i++) {
            if (whitelisted_devs[i] == _dev) {
                whitelisted_devs[i] = whitelisted_devs[whitelisted_devs.length - 1];
                whitelisted_devs.pop();
                emit DevRemovedFromWhitelist(_dev);
                return;
            }
        }
    }

    // ── Getters (same as V1) ───────────────────────────────────────

    function getWhitelistedAuthors() external view returns (address[] memory) {
        return whitelisted_authors;
    }

    function getWhitelistedDevs() external view returns (address[] memory) {
        return whitelisted_devs;
    }

    // ── Internal ───────────────────────────────────────────────────

    function _inArray(address[] memory _array, address _address) private pure returns (bool) {
        for (uint i = 0; i < _array.length; i++) {
            if (_array[i] == _address) return true;
        }
        return false;
    }
}

// ===== Factory =====

/**
 * @title S2SPublicationModuleV2Factory
 * @notice Deploys ERC1967 proxies pointing to S2SPublicationModuleV2.
 *
 * Same interface as the V1 factory. Deploy this fresh for new publications.
 * Existing V1 publications keep their old implementation — this factory
 * only affects new proxy deployments.
 */
contract S2SPublicationModuleV2Factory {

    address public latestImplementation;
    address[] public implementationHistory;
    mapping(address => address[]) public safeModules;

    event ImplementationDeployed(address indexed implementation, uint256 version);
    event ModuleCreated(address indexed safe, address indexed moduleProxy, address implementation);

    constructor() {
        latestImplementation = address(new S2SPublicationModuleV2());
        implementationHistory.push(latestImplementation);
        emit ImplementationDeployed(latestImplementation, implementationHistory.length);
    }

    function createModule(
        address safe,
        address[] memory _authors,
        address[] memory _devs
    ) public returns (address moduleProxy) {
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

    function deployNewImplementation() external returns (address) {
        address impl = address(new S2SPublicationModuleV2());
        latestImplementation = impl;
        implementationHistory.push(impl);
        emit ImplementationDeployed(impl, implementationHistory.length);
        return impl;
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