// Note userAddress is added as a parameter since :userAddress was a Lit placeholder for the connected wallet — you'll need to pass that explicitly now.

import { evmRead } from "./evm";

export const extractSignerAddress = (messageHash: string, signature: string): string => {
    return ethers.utils.recoverAddress(messageHash, signature);
};

export const canRead = async (
    contentId: string,
    safeAddress: string,
    publicationModule: string,
    signerAddress: string,
): Promise<boolean> => {


    const [canPublish, isOwner, isLicensed] = await Promise.all([
        evmRead("BASE", publicationModule, [
            "function canPublish(address _author) view returns (bool)"
        ], "canPublish", [safeAddress]),
        evmRead("BASE", safeAddress, [
            "function isOwner(address owner) view returns (bool)"
        ], "isOwner", [signerAddress]),
        evmRead("BASE", publicationModule, [
            "function isLicensed(string content_id) view returns (bool)"
        ], "isLicensed", [contentId])
    ]);

    return canPublish && isOwner && isLicensed;
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



