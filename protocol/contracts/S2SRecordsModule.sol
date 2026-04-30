// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IS2SRecordsModule
 * @notice Interface for the S2S Records Module
 */
interface IS2SRecordsModule {
    // Events
    event RecordSet(string indexed key, string value);
    event RecordsSetBatch(string[] keys, string[] values);
    event RecordDeleted(string indexed key);
    
    // Errors
    error OnlySafe();
    error ArrayLengthMismatch();
    error EmptyKey();
    error KeyNotFound();
    
    // View functions
    function NAME() external view returns (string memory);
    function VERSION() external view returns (string memory);
    function safe() external view returns (address);
    
    // Write functions
    function setRecord(string calldata key, string calldata value) external;
    function setRecords(string[] calldata keys, string[] calldata values) external;
    function deleteRecord(string calldata key) external;
    
    // Read functions
    function getRecord(string calldata key) external view returns (string memory value);
    function getRecords(string[] calldata keys) external view returns (string[] memory values);
    function recordExists(string calldata key) external view returns (bool exists);
    
    // Enumeration functions
    function getAllKeys() external view returns (string[] memory);
    function getAllRecords() external view returns (string[] memory keys, string[] memory values);
    function getRecordCount() external view returns (uint256);
    function getKeyAtIndex(uint256 index) external view returns (string memory);
    
    // Interface support
    function supportsInterface(bytes4 interfaceId) external pure returns (bool);
}

/**
 * @title S2SRecordsModule
 * @notice A Safe module that allows storing and retrieving string-string key-value records
 * @dev Only the associated Safe can modify records
 */
contract S2SRecordsModule is IS2SRecordsModule {
    string public constant NAME = "S2S Records Module";
    string public constant VERSION = "1.1.0"; // Updated version
    
    // The Safe that owns this module instance
    address public immutable safe;
    
    // Storage for string-string records
    mapping(string => string) private records;
    
    // Array to track all keys for enumeration
    string[] private recordKeys;
    
    // Mapping to track if a key exists and its index in the array
    mapping(string => uint256) private keyIndex;
    mapping(string => bool) private keyExists;
    
    modifier onlySafe() {
        if (msg.sender != safe) revert OnlySafe();
        _;
    }
    
    constructor(address _safe) {
        require(_safe != address(0), "Invalid safe address");
        safe = _safe;
    }
    
    /**
     * @notice Set a single record
     * @param key The key for the record
     * @param value The value for the record
     */
    function setRecord(string calldata key, string calldata value) external onlySafe {
        if (bytes(key).length == 0) revert EmptyKey();
        
        // If this is a new key, add it to our tracking
        if (!keyExists[key]) {
            recordKeys.push(key);
            keyIndex[key] = recordKeys.length - 1;
            keyExists[key] = true;
        }
        
        records[key] = value;
        emit RecordSet(key, value);
    }
    
    /**
     * @notice Set multiple records in a single transaction
     * @param keys Array of keys
     * @param values Array of values
     */
    function setRecords(
        string[] calldata keys, 
        string[] calldata values
    ) external onlySafe {
        if (keys.length != values.length) revert ArrayLengthMismatch();
        
        for (uint256 i = 0; i < keys.length; i++) {
            if (bytes(keys[i]).length == 0) revert EmptyKey();
            
            // If this is a new key, add it to our tracking
            if (!keyExists[keys[i]]) {
                recordKeys.push(keys[i]);
                keyIndex[keys[i]] = recordKeys.length - 1;
                keyExists[keys[i]] = true;
            }
            
            records[keys[i]] = values[i];
        }
        
        emit RecordsSetBatch(keys, values);
    }
    
    /**
     * @notice Delete a record
     * @param key The key to delete
     */
    function deleteRecord(string calldata key) external onlySafe {
        if (!keyExists[key]) revert KeyNotFound();
        
        // Remove from records mapping
        delete records[key];
        
        // Remove from tracking arrays (swap with last element and pop)
        uint256 indexToDelete = keyIndex[key];
        uint256 lastIndex = recordKeys.length - 1;
        
        if (indexToDelete != lastIndex) {
            string memory lastKey = recordKeys[lastIndex];
            recordKeys[indexToDelete] = lastKey;
            keyIndex[lastKey] = indexToDelete;
        }
        
        recordKeys.pop();
        delete keyIndex[key];
        keyExists[key] = false;
        
        emit RecordDeleted(key);
    }
    
    /**
     * @notice Get a single record
     * @param key The key to look up
     * @return value The value associated with the key
     */
    function getRecord(string calldata key) external view returns (string memory value) {
        return records[key];
    }
    
    /**
     * @notice Get multiple records
     * @param keys Array of keys to look up
     * @return values Array of values corresponding to the keys
     */
    function getRecords(string[] calldata keys) external view returns (string[] memory values) {
        values = new string[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            values[i] = records[keys[i]];
        }
        return values;
    }
    
    /**
     * @notice Check if a record exists (has been set, even if empty)
     * @param key The key to check
     * @return exists True if the record key exists
     */
    function recordExists(string calldata key) external view returns (bool exists) {
        return keyExists[key];
    }
    
    /**
     * @notice Get all record keys
     * @return Array of all keys that have been set
     */
    function getAllKeys() external view returns (string[] memory) {
        return recordKeys;
    }
    
    /**
     * @notice Get all records (keys and values)
     * @return keys Array of all keys
     * @return values Array of corresponding values
     */
    function getAllRecords() external view returns (string[] memory keys, string[] memory values) {
        keys = recordKeys;
        values = new string[](recordKeys.length);
        
        for (uint256 i = 0; i < recordKeys.length; i++) {
            values[i] = records[recordKeys[i]];
        }
        
        return (keys, values);
    }
    
    /**
     * @notice Get the total number of records
     * @return count Number of records stored
     */
    function getRecordCount() external view returns (uint256) {
        return recordKeys.length;
    }
    
    /**
     * @notice Get the key at a specific index
     * @param index The index to query
     * @return key The key at the given index
     */
    function getKeyAtIndex(uint256 index) external view returns (string memory) {
        require(index < recordKeys.length, "Index out of bounds");
        return recordKeys[index];
    }

    /**
     * @notice Check interface support
     * @param interfaceId The interface identifier
     * @return True if the interface is supported
     */
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IS2SRecordsModule).interfaceId ||
               interfaceId == 0x01ffc9a7; // ERC165
    }
}

/**
 * @title S2SRecordsModuleFactory
 * @notice Factory for deploying S2SRecordsModule instances
 */
contract S2SRecordsModuleFactory {
    event ModuleCreated(address indexed safe, address indexed module);
    
    /**
     * @notice Create a new S2SRecordsModule for a Safe
     * @param safe The Safe address that will own the module
     * @return module The address of the created module
     */
    function createModule(address safe) external returns (address module) {
        module = address(new S2SRecordsModule(safe));
        emit ModuleCreated(safe, module);
        return module;
    }
}