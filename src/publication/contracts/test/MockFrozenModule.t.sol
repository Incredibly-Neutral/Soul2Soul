// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * NOTE ON THE FILE NAME: `.t.sol`, so the artifact generator skips it.
 *
 * @notice An implementation that names its factory and declares its kind, but
 * answers nothing to `proxiableUUID()`: it has no upgrade door. The factory must
 * refuse it, because a module that moved there could never move again.
 */
contract MockFrozenModule {
    address public immutable FACTORY;
    bytes32 public immutable KIND;

    constructor(address factory, bytes32 kind) {
        FACTORY = factory;
        KIND = kind;
    }

    function factory() external view returns (address) {
        return FACTORY;
    }

    function moduleKind() external view returns (bytes32) {
        return KIND;
    }
}
