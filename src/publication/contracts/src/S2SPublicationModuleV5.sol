// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title S2SPublicationModuleV5
 * @notice V4's log, agreements and gates, with one change: the factory that
 *         approves upgrades is an immutable constructor argument instead of a
 *         storage slot written by `initialize`. Supersedes
 *         S2SPublicationModuleV4, which stays frozen.
 *
 * Upgrade authority. V3 let the publication's own safe name any implementation.
 * Here the safe may only choose among implementations the factory has recorded,
 * so a publication's protection is the protocol and its governance rather than
 * the publication's own owner, and a compromised publication safe cannot adopt
 * code of its own choosing.
 *
 * Why the factory is immutable. V4 recorded the factory in `initialize`, and
 * `initialize` runs once, on the proxy the factory deploys. Every proxy that
 * already exists was initialised by some earlier module, so an upgrade to V4 in
 * place leaves that slot zero and V4's `_authorizeUpgrade` then reverts
 * `NoFactory()` for the rest of the proxy's life: the publication keeps working
 * and can never change implementation again. A proxy running V2 also cannot be
 * registered on the deployed factory at all when its implementation is not in
 * the frozen legacy set, so the create path is not open to it either. V5 takes
 * the factory in the constructor instead. Any proxy, whether it was born here or
 * was running V2 a transaction ago, answers the same immutable on its first hop,
 * and the upgrade needs nothing in storage to work.
 *
 * The constructor refuses a factory with no code. The value cannot be corrected
 * later, so a wrong one would brick every upgrade on every proxy over this
 * implementation, and the refusal has to happen where the mistake is made.
 * `factory()` answers the constructor argument for the same reason V4's getter
 * did: the create2 factory reads it to decide whether a module is one it
 * governs.
 *
 * Model:
 *   - `makeOffer` is the single write authors use. It appends a version to the
 *     log, then: whitelisted author (or safe) → the document becomes an
 *     AGREEMENT immediately; anyone else → it becomes a pending OFFER. An author
 *     can keep calling `makeOffer` to edit while it is still an offer (each call
 *     appends a version) before the publication agrees.
 *   - `admit` (onlySafe) promotes an offer to an agreement.
 *   - Ending is asymmetric, and the two verbs are separate functions so a caller
 *     cannot mean both:
 *     - the author `retract`s. Terminal: `_ended` is set, the latest version is
 *       tombstoned, the genesis is frozen and this publication can never strike
 *       it again. Coming back means a new manuscript with a new genesis.
 *     - the publication `reject`s. Not terminal: an agreement returns to the
 *       pending offer set, an offer is declined, and the safe may accept again.
 *     An ended genesis is frozen: `makeOffer` and `admit` revert. Its
 *     versions stay on the ledger and remain readable through `getVersion`.
 *   - `_append` does not gate the first version of a genesis. An untrusted
 *     author can always leave a pending offer instead of reverting. After the
 *     first version only the genesis author appends, so the publication cannot
 *     write a version onto somebody else's genesis.
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
 * Storage: V3's layout, unchanged, and one bool after it. V4 appended a slot at
 * 119, `factory`, and V5 removes it: the address is a constructor constant now.
 * The bool at 119, `_backfilled`, is the backfill sentinel, so no slot a live
 * proxy already uses moves, every V2 proxy leaves 119 unspent, and the slot a
 * proxy upgraded to V4 holds as an address is never read as one here.
 *
 * Agreements and offers are enumerable sets of genesis pointing into the one
 * log; `getAgreements`/`getOffers` read each entry's latest version via a
 * cached pointer. Identity is bytes32 everywhere; the string→bytes32 conversion
 * is owned by `shared` and used identically at write time and at the gate, so
 * no on-chain cid map exists.
 */
/// @dev The one read this module makes on the factory. Declared locally for the
///      same reason the factory declares its own initializer interface: importing
///      the factory would tie the module to one version of it, and the address in
///      `FACTORY` is whatever factory the protocol deploy chose to approve
///      upgrades. Named apart from V4's copy of the same interface so that two
///      files declaring it do not collide in the generated ABI index.
interface IPublicationFactoryApprovals {
    function isApprovedImplementation(address implementation) external view returns (bool);
}

