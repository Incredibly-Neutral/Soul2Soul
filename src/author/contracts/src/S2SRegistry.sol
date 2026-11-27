// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IAuthorGate} from "./S2SAuthorGate.sol";

/**
 * @title S2SRegistry
 * @notice Author handles on Base. A handle is the unique name; the pen name the
 *         CLI writes is free text and `.s2s` is display only. Nothing here is
 *         ENS or DNS: the mapping is this contract's storage.
 *
 *         The registered owner of a handle is a Safe (`msg.sender`), and a Safe
 *         is accepted only when `S2SAuthorGate` says it is an author holding the
 *         records module named at registration. The gate's allowlists are
 *         constructor arguments of the gate, not of this contract.
 *
 *         Handle rules are byte rules on the raw UTF-8 bytes, checked in this
 *         order: length 3..32 bytes, then `a-z 0-9 -` only (uppercase is
 *         rejected, never folded), then no leading, trailing or doubled hyphen,
 *         then reservation, then the skeleton claim, then the cooldown. The
 *         same structure check runs in `reserve`, `unreserve` and
 *         `assignReserved`, so governance cannot reserve or assign a spelling
 *         that `register` would refuse.
 *
 *         Skeleton: lowercased, `-` removed, then `0→o`, `1→l`, `i→l`, `5→s`,
 *         `rn→m`, `vv→w`, applied in one pass over the hyphen-free bytes. The
 *         skeleton is what the one-name-per-spelling rule keys on, so `alice`,
 *         `a1ice`, `al-ice` and `allce` all claim the same name, and `cor-n`
 *         folds with `corn`, not with `c0rn`.
 *
 *         Governance can reserve names and assign a reserved name to a Safe. It
 *         has no path to change a registered entry's owner, version or records
 *         location, and no way to release on someone else's behalf: there is
 *         deliberately no such function. The only writer of an entry after
 *         `register` is the owning Safe (`setRecordsLocation`, `release`).
 *
 *         State transitions (see the functions): `register` writes an entry;
 *         `release` deletes it and starts the cooldown; a released handle keeps
 *         its version in `lastVersion`, so a re-registration after the cooldown
 *         gets version + 1 and a version is never reused.
 */
