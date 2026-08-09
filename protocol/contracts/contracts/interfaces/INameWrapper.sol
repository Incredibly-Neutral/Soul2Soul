// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

interface INameWrapper {
    function ownerOf(uint256 tokenId) external view returns (address);

    function safeTransferFrom(
        address from,
        address to,
        uint256 tokenId,
        uint256 amount,
        bytes calldata data
    ) external;

    function setSubnodeOwner(
        bytes32 parentNode,
        string calldata label,
        address owner,
        uint32 fuses,
        uint64 expiry
    ) external returns (bytes32);

    function unwrapETH2LD(
        bytes32 labelhash,
        address registrant,
        address controller
    ) external;
}
