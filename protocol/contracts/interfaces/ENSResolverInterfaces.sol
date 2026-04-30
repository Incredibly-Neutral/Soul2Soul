// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title IAddressResolver
 * @dev Interface for ENS address resolution
 */
interface IAddressResolver {
    /**
     * Returns the address associated with an ENS node.
     * @param node The ENS node to query.
     * @return The associated address.
     */
    function addr(bytes32 node) external view returns (address);
}

/**
 * @title ITextResolver
 * @dev Interface for ENS text record resolution
 */
interface ITextResolver {
    /**
     * Returns the text data associated with an ENS node and key.
     * @param node The ENS node to query.
     * @param key The text data key to query.
     * @return The associated text data.
     */
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

/**
 * @title IContentHashResolver
 * @dev Interface for ENS content hash resolution
 */
interface IContentHashResolver {
    /**
     * Returns the content hash associated with an ENS node.
     * @param node The ENS node to query.
     * @return The associated content hash.
     */
    function contenthash(bytes32 node) external view returns (bytes memory);
}

/**
 * @title INameResolver
 * @dev Interface for ENS reverse name resolution
 */
interface INameResolver {
    /**
     * Returns the name associated with an ENS node.
     * @param node The ENS node to query.
     * @return The associated name.
     */
    function name(bytes32 node) external view returns (string memory);
}

/**
 * @title IABIResolver
 * @dev Interface for ENS ABI resolution
 */
interface IABIResolver {
    /**
     * Returns the ABI associated with an ENS node.
     * @param node The ENS node to query.
     * @param contentTypes A bitwise OR of the ABI formats accepted by the caller.
     * @return contentType The content type of the returned ABI
     * @return data The ABI data
     */
    function ABI(bytes32 node, uint256 contentTypes) external view returns (uint256, bytes memory);
}

/**
 * @title IPubkeyResolver
 * @dev Interface for ENS public key resolution
 */
interface IPubkeyResolver {
    /**
     * Returns the SECP256k1 public key associated with an ENS node.
     * @param node The ENS node to query
     * @return x The X coordinate of the curve point for the public key.
     * @return y The Y coordinate of the curve point for the public key.
     */
    function pubkey(bytes32 node) external view returns (bytes32 x, bytes32 y);
}