// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./interfaces/INameWrapper.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";

interface IENS {
    function setOwner(bytes32 node, address owner) external;
    function setSubnodeOwner(bytes32 node, bytes32 label, address owner) external;
    function setResolver(bytes32 node, address resolver) external;
    function owner(bytes32 node) external view returns (address);
    function resolver(bytes32 node) external view returns (address);
}

interface IENSResolver {
    function setAddr(bytes32 node, address addr) external;
    function setText(bytes32 node, string calldata key, string calldata value) external;
    function addr(bytes32 node) external view returns (address);
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

/**
 * @title ENSSubdomainRegistry
 * @dev Ultra-simple subdomain registry allowing anyone to register subdomains for free
 */


contract ENSOpenSubdomainRegistry is IERC1155Receiver {
    IENS public immutable ens;
    INameWrapper public nameWrapper;
    bytes32 public immutable parentNode;
//    address public immutable defaultResolver;
    bool public isParentWrapped;

    // Simple registry to track subdomains that have been registered
    mapping(string => bool) public registeredSubdomains;

    // Events
    event SubdomainRegistered(string indexed subdomain, address indexed owner);
    event ParentDomainOwnershipReturned(address indexed newOwner);

    // Original owner of the parent domain who can reclaim it
    address public immutable parentDomainController;



    modifier validSubdomain(string memory subdomain) {
        require(bytes(subdomain).length > 0, "Empty subdomain");
        require(bytes(subdomain).length <= 63, "Subdomain too long");
        require(_isValidLabel(subdomain), "Invalid characters");
        _;
    }

    constructor(
            address _ens,
            bytes32 _parentNode,
    //        address _defaultResolver,
            address recoverAddress,
            address _nameWrapper
        ) {
            ens = IENS(_ens);
            parentNode = _parentNode;
    //        defaultResolver = _defaultResolver;
            parentDomainController = recoverAddress != address(0) ? recoverAddress : msg.sender;
            nameWrapper = INameWrapper(_nameWrapper);
            isParentWrapped = ens.owner(_parentNode) == _nameWrapper;

        }

    /**
     * @dev Return ownership of the parent domain to the original owner
     * This allows the original owner to renew the domain or make changes
     * Can only be called by the original owner
     */
    function reclaimParentDomain() external {
        require(msg.sender == parentDomainController, "Not the parent domain controller");

        if (isParentWrapped) {
            // For wrapped domains, check if this contract owns the wrapped token
            require(nameWrapper.ownerOf(uint256(parentNode)) == address(this),
                   "Contract doesn't own wrapped token");

            // Transfer the wrapped token back to original owner
            nameWrapper.safeTransferFrom(
                address(this),
                parentDomainController,
                uint256(parentNode),
                1,
                ""
            );
        } else {
            // Original logic for unwrapped domains
            require(ens.owner(parentNode) == address(this),
                   "Contract is not the parent domain coontroller");
            ens.setOwner(parentNode, parentDomainController);
        }

        emit ParentDomainOwnershipReturned(parentDomainController);
    }

    /**
     * @dev Register a new subdomain
     */
    function registerSubdomain(
        string memory subdomain,
        address subdomainOwner
    ) public validSubdomain(subdomain) {
        require(!registeredSubdomains[subdomain], "Subdomain already registered");
        require(subdomainOwner != address(0), "Invalid owner");

        // Mark subdomain as registered
        registeredSubdomains[subdomain] = true;
        // Set up ENS records
        bytes32 label = keccak256(bytes(subdomain));
     

        if (isParentWrapped) {
            // Use NameWrapper for wrapped domains
            nameWrapper.setSubnodeOwner(
                parentNode,
                subdomain,  // string for NameWrapper
                subdomainOwner,
                0,  // fuses
                0   // expiry
            );
        } else {
            // Use ENS registry for unwrapped domains
            ens.setSubnodeOwner(parentNode, label, subdomainOwner);

    //        if (defaultResolver != address(0)) {
    //            ens.setResolver(subnode, defaultResolver);
    //        }
        }
        emit SubdomainRegistered(subdomain, subdomainOwner);
    }

    /**
     * @dev Simple registration for caller
     */
    function registerSubdomainSimple(
        string memory subdomain
    ) external validSubdomain(subdomain) {
        registerSubdomain(subdomain, msg.sender);
    }

    // No admin functions needed - registry is permanently configured at deployment

    // =====================================
    // VIEW FUNCTIONS
    // =====================================

    /**
     * @dev Check if subdomain is available
     */
    function isSubdomainAvailable(string memory subdomain) external view returns (bool) {
        return !registeredSubdomains[subdomain];
    }



    // =====================================
    // INTERNAL FUNCTIONS
    // =====================================

    function _isValidLabel(string memory label) internal pure returns (bool) {
        bytes memory b = bytes(label);
        if (b.length == 0) return false;

        for (uint256 i = 0; i < b.length; i++) {
            bytes1 char = b[i];
            if (!(
                (char >= 0x30 && char <= 0x39) || // 0-9
                (char >= 0x61 && char <= 0x7A) || // a-z
                (char == 0x2D && i != 0 && i != b.length - 1) // - not at start/end
            )) {
                return false;
            }
        }
        return true;
    }

        /**
    * @dev Handle the receipt of a single ERC1155 token type.
    * Required for receiving NameWrapper tokens
    */
    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    /**
    * @dev Handle the receipt of multiple ERC1155 token types.
    */
    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    /**
    * @dev See {IERC165-supportsInterface}.
    */
    function supportsInterface(bytes4 interfaceId) public view virtual returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId;
    }

// No emergency functions - registry is permanently configured at deployment
}
