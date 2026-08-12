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
    /**
     * Optional CID of a publication-supplied template-helper module (a bare
     * pure-expression `{ name: fn }` object, merged into the built-in helper
     * map at render time). camelCase, matching `assetsCid`/`templateCid`.
     * This is the SOLE source for publication helpers at render time — there
     * is no on-chain record fallback. See
     * brain/specs/RFC-content-transforms.md (Track 2).
     */
    helpersCid?: string,
}

// // to deprecate
// export type S2SAsset = {
//     path: string,
//     cid: string
// }


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