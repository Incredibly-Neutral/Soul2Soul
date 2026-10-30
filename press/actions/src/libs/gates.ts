// Note userAddress is added as a parameter since :userAddress was a Lit placeholder for the connected wallet — you'll need to pass that explicitly now.

import { evmRead } from "./evm";
import { toBytes32Id } from '@s2s/soul2soul-shared/lit-actions';

export const extractSignerAddress = (messageHash: string, signature: string): string => {
    return ethers.utils.recoverAddress(messageHash, signature);
};

export const canRead = async (
    contentId: string,
    safeAddress: string,
    publicationModule: string,
    signerAddress: string,
    rpcs: string[],
): Promise<boolean> => {


    // Convert body.id → bytes32 genesis before the on-chain read.
    // toBytes32Id passes an already-hashed 0x+64hex id through unchanged;
    // it keccak256-hashes anything else (e.g. a raw CID string).
    const genesis = toBytes32Id(contentId);

    const [cp, isOwner, isDeal] = await Promise.all([
        evmRead("L2", publicationModule, [
            "function canPublish(address _author) view returns (bool)"
        ], "canPublish", [safeAddress], rpcs),
        evmRead("L2", safeAddress, [
            "function isOwner(address owner) view returns (bool)"
        ], "isOwner", [signerAddress], rpcs),
        evmRead("L2", publicationModule, [
            "function hasDeal(bytes32 genesis) view returns (bool)"
        ], "hasDeal", [genesis], rpcs)
    ]);

    return cp && isOwner && isDeal;
};

export const canPublish = async (
    authorSafeAddress: string,
    publicationModule: string,
    signerAddress: string,
    rpcs?: string[],
): Promise<boolean> => {

    const [canPublishResult, isOwner] = await Promise.all([
        evmRead("L2", publicationModule, [
            "function canPublish(address _author) view returns (bool)"
        ], "canPublish", [authorSafeAddress], rpcs),

        evmRead("L2", authorSafeAddress, [
            "function isOwner(address owner) view returns (bool)"
        ], "isOwner", [signerAddress], rpcs),
    ]);

    return canPublishResult && isOwner;
};

// A reset is a STRICTER gate than a normal publish: only an owner of the
// PUBLICATION Safe (`multisig`, resolved by getDomainOwnerAndModules) may nuke
// the tree — NOT merely an owner of a whitelisted author Safe. This mirrors the
// `isOwner` read in `canPublish` but evaluates it against the publication Safe
// (the value returned as `multisig` by getDomainOwnerAndModules) instead of the
// author Safe. See RFC-reset-tree-button.md.
export const canReset = async (
    multisig: string,
    signerAddress: string,
    rpcs?: string[],
): Promise<boolean> => {

    return await evmRead(
        "L2",
        multisig,
        ["function isOwner(address owner) view returns (bool)"],
        "isOwner",
        [signerAddress],
        rpcs,
    );
};