// ============================================================================
// Publication's own design vocabulary — how it looks, not what was authored.
//
// A publication is a name, a look, and a line. The name is the ENS stack in
// publication/ens-contracts; this file is the look: the template config, the
// collections it groups pages into, and the ripples that carry a page from one
// collection to another. Press consumes these shapes; it does not define them.
// ============================================================================

export type CollectionSortBy = 'position' | 'creationDate' | 'modifiedDate' | 'title';

export interface S2SCollection {
  filters?: any[];
  sortBy?: CollectionSortBy;
  slug: string;
}

export interface S2SRipple {
  origins: string[];
  destination: string;
  reference: string;
  query?: any;
  filters?: any[];
  trigger_filters?: Record<string, string>[];
}

export interface S2STemplateConfig {
  reference: string;
  file: string | null;
  path: string | null;
  collections?: S2SCollection[];
  filters?: any[];
}

export interface IMapping {
  templateConfig: S2STemplateConfig[];
  ripples: S2SRipple[];
}

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
    /**
     * Optional legacy ENS name the publication's on-chain contenthash is
     * written to. When set (and `aliases` is absent), the EVM update action
     * writes `contenthash_wrapped` at `namehash(domain)` instead of the
     * default `namehash(name)` subdomain target — a single write-node override
     * (identical to today's behaviour). Kept for backward compatibility: a
     * config with only `domain` set behaves exactly as before.
     */
    domain?: string,
    /**
     * Optional ENS alias names the publication's on-chain contenthash is ALSO
     * written to. Unlike the legacy `domain` override, aliases are ADDITIVE:
     * the EVM update action writes `contenthash_wrapped` at
     * `namehash(name)` AND `namehash(alias)` for every alias in one
     * `batchSetRecords` call, so each alias is an additional door to the same
     * record. When present, `domain` is ignored. Removed aliases are cleared
     * (empty value) on the next update so they stop resolving.
     */
    aliases?: string[],
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