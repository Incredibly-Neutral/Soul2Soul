// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/Proxy.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Upgrade.sol";

/// @dev What a proxy asks its deployer at construction time. The factory writes
///      the word immediately before the CREATE2 and clears it after, so a proxy
///      built by the factory is handed the implementation that factory just set.
///      This binds the deployer, not the contract: any account can deploy this
///      proxy behind its own deployer, and the resulting code is identical. Do not
///      read provenance from it.
interface IS2SModuleFactoryBootstrap {
    function bootstrapImplementation() external view returns (address);
}

/**
 * @notice The one proxy every module kind is deployed behind.
 *
 * No constructor arguments, so its creation code is a constant and its address
 * depends only on (factory, safe, kind). A proxy address is therefore the same
 * before and after any `setImplementation`, which is what lets a client compute
 * it offline.
 *
 * The implementation is read from the deployer at construction rather than
 * passed in, so the address cannot be steered by an argument.
 *
 * This contract cannot stop anyone from deploying it: any account can write a
 * contract that answers `bootstrapImplementation()` with whatever code it likes
 * and build a proxy behind it. What is true is narrower, and it is the only
 * thing to rely on: only the factory can put a proxy at a *predicted* address,
 * because the CREATE2 address contains the deployer. The runtime code of the
 * proxy is byte-identical whoever deployed it, so `extcodehash` or a bytecode
 * comparison proves nothing about provenance. Proof is `recordOf` in the factory,
 * or the address having been derived from the factory's own CREATE2.
 *
 * Note that an upgrade function is not here: this is a UUPS proxy, so upgrades
 * go through the implementation's `upgradeToAndCall` and are judged by the
 * implementation's gate. An implementation without a working gate freezes every
 * module that moves to it, which is why the factory checks that an
 * implementation answers `proxiableUUID()` before accepting it.
 *
 * Written against OpenZeppelin 4.9.6, where the ERC-1967 helpers are
 * `ERC1967Upgrade` and the `ERC1967Utils` library does not exist.
 */
contract S2SModuleProxy is Proxy, ERC1967Upgrade {
    constructor() {
        address implementation = IS2SModuleFactoryBootstrap(msg.sender).bootstrapImplementation();
        // The initializer is not called here: the factory calls the kind's own
        // initializer on the proxy once it exists, so this contract needs no
        // knowledge of any kind's interface.
        _upgradeToAndCall(implementation, "", false);
    }

    function _implementation() internal view override returns (address) {
        return ERC1967Upgrade._getImplementation();
    }
}
