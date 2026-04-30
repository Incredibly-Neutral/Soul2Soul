// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract S2SPublicationModule is Initializable, UUPSUpgradeable {

    address public safe;

    // Constants
    uint256 public constant MAX_WHITELISTED_AUTHORS = 100;
    uint256 public constant MAX_WHITELISTED_DEVS = 20;
    
    // ===== ORIGINAL STORAGE LAYOUT - DO NOT MODIFY ORDER =====
    mapping(string => bool) private licenses;
    mapping(string => address) private licenseAuthors;
    address[] private whitelisted_authors;
    address[] private whitelisted_devs;
    mapping(string => PendingLicense) private pendingLicenses;
    
    // ===== NEW STORAGE - ALWAYS ADD AT THE END =====
    string[] private allContentIds;
    mapping(string => bool) private contentIdExists;
    mapping(string => uint256) private contentIdIndex;

    struct PendingLicense {
        address author;
        address publication;
        uint256 timestamp;
    }

    // Events
    event LicenseGranted(address indexed author, address indexed publication, string indexed content_id);
    event LicenseRevoked(address indexed revoker, string indexed content_id);
    event LicenseOffered(address indexed author, address indexed publication, string indexed content_id);
    event ContractUpgraded(address indexed implementation);
    event AuthorWhitelisted(address indexed author);
    event AuthorRemovedFromWhitelist(address indexed author);
    event DevWhitelisted(address indexed dev);
    event DevRemovedFromWhitelist(address indexed dev);

    // Custom errors
    error MaxAuthorsReached();
    error MaxDevsReached();
    error InvalidAuthorAddress();
    error InvalidDevAddress();
    error OnlySafe();

    modifier onlySafe() {
        if (msg.sender != safe) revert OnlySafe();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _safe,
        address[] memory _authors,
        address[] memory _devs
    ) public initializer {
        __UUPSUpgradeable_init();

        safe = _safe;
        
        // Initialize whitelisted authors
        for(uint i = 0; i < _authors.length; i++) {
            if (_authors[i] == address(0)) revert InvalidAuthorAddress();
            if (!_inArray(whitelisted_authors, _authors[i])) {
                whitelisted_authors.push(_authors[i]);
            }
        }
        
        // Initialize whitelisted devs
        for(uint i = 0; i < _devs.length; i++) {
            if (_devs[i] == address(0)) revert InvalidDevAddress();
            if (!_inArray(whitelisted_devs, _devs[i])) {
                whitelisted_devs.push(_devs[i]);
            }
        }
    }

    function _authorizeUpgrade(address newImplementation) 
        internal 
        onlySafe
        override 
    {
        emit ContractUpgraded(newImplementation);
    }

    /**
     * @dev Returns the module name
     */
    function NAME() external pure returns (string memory) {
        return "S2S Publication Module";
    }

    /**
     * @dev Internal helper to check if address exists in array
     */
    function _inArray(address[] memory _array, address _address) private pure returns (bool) {
        for (uint i = 0; i < _array.length; i++) {
            if (_array[i] == _address) {
                return true;
            }
        }
        return false;
    }

    /**
     * @dev Internal helper to add content ID to tracking array
     */
    function _addContentId(string calldata content_id) private {
        if (!contentIdExists[content_id]) {
            contentIdIndex[content_id] = allContentIds.length;
            allContentIds.push(content_id);
            contentIdExists[content_id] = true;
        }
    }

    /**
     * @dev Internal helper to remove content ID from tracking array
     */
    function _removeContentId(string calldata content_id) private {
        if (contentIdExists[content_id]) {
            uint256 index = contentIdIndex[content_id];
            uint256 lastIndex = allContentIds.length - 1;
            
            if (index != lastIndex) {
                string memory lastContentId = allContentIds[lastIndex];
                allContentIds[index] = lastContentId;
                contentIdIndex[lastContentId] = index;
            }
            
            allContentIds.pop();
            delete contentIdIndex[content_id];
            delete contentIdExists[content_id];
        }
    }

    // ===== WHITELIST MANAGEMENT =====

    function whitelistAuthor(address _author) external onlySafe {
        if (_author == address(0)) revert InvalidAuthorAddress();
        if (whitelisted_authors.length >= MAX_WHITELISTED_AUTHORS) revert MaxAuthorsReached();
        
        if (!_inArray(whitelisted_authors, _author)) {
            whitelisted_authors.push(_author);
            emit AuthorWhitelisted(_author);
        }
    }

    function removeWhitelistedAuthor(address _author) external onlySafe {
        for (uint i = 0; i < whitelisted_authors.length; i++) {
            if (whitelisted_authors[i] == _author) {
                whitelisted_authors[i] = whitelisted_authors[whitelisted_authors.length - 1];
                whitelisted_authors.pop();
                emit AuthorRemovedFromWhitelist(_author);
                return;
            }
        }
    }

    function whitelistDev(address _dev) external onlySafe {
        if (_dev == address(0)) revert InvalidDevAddress();
        if (whitelisted_devs.length >= MAX_WHITELISTED_DEVS) revert MaxDevsReached();
        
        if (!_inArray(whitelisted_devs, _dev)) {
            whitelisted_devs.push(_dev);
            emit DevWhitelisted(_dev);
        }
    }

    function removeWhitelistedDev(address _dev) external onlySafe {
        for (uint i = 0; i < whitelisted_devs.length; i++) {
            if (whitelisted_devs[i] == _dev) {
                whitelisted_devs[i] = whitelisted_devs[whitelisted_devs.length - 1];
                whitelisted_devs.pop();
                emit DevRemovedFromWhitelist(_dev);
                return;
            }
        }
    }

    // ===== LICENSE MANAGEMENT =====

    function grantLicense(
        address publication,
        string calldata content_id
    ) external returns (bool) {
        _addContentId(content_id);
        
        bool isWhitelisted = _inArray(whitelisted_authors, msg.sender);
        
        if (isWhitelisted || msg.sender == safe) {
            licenses[content_id] = true;
            licenseAuthors[content_id] = msg.sender;
            emit LicenseGranted(msg.sender, publication, content_id);
            return true;
        } else {
            pendingLicenses[content_id] = PendingLicense({
                author: msg.sender,
                publication: publication,
                timestamp: block.timestamp
            });
            emit LicenseOffered(msg.sender, publication, content_id);
            return false;
        }
    }

    function acceptLicense(string calldata content_id) external onlySafe returns (bool) {
        PendingLicense memory pending = pendingLicenses[content_id];
        require(pending.author != address(0), "No pending license");
        require(!licenses[content_id], "License already exists");

        licenses[content_id] = true;
        licenseAuthors[content_id] = pending.author;

        delete pendingLicenses[content_id];

        emit LicenseGranted(pending.author, pending.publication, content_id);
        return true;
    }

    function revokeLicense(string calldata content_id) external returns (bool) {
        require(licenses[content_id], "No license exists for this content");

        if (msg.sender == safe || msg.sender == licenseAuthors[content_id]) {
            licenses[content_id] = false;
            delete licenseAuthors[content_id];
            _removeContentId(content_id);
            emit LicenseRevoked(msg.sender, content_id);
            return true;
        }
        
        return false;
    }

    // ===== PERMISSION CHECKS =====

    function canPublish(address _address) external view returns (bool) {
        if (_address == safe) return true;
        if (_inArray(whitelisted_devs, _address)) return true;
        if (_inArray(whitelisted_authors, _address)) return true;
        return false;
    }

    function isWhitelistedAuthor(address _address) external view returns (bool) {
        return _inArray(whitelisted_authors, _address);
    }

    function isWhitelistedDev(address _address) external view returns (bool) {
        return _inArray(whitelisted_devs, _address);
    }

    // ===== LICENSE QUERIES =====

    function isLicensed(string calldata content_id) external view returns (bool) {
        return licenses[content_id];
    }

    function isLicensedBulk(string[] calldata content_ids) external view returns (bool[] memory) {
        bool[] memory results = new bool[](content_ids.length);
        for (uint i = 0; i < content_ids.length; i++) {
            results[i] = licenses[content_ids[i]];
        }
        return results;
    }

    function getLicenseAuthor(string calldata content_id) external view returns (address) {
        return licenseAuthors[content_id];
    }

    function getAllContentIds() external view returns (string[] memory) {
        return allContentIds;
    }

    function getContentIds(uint256 offset, uint256 limit) external view returns (string[] memory) {
        if (offset >= allContentIds.length) {
            return new string[](0);
        }
        
        uint256 end = offset + limit;
        if (end > allContentIds.length) {
            end = allContentIds.length;
        }
        
        string[] memory result = new string[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = allContentIds[i];
        }
        
        return result;
    }

    function getContentIdCount() external view returns (uint256) {
        return allContentIds.length;
    }

    function hasPendingLicense(string calldata content_id) external view returns (bool) {
        return pendingLicenses[content_id].author != address(0);
    }

    function getPendingLicense(string calldata content_id) external view returns (
        address author,
        address publication,
        uint256 timestamp
    ) {
        PendingLicense memory pending = pendingLicenses[content_id];
        return (pending.author, pending.publication, pending.timestamp);
    }

    function getWhitelistedAuthors() external view returns (address[] memory) {
        return whitelisted_authors;
    }

    function getWhitelistedDevs() external view returns (address[] memory) {
        return whitelisted_devs;
    }
}

