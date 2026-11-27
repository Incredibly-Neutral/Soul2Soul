// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * NOTE ON THE FILE NAME: `.t.sol`, not `.sol` — `generateTypedArtifacts` skips
 * every path ending in `.t.sol`, and that hook has no include/exclude option.
 * This fixture must not be published as part of the package's ABI surface.
 */

/**
 * @title MockRecordsImplementation
 * @notice A stand-in for the records implementation in the author suite, where
 *         the real `S2SRecordsModuleV0_1` lives in the publication package and
 *         is not compiled here. It answers only the three declarations
 *         `AuthorFactory.setRecordsImplementation` reads, and each one can be
 *         made wrong on purpose: a `factory()` that names some other contract,
 *         a `moduleKind()` that names another kind, or a `proxiableUUID()` that
 *         is not the ERC-1967 slot.
 *
 *         It is never proxied onto with a working module: `initialize` always
 *         reverts, which is the case the factory's `try/catch` turns into
 *         `InitializerFailed`. Creation itself is exercised against the real
 *         implementation, deployed from the publication package's artifact.
 */
contract MockRecordsImplementation {

    /// @dev `keccak256("eip1967.proxy.implementation") - 1`. Passed explicitly so
    ///      the fixture can also answer the wrong slot.
    bytes32 private constant ERC1967_IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    /// @notice The gate this fixture names in `factory()`.
    address public immutable factory;

    bytes32 private immutable _moduleKind;
    bytes32 private immutable _proxiableUUID;

    constructor(address factory_, bytes32 moduleKind_, bytes32 proxiableUUID_) {
        factory = factory_;
        _moduleKind = moduleKind_;
        _proxiableUUID = proxiableUUID_;
    }

    function moduleKind() external view returns (bytes32) {
        return _moduleKind;
    }

    function proxiableUUID() external view returns (bytes32) {
        return _proxiableUUID;
    }

    function erc1967Slot() external pure returns (bytes32) {
        return ERC1967_IMPLEMENTATION_SLOT;
    }

    error NotARealModule();

    function initialize(address, bytes calldata) external pure {
        revert NotARealModule();
    }
}
