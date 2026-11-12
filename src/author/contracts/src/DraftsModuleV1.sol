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
     *      `timestamp` is unaffected, so old history reads back identically. An
     *      imported version (`absorb`) reads 0 for the same kind of reason: the
     *      block it was written in is on the old module, not here.
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

    /// @dev One EVM word. Every offset in the untrusted reads below is measured
    ///      in these.
    uint256 private constant WORD = 32;

    /// @dev The two reads `absorb` asks an old module for. Selectors, not a typed
    ///      interface: the answer is decoded by hand, so what the old module
    ///      claims to return is never trusted to fit a type defined here.
    bytes4 private constant SEL_FETCH_ALL_PAGED = bytes4(keccak256("fetchAllPaged(uint256,uint256)"));
    bytes4 private constant SEL_HISTORY = bytes4(keccak256("history(bytes32)"));

    // ── Events ─────────────────────────────────────────────────────

    event Appended(bytes32 indexed genesis, string cid, uint256 versionIndex, address indexed author);
    event ContractUpgraded(address indexed implementation);

    /// One `absorb` call: the page it asked the old module for, and what came
    /// back as usable. `genesisCount` is every entry in the page, `skipped` is
    /// those this module already knew or whose history it could not read, and
    /// `versionCount` is the versions actually appended. All three are zero when
    /// the old module could not be read at all.
    event Absorbed(
        address indexed oldModule,
        uint256 offset,
        uint256 limit,
        uint256 genesisCount,
        uint256 versionCount,
        uint256 skipped
    );

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

    // ── Writes: append, and import from an older module ────────────

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

        // The block is read from `block.number`, never taken as a parameter: a
        // caller-supplied block would let an author stamp a version into any
        // block, and the log's whole value is that its ordering is the chain's.
        //
        // Both casts are safe for any chain this can run on: `block.timestamp`
        // fits in 64 bits until roughly the year 584 billion, and `block.number`
        // likewise at any plausible block time — so neither can wrap in a period
        // anyone is storing a CID for. The narrow types are what keep the element
        // at two words.
        _append(genesis, cid, uint64(block.timestamp), uint64(block.number));
    }

    // ── Adoption: import an older module's log ─────────────────────

    /**
     * @dev Import a page of the log of the drafts module this Safe used before,
     *      so an author who stays at the same Safe address keeps their drafts
     *      when they adopt new modules.
     *
     *      `offset`/`limit` select one page of the OLD log, one Safe transaction
     *      per page: a whole log does not fit in one transaction, and a Safe
     *      proposal has to. What a page costs is `limit` genesis plus every
     *      version each of them has, so the caller picks the page size.
     *
     *      A genesis this module already knows is skipped, which is what makes a
     *      second call with the same page import nothing twice. Imported
     *      versions keep their cid and their old timestamp, in the old order,
     *      and are written with `blockNumber = 0`.
     *
     *      **`blockNumber` 0 means "imported, no block recorded".** The block a
     *      version was first written in is on the old module, not here, and the
     *      import does not copy it (it cannot: `history` returns timestamps and
     *      cids only). A pre-upgrade entry reads 0 for the same reason. A gate
     *      or reader that needs a block for an entry must fall back for those
     *      entries — to the timestamp, or to the old module — rather than read 0
     *      as block 0 of a chain.
     *
     *      `oldModule` is not trusted and cannot make this call revert: every
     *      read of it is a raw `staticcall` whose answer is bounds-checked word
     *      by word (`_oldGenesisList`, `_oldHistory`), and a module that fails,
     *      has no such function, or answers with something that is not the
     *      `fetchAllPaged`/`history` shape is skipped, not fatal. The batch only
     *      keeps going, so one broken genesis in an old log does not strand the
     *      rest. What is not tolerated is this module's own invariants: an
     *      imported version must have a non-empty cid and a timestamp that fits
     *      the stored width, or its genesis is skipped whole.
     *
     *      The loop is bounded twice over — by the page's length and by the data
     *      the old module actually returned — so a lying module cannot make this
     *      iterate or allocate past what it sent.
     */
    function absorb(address oldModule, uint256 offset, uint256 limit) external onlySafe {
        uint256 pageCount;
        uint256 importedVersions;
        uint256 skipped;

        (bool readable, bytes32[] memory page) = _oldGenesisList(oldModule, offset, limit);
        if (!readable) {
            // The event still records the attempt; zero counts are the whole
            // answer: nothing was imported, and nothing was skipped in particular.
            emit Absorbed(oldModule, offset, limit, 0, 0, 0);
            return;
        }

        for (uint256 i = 0; i < page.length; i++) {
            pageCount++;
            bytes32 g = page[i];

            // Known here already: the import is per genesis and idempotent. A
            // zero genesis is one the old page could not give us (a pointer
            // outside its own answer), and `append` would reject it.
            if (g == bytes32(0) || genesisAuthor[g] != address(0)) {
                skipped++;
                continue;
            }

            (bool hasHistory, uint256[] memory stamps, string[] memory cids) = _oldHistory(oldModule, g);
            if (!hasHistory) {
                skipped++;
                continue;
            }

            for (uint256 j = 0; j < cids.length; j++) {
                // blockNumber 0: imported, no block recorded. See the note above.
                _append(g, cids[j], uint64(stamps[j]), 0);
                importedVersions++;
            }
        }

        emit Absorbed(oldModule, offset, limit, pageCount, importedVersions, skipped);
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
    ///      `0` is a pre-upgrade or an imported entry: no block was recorded
    ///      here, and the timestamp is still authoritative — a gate that needs a
    ///      block must fall back for those, not read 0 as a block number. Never
    ///      reverts on an unknown genesis.
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

    /// @dev The one place a version enters the log, for both `append` and
    ///      `absorb`: the first version of a genesis binds it to the Safe and
    ///      pushes it onto the insertion-ordered list; every version appends one
    ///      `Version` and emits `Appended`.
    function _append(bytes32 genesis, string memory cid, uint64 timestamp, uint64 blockNumber) private {
        if (genesisAuthor[genesis] == address(0)) {
            genesisAuthor[genesis] = msg.sender;
            genesisList.push(genesis);
        }

        uint256 idx = versions[genesis].length;
        versions[genesis].push(Version({
            cid: cid,
            timestamp: timestamp,
            blockNumber: blockNumber
        }));

        emit Appended(genesis, cid, idx, msg.sender);
    }

    // ── Reading an untrusted old module ────────────────────────────

    /**
     * @dev `oldModule.fetchAllPaged(offset, limit)`, decoded by hand.
     *
     *      A typed call would not do: `try`/`catch` catches a revert in the
     *      callee, but a *decode* failure happens in this frame and is not
     *      caught — so a module that answers the right selector with the wrong
     *      bytes would revert the whole batch. Here the answer is returndata and
     *      every word is read only after a bounds check, so the worst a lying
     *      module buys is an empty page.
     *
     *      Only `genesis` is taken from each `Entry`; the rest of the struct is
     *      not needed to import a log.
     */
    function _oldGenesisList(address oldModule, uint256 offset, uint256 limit)
        private
        view
        returns (bool readable, bytes32[] memory page)
    {
        page = new bytes32[](0);
        (bool called, bytes memory raw) = oldModule.staticcall(
            abi.encodeWithSelector(SEL_FETCH_ALL_PAGED, offset, limit)
        );
        if (!called) return (false, page);

        (bool okBase, uint256 base) = _wordAt(raw, 0);
        if (!okBase) return (false, page);
        (bool okLen, uint256 n) = _wordAt(raw, base);
        if (!okLen) return (false, page);

        // Bounded by the caller's page and by the element head words that fit in
        // what came back: a module claiming a huge array is truncated to its own
        // answer, never allocated for.
        if (n > limit) n = limit;
        uint256 headWords = (raw.length - base - WORD) / WORD;
        if (n > headWords) n = headWords;
        if (n == 0) return (true, page);

        page = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            (bool okPtr, uint256 ptr) = _wordAt(raw, base + WORD + i * WORD);
            if (!okPtr) break;
            if (ptr > raw.length) continue;                 // element outside the answer
            (bool okGenesis, uint256 g) = _wordAt(raw, base + WORD + ptr);
            if (!okGenesis) continue;
            page[i] = bytes32(g);
        }
        return (true, page);
    }

    /**
     * @dev `oldModule.history(genesis)` — decoded by hand, for the same reason
     *      as `_oldGenesisList`: a malformed answer is a skipped genesis, not a
     *      revert.
     *
     *      All or nothing per genesis: the two arrays must be the same length
     *      and every version must decode, or the caller skips the genesis. A
     *      half-imported history would claim to be a complete trail.
     */
    function _oldHistory(address oldModule, bytes32 genesis)
        private
        view
        returns (bool readable, uint256[] memory stamps, string[] memory cids)
    {
        stamps = new uint256[](0);
        cids = new string[](0);

        (bool called, bytes memory raw) = oldModule.staticcall(
            abi.encodeWithSelector(SEL_HISTORY, genesis)
        );
        if (!called) return (false, stamps, cids);

        (bool okStamps, uint256 stampsBase) = _wordAt(raw, 0);
        if (!okStamps) return (false, stamps, cids);
        (bool okCids, uint256 cidsBase) = _wordAt(raw, WORD);
        if (!okCids) return (false, stamps, cids);

        (bool okN, uint256 n) = _wordAt(raw, stampsBase);
        if (!okN) return (false, stamps, cids);
        (bool okM, uint256 m) = _wordAt(raw, cidsBase);
        if (!okM) return (false, stamps, cids);

        // `history` returns parallel arrays and an empty one for an unknown
        // genesis; anything else is not this package's log.
        if (n == 0 || n != m) return (false, stamps, cids);
        if (n > (raw.length - stampsBase - WORD) / WORD) return (false, stamps, cids);
        if (n > (raw.length - cidsBase - WORD) / WORD) return (false, stamps, cids);

        stamps = new uint256[](n);
        cids = new string[](n);
        for (uint256 i = 0; i < n; i++) {
            (bool okStamp, uint256 stamp) = _wordAt(raw, stampsBase + WORD + i * WORD);
            if (!okStamp || stamp > type(uint64).max) return (false, stamps, cids);
            stamps[i] = stamp;

            (bool okPtr, uint256 ptr) = _wordAt(raw, cidsBase + WORD + i * WORD);
            if (!okPtr || ptr > raw.length) return (false, stamps, cids);
            (bool okCid, string memory cid) = _stringAt(raw, cidsBase + WORD + ptr);
            if (!okCid || bytes(cid).length == 0) return (false, stamps, cids);
            cids[i] = cid;
        }
        return (true, stamps, cids);
    }

    /// @dev One 32-byte word of `data` at byte offset `at`; false if it is not
    ///      entirely inside `data`.
    function _wordAt(bytes memory data, uint256 at) private pure returns (bool ok, uint256 word) {
        if (at > data.length || data.length - at < WORD) return (false, 0);
        assembly {
            word := mload(add(add(data, 0x20), at))
        }
        ok = true;
    }

    /// @dev A `string` out of returndata: a length word at `at`, its bytes after
    ///      it, both required to fit inside `data` before anything is allocated.
    function _stringAt(bytes memory data, uint256 at) private pure returns (bool ok, string memory s) {
        (bool okLen, uint256 len) = _wordAt(data, at);
        if (!okLen) return (false, "");
        if (data.length - at - WORD < len) return (false, "");

        bytes memory out = new bytes(len);
        assembly {
            let src := add(add(data, 0x20), add(at, 0x20))
            let dst := add(out, 0x20)
            for { let i := 0 } lt(i, len) { i := add(i, 0x20) } {
                mstore(add(dst, i), mload(add(src, i)))
            }
            // The last word copied carries bytes past `len`; zero them, or the
            // string's tail is whatever the allocator had in that word.
            if mod(len, 0x20) {
                let tail := add(dst, sub(len, mod(len, 0x20)))
                mstore(tail, and(mload(tail), not(sub(shl(mul(8, sub(0x20, mod(len, 0x20))), 1), 1))))
            }
        }
        return (true, string(out));
    }

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
