// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * NOTE ON THE FILE NAME: `.t.sol`, not `.sol`. `hardhat-deploy`'s
 * `generateTypedArtifacts` hook walks `artifacts/` and skips every path ending
 * in `.t.sol`, and that hook has no include/exclude option. The suffix keeps
 * this fixture out of `generated/abis/index.ts`, which is the package's `main`
 * and would otherwise publish a test fixture as part of the ABI surface.
 * Hardhat still compiles it and resolves it by name, which is all the suite
 * asks for.
 *
 * @notice Forwards a call and bubbles the revert data unchanged.
 *
 * The factory's `protocolSafe` must have code (an EOA safe re-opens the hole
 * the factory exists to close), so the suite cannot use a funded test account
 * as the protocol safe: `msg.sender` would have to be a contract. This
 * forwards the calldata and becomes that caller. Impersonating an EOA would
 * test a caller the constructor refuses to accept.
 */
contract MockCaller {
    function exec(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory result) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        return result;
    }
}
