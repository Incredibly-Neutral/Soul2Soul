import { S2SRipple } from '../rendering';

type S2SQuery = {
    method: string,
    args?: any
}

type S2SCollection = {
    slug: string,
    source: string,
    key: string,
    value: string,
    query: S2SQuery,
    filters?: any[]
}

type S2STemplateConfig = {
    reference: string,
    file: string,
    path: string,
    collections?: S2SCollection[],
    filters?: any[]  // ✅ ADD THIS
}

type S2SMapping = {
    templateConfig: S2STemplateConfig[],
    ripples: S2SRipple[]
}

export type S2SPublicationConfig = {
    assets: S2SAsset[],
    assetsGateway: string,
    contract: string,
    dataGateway: string,
    mapping: S2SMapping,  // ✅ Single object
    name: string,
    renderAction?: string,
    stylesheets?: S2SAsset[],
  //  templates: S2STemplate[],  // ← Is this duplicate of mapping.templateConfig?
    templateCid: string
}

export type S2SAsset = {
    path: string,
    cid: string
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