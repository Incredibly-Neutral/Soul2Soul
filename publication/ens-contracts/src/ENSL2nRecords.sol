// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";

/**$#
 * @title ENSSubdomainRecordsContract
 * @dev Contract deployed on BaseSep that maintains ENS records
 */
contract ENSSubdomainRecordsContract is Ownable {
    // Mapping from node hash to address
    mapping(bytes32 => address) public addresses;

    // Mapping from node hash to text records
    mapping(bytes32 => mapping(string => string)) public textRecords;

    // Mapping to track authorized resolvers, registrars, and Lit keys
    mapping(address => bool) public authorizedCallers;

    // Protocol multisig address that can authorize Lit keys
    address public protocolAddress;

    event AddressChanged(bytes32 indexed node, address newAddress);
    event TextChanged(bytes32 indexed node, string indexed key, string value);
    event CallerAuthorized(address indexed caller, bool authorized);
    event ProtocolAddressChanged(address indexed newProtocolAddress);

    modifier onlyAuthorized() {
        require(
            authorizedCallers[msg.sender] || msg.sender == owner(),
            "Not authorized"
        );
        _;
    }

    modifier onlyProtocol() {
        require(msg.sender == protocolAddress || msg.sender == owner(), "Not protocol or owner");
        _;
    }

    constructor(address initialOwner) {
        protocolAddress = msg.sender;
        if (initialOwner != address(0)) {
            _transferOwnership(initialOwner);
        }
    }

    // Helper function to get the node parameter from the current message call
    function _msgNodeParam() internal pure returns (bytes32) {
        if (msg.data.length < 36) return bytes32(0);
        bytes32 node;
        assembly {
            node := calldataload(4) // Skip function selector (4 bytes)
        }
        return node;
    }

    /**
     * @dev Set address record for a node
     */
    function setAddress(bytes32 node, address addr) external onlyAuthorized {

        addresses[node] = addr;
        emit AddressChanged(node, addr);
    }

    /**
     * @dev Set text record for a node
     */
    function setText(bytes32 node, string calldata key, string calldata value)
        external
        onlyAuthorized
    {
        textRecords[node][key] = value;
        emit TextChanged(node, key, value);
    }

    /**
     * @dev Get address record (called by CCIP-Read via RPC)
     * This is the function the DirectRPCResolver will call
     */
    function getAddress(bytes32 node) external view returns (address) {
        return addresses[node];
    }

    /**
     * @dev Get text record (called by CCIP-Read via RPC)
     * This is the function the DirectRPCResolver will call
     */
    function getText(bytes32 node, string calldata key)
        external
        view
        returns (string memory)
    {
        return textRecords[node][key];
    }

    /**
     * @dev Batch set multiple records for efficiency
     */
    function batchSetRecords(
        bytes32[] calldata nodes,
        address[] calldata addrs,
        string[][] calldata keys,
        string[][] calldata values
    ) external onlyAuthorized {
        require(nodes.length == addrs.length, "Length mismatch");

        for (uint i = 0; i < nodes.length; i++) {
            if (addrs[i] != address(0)) {
                addresses[nodes[i]] = addrs[i];
                emit AddressChanged(nodes[i], addrs[i]);
            }

            if (i < keys.length) {
                for (uint j = 0; j < keys[i].length; j++) {
                    if (j < values[i].length) {
                        textRecords[nodes[i]][keys[i][j]] = values[i][j];
                        emit TextChanged(nodes[i], keys[i][j], values[i][j]);
                    }
                }
            }
        }
    }

    /**
     * @dev Authorize a caller (resolver, registrar, Lit key, etc.) to modify records
     */
    function authorizeCaller(address caller, bool authorized) external {
        require(msg.sender == owner() || msg.sender == protocolAddress, "Not owner or protocol");
        authorizedCallers[caller] = authorized;
        emit CallerAuthorized(caller, authorized);
    }

    /**
     * @dev Set the protocol address that can authorize Lit keys
     */
    function setProtocolAddress(address newProtocolAddress) external onlyOwner {
        protocolAddress = newProtocolAddress;
        emit ProtocolAddressChanged(newProtocolAddress);
    }

    /**
     * @dev Get multiple records in one call (for efficiency)
     */
    function getRecords(bytes32 node, string[] calldata keys)
        external
        view
        returns (address addr, string[] memory values)
    {
        addr = addresses[node];
        values = new string[](keys.length);

        for (uint i = 0; i < keys.length; i++) {
            values[i] = textRecords[node][keys[i]];
        }
    }

    /**
     * @dev Check if a node has any records set
     */
    function hasRecords(bytes32 node) external view returns (bool) {
        return addresses[node] != address(0);
    }

    /**
     * @dev Get all text record keys for a node (up to a limit)
     * Note: This is not gas-efficient and should only be used for queries
     */
    function getTextRecordKeys(bytes32 node, string[] calldata keysToCheck)
        external
        view
        returns (string[] memory existingKeys)
    {
        uint count = 0;

        // First pass: count existing keys
        for (uint i = 0; i < keysToCheck.length; i++) {
            if (bytes(textRecords[node][keysToCheck[i]]).length > 0) {
                count++;
            }
        }

        // Second pass: populate array
        existingKeys = new string[](count);
        uint index = 0;
        for (uint i = 0; i < keysToCheck.length; i++) {
            if (bytes(textRecords[node][keysToCheck[i]]).length > 0) {
                existingKeys[index] = keysToCheck[i];
                index++;
            }
        }
    }


    /**
     * @dev Struct for storing complete node data
     */
    struct NodeData {
        bytes32 node;
        address owner;
        address addr;
        string[] keys;
        string[] values;
    }

    /**
     * @dev Export the complete state for a batch of nodes
     * @param nodes Array of node hashes to export
     * @param commonKeys Array of text record keys to export for all nodes
     * @return nodeData Array of structs containing all data for each node
     */
    function exportState(bytes32[] calldata nodes, string[] calldata commonKeys)
        external
        view
        onlyOwner
        returns (NodeData[] memory nodeData)
    {
        nodeData = new NodeData[](nodes.length);

        for (uint i = 0; i < nodes.length; i++) {
            nodeData[i].node = nodes[i];
            nodeData[i].addr = addresses[nodes[i]];

            // Export text records for common keys
            nodeData[i].keys = new string[](commonKeys.length);
            nodeData[i].values = new string[](commonKeys.length);

            for (uint j = 0; j < commonKeys.length; j++) {
                nodeData[i].keys[j] = commonKeys[j];
                nodeData[i].values[j] = textRecords[nodes[i]][commonKeys[j]];
            }
        }
    }


}
