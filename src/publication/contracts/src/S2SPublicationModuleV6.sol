// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title S2SPublicationModuleV6
 * @notice The publication module for a fresh start: no migration, one kind, one
 *         initializer, one approval set.
 *
 * A module is deployed by S2SPublicationModulesFactoryV6 behind a proxy whose
 * address depends only on (factory, safe, kind). Nothing here is carried over
 * from an earlier module: no reinitializer, no sentinel in a slot somebody else
 * spent, no deprecated name. This is the first module a fresh deployment runs,
 * so it has no predecessor to be compatible with, and no proxy can arrive in a
 * state this code cannot explain.
 *
 * Three declarations, all read by the factory before it will set this
 * implementation:
 *   - `moduleKind()` says which kind it is, so a module of one kind cannot be
 *     handed another kind's storage layout,
 *   - `factory()` says which factory judges its upgrades,
 *   - `proxiableUUID()` says it has an upgrade door, so no module that moves here
 *     is frozen.
 *
 * Upgrade authority. The publication's safe chooses when to move, and
 * `_authorizeUpgrade` asks the factory whether the target is approved *for this
 * kind*. Getting that wrong is a freeze, not a takeover: an unapproved target
 * reverts `ImplementationNotApproved`.
 *
 * Initialisation. `initialize(address safe, bytes params)` is called by the
 * factory, in the same call that deploys the proxy, with the safe it recorded.
 * The safe is therefore never an argument a caller can supply, and the module
 * cannot be left uninitialised for someone else to claim. `params` decodes to
 * `(address[] authors, address[] devs)`.
 *
 * Genesis identity. The id is the client's to derive, normalised by the shared
 * helper before the call; the module records who claimed it first and lets no
 * one else append. It does not check how the id was derived, so the derivation
 * stays one thing in one place rather than two that must agree.
 *
 * Model:
 *   - `makeOffer` is the single write authors use. It appends a version to the
 *     log, then: whitelisted author (or safe) → the document becomes an
 *     AGREEMENT immediately; anyone else → it becomes a pending OFFER, and an
 *     edit to a document that was already agreed moves it back to an OFFER.
 *     The publication never holds an agreement to a version it did not admit.
 *   - `admit` (onlySafe) promotes an offer to an agreement.
 *   - the author `retract`s (terminal), the publication `reject`s (reversible).
 *   - `canPublish`, `canRead`, `canReview` stay the three separate predicates
 *     they were: publish rights, per-genesis reads, and reviewer membership are
 *     different questions.
 *
 * Storage: declared once, in the order the contract reads it. There is no older
 * layout to stay compatible with.
 */
/// @dev The reads this module makes on the factory. Declared here rather than
///      imported: importing the factory would tie the module to one build of it,
///      and `FACTORY` is whatever factory the protocol deploy chose.
interface IPublicationFactoryApprovals {
    function isApproved(bytes32 kind, address implementation) external view returns (bool);
    function protocolSafe() external view returns (address);
}