contract S2SRegistry {

    /// @notice How a Safe's records module proves it belongs to that Safe.
    struct Entry {
        address safe;
        string handle;
        uint32 version;
        uint64 registeredAt;
        address recordsLocation;
    }

    /// @dev `check` reasons, exported so callers and tests read the same numbers.
    uint8 public constant REASON_FREE = 0;
    uint8 public constant REASON_INVALID_CHAR = 1;
    uint8 public constant REASON_INVALID_LENGTH = 2;
    uint8 public constant REASON_INVALID_HYPHEN = 3;
    uint8 public constant REASON_RESERVED = 4;
    uint8 public constant REASON_SKELETON_TAKEN = 5;
    uint8 public constant REASON_COOLING = 6;
    uint8 public constant REASON_REGISTERED = 7;

    /// @notice Release cooldown. Blocks a second Safe from taking a name the
    ///         moment it is freed, not the previous owner from returning.
    uint64 public constant COOLDOWN = 90 days;

    /// @notice The gate asked about `msg.sender` at registration time.
    address public authorGate;

    /// @notice The only address allowed to reserve, assign and move the gate.
    address public governance;

    /// @dev Keyed `keccak256(bytes(handle))`. Deleted on release.
    mapping(bytes32 => Entry) private entries;

    /// @dev The handle a Safe currently holds, or zero.
    mapping(address => bytes32) private handleOf;

    /// @dev Skeleton hash → the handle hash that claimed it. Cleared on release,
    ///      which is what frees the spellings together.
    mapping(bytes32 => bytes32) private skeletonOwner;

    /// @dev Skeleton hashes governance keeps out of public registration.
    mapping(bytes32 => bool) private reserved;

    /// @dev Skeleton hash → the timestamp before which no one may claim it.
    mapping(bytes32 => uint64) private coolingUntil;

    /// @dev The last version ever assigned per handle hash. `entries[h]` is
    ///      deleted on release, so this is the only record that keeps a
    ///      re-registration from restarting at 1 and reusing a version.
    mapping(bytes32 => uint32) private lastVersion;

    event Registered(
        bytes32 indexed handleHash,
        string handle,
        address indexed safe,
        uint32 version
    );
    event Released(bytes32 indexed handleHash, address indexed safe, bytes32 skeletonHash);
    event RecordsLocationSet(bytes32 indexed handleHash, address location);
    /// @dev `handle` is carried so an indexer can recover the reserved spelling,
    ///      not just the skeleton it folds to.
    event ReservedSet(bytes32 indexed skeletonHash, bool reserved, string handle);
    event AuthorGateSet(address gate);
    event GovernanceTransferred(address governance);

    error InvalidChar(uint256 index);
    error InvalidLength();
    error InvalidHyphen();
    error Reserved();
    error SkeletonTaken();
    error CoolingDown(uint64 until);
    error AlreadyRegistered();
    error NoHandle();
    error NotAuthor();
    error NotGovernance();
    error ZeroAddress();
    error NotAContract();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    /**
     * @param _authorGate The author gate. Must have code: it is called on every
     *        registration and assignment.
     * @param _governance The governance address. Must have code and be non-zero;
     *        governance must be able to send a transaction (a Safe or a
     *        governance executor), because every governance function is
     *        `msg.sender == governance`.
     */
    constructor(address _authorGate, address _governance) {
        if (_authorGate == address(0) || _governance == address(0)) revert ZeroAddress();
        if (_authorGate.code.length == 0 || _governance.code.length == 0) revert NotAContract();
        authorGate = _authorGate;
        governance = _governance;
    }

    // ── The owning Safe writes ─────────────────────────────────────

    /**
     * @notice Claim `handle` for `msg.sender`, pointing at `recordsLocation`.
     * @dev Order is fixed: one handle per Safe, then the gate, then the name
     *      rules. `recordsLocation` must be the Safe's own enabled records
     *      module — the gate checks that it answers `safe()` with `msg.sender` —
     *      so a registration cannot point at another author's module.
     */
    function register(string calldata handle, address recordsLocation) external {
        if (handleOf[msg.sender] != bytes32(0)) revert AlreadyRegistered();
        if (!IAuthorGate(authorGate).isAuthor(msg.sender, recordsLocation)) revert NotAuthor();

        bytes32 skeletonHash = _requireName(handle);
        bytes32 handleHash = keccak256(bytes(handle));
        if (reserved[skeletonHash]) revert Reserved();
        if (skeletonOwner[skeletonHash] != bytes32(0)) revert SkeletonTaken();
        uint64 until = coolingUntil[skeletonHash];
        if (until > block.timestamp) revert CoolingDown(until);

        _writeEntry(handleHash, skeletonHash, handle, msg.sender, recordsLocation);
    }

    /**
     * @notice Give up `msg.sender`'s handle. The entry is deleted, the skeleton
     *         is freed, and the cooldown starts. The version stays in
     *         `lastVersion`, so the next registration of this handle continues
     *         the sequence instead of reusing one.
     */
    function release() external {
        bytes32 handleHash = handleOf[msg.sender];
        if (handleHash == bytes32(0)) revert NoHandle();

        bytes32 skeletonHash = keccak256(bytes(_skeleton(entries[handleHash].handle)));
        delete entries[handleHash];
        delete handleOf[msg.sender];
        delete skeletonOwner[skeletonHash];
        coolingUntil[skeletonHash] = uint64(block.timestamp) + COOLDOWN;

        emit Released(handleHash, msg.sender, skeletonHash);
    }

    /// @notice Move the owning Safe's records pointer, e.g. after the Safe
    ///         installs a new records module.
    function setRecordsLocation(address location) external {
        bytes32 handleHash = handleOf[msg.sender];
        if (handleHash == bytes32(0)) revert NoHandle();
        entries[handleHash].recordsLocation = location;
        emit RecordsLocationSet(handleHash, location);
    }

    // ── Governance ─────────────────────────────────────────────────
    //
    // Read this before adding a governance function: governance has no path to
    // change a registered entry's `safe`, `version` or `recordsLocation`, and no
    // way to release another address's handle. `assignReserved` writes only a
    // free handle, with the Safe's own module passed and gate-checked, so it can
    // give away an unclaimed reserved name but can never move one that exists.

    /// @notice Reserve the skeletons of `handles` so public registration refuses
    ///         them. Each handle must pass the same structure check `register`
    ///         applies; a spelling no author could register is refused rather
    ///         than reserved as an unmatchable skeleton.
    function reserve(string[] calldata handles) external onlyGovernance {
        for (uint256 i = 0; i < handles.length; i++) {
            bytes32 skeletonHash = _requireName(handles[i]);
            reserved[skeletonHash] = true;
            emit ReservedSet(skeletonHash, true, handles[i]);
        }
    }

    /// @notice Return `handles`' skeletons to public registration. Validated for
    ///         the same reason `reserve` is: an invalid spelling names no
    ///         skeleton an author could hold.
    function unreserve(string[] calldata handles) external onlyGovernance {
        for (uint256 i = 0; i < handles.length; i++) {
            bytes32 skeletonHash = _requireName(handles[i]);
            reserved[skeletonHash] = false;
            emit ReservedSet(skeletonHash, false, handles[i]);
        }
    }

    /**
     * @notice Assign a reserved `handle` to `safe`, at `recordsLocation`.
     * @dev The `recordsLocation` argument exists because the pointer must be
     *      written at registration and governance cannot read it later. The
     *      reserved flag is left set: a released name returns to the pool, not
     *      to public registration.
     *
     *      `Reserved()` is the failed precondition here as well as the refusal
     *      in `register`: this function requires the skeleton to be in the
     *      reserved set, and the error set has no separate `NotReserved`.
     */
    function assignReserved(
        string calldata handle,
        address safe,
        address recordsLocation
    ) external onlyGovernance {
        bytes32 skeletonHash = _requireName(handle);
        bytes32 handleHash = keccak256(bytes(handle));

        if (!reserved[skeletonHash]) revert Reserved();
        if (entries[handleHash].safe != address(0)) revert SkeletonTaken();
        if (skeletonOwner[skeletonHash] != bytes32(0)) revert SkeletonTaken();
        uint64 until = coolingUntil[skeletonHash];
        if (until > block.timestamp) revert CoolingDown(until);
        if (handleOf[safe] != bytes32(0)) revert AlreadyRegistered();
        if (!IAuthorGate(authorGate).isAuthor(safe, recordsLocation)) revert NotAuthor();

        _writeEntry(handleHash, skeletonHash, handle, safe, recordsLocation);
    }

    /// @notice Point the registry at a new author gate. Non-zero and with code:
    ///         this is the contract every registration trusts.
    function setAuthorGate(address gate) external onlyGovernance {
        if (gate == address(0)) revert ZeroAddress();
        if (gate.code.length == 0) revert NotAContract();
        authorGate = gate;
        emit AuthorGateSet(gate);
    }

    function transferGovernance(address newGovernance) external onlyGovernance {
        if (newGovernance == address(0)) revert ZeroAddress();
        governance = newGovernance;
        emit GovernanceTransferred(newGovernance);
    }

    // ── Reads ──────────────────────────────────────────────────────

    /// @notice The Safe holding `handle`, or zero. A released name resolves to
    ///         zero even though its version is retained.
    function resolve(string calldata handle) external view returns (address) {
        return entries[keccak256(bytes(handle))].safe;
    }

    /// @notice The handle `who` holds, or the empty string.
    function nameOf(address who) external view returns (string memory) {
        bytes32 handleHash = handleOf[who];
        if (handleHash == bytes32(0)) return "";
        return entries[handleHash].handle;
    }

    /// @notice The live entry for `handle`, or a zeroed entry when it is free.
    function entry(string calldata handle) external view returns (Entry memory) {
        return entries[keccak256(bytes(handle))];
    }

    /// @notice The last version ever assigned to `handle`, 0 if never
    ///         registered. Survives release on purpose: versions are never
    ///         reused. For the live entry's version use `entry(handle).version`.
    function versionOf(string calldata handle) external view returns (uint32) {
        return lastVersion[keccak256(bytes(handle))];
    }

    /**
     * @notice Whether `handle` can be registered right now, and why not.
     * @dev Caller-independent: it does not consider whether the caller already
     *      holds another handle. `register` still reverts `AlreadyRegistered`
     *      in that case.
     *
     *      Reasons 1..3 precede the storage checks; a name that fails the
     *      structure rules returns that reason even when it is also reserved.
     */
    function check(string calldata handle) external view returns (bool available, uint8 reason) {
        (uint8 nameReason, , bytes32 skeletonHash) = _nameReason(handle);
        if (nameReason != REASON_FREE) return (false, nameReason);

        bytes32 handleHash = keccak256(bytes(handle));
        if (reserved[skeletonHash]) return (false, REASON_RESERVED);
        if (entries[handleHash].safe != address(0)) return (false, REASON_REGISTERED);
        if (skeletonOwner[skeletonHash] != bytes32(0)) return (false, REASON_SKELETON_TAKEN);
        if (coolingUntil[skeletonHash] > block.timestamp) return (false, REASON_COOLING);
        return (true, REASON_FREE);
    }

    /// @notice The skeleton of `handle`: lowercased, `-` removed, then `0→o`,
    ///         `1→l`, `i→l`, `5→s`, `rn→m`, `vv→w`, one pass over the
    ///         hyphen-free bytes.
    /// @dev Canonical even for input `register` would refuse, so callers can use
    ///      it to compare spellings before validation. Validation uses the same
    ///      private function, so a rule change cannot make `check` disagree with
    ///      `register`.
    function skeletonOf(string calldata handle) external pure returns (string memory) {
        return _skeleton(handle);
    }

    // ── Internal ───────────────────────────────────────────────────

    /// @dev The one write path shared by `register` and `assignReserved`.
    function _writeEntry(
        bytes32 handleHash,
        bytes32 skeletonHash,
        string calldata handle,
        address safe,
        address recordsLocation
    ) private {
        uint32 version = lastVersion[handleHash] + 1;
        lastVersion[handleHash] = version;
        entries[handleHash] = Entry({
            safe: safe,
            handle: handle,
            version: version,
            registeredAt: uint64(block.timestamp),
            recordsLocation: recordsLocation
        });
        handleOf[safe] = handleHash;
        skeletonOwner[skeletonHash] = handleHash;
        emit Registered(handleHash, handle, safe, version);
    }

    /// @dev Structure and skeleton in one read, so `check` and the two writers
    ///      cannot disagree about what a name is. Order is the documented order:
    ///      length, characters (first offending byte index), hyphens, skeleton.
    function _nameReason(string calldata handle)
        private
        pure
        returns (uint8 reason, uint256 index, bytes32 skeletonHash)
    {
        bytes memory raw = bytes(handle);
        if (raw.length < 3 || raw.length > 32) {
            return (REASON_INVALID_LENGTH, 0, bytes32(0));
        }
        for (uint256 i = 0; i < raw.length; i++) {
            bytes1 c = raw[i];
            bool allowed = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x2d;
            if (!allowed) return (REASON_INVALID_CHAR, i, bytes32(0));
        }
        if (raw[0] == 0x2d || raw[raw.length - 1] == 0x2d) {
            return (REASON_INVALID_HYPHEN, 0, bytes32(0));
        }
        for (uint256 i = 1; i < raw.length; i++) {
            if (raw[i] == 0x2d && raw[i - 1] == 0x2d) {
                return (REASON_INVALID_HYPHEN, 0, bytes32(0));
            }
        }
        return (REASON_FREE, 0, keccak256(bytes(_skeleton(handle))));
    }

    /// @dev Structure check for the three governance writers: `register`'s
    ///      reason codes raise the same errors here, so a name governance can
    ///      reserve or assign is exactly a name an author could register.
    function _requireName(string calldata handle) private pure returns (bytes32 skeletonHash) {
        (uint8 reason, uint256 index, bytes32 validSkeleton) = _nameReason(handle);
        if (reason == REASON_INVALID_LENGTH) revert InvalidLength();
        if (reason == REASON_INVALID_CHAR) revert InvalidChar(index);
        if (reason == REASON_INVALID_HYPHEN) revert InvalidHyphen();
        return validSkeleton;
    }

    /// @dev Lowercase first, then drop every `-`, then fold the remaining bytes:
    ///      the pair rules see a hyphen-free buffer, so `cor-n` folds to `corn`
    ///      and then `com`, the same as `corn`. The output is trimmed with
    ///      `mstore` to the bytes actually written.
    function _skeleton(string memory handle) private pure returns (string memory) {
        bytes memory raw = bytes(handle);

        // Canonical case and hyphens out, in that order, before any pair rule.
        bytes memory stripped = new bytes(raw.length);
        uint256 strippedLength;
        for (uint256 i = 0; i < raw.length; i++) {
            bytes1 c = raw[i];
            if (c >= 0x41 && c <= 0x5a) c = bytes1(uint8(c) + 32);
            if (c == 0x2d) continue;
            stripped[strippedLength++] = c;
        }

        bytes memory out = new bytes(strippedLength);
        uint256 length;

        for (uint256 i = 0; i < strippedLength; i++) {
            bytes1 c = stripped[i];
            if (c == 0x72 && i + 1 < strippedLength && stripped[i + 1] == 0x6e) {
                out[length++] = 0x6d; // rn -> m
                i++;
            } else if (c == 0x76 && i + 1 < strippedLength && stripped[i + 1] == 0x76) {
                out[length++] = 0x77; // vv -> w
                i++;
            } else if (c == 0x30) {
                out[length++] = 0x6f; // 0 -> o
            } else if (c == 0x31 || c == 0x69) {
                out[length++] = 0x6c; // 1, i -> l
            } else if (c == 0x35) {
                out[length++] = 0x73; // 5 -> s
            } else {
                out[length++] = c;
            }
        }

        assembly {
            mstore(out, length)
        }
        return string(out);
    }
}
