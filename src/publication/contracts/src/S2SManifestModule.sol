// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title S2SManifestModule
 * @notice One deployment's manifest: the JSON document a client reads to find
 *         every address and action CID it needs, plus every version ever
 *         published. Written only by the owning Safe, behind the same factory
 *         proxy as every other kind.
 *
 * Why a module instead of a record in the records module. The manifest is a
 * document with a version, not one key among many: the version has to be
 * written with it, the history has to be enumerable, and the major on the
 * document has to agree with the contract that serves it, or a reader gets a
 * document it cannot use. A key-value store cannot say any of that. Here the
 * shape is the contract's, so a writer cannot publish a document that
 * disagrees with `VERSION()`, and a reader does not have to guess key names or
 * call twice to get a version and a document that belong together.
 *
 * The version is `x.y.z`. The major changes when the document's shape changes,
 * the minor when an optional field is added, the patch when an action CID is
 * repointed. `VERSION()` here is the major and nothing else, because this
 * module is not redeployed when the document moves within it, and
 * `setManifest` refuses a document whose major is not the one this module
 * serves.
 *
 * Three declarations the factory reads before it will set this implementation:
 * `moduleKind()`, `factory()`, and `proxiableUUID()`. An upgrade target is then
 * judged per kind, and an implementation approved for another kind is not a
 * target here.
 */
interface IS2SManifestModule {
    event ManifestSet(string version, string json);
    event ContractUpgraded(address indexed implementation);

    error OnlySafe();
    error OnlyFactory();
    error EmptyVersion();
    error VersionNotXYZ(string version);
    error MajorMismatch(string documentMajor, string moduleMajor);
    error EmptyDocument();
    error VersionIsHistory(string version);
    error VersionNotFound(string version);
    error NoManifest();
    error ImplementationNotApproved(address implementation);
    error InvalidFactory(address factory);
    error ProtocolSafeMismatch(address factorySays, address expected);

    function NAME() external view returns (string memory);
    function VERSION() external view returns (string memory);
    function safe() external view returns (address);
    function moduleKind() external view returns (bytes32);

    function setManifest(string calldata version, string calldata json) external;

    function getManifest() external view returns (string memory version, string memory json);
    function getManifest(string calldata version) external view returns (string memory json);
    function manifestVersion() external view returns (string memory);

    function getVersions() external view returns (string[] memory);
    function versionCount() external view returns (uint256);
    function getVersionAt(uint256 index) external view returns (string memory);
    function versionExists(string calldata version) external view returns (bool);

    function supportsInterface(bytes4 interfaceId) external pure returns (bool);
}

/// @dev The reads this module makes on the factory, declared here rather than
///      imported, so the module is not tied to one build of the factory.
interface IManifestFactoryApprovals {
    function isApproved(bytes32 kind, address implementation) external view returns (bool);
    function protocolSafe() external view returns (address);
}