contract S2SPublicationModuleV5 is Initializable, UUPSUpgradeable {

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

    // ── Reviewers & ended genesis (appended after V2's layout) ─────

    mapping(address reviewer => bool) private reviewers;
    address[] private reviewerList;
    mapping(address author => uint256) private agreementsHeldBy;
    mapping(bytes32 genesis => bool) private _ended;

    // ── Backfill sentinel (slot 119, V4's removed `factory` slot) ──

    /// @dev True once `agreementsHeldBy` has been counted for this proxy: set by
    ///      `initialize` on a fresh deployment, and by `reinitializeV3` when it
    ///      runs. `reinitializeV3` requires it to be false, so a fresh proxy
    ///      cannot run a backfill over counts `_addAgreement` already made. It
    ///      occupies the slot V4's `factory` did, which every V2 proxy leaves
    ///      unspent, so nothing a live proxy uses moves.
    bool private _backfilled;

    // ── Upgrade authority (constructor constant, no storage) ───────

    /// @dev The factory whose approved set decides what this module may upgrade
    ///      to. Immutable: it is the same answer for every proxy over this
    ///      implementation, including one that was running V2 a transaction ago.
    address public immutable FACTORY;

    /// @notice The factory that approves this module's upgrades.
    /// @dev V4's getter, answering a constant instead of a slot. The create2
    ///      factory reads it to tell a module it governs from one it does not.
    function factory() external view returns (address) {
        return FACTORY;
    }

    // ── Events ─────────────────────────────────────────────────────

    event Appended(bytes32 indexed genesis, string cid, uint256 versionIndex, address indexed author);
    event OfferMade(bytes32 indexed genesis, address indexed author);
    event OfferAccepted(bytes32 indexed genesis, address indexed author);
    event AgreementStruck(bytes32 indexed genesis, address indexed author);
    /// @custom:deprecated V2 name; emitted alongside `AgreementStruck` for old indexers.
    event DealStruck(bytes32 indexed genesis, address indexed author);
    // V2 shape kept for old indexers; now emitted only by `retract`, bool always false.
    event Retracted(bytes32 indexed genesis, address indexed by, bool keptAsOffer);
    event Rejected(bytes32 indexed genesis, address indexed author, bool keptAsOffer);

    event AuthorWhitelisted(address indexed author);
    event AuthorRemovedFromWhitelist(address indexed author);
    event DevWhitelisted(address indexed dev);
    event DevRemovedFromWhitelist(address indexed dev);
    event ReviewerAdded(address indexed reviewer);
    event ReviewerRemoved(address indexed reviewer);
    event ContractUpgraded(address indexed implementation);

    // ── Errors ─────────────────────────────────────────────────────

    error OnlySafe();
    error NotGenesisAuthor();
    error NotAuthorized();
    error MaxAuthorsReached();
    error MaxDevsReached();
    error MaxReviewersReached();
    error InvalidAuthorAddress();
    error InvalidDevAddress();
    error InvalidReviewerAddress();
    error EmptyCid();
    error ZeroHash();
    error Ended();
    error InvalidFactory(address factory);
    error ImplementationNotApproved(address implementation);
    error AlreadyBackfilled();

    modifier onlySafe() {
        if (msg.sender != safe) revert OnlySafe();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    /// @param _factory The factory that approves upgrade targets. Must have
    ///        code: the value cannot be corrected after this point, and a
    ///        factory that answers nothing refuses every upgrade for good.
    constructor(address _factory) {
        if (_factory == address(0) || _factory.code.length == 0) revert InvalidFactory(_factory);
        FACTORY = _factory;
        _disableInitializers();
    }

    function initialize(
        address _safe,
        address[] memory _authors,
        address[] memory _devs
    ) public initializer {
        __UUPSUpgradeable_init();
        safe = _safe;
        _backfilled = true;

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
     *      unique genesis, so nothing is cleared first.
     *
     *      It increments, so it must not run where the counts are already right.
     *      `reinitializer(2)` is spent on a proxy that ran it, and `_backfilled`
     *      is set by `initialize`, so a fresh deployment cannot run it either:
     *      there `_addAgreement` has already counted every agreement and a
     *      second pass would double it, which `_removeAgreement` floors at zero
     *      rather than unwinds, leaving `ownerHasAgreement` true for an author
     *      holding nothing. On a fresh deployment the call is refused
     *      `AlreadyBackfilled()`, not accepted as a no-op.
     */
    function reinitializeV3() external reinitializer(2) onlySafe {
        if (_backfilled) revert AlreadyBackfilled();
        _backfilled = true;
        for (uint i = 0; i < agreementList.length; i++) {
            address author = genesisAuthor[agreementList[i]];
            if (author != address(0)) agreementsHeldBy[author] += 1;
        }
    }

    /**
     * @dev Only the publication's safe may start an upgrade, and only to an
     *      implementation the protocol safe set on the factory in `FACTORY`.
     *      There is no zero case to fail closed on: the constructor refused it,
     *      and the constant cannot change.
     */
    function _authorizeUpgrade(address newImplementation) internal onlySafe override {
        if (!IPublicationFactoryApprovals(FACTORY).isApprovedImplementation(newImplementation)) {
            revert ImplementationNotApproved(newImplementation);
        }
        emit ContractUpgraded(newImplementation);
    }

    function NAME() external pure returns (string memory) {
        return "S2S Publication Module V5";
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
        if (_ended[genesis]) revert Ended();
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

    /// @dev Publication admits a pending offer → agreement.
    function admit(bytes32 genesis) public onlySafe {
        if (_ended[genesis]) revert Ended();
        require(_isOffer[genesis], "no offer");
        _removeOffer(genesis);
        if (!_isAgreement[genesis]) _addAgreement(genesis);
        emit OfferAccepted(genesis, genesisAuthor[genesis]);
    }

    /// @custom:deprecated V2 name; use `admit`.
    function acceptOffer(bytes32 genesis) external onlySafe { admit(genesis); }

    /**
     * @dev The author's verb, and terminal. Ending an agreement sets `_ended`
     *      and tombstones the latest version, then removes the genesis from the
     *      agreement set; the publication can never strike it again. Withdrawing
     *      a pending offer that is under no agreement sets no flag: there is
     *      nothing to end. Only the genesis author reaches this function.
     */
    function retract(bytes32 genesis) external {
        if (msg.sender != genesisAuthor[genesis]) revert NotAuthorized();
        require(_isAgreement[genesis] || _isOffer[genesis], "not an agreement or offer");

        if (_isAgreement[genesis]) {
            _ended[genesis] = true;
            versions[genesis][latestIndex[genesis]].tombstone = true;
            _removeAgreement(genesis);
        } else {
            _removeOffer(genesis);
        }
        emit Retracted(genesis, msg.sender, false);
    }

    /**
     * @dev The publication's verb, and reversible. `reject` never sets `_ended`:
     *      an agreement returns to the pending offer set, an offer is declined,
     *      and the safe may accept again.
     */
    function reject(bytes32 genesis) external onlySafe {
        require(_isAgreement[genesis] || _isOffer[genesis], "not an agreement or offer");

        if (_isAgreement[genesis]) {
            _removeAgreement(genesis);
            if (!_isOffer[genesis]) _addOffer(genesis);
            emit Rejected(genesis, genesisAuthor[genesis], true);
        } else {
            _removeOffer(genesis);
            emit Rejected(genesis, genesisAuthor[genesis], false);
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

    /// @dev True iff the author has ended this genesis for this publication.
    ///      Permanent: `makeOffer` and `admit` revert for an ended genesis.
    function hasEnded(bytes32 genesis) external view returns (bool) {
        return _ended[genesis];
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
            // Later versions: only the genesis author writes. The publication
            // cannot append onto somebody else's genesis.
            if (author != genesisAuthor[genesis]) revert NotGenesisAuthor();
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