// Factory contract

contract S2SPublicationModuleFactory {

    // Tracks the latest implementation version
    address public latestImplementation;

    // Tracks all deployed module implementations
    address[] public implementationHistory;

    // Tracks modules created for each safe
    mapping(address => address[]) public safeModules;

    // Events for tracking factory actions
    event ImplementationDeployed(
        address indexed implementation, 
        uint256 version
    );
    
    event ModuleCreated(
        address indexed safe, 
        address indexed moduleProxy, 
        address implementation
    );

    constructor() {
        // Deploy initial implementation when factory is created
        latestImplementation = address(new S2SPublicationModule());
        implementationHistory.push(latestImplementation);
        
        emit ImplementationDeployed(
            latestImplementation, 
            implementationHistory.length
        );
    }

    /**
     * @dev Create a new module proxy for a specific Safe
     * @param safe The Safe address for which the module is being created
     * @param _authors Initial whitelisted authors
     * @param _devs Initial whitelisted devs
     * @return moduleProxy Address of the newly created module proxy
     */
    function createModule(
        address safe,
        address[] memory _authors,
        address[] memory _devs
    ) external returns (address moduleProxy) {
        bytes memory initializer = abi.encodeWithSignature(
            "initialize(address,address[],address[])", 
            safe,
            _authors,
            _devs
        );

        moduleProxy = address(
            new ERC1967Proxy(
                latestImplementation, 
                initializer
            )
        );

        safeModules[safe].push(moduleProxy);

        emit ModuleCreated(
            safe, 
            moduleProxy, 
            latestImplementation
        );

        return moduleProxy;
    }

    /**
     * @dev Create a new module proxy with empty whitelists (convenience function)
     * @param safe The Safe address for which the module is being created
     * @return moduleProxy Address of the newly created module proxy
     */
    function createModuleEmpty(address safe) external returns (address moduleProxy) {
        address[] memory emptyAuthors = new address[](0);
        address[] memory emptyDevs = new address[](0);
        
        bytes memory initializer = abi.encodeWithSignature(
            "initialize(address,address[],address[])", 
            safe,
            emptyAuthors,
            emptyDevs
        );

        moduleProxy = address(
            new ERC1967Proxy(
                latestImplementation, 
                initializer
            )
        );

        safeModules[safe].push(moduleProxy);

        emit ModuleCreated(
            safe, 
            moduleProxy, 
            latestImplementation
        );

        return moduleProxy;
    }

    /**
     * @dev Deploy a new implementation version
     * @return newImplementation Address of the newly deployed implementation
     */
    function deployNewImplementation() external returns (address) {
        address newImplementation = address(new S2SPublicationModule());
        
        latestImplementation = newImplementation;
        implementationHistory.push(newImplementation);

        emit ImplementationDeployed(
            newImplementation, 
            implementationHistory.length
        );

        return newImplementation;
    }

    /**
     * @dev Get all module proxies for a specific Safe
     * @param safe The Safe address
     * @return Array of module proxy addresses
     */
    function getModulesForSafe(address safe) external view returns (address[] memory) {
        return safeModules[safe];
    }

    /**
     * @dev Get the total number of implementations deployed
     * @return Number of implementations
     */
    function implementationCount() external view returns (uint256) {
        return implementationHistory.length;
    }

    /**
     * @dev Get implementation by version (1-indexed)
     * @param version The version number
     * @return Implementation address
     */
    function getImplementationByVersion(uint256 version) external view returns (address) {
        require(version > 0 && version <= implementationHistory.length, "Invalid version");
        return implementationHistory[version - 1];
    }
}