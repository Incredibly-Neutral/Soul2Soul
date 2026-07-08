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
): Promise<boolean> => {


    // Convert body.id → bytes32 genesis before the on-chain read.
    // toBytes32Id passes an already-hashed 0x+64hex id through unchanged;
    // it keccak256-hashes anything else (e.g. a raw CID string).
    const genesis = toBytes32Id(contentId);

    const [canPublish, isOwner, isDeal] = await Promise.all([
        evmRead("BASE", publicationModule, [
            "function canPublish(address _author) view returns (bool)"
        ], "canPublish", [safeAddress]),
        evmRead("BASE", safeAddress, [
            "function isOwner(address owner) view returns (bool)"
        ], "isOwner", [signerAddress]),
        evmRead("BASE", publicationModule, [
            "function hasDeal(bytes32 genesis) view returns (bool)"
        ], "hasDeal", [genesis])
    ]);

    return canPublish && isOwner && isDeal;
};

export const canPublish = async (
    authorSafeAddress: string,
    publicationModule: string,
    signerAddress: string,
): Promise<boolean> => {

    const [canPublishResult, isOwner] = await Promise.all([
        evmRead("BASE", publicationModule, [
            "function canPublish(address _author) view returns (bool)"
        ], "canPublish", [authorSafeAddress]),

        evmRead("BASE", authorSafeAddress, [
            "function isOwner(address owner) view returns (bool)"
        ], "isOwner", [signerAddress]),
    ]);

    return canPublishResult && isOwner;
};



