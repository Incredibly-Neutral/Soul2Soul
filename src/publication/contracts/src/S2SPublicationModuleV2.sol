// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title S2SPublicationModuleV2
 * @notice One append-only version log per document (keyed by genesis), with a
 *         deal/offer layer over the SAME log — publishing and licensing are one
 *         concern.
 *
 * Model:
 *   - `makeOffer` is the single write authors use. It appends a version to the
 *     log, then: whitelisted author (or safe) → the document becomes a DEAL
 *     immediately; anyone else → it becomes a pending OFFER. An author can keep
 *     calling `makeOffer` to edit while it is still an offer (each call appends
 *     a version) before the publication agrees.
 *   - `acceptOffer` (onlySafe) promotes an offer to a deal.
 *   - `retract` is asymmetric: the author withdraws entirely (removed from
 *     deals/offers); the publication (safe) demotes a deal back to an offer, or
 *     rejects an offer.
 *   - `hasDeal(genesis)` is the gate the Lit actions read. Identity is bytes32
 *     everywhere; the string→bytes32 conversion is owned by `shared` and used
 *     identically at write time and at the gate, so no on-chain cid map exists.
 *
 * Deals and offers are enumerable sets of genesis pointing into the one log;
 * `getDeals`/`getOffers` read each entry's latest version via a cached pointer.
 */
