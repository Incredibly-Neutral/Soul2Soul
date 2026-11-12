// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * NOTE ON THE FILE NAME: `.t.sol`, as with `MockSafe.t.sol`. `hardhat-deploy`'s
 * `generateTypedArtifacts` hook skips that suffix, so these fixtures compile for
 * the suite and never land in `generated/` as if they were part of the package's
 * ABI surface.
 *
 * These are drafts modules that do not behave: what `absorb` has to survive when
 * the module it imports from is not this package's. None of them may abort the
 * batch — a broken old log is a page with nothing in it, not a failed call.
 */

/**
 * @title RevertingOldModule
 * @notice Reverts from both reads, which is the polite way to fail.
 */
contract RevertingOldModule {
    error Broken();

    function fetchAllPaged(uint256, uint256) external pure returns (bytes32[] memory) {
        revert Broken();
    }

    function history(bytes32) external pure returns (uint256[] memory, string[] memory) {
        revert Broken();
    }
}

/**
 * @title GarbageOldModule
 * @notice Answers anything, including a matching selector, with one word that
 *         cannot be a valid offset in a one-word answer. This is the case a
 *         typed call cannot survive: the call succeeds, and the *decode* is what
 *         would revert — in the caller's frame, where `try`/`catch` does not
 *         reach.
 */
contract GarbageOldModule {
    fallback() external {
        assembly {
            mstore(0x00, not(0))
            return(0x00, 0x20)
        }
    }
}

/**
 * @title HalfBrokenOldModule
 * @notice A page of two genesis, one of which has a readable history and one of
 *         which reverts. The batch must import the first and skip the second.
 */
contract HalfBrokenOldModule {
    struct Entry {
        bytes32 genesis;
        address author;
        string cid;
        uint256 timestamp;
        uint256 versionCount;
    }

    bytes32 public immutable good;
    bytes32 public immutable bad;

    string[] private cids;
    uint256[] private stamps;

    constructor(bytes32 good_, bytes32 bad_) {
        good = good_;
        bad = bad_;
        cids.push("bafy-old-v1");
        cids.push("bafy-old-v2");
        stamps.push(1_700_000_001);
        stamps.push(1_700_000_002);
    }

    /// @dev Same shape as the module's, honouring offset and limit the same way.
    function fetchAllPaged(uint256 offset, uint256 limit) external view returns (Entry[] memory page) {
        if (offset >= 2 || limit == 0) return new Entry[](0);
        if (limit > 2 - offset) limit = 2 - offset;

        page = new Entry[](limit);
        for (uint256 i = 0; i < limit; i++) {
            bytes32 g = offset + i == 0 ? good : bad;
            page[i] = Entry({genesis: g, author: address(this), cid: "", timestamp: 0, versionCount: 0});
        }
    }

    function history(bytes32 g) external view returns (uint256[] memory, string[] memory) {
        if (g != good) revert("no such history");
        return (stamps, cids);
    }
}

/**
 * @title BadHistoryOldModule
 * @notice A page of three genesis whose histories are all wrong in a different
 *         way: one is fine, one returns arrays of different lengths, one returns
 *         a timestamp wider than the module stores. The import must take the
 *         first and skip the other two whole — a half-imported history would
 *         claim to be a complete trail, and a truncated timestamp would be a
 *         timestamp that is not the one on the old log.
 */
contract BadHistoryOldModule {
    struct Entry {
        bytes32 genesis;
        address author;
        string cid;
        uint256 timestamp;
        uint256 versionCount;
    }

    bytes32 public immutable good;
    bytes32 public immutable skewed;
    bytes32 public immutable tooLate;

    constructor(bytes32 good_, bytes32 skewed_, bytes32 tooLate_) {
        good = good_;
        skewed = skewed_;
        tooLate = tooLate_;
    }

    function fetchAllPaged(uint256 offset, uint256 limit) external view returns (Entry[] memory page) {
        if (offset >= 3 || limit == 0) return new Entry[](0);
        if (limit > 3 - offset) limit = 3 - offset;

        bytes32[3] memory all = [good, skewed, tooLate];
        page = new Entry[](limit);
        for (uint256 i = 0; i < limit; i++) {
            page[i] = Entry({genesis: all[offset + i], author: address(this), cid: "", timestamp: 0, versionCount: 0});
        }
    }

    function history(bytes32 g) external view returns (uint256[] memory stamps, string[] memory cids) {
        if (g == good) {
            stamps = new uint256[](1);
            cids = new string[](1);
            stamps[0] = 1_700_000_003;
            cids[0] = "bafy-bad-history-good";
        } else if (g == skewed) {
            // Two timestamps, one cid: not the parallel arrays `history` writes.
            stamps = new uint256[](2);
            cids = new string[](1);
            stamps[0] = 1;
            stamps[1] = 2;
            cids[0] = "bafy-only-one";
        } else {
            // 2**64: a timestamp that does not fit the stored uint64.
            stamps = new uint256[](1);
            cids = new string[](1);
            stamps[0] = uint256(type(uint64).max) + 1;
            cids[0] = "bafy-too-late";
        }
    }
}
