// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title IDraftsModule — the drafts role, as an EIP-165 interface id
 * @notice The functions that make a contract a drafts module, and nothing else.
 *         No `initialize`, no `upgradeTo`: those are how a module is deployed,
 *         not what role it plays, and an id that moved with the deployment shape
 *         would stop identifying the role.
 *
 * @dev The id computed from this interface is `0xefb74036`, and it is a constant
 *      of the deployed contract: `supportsInterface` answers a compile-time
 *      literal, so the answer cannot drift from the deployed bytecode. Once a
 *      module is published that id may never change. A reader discovers the role
 *      by asking a module for that exact id — it has no other way in, because the
 *      role is not stored anywhere and there is no registry to consult — so
 *      changing the id silently makes every already-published module
 *      undiscoverable, permanently, since an upgrade cannot reach a reader that
 *      has already decided.
 *
 *      EIP-165 excludes inherited functions from an interface id, so
 *      `supportsInterface(bytes4)` itself is deliberately not part of it: it is
 *      how the question is asked, not part of the answer.
 */
interface IDraftsModule {
    function append(bytes32 genesis, string calldata cid) external;
    function isDraft(bytes32 genesis) external view returns (bool);
    function authorOf(bytes32 genesis) external view returns (address);
    function count() external view returns (uint256);
}

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
 *
 * Role discovery is EIP-165: `supportsInterface(type(IDraftsModule).interfaceId)`
 * answers true on every published drafts module, and the id is a constant of this
 * contract (see `IDraftsModule` above for why it may never change).
 */
contract DraftsModuleV1 is IDraftsModule, Initializable, UUPSUpgradeable {

    address public safe;

    // ── The one append log ─────────────────────────────────────────

    /**
     * @dev Two words per element, same as before the block was recorded. `cid` is
     *      a string, i.e. exactly one word for its length slot and a separate
     *      region for its bytes, whether the CID is short or long — so the length
     *      word is the first word of the element regardless. The two `uint64`s
     *      then pack into the second word, which is why adding `blockNumber` does
     *      not move a single stored entry or renumber the storage declarations
     *      (INV-3).
     *
     *      Reading an entry written before this implementation: its second word is
     *      a plain `uint256` timestamp. Read as two `uint64`s it yields that same
     *      timestamp in the low 64 bits and zero in the next 64, so
     *      `blockNumber == 0` means "written before this implementation, no block
     *      recorded" — not block 0 of a chain, which no chain has a use for here.
     *      `timestamp` is unaffected, so old history reads back identically.
     */
    struct Version {
        string cid;         // IPFS CID of this version's plaintext content
        uint64 timestamp;   // block.timestamp of the append
        uint64 blockNumber; // block.number of the append; 0 = pre-upgrade entry
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

    /**
     * @dev EIP-165 role signalling. The id is a compile-time constant of the
     *      deployed contract: it is the answer a reader discovers the role by, so
     *      once published it may never change — a silent change makes every
     *      already-published module undiscoverable, because no registry exists to
     *      correct. `pure` and no storage read, so it cannot fail and cannot be
     *      made to answer differently by an upgrade's storage.
     */
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IDraftsModule).interfaceId
            || interfaceId == 0x01ffc9a7; // type(IERC165).interfaceId
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
        // The block is read from `block.number`, never taken as a parameter: a
        // caller-supplied block would let an author stamp a version into any
        // block, and the log's whole value is that its ordering is the chain's.
        //
        // Both casts are safe for any chain this can run on: `block.timestamp`
        // fits in 64 bits until roughly the year 584 billion, and `block.number`
        // likewise at any plausible block time — so neither can wrap in a period
        // anyone is storing a CID for. The narrow types are what keep the element
        // at two words.
        versions[genesis].push(Version({
            cid: cid,
            timestamp: uint64(block.timestamp),
            blockNumber: uint64(block.number)
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

    /// @dev All versions of `genesis`, oldest first. `timestamps` stays
    ///      `uint256[]` because that is the ABI callers already read; the
    ///      narrower stored value is widened on the way out.
    function history(bytes32 genesis) external view returns (uint256[] memory timestamps, string[] memory cids) {
        Version[] storage vs = versions[genesis];
        uint256 n = vs.length;

        timestamps = new uint256[](n);
        cids = new string[](n);
        for (uint256 i = 0; i < n; i++) {
            timestamps[i] = uint256(vs[i].timestamp);
            cids[i] = vs[i].cid;
        }
    }

    /// @dev The block numbers behind `history`'s timestamps, index for index:
    ///      `blocksOf(g)[i]` is the block that wrote `history(g).timestamps[i]`.
    ///      A separate call rather than a third return value of `history`, so the
    ///      existing read keeps its shape, and a reader that does not care about
    ///      blocks pays nothing for them.
    ///
    ///      `0` is a pre-upgrade entry: no block was recorded, and the timestamp
    ///      is still authoritative. Never reverts on an unknown genesis.
    function blocksOf(bytes32 genesis) external view returns (uint64[] memory blocks) {
        Version[] storage vs = versions[genesis];
        uint256 n = vs.length;

        blocks = new uint64[](n);
        for (uint256 i = 0; i < n; i++) {
            blocks[i] = vs[i].blockNumber;
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
        // `Entry.timestamp` stays `uint256`: the struct is a return type consumed
        // by ABIs, and narrowing it would break every existing reader.
        e = Entry({
            genesis: genesis,
            author: genesisAuthor[genesis],
            cid: v.cid,
            timestamp: uint256(v.timestamp),
            versionCount: n
        });
    }
}
