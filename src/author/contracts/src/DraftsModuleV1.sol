// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title DraftsModuleV1
 * @notice One append-only version log per manuscript, installed as a Safe module
 *         on an AUTHOR Safe. A draft is a genesis that has versions but was never
 *         offered to a publication — this contract never holds that offer, so
 *         "is a draft" is simply "the log knows this genesis".
 *
 * Model:
 *   - `append` is the only write and it is `onlySafe`: the author's own Safe
 *     drives the module, so the author of every draft is the Safe itself. This
 *     is the deliberate simplification over the publication module's
 *     `makeOffer`, which has to reason about who is entitled to publish.
 *   - There is no publication, no whitelist, no deal/offer set and no gate. A
 *     genesis lives in exactly one log, ordered by first append; later appends
 *     add versions to that log and nothing else changes.
 *   - CIDs are plaintext in V1. No encryption, no tombstones, no deletion: the
 *     log only grows, which is what makes `history` a stable manuscript trail.
 *   - Identity is `bytes32` everywhere, same convention as the publication
 *     module: the string→bytes32 conversion is owned by `shared` and happens
 *     before the call, so no on-chain cid↔genesis map exists.
 *
 * Storage layout is append-only across upgrades (INV-3 in the publication
 * spec): `safe`, `versions`, `genesisAuthor`, `genesisList`. `Entry` is a return
 * type, never storage.
 */
contract DraftsModuleV1 is Initializable, UUPSUpgradeable {

    address public safe;

    // ── The one append log ─────────────────────────────────────────

    struct Version {
        string cid;         // IPFS CID of this version's plaintext content
        uint256 timestamp;
    }

    /// A resolved entry (genesis + its latest version), for reads only.
    struct Entry {
        bytes32 genesis;
        address author;
        string cid;
        uint256 timestamp;
        uint256 versionCount;
    }

    mapping(bytes32 genesis => Version[]) private versions;
    mapping(bytes32 genesis => address) private genesisAuthor;
    bytes32[] private genesisList;

    // ── Events ─────────────────────────────────────────────────────

    event Appended(bytes32 indexed genesis, string cid, uint256 versionIndex, address indexed author);
    event ContractUpgraded(address indexed implementation);

    // ── Errors ─────────────────────────────────────────────────────

    error OnlySafe();
    error ZeroHash();
    error EmptyCid();
    error ZeroAddress();

    modifier onlySafe() {
        if (msg.sender != safe) revert OnlySafe();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _safe) public initializer {
        // A zero `safe` passes no caller check ever, so the module would be born
        // dead: writes and upgrades both unreachable, with no way to repair it.
        if (_safe == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        safe = _safe;
    }

    function _authorizeUpgrade(address newImplementation) internal onlySafe override {
        emit ContractUpgraded(newImplementation);
    }

    function NAME() external pure returns (string memory) {
        return "S2S Drafts Module V1";
    }

    // ── The single write ───────────────────────────────────────────

    /**
     * @dev Append a version to `genesis`'s log. The first append binds the
     *      genesis to this Safe (and to the insertion-ordered list); later
     *      appends only add a version. There is no edit, no replace, no delete.
     */
    function append(bytes32 genesis, string calldata cid) external onlySafe {
        if (genesis == bytes32(0)) revert ZeroHash();
        if (bytes(cid).length == 0) revert EmptyCid();

        if (genesisAuthor[genesis] == address(0)) {
            genesisAuthor[genesis] = msg.sender;
            genesisList.push(genesis);
        }

        uint256 idx = versions[genesis].length;
        versions[genesis].push(Version({
            cid: cid,
            timestamp: block.timestamp
        }));

        emit Appended(genesis, cid, idx, msg.sender);
    }

    // ── Reads: enumerated (latest version per genesis) ─────────────

    function fetchAll() external view returns (Entry[] memory) {
        return _page(0, genesisList.length);
    }

    function fetchAllPaged(uint256 offset, uint256 limit) external view returns (Entry[] memory) {
        return _page(offset, limit);
    }

    /// @dev Latest version of `genesis`. Deliberately does **not** revert on an
    ///      unknown genesis: it returns a zeroed Entry whose `versionCount` is 0,
    ///      so a caller tests `versionCount == 0` instead of catching a revert.
    function fetch(bytes32 genesis) external view returns (Entry memory) {
        return _entry(genesis);
    }

    // ── Reads: one genesis ─────────────────────────────────────────

    /// @dev All versions of `genesis`, oldest first.
    function history(bytes32 genesis) external view returns (uint256[] memory timestamps, string[] memory cids) {
        Version[] storage vs = versions[genesis];
        uint256 n = vs.length;

        timestamps = new uint256[](n);
        cids = new string[](n);
        for (uint256 i = 0; i < n; i++) {
            timestamps[i] = vs[i].timestamp;
            cids[i] = vs[i].cid;
        }
    }

    function versionCount(bytes32 genesis) external view returns (uint256) {
        return versions[genesis].length;
    }

    function isDraft(bytes32 genesis) external view returns (bool) {
        return genesisAuthor[genesis] != address(0);
    }

    function authorOf(bytes32 genesis) external view returns (address) {
        return genesisAuthor[genesis];
    }

    // ── Reads: the log itself ──────────────────────────────────────

    function count() external view returns (uint256) {
        return genesisList.length;
    }

    // ── Internal ───────────────────────────────────────────────────

    function _page(uint256 offset, uint256 limit) private view returns (Entry[] memory) {
        uint256 n = genesisList.length;
        if (offset >= n || limit == 0) return new Entry[](0);

        // Clamp before adding: `offset + limit` overflows for a huge limit, and a
        // read that reverts on a caller's arithmetic is a read that lies about
        // the log. A reader may pass `type(uint256).max` to mean "to the end".
        if (limit > n - offset) limit = n - offset;
        uint256 end = offset + limit;

        Entry[] memory out = new Entry[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            out[i - offset] = _entry(genesisList[i]);
        }
        return out;
    }

    function _entry(bytes32 genesis) private view returns (Entry memory e) {
        Version[] storage vs = versions[genesis];
        uint256 n = vs.length;
        if (n == 0) return e;   // all-zero Entry: unknown genesis, versionCount 0

        Version storage v = vs[n - 1];
        e = Entry({
            genesis: genesis,
            author: genesisAuthor[genesis],
            cid: v.cid,
            timestamp: v.timestamp,
            versionCount: n
        });
    }
}