contract S2SManifestModule is IS2SManifestModule, Initializable, UUPSUpgradeable {
    string public constant NAME = "S2S Manifest Module";

    /// @notice The document's major version, and only that. The document names
    ///         its own `x.y.z`; `setManifest` refuses a document whose major is
    ///         not this one, so every document this module holds is readable
    ///         beside it.
    string public constant VERSION = "1";

    /// @notice This module's kind, in the one pattern every kind follows:
    ///         `s2s.module.<name>`. The factory approves upgrade targets per
    ///         kind, and a deploy script that passes another kind's string is
    ///         refused by `ImplementationKindMismatch` rather than silently
    ///         accepted.
    bytes32 public constant MODULE_KIND = keccak256("s2s.module.manifest");

    /// @notice The Safe that owns this module. Set once, by the factory.
    address public safe;

    /// @dev The live document and the version written beside it. One write, two
    ///      answers, so a reader cannot be handed a version from one publish and
    ///      a document from another.
    string private currentJson;
    string private currentVersion;

    mapping(string => string) private jsonByVersion;
    string[] private versions;
    mapping(string => bool) private versionSeen;

    /// @dev The factory whose approved set decides what this module may upgrade
    ///      to. Immutable: no storage write can change it, and it is the same
    ///      answer for every proxy over this implementation.
    address public immutable FACTORY;

    modifier onlySafe() {
        if (msg.sender != safe) revert OnlySafe();
        _;
    }

    /// @notice The factory that approves this module's upgrades.
    function factory() external view returns (address) {
        return FACTORY;
    }

    function moduleKind() external pure returns (bytes32) {
        return MODULE_KIND;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    /// @param _factory The factory that approves upgrade targets. Must have
    ///        code: the value cannot be corrected after this point.
    /// @param _protocolSafe The protocol safe this deploy expects the factory to
    ///        name. Not proof of ownership: what binds this implementation to
    ///        the protocol is the protocol safe's `setImplementation`.
    constructor(address _factory, address _protocolSafe) {
        if (_factory == address(0) || _factory.code.length == 0) revert InvalidFactory(_factory);
        address answers = IManifestFactoryApprovals(_factory).protocolSafe();
        if (answers != _protocolSafe) revert ProtocolSafeMismatch(answers, _protocolSafe);
        FACTORY = _factory;
        _disableInitializers();
    }

    /**
     * @dev Called by the factory, in the same call that deployed this proxy,
     *      with the Safe the factory recorded. `params` is
     *      `abi.encode(string version, string json)` to publish the first
     *      document, or empty.
     */
    function initialize(address _safe, bytes calldata params) external initializer {
        if (msg.sender != FACTORY) revert OnlyFactory();
        __UUPSUpgradeable_init();
        safe = _safe;

        if (params.length != 0) {
            (string memory version, string memory json) = abi.decode(params, (string, string));
            _set(version, json);
            emit ManifestSet(version, json);
        }
    }

    /// @dev Only the owning Safe starts an upgrade, and only to an implementation
    ///      the protocol safe approved for this kind. The approval is read at the
    ///      moment of the upgrade, so a withdrawn target cannot be used.
    function _authorizeUpgrade(address newImplementation) internal onlySafe override {
        if (!IManifestFactoryApprovals(FACTORY).isApproved(MODULE_KIND, newImplementation)) {
            revert ImplementationNotApproved(newImplementation);
        }
        emit ContractUpgraded(newImplementation);
    }

    // ── Writes ─────────────────────────────────────────────────────

    /**
     * @notice Publish `json` under `version`: it becomes the live document and
     *         the snapshot kept for that version.
     *
     * @dev The major is checked here, not by the reader. A document whose major
     *      is not `VERSION()` is a document this module cannot be read
     *      alongside, so it is refused before it can be stored.
     *
     *      A version that is already history is refused: history is what a
     *      reader pinned to a release gets, and silently rewriting it would
     *      change an answer that was already given. The live version may be
     *      rewritten, which is how a CID is corrected within the release that
     *      has not yet been pinned; moving to a new release uses a new version.
     */
    function setManifest(string calldata version, string calldata json) external onlySafe {
        _set(version, json);
        emit ManifestSet(version, json);
    }

    // ── Reads ──────────────────────────────────────────────────────

    /// @notice The live document and the version it was published under, in one
    ///         call.
    function getManifest() external view returns (string memory version, string memory json) {
        if (bytes(currentJson).length == 0) revert NoManifest();
        return (currentVersion, currentJson);
    }

    /// @notice The document published under one version, as it was published.
    function getManifest(string calldata version) external view returns (string memory json) {
        json = jsonByVersion[version];
        if (bytes(json).length == 0) revert VersionNotFound(version);
    }

    /// @notice The version of the live document. Reverts when nothing is
    ///         published, rather than answering the empty string.
    function manifestVersion() external view returns (string memory) {
        if (bytes(currentVersion).length == 0) revert NoManifest();
        return currentVersion;
    }

    /// @notice Every version ever published, oldest first. The last one is the
    ///         live version.
    function getVersions() external view returns (string[] memory) {
        return versions;
    }

    function versionCount() external view returns (uint256) {
        return versions.length;
    }

    function getVersionAt(uint256 index) external view returns (string memory) {
        require(index < versions.length, "Index out of bounds");
        return versions[index];
    }

    function versionExists(string calldata version) external view returns (bool) {
        return versionSeen[version];
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IS2SManifestModule).interfaceId || interfaceId == 0x01ffc9a7;
    }

    // ── Internal ───────────────────────────────────────────────────

    function _set(string memory version, string memory json) private {
        if (bytes(version).length == 0) revert EmptyVersion();
        string memory major = _major(version);
        if (keccak256(bytes(major)) != keccak256(bytes(VERSION))) {
            revert MajorMismatch(major, VERSION);
        }
        if (bytes(json).length == 0) revert EmptyDocument();

        if (versionSeen[version]) {
            // The live version may be rewritten; an older one is history.
            if (keccak256(bytes(version)) != keccak256(bytes(currentVersion))) {
                revert VersionIsHistory(version);
            }
        } else {
            versionSeen[version] = true;
            versions.push(version);
        }

        jsonByVersion[version] = json;
        currentVersion = version;
        currentJson = json;
    }

    /// @dev The first segment of `x.y.z`, and the check that there are exactly
    ///      three segments of digits: `1`, `1.0` and `1.0.0.0` are not versions
    ///      this module will store, so a reader never meets a key it cannot
    ///      name.
    function _major(string memory version) private pure returns (string memory) {
        bytes memory v = bytes(version);
        uint256 dots;
        uint256 digitsInSegment;
        uint256 firstDot = type(uint256).max;

        for (uint256 i = 0; i < v.length; i++) {
            // 0x2e is '.', 0x30..0x39 are '0'..'9'.
            if (uint8(v[i]) == 0x2e) {
                if (digitsInSegment == 0) revert VersionNotXYZ(version);
                if (firstDot == type(uint256).max) firstDot = i;
                dots++;
                digitsInSegment = 0;
            } else {
                if (uint8(v[i]) < 0x30 || uint8(v[i]) > 0x39) revert VersionNotXYZ(version);
                digitsInSegment++;
            }
        }
        if (dots != 2 || digitsInSegment == 0) revert VersionNotXYZ(version);

        bytes memory major = new bytes(firstDot);
        for (uint256 j = 0; j < firstDot; j++) {
            major[j] = v[j];
        }
        return string(major);
    }
}
