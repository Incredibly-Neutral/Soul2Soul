// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/**
 * @title S2SManifestModuleV0_1
 * @notice One deployment's manifest: the JSON document a client reads to find
 *         every address and action CID it needs, plus every version ever
 *         published. Written only by the owning Safe, behind the same factory
 *         proxy as every other kind.
 *
 * Why a module instead of a record in the records module. The manifest is a
 * document with a version, not one key among many: the version has to be
 * written with it and the history has to be enumerable. A key-value store
 * cannot say either of those, and a reader of it has to know the naming
 * convention rather than ask for a version.
 *
 * There is one version and it is the document's own `x.y.z`, written beside it.
 * The module keeps no version of its own: it cannot tell a 2.x document from a
 * 1.x one, so claiming a major would be a constant that every upgrade has to
 * keep in step with stored history, and one mismatch would make a document
 * unreadable. A reader that only understands major 1 meets a 2.x document and
 * refuses it, which is where that judgement can actually be made.
 *
 * The rules the module keeps are the ones it can enforce:
 *
 *   - `x.y.z`, three digit segments, no leading zeros in any of them,
 *   - a version is written once; publishing it again reverts `VersionExists`,
 *     so repointing a CID moves the third digit, and `getManifest(version)` is a
 *     promise rather than a lookup,
 *   - versions strictly increase in `(major, minor, patch)`, so the last entry
 *     in the list is the live one and no client has to sort the list.
 */
interface IS2SManifestModuleV0_1 is IERC165 {
    event ManifestSet(bytes32 indexed versionHash, string version, bytes32 jsonHash);

    error OnlySafe();
    error OnlyFactory();
    error ZeroSafe();
    error EmptyVersion();
    error VersionNotXYZ(string version);
    error LeadingZero(string version);
    error EmptyDocument();
    error VersionExists(string version);
    error VersionNotIncreasing(string version, string current);
    error VersionNotFound(string version);
    error IndexOutOfBounds(uint256 index);
    error NoManifest();
    error ImplementationNotApproved(address implementation);
    error InvalidFactory(address factory);
    error ProtocolSafeMismatch(address factorySays, address expected);

    function NAME() external view returns (string memory);
    function safe() external view returns (address);
    function factory() external view returns (address);
    function moduleKind() external view returns (bytes32);

    function setManifest(string calldata version, string calldata json) external;

    function getManifest() external view returns (string memory version, string memory json);
    function getManifest(string calldata version) external view returns (string memory json);
    function manifestVersion() external view returns (string memory);

    function getVersions() external view returns (string[] memory);
    function versionCount() external view returns (uint256);
    function getVersionAt(uint256 index) external view returns (string memory);
    function versionExists(string calldata version) external view returns (bool);
}

/// @dev The reads this module makes on the factory, declared here rather than
///      imported, so the module is not tied to one build of the factory.
interface IManifestFactoryApprovals {
    function isApproved(bytes32 kind, address implementation) external view returns (bool);
    function protocolSafe() external view returns (address);
}

