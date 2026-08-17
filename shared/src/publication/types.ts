import { S2SRipple, type S2STemplateConfig } from '../protocol/types';

// Import the canonical types from protocol/types.ts.
// Adding the S2SQuery shape here as a convenience re-export.
export type { S2STemplateConfig };

export type S2SQuery = {
    method: string,
    args?: any
}

type S2SMapping = {
    templateConfig: S2STemplateConfig[],
    ripples: S2SRipple[]
}

export type S2SPublicationConfig = {
    assetsCid: string, 
    contract: string,
    dataGateway: string,
    mapping: S2SMapping,  // ✅ Single object
    name: string,
    templateCid: string,
    localePaths?: Record<string, string>,  // optional locale → path-prefix map (monolingual by default)
}

export type S2SPublication = {
    name: string,
    owners: string[],
    authors: string[],
    contract?: string,
    configCid?: string, // ipfs hash for S2SPublicationConfig
    feed?: string,
    devRepository: string
    branch: string
};