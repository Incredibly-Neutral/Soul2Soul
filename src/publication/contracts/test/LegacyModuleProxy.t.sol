// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

interface ILegacyModuleInitializer {
    function initialize(address safe, address[] calldata authors, address[] calldata devs) external;
}

/**
 * NOTE ON THE FILE NAME: `.t.sol`, for the same reason `MockCaller.t.sol` has
 * it. `hardhat-deploy`'s `generateTypedArtifacts` hook skips every path ending
 * in `.t.sol`, so this fixture stays out of `generated/abis/index.ts`, which is
 * the package's `main`. Hardhat still compiles it and resolves it by name.
 *
 * @notice Deploys an `ERC1967Proxy` with plain `CREATE`, which is how a V2 or V3
 *         publication's module was deployed: an address nobody can predict, and
 *         one the module can never leave. The suite needs that address to test
 *         `registerModule`'s legacy branch — a proxy over an implementation the
 *         factory did not deploy and did not create the proxy for.
 *
 * The proxy is initialised with `safe` because `registerModule` asks the module
 * for `safe()` and refuses a mismatch: an uninitialised proxy answers zero, which
 * is the case the suite tests separately with a bare implementation address.
 */
contract LegacyModuleProxyDeployer {
    /// @notice The proxy this deployer created, at a plain-CREATE address.
    address public immutable proxy;

    constructor(address implementation, address safe) {
        address deployed = address(new ERC1967Proxy(implementation, ""));
        ILegacyModuleInitializer(deployed).initialize(safe, new address[](0), new address[](0));
        proxy = deployed;
    }
}