contract S2SPublicationModuleV2 is Initializable, UUPSUpgradeable {

    address public safe;

    // ── Constants ──────────────────────────────────────────────────

    uint256 public constant MAX_WHITELISTED_AUTHORS = 100;
    uint256 public constant MAX_WHITELISTED_DEVS = 20;

    // ── The one append log ─────────────────────────────────────────

    struct Version {
        string cid;         // IPFS CID of this version's (encrypted) content
        uint256 timestamp;
        bool tombstone;
    }

    /// A resolved entry (genesis + its latest version), for enumeration reads.
    struct Entry {
        bytes32 genesis;
        address author;
        string cid;
        uint256 timestamp;
    }

    mapping(bytes32 genesis => Version[]) private versions;
    mapping(bytes32 genesis => address) private genesisAuthor;
    mapping(bytes32 genesis => uint256) private latestIndex;

    // ── Whitelist ──────────────────────────────────────────────────

    address[] private whitelisted_authors;
    address[] private whitelisted_devs;

    // ── Deals & offers over the log ────────────────────────────────

    mapping(bytes32 genesis => bool) private _isDeal;
    bytes32[] private dealList;
    mapping(bytes32 genesis => uint256) private dealPos;
    mapping(bytes32 genesis => uint256) private dealAt;

    mapping(bytes32 genesis => bool) private _isOffer;
    bytes32[] private offerList;
    mapping(bytes32 genesis => uint256) private offerPos;
    mapping(bytes32 genesis => uint256) private offerAt;

    // ── Events ─────────────────────────────────────────────────────

    event Appended(bytes32 indexed genesis, string cid, uint256 versionIndex, address indexed author);
    event OfferMade(bytes32 indexed genesis, address indexed author);
    event OfferAccepted(bytes32 indexed genesis, address indexed author);
    event DealStruck(bytes32 indexed genesis, address indexed author);
    event Retracted(bytes32 indexed genesis, address indexed by, bool keptAsOffer);

    event AuthorWhitelisted(address indexed author);
    event AuthorRemovedFromWhitelist(address indexed author);
    event DevWhitelisted(address indexed dev);
    event DevRemovedFromWhitelist(address indexed dev);
    event ContractUpgraded(address indexed implementation);

    // ── Errors ─────────────────────────────────────────────────────

    error OnlySafe();
    error NotAuthorized();
    error MaxAuthorsReached();
    error MaxDevsReached();
    error InvalidAuthorAddress();
    error InvalidDevAddress();
    error EmptyCid();
    error ZeroHash();

    modifier onlySafe() {
        if (msg.sender != safe) revert OnlySafe();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _safe,
        address[] memory _authors,
        address[] memory _devs
    ) public initializer {
        __UUPSUpgradeable_init();
        safe = _safe;

        for (uint i = 0; i < _authors.length; i++) {
            if (_authors[i] == address(0)) revert InvalidAuthorAddress();
            if (!_inArray(whitelisted_authors, _authors[i])) whitelisted_authors.push(_authors[i]);
        }
        for (uint i = 0; i < _devs.length; i++) {
            if (_devs[i] == address(0)) revert InvalidDevAddress();
            if (!_inArray(whitelisted_devs, _devs[i])) whitelisted_devs.push(_devs[i]);
        }
    }

    function _authorizeUpgrade(address newImplementation) internal onlySafe override {
        emit ContractUpgraded(newImplementation);
    }

    function NAME() external pure returns (string memory) {
        return "S2S Publication Module V2";
    }

    // ── Single write: makeOffer (append + place in deals or offers) ─

    /**
     * @dev Append a version and place the document. Whitelisted author or safe
     *      → deal; anyone else → offer. Editing an existing offer just appends
     *      another version (stays an offer). Editing content that is already a
     *      deal appends a version and leaves the deal intact.
     */
    function makeOffer(
        bytes32 genesis,
        string calldata cid
    ) external returns (bool dealt) {
        _append(genesis, cid, msg.sender);

        if (msg.sender == safe || _inArray(whitelisted_authors, msg.sender)) {
            if (_isOffer[genesis]) _removeOffer(genesis);
            if (!_isDeal[genesis]) {
                _addDeal(genesis);
                emit DealStruck(genesis, genesisAuthor[genesis]);
            }
            return true;
        }

        // Non-whitelisted author. Leave an existing deal untouched (don't yank a
        // live deal on edit); otherwise ensure it sits as a pending offer.
        if (!_isDeal[genesis] && !_isOffer[genesis]) {
            _addOffer(genesis);
            emit OfferMade(genesis, genesisAuthor[genesis]);
        }
        return _isDeal[genesis];
    }

    /// @dev Publication accepts a pending offer → deal.
    function acceptOffer(bytes32 genesis) external onlySafe {
        require(_isOffer[genesis], "no offer");
        _removeOffer(genesis);
        if (!_isDeal[genesis]) _addDeal(genesis);
        emit OfferAccepted(genesis, genesisAuthor[genesis]);
    }

    /**
     * @dev Retract, asymmetric by caller:
     *      - author  → removed from deals and/or offers (full withdrawal)
     *      - safe     → a deal is demoted back to an offer; an offer is rejected
     */
    function retract(bytes32 genesis) external {
        require(_isDeal[genesis] || _isOffer[genesis], "not a deal or offer");

        if (msg.sender == genesisAuthor[genesis]) {
            if (_isDeal[genesis]) _removeDeal(genesis);
            if (_isOffer[genesis]) _removeOffer(genesis);
            emit Retracted(genesis, msg.sender, false);
        } else if (msg.sender == safe) {
            if (_isDeal[genesis]) {
                _removeDeal(genesis);
                if (!_isOffer[genesis]) _addOffer(genesis);
                emit Retracted(genesis, msg.sender, true);
            } else {
                _removeOffer(genesis);
                emit Retracted(genesis, msg.sender, false);
            }
        } else {
            revert NotAuthorized();
        }
    }

    // ── The gate the Lit actions read ──────────────────────────────

    /// @dev True iff `genesis` is currently under a deal. Callers convert their
    ///      content reference → genesis via the shared helper before calling.
    function hasDeal(bytes32 genesis) external view returns (bool) {
        return _isDeal[genesis];
    }

    function hasOffer(bytes32 genesis) external view returns (bool) {
        return _isOffer[genesis];
    }

    // ── Enumeration (deals / offers with their latest version) ─────

    function getDeals(uint256 offset, uint256 limit) external view returns (Entry[] memory) {
        return _page(dealList, offset, limit);
    }

    function getOffers(uint256 offset, uint256 limit) external view returns (Entry[] memory) {
        return _page(offerList, offset, limit);
    }

    function getDealCount() external view returns (uint256) { return dealList.length; }
    function getOfferCount() external view returns (uint256) { return offerList.length; }

    function _page(bytes32[] storage list, uint256 offset, uint256 limit) private view returns (Entry[] memory) {
        uint256 n = list.length;
        if (offset >= n) return new Entry[](0);
        uint256 end = offset + limit;
        if (end > n) end = n;

        Entry[] memory out = new Entry[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            bytes32 g = list[i];
            Version storage v = versions[g][latestIndex[g]];
            out[i - offset] = Entry({
                genesis: g,
                author: genesisAuthor[g],
                cid: v.cid,
                timestamp: v.timestamp
            });
        }
        return out;
    }

    // ── Log reads ──────────────────────────────────────────────────

    function getLatest(bytes32 genesis) external view returns (Entry memory) {
        require(versions[genesis].length > 0, "no versions");
        Version storage v = versions[genesis][latestIndex[genesis]];
        return Entry({
            genesis: genesis,
            author: genesisAuthor[genesis],
            cid: v.cid,
            timestamp: v.timestamp
        });
    }

    function getVersion(bytes32 genesis, uint256 index) external view returns (Version memory) {
        require(index < versions[genesis].length, "index out of bounds");
        return versions[genesis][index];
    }

    function getVersionCount(bytes32 genesis) external view returns (uint256) {
        return versions[genesis].length;
    }

    function isGenesis(bytes32 genesis) external view returns (bool) {
        return genesisAuthor[genesis] != address(0);
    }

    function authorOf(bytes32 genesis) external view returns (address) {
        return genesisAuthor[genesis];
    }

    // ── Permission checks ──────────────────────────────────────────

    /// @dev True iff `genesis` is under a deal and `reader` is either the
    ///      publication Safe or the Safe that authored it. The gate the Lit
    ///      actions read; `hasDeal` alone is not enough because `reader` is
    ///      supplied by the caller.
    function canRead(bytes32 genesis, address reader) external view returns (bool) {
       if (!_isDeal[genesis]) return false;
       return reader == safe || reader == genesisAuthor[genesis];
    }

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

    // ── Whitelist management ───────────────────────────────────────

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

    function getWhitelistedAuthors() external view returns (address[] memory) {
        return whitelisted_authors;
    }

    function getWhitelistedDevs() external view returns (address[] memory) {
        return whitelisted_devs;
    }

    // ── Internal: append mechanism ─────────────────────────────────

    function _append(bytes32 genesis, string calldata cid, address author) private {
        if (genesis == bytes32(0)) revert ZeroHash();
        if (bytes(cid).length == 0) revert EmptyCid();

        if (genesisAuthor[genesis] == address(0)) {
            // if (!canPublish(author)) revert OnlySafe();
            genesisAuthor[genesis] = author;
        } else {
            if (author != genesisAuthor[genesis] && author != safe) revert OnlySafe();
        }

        uint256 idx = versions[genesis].length;
        versions[genesis].push(Version({
            cid: cid,
            timestamp: block.timestamp,
            tombstone: false
        }));
        latestIndex[genesis] = idx;

        emit Appended(genesis, cid, idx, author);
    }

    // ── Internal: set membership (swap-pop) ────────────────────────

    function _addDeal(bytes32 g) private {
        dealPos[g] = dealList.length;
        dealList.push(g);
        _isDeal[g] = true;
        dealAt[g] = block.timestamp;
    }

    function _removeDeal(bytes32 g) private {
        uint256 idx = dealPos[g];
        uint256 last = dealList.length - 1;
        if (idx != last) {
            bytes32 lg = dealList[last];
            dealList[idx] = lg;
            dealPos[lg] = idx;
        }
        dealList.pop();
        delete dealPos[g];
        delete _isDeal[g];
        delete dealAt[g];
    }

    function _addOffer(bytes32 g) private {
        offerPos[g] = offerList.length;
        offerList.push(g);
        _isOffer[g] = true;
        offerAt[g] = block.timestamp;
    }

    function _removeOffer(bytes32 g) private {
        uint256 idx = offerPos[g];
        uint256 last = offerList.length - 1;
        if (idx != last) {
            bytes32 lg = offerList[last];
            offerList[idx] = lg;
            offerPos[lg] = idx;
        }
        offerList.pop();
        delete offerPos[g];
        delete _isOffer[g];
        delete offerAt[g];
    }

    function _inArray(address[] memory _array, address _address) private pure returns (bool) {
        for (uint i = 0; i < _array.length; i++) {
            if (_array[i] == _address) return true;
        }
        return false;
    }
}
