// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title S2SPublicationModuleV3
 * @notice One append-only version log per document (keyed by genesis), with an
 *         agreement/offer layer over the SAME log — publishing and licensing are
 *         one concern. Supersedes S2SPublicationModuleV2: the deal vocabulary
 *         becomes agreement, reviewers are added, and read access moves behind
 *         two explicit gates.
 *
 * Model:
 *   - `makeOffer` is the single write authors use. It appends a version to the
 *     log, then: whitelisted author (or safe) → the document becomes an
 *     AGREEMENT immediately; anyone else → it becomes a pending OFFER. An author
 *     can keep calling `makeOffer` to edit while it is still an offer (each call
 *     appends a version) before the publication agrees.
 *   - `acceptOffer` (onlySafe) promotes an offer to an agreement.
 *   - `retract` is asymmetric: the author withdraws entirely (removed from
 *     agreements/offers); the publication (safe) demotes an agreement back to an
 *     offer, or rejects an offer.
 *   - `_append` does not gate the first version of a genesis. An untrusted
 *     author can always leave a pending offer instead of reverting.
 *
 * Read gates (frozen signatures; sibling branches code against them):
 *   - `canRead(genesis, reader)` — the safe, the genesis author and reviewers
 *     all read a genesis once it is under an agreement or an offer; an unknown
 *     genesis is never readable.
 *   - `canReview(genesis, who)` — a reviewer, for an agreement or an offer.
 *
 * Three layers, deliberately separate:
 *   - `canPublish(address)` is the whitelist predicate for "may write into this
 *     module at all" — the safe, a whitelisted dev or a whitelisted author. It
 *     is V2's body unchanged and nothing about agreements feeds it.
 *   - `agreementsHeldBy` / `ownerHasAgreement(address)` answer a different,
 *     per-author question: does this address currently hold any agreement with
 *     this publication. It never grants publish rights.
 *   - `canRead` / `canReview` are the per-genesis read gates: one manuscript,
 *     one publication, one reader.
 *
 * Reviewers are an enumerable set capped at `MAX_REVIEWERS`, managed by the
 * safe. A live proxy upgraded from V2 backfills `agreementsHeldBy` through
 * `reinitializeV3`.
 *
 * Storage: `safe` is slot 101; 102–114 is V2's layout unchanged under the new
 * agreement names (declaration order preserved); 115 `reviewers`,
 * 116 `reviewerList`, 117 `agreementsHeldBy`.
 *
 * Agreements and offers are enumerable sets of genesis pointing into the one
 * log; `getAgreements`/`getOffers` read each entry's latest version via a
 * cached pointer. Identity is bytes32 everywhere; the string→bytes32 conversion
 * is owned by `shared` and used identically at write time and at the gate, so
 * no on-chain cid map exists.
 */
