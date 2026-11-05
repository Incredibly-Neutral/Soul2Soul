// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title OwnerHistoryModuleV1
 * @notice The author Safe's ownership history: who was an owner, and from which
 *         block. Installed as a UUPS proxy per author Safe, one proxy per Safe,
 *         exactly like DraftsModuleV1.
 *
 * Why this exists (the short version):
 *   The gate on the publication module asks `Safe.isOwner(signer)` — present
 *   tense. Rotate one owner and every earlier signature over the author's work
 *   stops verifying, even though the work did not change. This module keeps the
 *   missing tense: `isOwnerAt` and its timestamp twin `wasOwnerAt`.
 *
 * How it stays current:
 *   Safe 1.4.1 has no owner-rotation callback. The only on-chain tap is the
 *   transaction guard (`setGuard` is `onlySelf`, so a Safe tx installs it, and
 *   `execTransaction` calls `checkAfterExecution` every time). Every owner
 *   mutation is `onlySelf`, so every rotation passes through the guard, and the
 *   guard — `OwnerHistoryGuard`, a separate contract because a revert there
 *   would brick the Safe — calls `sync()` here.
 *
 *   `sync()` reads the Safe's live owner set and diffs it against the current
 *   era. It is permissionless and a pure function of chain state: the only
 *   thing it can write is what the Safe already says. That is deliberate — it
 *   is also the repair path when the hook is missed (a module enable/disable
 *   window, a guard removed for a Safe upgrade, an out-of-gas hook).
 *
 *   The tap is not a guarantee, and the guard is not the primary path:
 *     - The guard is **best-effort**. A Safe transaction whose gas limit is the
 *       estimated cost starves the hook, and the era is then stamped at the next
 *       `sync()`. Rotations proposed by this project's tooling should carry an
 *       explicit `sync()` call; the guard catches the ones that do not.
 *     - `execTransactionFromModule` is a self-call and skips guards, so an
 *       enabled Safe module can rotate owners and can `setGuard(address(0))`
 *       with no hook at all. Guard coverage is over *transactions*, not over a
 *       malicious module. Again: `sync()` repairs it.
 *
 * The half-open era model:
 *   Era k covers blocks `[startBlock, endBlock)`; `endBlock == 0` means "still
 *   current". For a block strictly in the past the eras and the tenure index
 *   are the whole answer, and at the boundary block — the block the Safe rotated
 *   in — the new set is authoritative: the tenure of whoever left ends there and
 *   the tenure of whoever joined starts there, so `isOwnerAt(x, boundary)` and
 *   `isOwnerAt(y, boundary)` give exactly one true answer for the pair that
 *   swapped, and no block belongs to two eras.
 *
 *   At the *head* the index is deliberately not consulted (see `isOwnerAt`):
 *   inside the current block the answer comes from the Safe's live `isOwner`, so
 *   it reflects whatever the pre-state or post-state of that block is at the
 *   moment of the call. A gate judging the current block must therefore read
 *   `isOwnerAt(who, block.number)` and accept that a rotation landing in the same
 *   block may or may not be visible — wait a block before trusting it.
 *
 * Storage declaration order is the upgrade contract, same rule as the drafts
 * module (INV-3 in the publication spec): `safe`, `eras`, `tenureBlocks`,
 * `tenureTimes`, `ownersEverSet`, `seen`.
 */
