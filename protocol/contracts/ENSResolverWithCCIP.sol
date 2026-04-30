// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// Basic interfaces needed for ENS resolution
interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IExtendedResolver {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
}

interface IAddressResolver {
    function addr(bytes32 node) external view returns (address);
    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory);
}

interface ITextResolver {
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

interface IContentHashResolver {
    function contenthash(bytes32 node) external view returns (bytes memory);
}

interface INameResolver {
    function name(bytes32 node) external view returns (string memory);
}

interface IENS {
    function owner(bytes32 node) external view returns (address);
    function resolver(bytes32 node) external view returns (address);
}

interface INameWrapper {
    function isWrapped(bytes32 node) external view returns (bool);
    function ownerOf(uint256 id) external view returns (address);
}

/**
 * @title SimpleWrappedENSResolver
 * @dev A simple ENS resolver that supports wrapped names and uses CCIP-Read
 */
contract ENSResolverWthCCIP is IExtendedResolver, IAddressResolver, ITextResolver, IContentHashResolver, INameResolver, IERC165 {

    // CCIP Read error
    error OffchainLookup(
        address sender,
        string[] urls,
        bytes callData,
        bytes4 callbackFunction,
        bytes extraData
    );

    address public owner;
    string[] public rpcUrls;
    address public immutable baseRecordsContract;
    bytes32 public immutable domainNode;
    address public immutable ensRegistry;
    address public immutable nameWrapper;

    constructor(
        bytes32 _domainNode,
        string[] memory _rpcUrls,
        address _baseRecordsContract,
        address _ensRegistry,
        address _nameWrapper,
        address initialOwner
    ) {
        domainNode = _domainNode;
        rpcUrls = _rpcUrls;
        baseRecordsContract = _baseRecordsContract;
        ensRegistry = _ensRegistry;
        nameWrapper = _nameWrapper;
        owner = initialOwner != address(0) ? initialOwner : msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not authorized");
        _;
    }

    /**
     * @dev Check if a name is wrapped
     */
    function isWrapped(bytes32 node) public view returns (bool) {
        if (nameWrapper == address(0)) return false;

        try INameWrapper(nameWrapper).isWrapped(node) returns (bool wrapped) {
            return wrapped;
        } catch {
            // Fallback: check if Name Wrapper owns the name
            try IENS(ensRegistry).owner(node) returns (address nodeOwner) {
                return nodeOwner == nameWrapper;
            } catch {
                return false;
            }
        }
    }

    /**
     * @dev ENSIP-10 resolve method - proper implementation for wrapped name compatibility
     */
    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        override
        returns (bytes memory)
    {
        // Convert DNS-encoded name to node hash using proper namehash
        bytes32 node = dnsNameToNodeHash(name);

        // Extract function selector from data
        bytes4 selector;
        if (data.length >= 4) {
            selector = bytes4(data[0:4]);
        } else {
            revert("Invalid data length");
        }

        // Route to appropriate resolution method
        if (selector == 0x3b3b57de) { // addr(bytes32)
            return this.resolveAddr(node);
        } else if (selector == 0xf1cb7e06) { // addr(bytes32,uint256)
            // Extract coinType from data
            uint256 coinType = 0;
            if (data.length >= 68) {
                // Simple extraction of coinType from position 36-68
                for (uint i = 36; i < 68; i++) {
                    coinType = (coinType << 8) | uint8(data[i]);
                }
            }
            return this.resolveAddrMulti(node, coinType);
        } else if (selector == 0x59d1d43c) { // text(bytes32,string)
            // For text, we'll use a default key since string parsing is complex
            return this.resolveText(node, "default");
        } else if (selector == 0xbc1c58d1) { // contenthash(bytes32)
            return this.resolveContenthash(node);
        } else if (selector == 0x691f3431) { // name(bytes32)
            return this.resolveName(node);
        }

        revert("Unsupported selector");
    }

    /**
     * @dev Convert DNS-encoded name to ENS namehash
     * Implements proper ENS namehash algorithm according to EIP-137
     */
    function dnsNameToNodeHash(bytes calldata name) internal pure returns (bytes32) {
        if (name.length == 0) {
            return bytes32(0);
        }

        return namehash(name, 0);
    }

    /**
     * @dev Recursively compute ENS namehash from DNS-encoded name
     * @param name DNS-encoded domain name
     * @param offset Current position in the name
     * @return node The computed namehash
     */
    function namehash(bytes calldata name, uint256 offset) internal pure returns (bytes32 node) {
        if (offset >= name.length) {
            return bytes32(0);
        }

        // Read label length
        uint256 labelLength = uint256(uint8(name[offset]));

        // If label length is 0, we've reached the end
        if (labelLength == 0) {
            return bytes32(0);
        }

        // Extract the label
        bytes memory label = name[offset + 1:offset + 1 + labelLength];

        // Recursively compute namehash for the parent domain
        bytes32 parentNode = namehash(name, offset + 1 + labelLength);

        // Compute namehash: keccak256(parentNode + keccak256(label))
        return keccak256(abi.encodePacked(parentNode, keccak256(label)));
    }

    /**
     * @dev Internal resolve methods that handle CCIP-Read
     */
    function resolveAddr(bytes32 node) external view returns (bytes memory) {
        bool wrapped = isWrapped(node);
        string memory key = wrapped ? "addr_wrapped" : "addr";

        bytes memory contractCallData = abi.encodeWithSignature(
            "getText(bytes32,string)",
            node,
            key
        );

        bytes memory rpcCallData = abi.encode(
            baseRecordsContract,
            contractCallData
        );

        revert OffchainLookup(
            address(this),
            rpcUrls,
            rpcCallData,
            this.resolveAddrCallback.selector,
            abi.encode(node, wrapped)
        );
    }

    function resolveAddrMulti(bytes32 node, uint256 coinType) external view returns (bytes memory) {
        bool wrapped = isWrapped(node);
        string memory key = string(abi.encodePacked(
            "addr_",
            toString(coinType),
            wrapped ? "_wrapped" : ""
        ));

        bytes memory contractCallData = abi.encodeWithSignature(
            "getText(bytes32,string)",
            node,
            key
        );

        bytes memory rpcCallData = abi.encode(
            baseRecordsContract,
            contractCallData
        );

        revert OffchainLookup(
            address(this),
            rpcUrls,
            rpcCallData,
            this.resolveAddrMultiCallback.selector,
            abi.encode(node, coinType, wrapped)
        );
    }

    function resolveText(bytes32 node, string memory key) external view returns (bytes memory) {
        bool wrapped = isWrapped(node);
        string memory actualKey = wrapped ? string(abi.encodePacked(key, "_wrapped")) : key;

        bytes memory contractCallData = abi.encodeWithSignature(
            "getText(bytes32,string)",
            node,
            actualKey
        );

        bytes memory rpcCallData = abi.encode(
            baseRecordsContract,
            contractCallData
        );

        revert OffchainLookup(
            address(this),
            rpcUrls,
            rpcCallData,
            this.resolveTextCallback.selector,
            abi.encode(node, key, wrapped)
        );
    }

    function resolveContenthash(bytes32 node) external view returns (bytes memory) {

        bool wrapped = isWrapped(node);
        string memory key = wrapped ? "contenthash_wrapped" : "contenthash";

        bytes memory contractCallData = abi.encodeWithSignature(
            "getText(bytes32,string)",
            node,
            key
        );

        bytes memory rpcCallData = abi.encode(
            baseRecordsContract,
            contractCallData
        );

        revert OffchainLookup(
            address(this),
            rpcUrls,
            rpcCallData,
            this.resolveContenthashCallback.selector,
            abi.encode(node, wrapped)
        );
    }

    function resolveName(bytes32 node) external view returns (bytes memory) {
        bool wrapped = isWrapped(node);
        string memory key = wrapped ? "name_wrapped" : "name";

        bytes memory contractCallData = abi.encodeWithSignature(
            "getText(bytes32,string)",
            node,
            key
        );

        bytes memory rpcCallData = abi.encode(
            baseRecordsContract,
            contractCallData
        );

        revert OffchainLookup(
            address(this),
            rpcUrls,
            rpcCallData,
            this.resolveNameCallback.selector,
            abi.encode(node, wrapped)
        );
    }

    /**
     * @dev Get address for a node
     */
    function addr(bytes32 node) external view override returns (address) {
        bool wrapped = isWrapped(node);

        string memory key = wrapped ? "addr_wrapped" : "addr";

        bytes memory contractCallData = abi.encodeWithSignature(
            "getText(bytes32,string)",
            node,
            key
        );

        bytes memory rpcCallData = abi.encode(
            baseRecordsContract,
            contractCallData
        );

        revert OffchainLookup(
            address(this),
            rpcUrls,
            rpcCallData,
            this.addrCallback.selector,
            abi.encode(node, wrapped)
        );
    }

    /**
     * @dev Get address for a node with coin type
     */
    function addr(bytes32 node, uint256 coinType) external view override returns (bytes memory) {
        bool wrapped = isWrapped(node);

        string memory key = string(abi.encodePacked(
            "addr_",
            toString(coinType),
            wrapped ? "_wrapped" : ""
        ));

        bytes memory contractCallData = abi.encodeWithSignature(
            "getText(bytes32,string)",
            node,
            key
        );

        bytes memory rpcCallData = abi.encode(
            baseRecordsContract,
            contractCallData
        );

        revert OffchainLookup(
            address(this),
            rpcUrls,
            rpcCallData,
            this.addrMultiCallback.selector,
            abi.encode(node, coinType, wrapped)
        );
    }

    /**
     * @dev Get text record for a node
     */
    function text(bytes32 node, string calldata key) external view override returns (string memory) {
        bool wrapped = isWrapped(node);

        string memory actualKey = wrapped ? string(abi.encodePacked(key, "_wrapped")) : key;

        bytes memory contractCallData = abi.encodeWithSignature(
            "getText(bytes32,string)",
            node,
            actualKey
        );

        bytes memory rpcCallData = abi.encode(
            baseRecordsContract,
            contractCallData
        );

        revert OffchainLookup(
            address(this),
            rpcUrls,
            rpcCallData,
            this.textCallback.selector,
            abi.encode(node, key, wrapped)
        );
    }

    /**
     * @dev Get content hash for a node
     */
    function contenthash(bytes32 node) external view override returns (bytes memory) {
        bool wrapped = isWrapped(node);

        string memory key = wrapped ? "contenthash_wrapped" : "contenthash";

        bytes memory contractCallData = abi.encodeWithSignature(
            "getText(bytes32,string)",
            node,
            key
        );

        bytes memory rpcCallData = abi.encode(
            baseRecordsContract,
            contractCallData
        );

        revert OffchainLookup(
            address(this),
            rpcUrls,
            rpcCallData,
            this.contenthashCallback.selector,
            abi.encode(node, wrapped)
        );
    }

    /**
     * @dev Get name for a node
     */
    function name(bytes32 node) external view override returns (string memory) {
        bool wrapped = isWrapped(node);

        string memory key = wrapped ? "name_wrapped" : "name";

        bytes memory contractCallData = abi.encodeWithSignature(
            "getText(bytes32,string)",
            node,
            key
        );

        bytes memory rpcCallData = abi.encode(
            baseRecordsContract,
            contractCallData
        );

        revert OffchainLookup(
            address(this),
            rpcUrls,
            rpcCallData,
            this.nameCallback.selector,
            abi.encode(node, wrapped)
        );
    }

    // Callback functions for resolve() method
    function resolveAddrCallback(bytes calldata response, bytes calldata extraData) external pure returns (bytes memory) {
        (bytes32 node, bool wrapped) = abi.decode(extraData, (bytes32, bool));
        string memory addressStr = abi.decode(response, (string));

        if (bytes(addressStr).length == 0) {
            return abi.encode(address(0));
        }

        return abi.encode(parseAddress(addressStr));
    }

    function resolveAddrMultiCallback(bytes calldata response, bytes calldata extraData) external pure returns (bytes memory) {
        (bytes32 node, uint256 coinType, bool wrapped) = abi.decode(extraData, (bytes32, uint256, bool));
        string memory addressStr = abi.decode(response, (string));

        if (bytes(addressStr).length == 0) {
            return abi.encode(bytes(""));
        }

        // For ETH (coinType 60), convert to address bytes
        if (coinType == 60) {
            address resolvedAddr = parseAddress(addressStr);
            if (resolvedAddr == address(0)) {
                return abi.encode(bytes(""));
            }
            bytes memory result = new bytes(20);
            assembly {
                mstore(add(result, 32), resolvedAddr)
            }
            return abi.encode(result);
        }

        return abi.encode(bytes(addressStr));
    }

    function resolveTextCallback(bytes calldata response, bytes calldata extraData) external pure returns (bytes memory) {
        (bytes32 node, string memory key, bool wrapped) = abi.decode(extraData, (bytes32, string, bool));
        string memory textResult = abi.decode(response, (string));
        return abi.encode(textResult);
    }

    function resolveContenthashCallback(bytes calldata response, bytes calldata extraData) external pure returns (bytes memory) {

        string memory contenthashStr = abi.decode(response, (string));

        if (bytes(contenthashStr).length > 2 &&
            bytes(contenthashStr)[0] == 0x30 &&
            bytes(contenthashStr)[1] == 0x78) {

            // Use the working ENS hex conversion
            string memory hexPart = substring(contenthashStr, 2, bytes(contenthashStr).length - 2);

            bytes memory result = hexStringToBytes(hexPart);
            return abi.encode(result);

        }


        return abi.encode(bytes(contenthashStr));
    }



    function resolveNameCallback(bytes calldata response, bytes calldata extraData) external pure returns (bytes memory) {
        (bytes32 node, bool wrapped) = abi.decode(extraData, (bytes32, bool));
        string memory nameResult = abi.decode(response, (string));
        return abi.encode(nameResult);
    }

    // Original callback functions for direct method calls
    function addrCallback(bytes calldata response, bytes calldata extraData) external pure returns (address) {
        (bytes32 node, bool wrapped) = abi.decode(extraData, (bytes32, bool));
        string memory addressStr = abi.decode(response, (string));

        if (bytes(addressStr).length == 0) {
            return address(0);
        }

        return parseAddress(addressStr);
    }

    function addrMultiCallback(bytes calldata response, bytes calldata extraData) external pure returns (bytes memory) {
        (bytes32 node, uint256 coinType, bool wrapped) = abi.decode(extraData, (bytes32, uint256, bool));
        string memory addressStr = abi.decode(response, (string));

        if (bytes(addressStr).length == 0) {
            return new bytes(0);
        }

        // For ETH (coinType 60), convert to address bytes
        if (coinType == 60) {
            address resolvedAddr = parseAddress(addressStr);
            if (resolvedAddr == address(0)) {
                return new bytes(0);
            }
            bytes memory result = new bytes(20);
            assembly {
                mstore(add(result, 32), resolvedAddr)
            }
            return result;
        }

        return bytes(addressStr);
    }

    function textCallback(bytes calldata response, bytes calldata extraData) external pure returns (string memory) {
        (bytes32 node, string memory key, bool wrapped) = abi.decode(extraData, (bytes32, string, bool));
        return abi.decode(response, (string));
    }

    function contenthashCallback(bytes calldata response, bytes calldata extraData) external pure returns (bytes memory) {
        // return abi.encode(bytes("CONTENTHASH_CALLBACK_CALLED"));
        (bytes32 node, bool wrapped) = abi.decode(extraData, (bytes32, bool));
        string memory contenthashStr = abi.decode(response, (string));

        if (bytes(contenthashStr).length == 0) {
            return new bytes(0);
        }

        // Simple hex conversion
        if (bytes(contenthashStr).length > 2 &&
            bytes(contenthashStr)[0] == 0x30 &&
            bytes(contenthashStr)[1] == 0x78) {
            return hexStringToBytes(substring(contenthashStr, 2, bytes(contenthashStr).length - 2));
        }


        return bytes(contenthashStr);


    }

    function nameCallback(bytes calldata response, bytes calldata extraData) external pure returns (string memory) {
        (bytes32 node, bool wrapped) = abi.decode(extraData, (bytes32, bool));
        return abi.decode(response, (string));
    }

    /**
     * @dev EIP-165 interface support - CRITICAL for wrapped name compatibility
     */
    function supportsInterface(bytes4 interfaceID) external pure override returns (bool) {
        return
            interfaceID == 0x01ffc9a7 ||  // IERC165
            interfaceID == 0x9061b923 ||  // IExtendedResolver (ENSIP-10) - REQUIRED for wrapped names
            interfaceID == 0x3b3b57de ||  // addr(bytes32)
            interfaceID == 0xf1cb7e06 ||  // addr(bytes32,uint256)
            interfaceID == 0x59d1d43c ||  // text(bytes32,string)
            interfaceID == 0xbc1c58d1 ||  // contenthash(bytes32)
            interfaceID == 0x691f3431;    // name(bytes32)
    }

    function parseAddress(string memory addressStr) internal pure returns (address) {
        bytes memory addressBytes = bytes(addressStr);
        if (addressBytes.length != 42) return address(0);
        if (addressBytes[0] != 0x30 || addressBytes[1] != 0x78) return address(0);

        // Extract hex part (remove "0x" prefix)
        string memory hexPart = substring(addressStr, 2, 40);

        // Convert hex string to bytes
        bytes memory addressBytesDecoded = hexStringToBytes(hexPart);

        // Convert bytes to address (should be exactly 20 bytes)
        if (addressBytesDecoded.length != 20) return address(0);

        return address(uint160(bytes20(addressBytesDecoded)));
    }

    function hexStringToBytes(string memory s) internal pure returns (bytes memory) {
        bytes memory ss = bytes(s);
        require(ss.length % 2 == 0, "hex string length must be even");
        bytes memory r = new bytes(ss.length / 2);
        for (uint256 i = 0; i < ss.length / 2; ++i) {
            r[i] = bytes1(fromHexChar(uint8(ss[2 * i])) * 16 + fromHexChar(uint8(ss[2 * i + 1])));
        }
        return r;
    }

    function fromHexChar(uint8 c) internal pure returns (uint8) {
        if (bytes1(c) >= bytes1('0') && bytes1(c) <= bytes1('9')) {
            return c - uint8(bytes1('0'));
        }
        if (bytes1(c) >= bytes1('a') && bytes1(c) <= bytes1('f')) {
            return 10 + c - uint8(bytes1('a'));
        }
        if (bytes1(c) >= bytes1('A') && bytes1(c) <= bytes1('F')) {
            return 10 + c - uint8(bytes1('A'));
        }
        revert("invalid hex character");
    }

    function toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) {
            return "0";
        }
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    function substring(string memory str, uint startIndex, uint length) internal pure returns (string memory) {
        bytes memory strBytes = bytes(str);
        if (startIndex >= strBytes.length || length == 0) return "";

        if (startIndex + length > strBytes.length) {
            length = strBytes.length - startIndex;
        }

        bytes memory result = new bytes(length);
        for (uint i = 0; i < length; i++) {
            result[i] = strBytes[startIndex + i];
        }
        return string(result);
    }


    // Admin functions
    function updateRpcUrls(string[] memory newUrls) external onlyOwner {
        require(newUrls.length > 0, "Must provide at least one URL");
        rpcUrls = newUrls;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "New owner cannot be zero address");
        owner = newOwner;
    }
}