contract S2SManifestModuleV0_1 is IS2SManifestModuleV0_1, Initializable, UUPSUpgradeable {
    string public constant NAME = "S2S Manifest Module";

    /// @notice This module's kind, in the one pattern every kind follows:
    ///         `s2s.module.<name>`. The factory approves upgrade targets per
    ///         kind, and a deploy script that passes another kind's string is
    ///         refused by `ImplementationKindMismatch`, which lives in
    ///         `S2SPublicationModulesFactoryV0_1`, not in this file.
    bytes32 public constant MODULE_KIND = keccak256("s2s.module.manifest");

    /// @notice The Safe that owns this module. Set once, by the factory. It
    ///         cannot change: a migration is an upgrade, and the upgrade path is
    ///         what moves it. Nothing else can write or upgrade the module, so a
    ///         wrong safe here is a module that does nothing, not one that can be
    ///         rescued.
    address public safe;

    /// @dev The live version and its numbers. The document is not duplicated:
    ///      `getManifest()` reads `jsonByVersion[currentVersion]`, and both still
    ///      come from one write. A second copy of a 10 KB document is about six
    ///      million gas and buys nothing.
    string private currentVersion;
    uint256 private currentMajor;
    uint256 private currentMinor;
    uint256 private currentPatch;

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
     *
     *      A zero Safe is refused here rather than trusted from the factory: a
     *      module owned by nothing can never be written and never be upgraded,
     *      so the mistake would be permanent.
     */
    function initialize(address _safe, bytes calldata params) external initializer {
        if (msg.sender != FACTORY) revert OnlyFactory();
        if (_safe == address(0)) revert ZeroSafe();
        __UUPSUpgradeable_init();
        safe = _safe;

        if (params.length != 0) {
            (string memory version, string memory json) = abi.decode(params, (string, string));
            _set(version, json);
        }
    }

    /// @dev Only the owning Safe starts an upgrade, and only to an implementation
    ///      the protocol safe approved for this kind. The approval is read at the
    ///      moment of the upgrade, so a withdrawn target cannot be used.
    function _authorizeUpgrade(address newImplementation) internal view onlySafe override {
        if (!IManifestFactoryApprovals(FACTORY).isApproved(MODULE_KIND, newImplementation)) {
            revert ImplementationNotApproved(newImplementation);
        }
    }

    // ── Writes ─────────────────────────────────────────────────────

    /**
     * @notice Publish `json` under `version`: it becomes the live document and
     *         the snapshot kept for that version.
     *
     * @dev The checks are the contract's, not the reader's. A version that is not
     *      `x.y.z`, has a leading zero, does not increase on the live one, or has
     *      already been published is refused before anything is stored. A
     *      published version never changes answer: repointing a CID moves the
     *      third digit, which is what keeps `getManifest(version)` a promise.
     */
    function setManifest(string calldata version, string calldata json) external onlySafe {
        _set(version, json);
    }

    // ── Reads ──────────────────────────────────────────────────────

    /// @notice The live document and the version it was published under, in one
    ///         call.
    function getManifest() external view returns (string memory version, string memory json) {
        if (bytes(currentVersion).length == 0) revert NoManifest();
        return (currentVersion, jsonByVersion[currentVersion]);
    }

    /**
     * @notice The document published under one version, as it was published.
     *
     * @dev Answers any version ever published, across a major, because the caller
     *      named it. Whether a given reader understands that major is the
     *      reader's question, not this module's.
     */
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

    /// @notice Every version ever published, in publish order. The last one is
    ///         the live version, because a write only ever increases the version.
    function getVersions() external view returns (string[] memory) {
        return versions;
    }

    function versionCount() external view returns (uint256) {
        return versions.length;
    }

    function getVersionAt(uint256 index) external view returns (string memory) {
        if (index >= versions.length) revert IndexOutOfBounds(index);
        return versions[index];
    }

    function versionExists(string calldata version) external view returns (bool) {
        return versionSeen[version];
    }

    /// @dev The module's own interface plus ERC-165. `is IS2SManifestModuleV0_1 is
    ///      IERC165`, so `supportsInterface` is not folded into the module's id
    ///      the way a locally declared one would be.
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IS2SManifestModuleV0_1).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // ── Internal ───────────────────────────────────────────────────

    function _set(string memory version, string memory json) private {
        if (bytes(version).length == 0) revert EmptyVersion();
        (uint256 major, uint256 minor, uint256 patch) = _parse(version);

        if (bytes(json).length == 0) revert EmptyDocument();
        if (versionSeen[version]) revert VersionExists(version);

        if (bytes(currentVersion).length != 0) {
            bool increases = major > currentMajor ||
                (major == currentMajor && (minor > currentMinor ||
                    (minor == currentMinor && patch > currentPatch)));
            if (!increases) revert VersionNotIncreasing(version, currentVersion);
        }

        versionSeen[version] = true;
        versions.push(version);
        jsonByVersion[version] = json;
        currentVersion = version;
        currentMajor = major;
        currentMinor = minor;
        currentPatch = patch;

        uint256 n = bytes(json).length;
        bytes32 jsonHash;
        assembly {
            jsonHash := keccak256(add(json, 32), n)
        }
        emit ManifestSet(keccak256(bytes(version)), version, jsonHash);
    }

    /**
     * @dev Splits `x.y.z` into numbers and refuses everything else: not three
     *      segments, a non-digit, an empty segment, a leading zero, or a segment
     *      long enough that the comparison stops meaning what it says.
     *
     *      The numbers are the order. A higher major wins, as semver says, which
     *      is also how the list stays sorted across a major bump.
     */
    function _parse(string memory version) private pure returns (uint256 major, uint256 minor, uint256 patch) {
        bytes memory v = bytes(version);
        if (v.length == 0) revert VersionNotXYZ(version);

        uint256 segment;
        uint256 value;
        uint256 digits;

        for (uint256 i = 0; i <= v.length; i++) {
            bool atDot = i < v.length && uint8(v[i]) == 0x2e;
            if (i < v.length && !atDot) {
                uint8 c = uint8(v[i]);
                if (c < 0x30 || c > 0x39) revert VersionNotXYZ(version);
                // semver has no leading zeros: `01` is not a number, it is a typo.
                if (digits == 0 && c == 0x30 && i + 1 < v.length && uint8(v[i + 1]) != 0x2e) {
                    revert LeadingZero(version);
                }
                if (digits == 9) revert VersionNotXYZ(version);
                value = value * 10 + (c - 0x30);
                digits++;
                continue;
            }

            if (digits == 0) revert VersionNotXYZ(version);
            if (segment == 0) {
                major = value;
            } else if (segment == 1) {
                minor = value;
            } else {
                patch = value;
            }
            segment++;
            digits = 0;
            value = 0;
        }

        if (segment != 3) revert VersionNotXYZ(version);
    }
}