contract S2SPublicationModuleV3 is Initializable, UUPSUpgradeable {

    address public safe;

    // ── Constants ──────────────────────────────────────────────────

    uint256 public constant MAX_WHITELISTED_AUTHORS = 100;
    uint256 public constant MAX_WHITELISTED_DEVS = 20;
    uint256 public constant MAX_REVIEWERS = 20;

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

    // ── Agreements & offers over the log ───────────────────────────

    mapping(bytes32 genesis => bool) private _isAgreement;
    bytes32[] private agreementList;
    mapping(bytes32 genesis => uint256) private agreementPos;
    mapping(bytes32 genesis => uint256) private agreementAt;

    mapping(bytes32 genesis => bool) private _isOffer;
    bytes32[] private offerList;
    mapping(bytes32 genesis => uint256) private offerPos;
    mapping(bytes32 genesis => uint256) private offerAt;

    // ── Reviewers (appended after V2's layout: 115–116) ────────────

    mapping(address reviewer => bool) private reviewers;
    address[] private reviewerList;
    mapping(address author => uint256) private agreementsHeldBy;

    // ── Events ─────────────────────────────────────────────────────

    event Appended(bytes32 indexed genesis, string cid, uint256 versionIndex, address indexed author);
    event OfferMade(bytes32 indexed genesis, address indexed author);
    event OfferAccepted(bytes32 indexed genesis, address indexed author);
    event AgreementStruck(bytes32 indexed genesis, address indexed author);
    /// @custom:deprecated V2 name; emitted alongside `AgreementStruck` for old indexers.
    event DealStruck(bytes32 indexed genesis, address indexed author);
    event Retracted(bytes32 indexed genesis, address indexed by, bool keptAsOffer);

    event AuthorWhitelisted(address indexed author);
    event AuthorRemovedFromWhitelist(address indexed author);
    event DevWhitelisted(address indexed dev);
    event DevRemovedFromWhitelist(address indexed dev);
    event ReviewerAdded(address indexed reviewer);
    event ReviewerRemoved(address indexed reviewer);
    event ContractUpgraded(address indexed implementation);

    // ── Errors ─────────────────────────────────────────────────────

    error OnlySafe();
    error NotAuthorized();
    error MaxAuthorsReached();
    error MaxDevsReached();
    error MaxReviewersReached();
    error InvalidAuthorAddress();
    error InvalidDevAddress();
    error InvalidReviewerAddress();
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

    /**
     * @dev Run once at upgrade time on a live proxy, so `agreementsHeldBy`
     *      reflects the agreements struck while the proxy ran V2. The list holds
     *      unique genesis and the reinitializer can only run once, so nothing is
     *      cleared first. A fresh deployment does not need it: the list is empty
     *      and the call is a no-op.
     */
    function reinitializeV3() external reinitializer(2) onlySafe {
        for (uint i = 0; i < agreementList.length; i++) {
            address author = genesisAuthor[agreementList[i]];
            if (author != address(0)) agreementsHeldBy[author] += 1;
        }
    }

    function _authorizeUpgrade(address newImplementation) internal onlySafe override {
        emit ContractUpgraded(newImplementation);
    }

    function NAME() external pure returns (string memory) {
        return "S2S Publication Module V3";
    }

    // ── Single write: makeOffer (append + place in agreements or offers) ─

    /**
     * @dev Append a version and place the document. Whitelisted author or safe
     *      → agreement; anyone else → offer. Editing an existing offer just
     *      appends another version (stays an offer). Editing content that is
     *      already an agreement appends a version and leaves the agreement intact.
     */
    function makeOffer(
        bytes32 genesis,
        string calldata cid
    ) external returns (bool agreed) {
        _append(genesis, cid, msg.sender);

        if (msg.sender == safe || _inArray(whitelisted_authors, msg.sender)) {
            if (_isOffer[genesis]) _removeOffer(genesis);
            if (!_isAgreement[genesis]) {
                _addAgreement(genesis);
                emit AgreementStruck(genesis, genesisAuthor[genesis]);
                emit DealStruck(genesis, genesisAuthor[genesis]);
            }
            return true;
        }

        // Non-whitelisted author. Leave an existing agreement untouched (don't
        // yank a live agreement on edit); otherwise ensure it sits as an offer.
        if (!_isAgreement[genesis] && !_isOffer[genesis]) {
            _addOffer(genesis);
            emit OfferMade(genesis, genesisAuthor[genesis]);
        }
        return _isAgreement[genesis];
    }

    /// @dev Publication accepts a pending offer → agreement.
    function acceptOffer(bytes32 genesis) external onlySafe {
        require(_isOffer[genesis], "no offer");
        _removeOffer(genesis);
        if (!_isAgreement[genesis]) _addAgreement(genesis);
        emit OfferAccepted(genesis, genesisAuthor[genesis]);
    }

    /**
     * @dev Retract, asymmetric by caller:
     *      - author  → removed from agreements and/or offers (full withdrawal)
     *      - safe     → an agreement is demoted back to an offer; an offer is rejected
     */
    function retract(bytes32 genesis) external {
        require(_isAgreement[genesis] || _isOffer[genesis], "not an agreement or offer");

        if (msg.sender == genesisAuthor[genesis]) {
            if (_isAgreement[genesis]) _removeAgreement(genesis);
            if (_isOffer[genesis]) _removeOffer(genesis);
            emit Retracted(genesis, msg.sender, false);
        } else if (msg.sender == safe) {
            if (_isAgreement[genesis]) {
                _removeAgreement(genesis);
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

    // ── The gates clients and the Lit actions read ─────────────────

    /**
     * @dev Read access for `genesis`. The safe, the genesis author and reviewers
     *      all read a genesis once it is under an agreement or an offer; an
     *      unknown genesis (no author) is never readable.
     */
    function canRead(bytes32 genesis, address reader) external view returns (bool) {
        if (genesisAuthor[genesis] == address(0)) return false;
        if (reader == safe || reader == genesisAuthor[genesis]) {
            return _isAgreement[genesis] || _isOffer[genesis];
        }
        if (reviewers[reader]) {
            return _isAgreement[genesis] || _isOffer[genesis];
        }
        return false;
    }

    /// @dev True iff `who` is a reviewer and `genesis` is under an agreement or offer.
    function canReview(bytes32 genesis, address who) external view returns (bool) {
        return reviewers[who] && (_isAgreement[genesis] || _isOffer[genesis]);
    }

    /// @dev True iff `genesis` is currently under an agreement. Callers convert
    ///      their content reference → genesis via the shared helper before calling.
    function hasAgreement(bytes32 genesis) external view returns (bool) {
        return _isAgreement[genesis];
    }

    /// @custom:deprecated V2 name; use `hasAgreement`.
    function hasDeal(bytes32 genesis) external view returns (bool) { return _isAgreement[genesis]; }

    function hasOffer(bytes32 genesis) external view returns (bool) {
        return _isOffer[genesis];
    }

    /// @dev True iff `_address` currently holds at least one agreement. Not a
    ///      publish gate: `canPublish` stays the whitelist predicate.
    function ownerHasAgreement(address _address) external view returns (bool) {
        return agreementsHeldBy[_address] > 0;
    }

    // ── Enumeration (agreements / offers with their latest version) ─

    function getAgreements(uint256 offset, uint256 limit) public view returns (Entry[] memory) {
        return _page(agreementList, offset, limit);
    }

    /// @custom:deprecated V2 name; use `getAgreements`.
    function getDeals(uint256 offset, uint256 limit) external view returns (Entry[] memory) { return getAgreements(offset, limit); }

    function getOffers(uint256 offset, uint256 limit) external view returns (Entry[] memory) {
        return _page(offerList, offset, limit);
    }

    function getAgreementCount() public view returns (uint256) { return agreementList.length; }

    /// @custom:deprecated V2 name; use `getAgreementCount`.
    function getDealCount() external view returns (uint256) { return getAgreementCount(); }

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

    // ── Reviewer management ────────────────────────────────────────

    /// @dev Add or remove a reviewer. Idempotent; reverts on the zero address.
    function setReviewer(address _reviewer, bool _enabled) external onlySafe {
        if (_reviewer == address(0)) revert InvalidReviewerAddress();

        if (_enabled) {
            if (reviewers[_reviewer]) return;
            if (reviewerList.length >= MAX_REVIEWERS) revert MaxReviewersReached();
            reviewers[_reviewer] = true;
            reviewerList.push(_reviewer);
            emit ReviewerAdded(_reviewer);
            return;
        }

        if (!reviewers[_reviewer]) return;
        for (uint i = 0; i < reviewerList.length; i++) {
            if (reviewerList[i] == _reviewer) {
                reviewerList[i] = reviewerList[reviewerList.length - 1];
                reviewerList.pop();
                break;
            }
        }
        delete reviewers[_reviewer];
        emit ReviewerRemoved(_reviewer);
    }

    function getReviewers() external view returns (address[] memory) {
        return reviewerList;
    }

    // ── Internal: append mechanism ─────────────────────────────────

    function _append(bytes32 genesis, string calldata cid, address author) private {
        if (genesis == bytes32(0)) revert ZeroHash();
        if (bytes(cid).length == 0) revert EmptyCid();

        if (genesisAuthor[genesis] == address(0)) {
            // First version of a genesis is never gated: an untrusted author must
            // be able to leave a pending offer rather than revert here.
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

    function _addAgreement(bytes32 g) private {
        if (_isAgreement[g]) return;
        agreementPos[g] = agreementList.length;
        agreementList.push(g);
        _isAgreement[g] = true;
        agreementAt[g] = block.timestamp;

        address author = genesisAuthor[g];
        if (author != address(0)) agreementsHeldBy[author] += 1;
    }

    function _removeAgreement(bytes32 g) private {
        uint256 idx = agreementPos[g];
        uint256 last = agreementList.length - 1;
        if (idx != last) {
            bytes32 lg = agreementList[last];
            agreementList[idx] = lg;
            agreementPos[lg] = idx;
        }
        agreementList.pop();
        delete agreementPos[g];
        delete _isAgreement[g];
        delete agreementAt[g];

        address author = genesisAuthor[g];
        if (author != address(0) && agreementsHeldBy[author] > 0) agreementsHeldBy[author] -= 1;
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