contract OwnerHistoryModuleV1 is Initializable, UUPSUpgradeable {

    /// @notice The Safe whose ownership this module mirrors. The only address
    ///         allowed to upgrade the module; everything else is permissionless.
    address public safe;

    /// @dev The two Safe calls this module makes, as selector constants rather
    ///      than through a local `interface`: an interface here would exist only
    ///      to be called, and would add a second, unused ABI entry to the
    ///      package's public surface. The strings are the Safe's own signatures.
    bytes4 private constant SAFE_GET_OWNERS = bytes4(keccak256("getOwners()"));
    bytes4 private constant SAFE_IS_OWNER = bytes4(keccak256("isOwner(address)"));

    struct Era {
        uint64 startBlock;      // first block of the era (inclusive)
        uint64 endBlock;        // first block NOT in the era; 0 = current
        uint64 startTime;       // first timestamp of the era (inclusive)
        uint64 endTime;         // first timestamp NOT in the era; 0 = current
        address[] owners;       // the owner set for the whole era
    }

    /// @dev One tenure per contiguous ownership spell. `end == 0` is ongoing.
    ///      The O(1)-per-address index: eras are the enumerable record, tenures
    ///      are what a per-signer query walks.
    struct Tenure {
        uint64 start;
        uint64 end;
    }

    Era[] private eras;
    mapping(address who => Tenure[]) private tenureBlocks;
    mapping(address who => Tenure[]) private tenureTimes;
    address[] private ownersEverSet;
    mapping(address who => bool) private seen;

    // ── Events ─────────────────────────────────────────────────────

    event EraOpened(uint256 indexed eraIndex, uint64 startBlock, uint64 startTime, address[] owners);
    event EraClosed(uint256 indexed eraIndex, uint64 endBlock, uint64 endTime);
    event OwnerAdded(address indexed owner, uint256 eraIndex);
    event OwnerRemoved(address indexed owner, uint256 eraIndex);
    event ContractUpgraded(address indexed implementation);

    // ── Errors ─────────────────────────────────────────────────────

    error OnlySafe();
    error ZeroAddress();
    error SafeCallFailed();
    /// @dev The `safe` answered `getOwners()` with nothing: deployed but not
    ///      `setup()`, or a contract that merely looks like a Safe. Era 0 would
    ///      be silently empty and nobody would ever have a tenure.
    error ZeroOwners();

    modifier onlySafe() {
        if (msg.sender != safe) revert OnlySafe();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Era 0 is the Safe's owner set at install time. Unlike the drafts
     *      module this reads the Safe immediately, so pointing the init at a
     *      contract without `getOwners()` fails here — at deployment, where it
     *      is free — instead of on the first `sync()` behind a guard's catch,
     *      where it would be silent.
     */
    function initialize(address _safe) public initializer {
        if (_safe == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        safe = _safe;

        address[] memory owners = _readSafeOwners();
        if (owners.length == 0) revert ZeroOwners();
        uint256 index = _openEra(owners);
        for (uint256 i = 0; i < owners.length; i++) {
            // Era 0's owners get a tenure too, opened at this block. Without it
            // `isOwnerAt` would answer "no" for the founding set at any block
            // before the first rotation — the era would show them and the index
            // would deny them.
            _openTenure(owners[i]);
            emit OwnerAdded(owners[i], index);
        }
    }

    function _authorizeUpgrade(address newImplementation) internal onlySafe override {
        emit ContractUpgraded(newImplementation);
    }

    function NAME() external pure returns (string memory) {
        return "S2S Owner History Module V1";
    }

    // ── The one write ──────────────────────────────────────────────

    /**
     * @dev Bring the mirror up to date with the Safe. Permissionless: the write
     *      is fully determined by `safe.getOwners()` plus the current block, so
     *      there is nothing an unauthorized caller could forge.
     *
     *      Idempotent: when the set is unchanged it writes nothing (not even a
     *      timestamp) and returns false, so the guard can call it on every Safe
     *      transaction for the price of one `getOwners()` read — and a stranger
     *      can call it after a missed hook to repair the gap.
     *
     *      The repair is lossy by exactly one gap: the new era starts at the
     *      *sync* block, not at the block the Safe actually rotated. Everything
     *      between the real rotation and the repair is attributed to the old
     *      set. That is the documented cost of not having a callback, and it is
     *      why the guard exists to keep the gap empty in normal operation.
     */
    function sync() external returns (bool) {
        // A proxy deployed without `initialize` has no era 0, and `length - 1`
        // would panic. Only reachable by skipping the factory, but the guard
        // calls this function with a swallowed revert, so it must fail cleanly.
        if (eras.length == 0) revert SafeCallFailed();

        address[] memory live = _readSafeOwners();

        uint256 lastIndex = eras.length - 1;
        address[] memory previous = eras[lastIndex].owners;
        if (_sameSet(live, previous)) return false;

        _closeEra(lastIndex);

        uint256 nextIndex = eras.length;
        for (uint256 i = 0; i < previous.length; i++) {
            if (!_contains(live, previous[i])) {
                _closeTenure(previous[i]);
                emit OwnerRemoved(previous[i], nextIndex);
            }
        }

        _openEra(live);

        for (uint256 i = 0; i < live.length; i++) {
            if (!_contains(previous, live[i])) {
                _openTenure(live[i]);
                emit OwnerAdded(live[i], nextIndex);
            }
        }

        return true;
    }

    // ── Reads: the live mirror ─────────────────────────────────────

    /**
     * @dev The Safe's own answer, never ours. If the Safe call fails (self-
     *      destructed, wrong chain, a `safe` that never had `isOwner`) this
     *      answers false instead of reverting: a gate that reverts on a bad
     *      lookup is a gate that can be DOSed by pointing at a dead address.
     */
    function isOwner(address who) public view returns (bool) {
        (bool ok, bytes memory data) = safe.staticcall(abi.encodeWithSelector(SAFE_IS_OWNER, who));
        if (!ok || data.length < 32) return false;
        // `abi.decode(data, (bool))` reverts on a word other than 0 or 1, which
        // would make this "never reverts" read revert. Compare the raw word.
        return abi.decode(data, (uint256)) == 1;
    }

    // ── Reads: history ─────────────────────────────────────────────

    /**
     * @dev The universal check: was `who` an owner at `blockNumber`? There is
     *      no second, "either tense" variant on purpose. A function answering
     *      `isOwner(who) || isOwnerAt(who, n)` would accept an owner who joined
     *      *after* `n` for a query *about* `n` — precisely the substitution a
     *      gate exists to reject ("was this signer an owner when they signed?")
     *      — and it would be redundant, because this function already covers
     *      the present tense:
     *
     *        - `blockNumber` < the current block: answered from the tenure
     *          index, half-open, so the block a rotation landed in belongs to
     *          the new set.
     *        - `blockNumber` >= the current block: answered by the Safe's own
     *          `isOwner`. The index can lag by one `sync()` inside a block (the
     *          guard runs after the mutation), and a mirror that said "no"
     *          about a sitting owner in the current block would be wrong in the
     *          case callers care about most.
     *
     *      So a gate that wants "owner now" calls `isOwnerAt(who, block.number)`
     *      and gets the live set; a gate proving a past signature calls it with
     *      the block that signature was valid at and gets the historical set,
     *      including "nobody" for an address that joined later.
     */
    function isOwnerAt(address who, uint256 blockNumber) public view returns (bool) {
        if (blockNumber >= block.number) return isOwner(who);

        Tenure[] storage tenures = tenureBlocks[who];
        for (uint256 i = 0; i < tenures.length; i++) {
            Tenure storage t = tenures[i];
            if (blockNumber >= t.start && (t.end == 0 || blockNumber < t.end)) return true;
        }
        return false;
    }

    /// @dev Timestamp twin of `isOwnerAt`; same half-open rule on `endTime`.
    function wasOwnerAt(address who, uint256 timestamp) public view returns (bool) {
        if (timestamp >= block.timestamp) return isOwner(who);

        Tenure[] storage tenures = tenureTimes[who];
        for (uint256 i = 0; i < tenures.length; i++) {
            Tenure storage t = tenures[i];
            if (timestamp >= t.start && (t.end == 0 || timestamp < t.end)) return true;
        }
        return false;
    }

    function tenuresOf(address who) external view returns (Tenure[] memory blocks, Tenure[] memory times) {
        blocks = tenureBlocks[who];
        times = tenureTimes[who];
    }

    function eraCount() external view returns (uint256) {
        return eras.length;
    }

    /// @dev Out-of-range answers an empty era rather than reverting: an index
    ///      past the end is a caller mistake, not a reason a reader dies.
    function eraAt(uint256 index) public view returns (Era memory) {
        if (index >= eras.length) {
            return Era(0, 0, 0, 0, new address[](0));
        }
        Era storage e = eras[index];
        address[] memory owners = e.owners;
        return Era(e.startBlock, e.endBlock, e.startTime, e.endTime, owners);
    }

    function currentEra() external view returns (Era memory) {
        if (eras.length == 0) return Era(0, 0, 0, 0, new address[](0));
        return eraAt(eras.length - 1);
    }

    function ownersEver() external view returns (address[] memory) {
        return ownersEverSet;
    }

    /// @dev Start block of the current era: the last sync that actually moved
    ///      the set. A no-op `sync()` deliberately does not advance it.
    function lastSyncedBlock() external view returns (uint256) {
        if (eras.length == 0) return 0;
        return eras[eras.length - 1].startBlock;
    }

    function count() external view returns (uint256) {
        return ownersEverSet.length;
    }

    // ── Internal ───────────────────────────────────────────────────

    function _readSafeOwners() private view returns (address[] memory owners) {
        (bool ok, bytes memory data) = safe.staticcall(abi.encodeWithSelector(SAFE_GET_OWNERS));
        if (!ok || data.length == 0) revert SafeCallFailed();
        owners = abi.decode(data, (address[]));
    }

    /// @dev `_openEra` opens at the current block; the caller emits `OwnerAdded`
    ///      for the addresses that entered in this era, because "entered" is
    ///      only known to the caller (era 0: all of them).
    function _openEra(address[] memory owners) private returns (uint256 index) {
        index = eras.length;
        Era storage era = eras.push();
        era.startBlock = uint64(block.number);
        era.startTime = uint64(block.timestamp);

        for (uint256 i = 0; i < owners.length; i++) {
            era.owners.push(owners[i]);
            if (!seen[owners[i]]) {
                seen[owners[i]] = true;
                ownersEverSet.push(owners[i]);
            }
        }

        emit EraOpened(index, era.startBlock, era.startTime, owners);
    }

    function _closeEra(uint256 index) private {
        Era storage era = eras[index];
        era.endBlock = uint64(block.number);
        era.endTime = uint64(block.timestamp);
        emit EraClosed(index, era.endBlock, era.endTime);
    }

    function _openTenure(address who) private {
        tenureBlocks[who].push(Tenure(uint64(block.number), 0));
        tenureTimes[who].push(Tenure(uint64(block.timestamp), 0));
    }

    function _closeTenure(address who) private {
        Tenure[] storage blocks_ = tenureBlocks[who];
        Tenure[] storage times_ = tenureTimes[who];
        // Both arrays are written in lockstep, so the last entry of each belongs
        // to the tenure being closed. An already-closed tenure is **skipped**,
        // not asserted: closing twice would be a bug in `sync`, but a revert
        // here would be unrecoverable through a guard whose `catch` swallows it
        // and would leave the era half-written. Skipping keeps the write
        // idempotent, which is the property `sync` is allowed to rely on.
        if (blocks_.length > 0) {
            Tenure storage t = blocks_[blocks_.length - 1];
            if (t.end == 0) t.end = uint64(block.number);
        }
        if (times_.length > 0) {
            Tenure storage t = times_[times_.length - 1];
            if (t.end == 0) t.end = uint64(block.timestamp);
        }
    }

    function _contains(address[] memory set, address who) private pure returns (bool) {
        for (uint256 i = 0; i < set.length; i++) {
            if (set[i] == who) return true;
        }
        return false;
    }

    /// @dev Set equality, not order equality: Safe's `getOwners` order is
    ///      stable in practice but is not a guarantee, and an owner set is a set.
    ///      The Safe maintains no duplicates, so equal lengths plus one-way
    ///      containment is enough. Owner arrays are threshold-sized (a handful),
    ///      which is why the nested scan is acceptable here.
    function _sameSet(address[] memory a, address[] memory b) private pure returns (bool) {
        if (a.length != b.length) return false;
        for (uint256 i = 0; i < a.length; i++) {
            if (!_contains(b, a[i])) return false;
        }
        return true;
    }
}