contract S2SPublicationModuleV6 is Initializable, UUPSUpgradeable {

    address public safe;

    // ── Constants ──────────────────────────────────────────────────

    /// @notice This module's kind. The factory approves upgrade targets per
    ///         kind, and the gate below asks about this one, so a target approved
    ///         for another kind is not a target here.
    bytes32 public constant MODULE_KIND = keccak256("s2s.module.publication");

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

    // ── Reviewers & ended genesis ──────────────────────────────────

    mapping(address reviewer => bool) private reviewers;
    address[] private reviewerList;
    mapping(address author => uint256) private agreementsHeldBy;
    mapping(bytes32 genesis => bool) private _ended;

    // ── Membership beside the arrays (fresh start only) ────────────

    /// @dev `whitelisted_authors` answers "who is whitelisted" only by copying
    ///      the whole array into memory, which is up to 100 storage reads on every
    ///      `makeOffer` and `canPublish`. These two answer the same question in one
    ///      read. The arrays stay, because the getters enumerate them.
    mapping(address author => bool) private authorSet;
    mapping(address dev => bool) private devSet;

    // ── Upgrade authority (constructor constant, no storage) ───────

    /// @dev The factory whose approved set decides what this module may upgrade
    ///      to. Immutable: it is the same answer for every proxy over this
    ///      implementation, and no storage write can change it.
    address public immutable FACTORY;

    /// @notice The factory that approves this module's upgrades.
    /// @dev A constant, not a slot: the same answer for every proxy over this
    ///      implementation. The factory reads it to tell a module it governs from
    ///      one it does not.
    function factory() external view returns (address) {
        return FACTORY;
    }

    // ── Events ─────────────────────────────────────────────────────

    event Appended(bytes32 indexed genesis, string cid, uint256 versionIndex, address indexed author);
    event OfferMade(bytes32 indexed genesis, address indexed author);
    event OfferAccepted(bytes32 indexed genesis, address indexed author);
    /// An edit by a non-whitelisted author moved an agreement back to the offer
    /// set: the agreed version is no longer the latest one, so the publication
    /// has not seen what is on the log.
    event AgreementSuspended(bytes32 indexed genesis, address indexed author);
    event AgreementStruck(bytes32 indexed genesis, address indexed author);
    event Retracted(bytes32 indexed genesis, address indexed by);
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
    error OnlyFactory();
    error ImplementationNotApproved(address implementation);
    error ProtocolSafeMismatch(address factorySays, address expected);

    modifier onlySafe() {
        if (msg.sender != safe) revert OnlySafe();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    /// @param _factory The factory that approves upgrade targets. Must have
    ///        code: the value cannot be corrected after this point, and a
    ///        factory that answers nothing refuses every upgrade for good.
    /// @param _protocolSafe The protocol safe this deploy expects the factory to
    ///        name. The constructor refuses a factory that disagrees about which
    ///        safe governs it, which catches a wrong address where alone it can be
    ///        caught, before the immutable is fixed. It is not proof of ownership:
    ///        a factory answering the same safe and governed by someone else passes
    ///        it. What binds this implementation to the protocol is the protocol
    ///        safe's `setImplementation` on that factory.
    constructor(address _factory, address _protocolSafe) {
        if (_factory == address(0) || _factory.code.length == 0) revert InvalidFactory(_factory);
        address answers = IPublicationFactoryApprovals(_factory).protocolSafe();
        if (answers != _protocolSafe) revert ProtocolSafeMismatch(answers, _protocolSafe);
        FACTORY = _factory;
        _disableInitializers();
    }

    /**
     * @dev Called by the factory, in the same call that deployed this proxy.
     *      Only the factory may reach it: the safe it is given is the safe the
     *      factory recorded, and a caller cannot substitute one.
     *
     *      `params` is `abi.encode(address[] authors, address[] devs)`; empty
     *      bytes means no whitelisting. The caps are checked here as well as in
     *      `whitelistAuthor`/`whitelistDev`, because the lists arrive whole and a
     *      single oversized call would otherwise start above the cap. The cap
     *      counts entries in the list, so a list holding duplicates is refused
     *      sooner than the array would be full.
     */
    function initialize(address _safe, bytes calldata params) external initializer {
        if (msg.sender != FACTORY) revert OnlyFactory();
        __UUPSUpgradeable_init();
        safe = _safe;

        if (params.length != 0) {
            (address[] memory _authors, address[] memory _devs) = abi.decode(
                params,
                (address[], address[])
            );
            if (_authors.length > MAX_WHITELISTED_AUTHORS) revert MaxAuthorsReached();
            if (_devs.length > MAX_WHITELISTED_DEVS) revert MaxDevsReached();

            for (uint i = 0; i < _authors.length; i++) {
                if (_authors[i] == address(0)) revert InvalidAuthorAddress();
                if (!authorSet[_authors[i]]) {
                    authorSet[_authors[i]] = true;
                    whitelisted_authors.push(_authors[i]);
                }
            }
            for (uint i = 0; i < _devs.length; i++) {
                if (_devs[i] == address(0)) revert InvalidDevAddress();
                if (!devSet[_devs[i]]) {
                    devSet[_devs[i]] = true;
                    whitelisted_devs.push(_devs[i]);
                }
            }
        }
    }

    /// @notice This module's kind, matching the kind it is approved under.
    function moduleKind() external pure returns (bytes32) {
        return MODULE_KIND;
    }

    /**
     * @dev Only the publication's safe may start an upgrade, and only to an
     *      implementation the protocol safe approved *for this kind* on the
     *      factory in `FACTORY`. Approval is read at the moment of the upgrade,
     *      so a target withdrawn later cannot be used, and approval for another
     *      kind does not apply here.
     */
    function _authorizeUpgrade(address newImplementation) internal onlySafe override {
        if (!IPublicationFactoryApprovals(FACTORY).isApproved(MODULE_KIND, newImplementation)) {
            revert ImplementationNotApproved(newImplementation);
        }
        emit ContractUpgraded(newImplementation);
    }

    function NAME() external pure returns (string memory) {
        return "S2S Publication Module V6";
    }

    // ── Single write: makeOffer (append + place in agreements or offers) ─

    /**
     * @dev Append a version and place the document. Whitelisted author or safe
     *      → agreement; anyone else → offer. Editing an existing offer just
     *      appends another version and it stays an offer. Editing a document that
     *      is already an agreement suspends the agreement: the new version is not
     *      the one the publication admitted, so it goes back to the offer set and
     *      the publication admits it again. `AgreementSuspended` is the signal;
     *      the return value is false for that author either way.
     */
    function makeOffer(
        bytes32 genesis,
        string calldata cid
    ) external returns (bool agreed) {
        if (_ended[genesis]) revert Ended();
        _append(genesis, cid, msg.sender);

        if (msg.sender == safe || authorSet[msg.sender]) {
            if (_isOffer[genesis]) _removeOffer(genesis);
            if (!_isAgreement[genesis]) {
                _addAgreement(genesis);
                emit AgreementStruck(genesis, genesisAuthor[genesis]);
            }
            return true;
        }

        // Non-whitelisted author. The version just appended is not the version
        // the publication agreed to, so an agreement does not survive it: the
        // document goes back to the offer set and the publication admits the new
        // version explicitly, or the edit stays an offer. An author who should
        // not wait for that is whitelisted, and the branch above applies.
        if (_isAgreement[genesis]) {
            _removeAgreement(genesis);
            if (!_isOffer[genesis]) _addOffer(genesis);
            emit AgreementSuspended(genesis, genesisAuthor[genesis]);
        } else if (!_isOffer[genesis]) {
            _addOffer(genesis);
            emit OfferMade(genesis, genesisAuthor[genesis]);
        }
        return false;
    }

    /// @dev Publication admits a pending offer → agreement.
    function admit(bytes32 genesis) public onlySafe {
        if (_ended[genesis]) revert Ended();
        require(_isOffer[genesis], "no offer");
        _removeOffer(genesis);
        if (!_isAgreement[genesis]) _addAgreement(genesis);
        emit OfferAccepted(genesis, genesisAuthor[genesis]);
    }

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
        emit Retracted(genesis, msg.sender);
    }

    /**
     * @dev The publication's verb, and reversible. `reject` never sets `_ended`:
     *      an agreement returns to the pending offer set, an offer is declined,
     *      and the safe may accept again.
     *
     *      Deliberately not a lock. A whitelisted author can undo a rejection by
     *      calling `makeOffer` once more, because a whitelisted write becomes an
     *      agreement on its own. That is the whitelist's meaning: the publication
     *      agreed in advance to whatever those authors write. Removing the author
     *      from the whitelist is the lever, and it is the safe's.
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

    function hasOffer(bytes32 genesis) external view returns (bool) {
        return _isOffer[genesis];
    }

    /// @dev When `genesis` entered the agreement set, or zero when it is not in it.
    ///      `_addAgreement` writes this and `_removeAgreement` clears it; nothing
    ///      else on chain reads it, so this view is the only way it is seen.
    function agreedAt(bytes32 genesis) external view returns (uint256) {
        return agreementAt[genesis];
    }

    /// @dev When `genesis` entered the offer set, or zero when it is not in it.
    function offeredAt(bytes32 genesis) external view returns (uint256) {
        return offerAt[genesis];
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

    function getOffers(uint256 offset, uint256 limit) external view returns (Entry[] memory) {
        return _page(offerList, offset, limit);
    }

    function getAgreementCount() public view returns (uint256) { return agreementList.length; }

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
        if (devSet[_address]) return true;
        if (authorSet[_address]) return true;
        return false;
    }

    function isWhitelistedAuthor(address _address) external view returns (bool) {
        return authorSet[_address];
    }

    function isWhitelistedDev(address _address) external view returns (bool) {
        return devSet[_address];
    }

    // ── Whitelist management ───────────────────────────────────────

    function whitelistAuthor(address _author) external onlySafe {
        if (_author == address(0)) revert InvalidAuthorAddress();
        if (whitelisted_authors.length >= MAX_WHITELISTED_AUTHORS) revert MaxAuthorsReached();
        if (!authorSet[_author]) {
            authorSet[_author] = true;
            whitelisted_authors.push(_author);
            emit AuthorWhitelisted(_author);
        }
    }

    function removeWhitelistedAuthor(address _author) external onlySafe {
        for (uint i = 0; i < whitelisted_authors.length; i++) {
            if (whitelisted_authors[i] == _author) {
                whitelisted_authors[i] = whitelisted_authors[whitelisted_authors.length - 1];
                whitelisted_authors.pop();
                authorSet[_author] = false;
                emit AuthorRemovedFromWhitelist(_author);
                return;
            }
        }
    }

    function whitelistDev(address _dev) external onlySafe {
        if (_dev == address(0)) revert InvalidDevAddress();
        if (whitelisted_devs.length >= MAX_WHITELISTED_DEVS) revert MaxDevsReached();
        if (!devSet[_dev]) {
            devSet[_dev] = true;
            whitelisted_devs.push(_dev);
            emit DevWhitelisted(_dev);
        }
    }

    function removeWhitelistedDev(address _dev) external onlySafe {
        for (uint i = 0; i < whitelisted_devs.length; i++) {
            if (whitelisted_devs[i] == _dev) {
                whitelisted_devs[i] = whitelisted_devs[whitelisted_devs.length - 1];
                whitelisted_devs.pop();
                devSet[_dev] = false;
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

}
