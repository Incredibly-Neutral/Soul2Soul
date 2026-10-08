// cid-view canonical types — zod-FREE, no runtime imports (pure types only).
// INV-7 discipline: consistent with the lit-actions entry even though cid-view
// is not in the action bundle. Downstream collectors/coordinator (deals.ts /
// config.ts / tree.ts / coordinator.ts) import these exact types.

export type CidCategory =
  | 'deal'            // latest CID of a deal (getDeals)
  | 'deal-version'    // a historical version CID of a deal (getVersion)
  | 'offer'           // latest CID of an offer (getOffers)
  | 'offer-version'   // a historical version of an offer
  | 'config'          // the publication config JSON CID (configCid)
  | 'template-dag'    // the templates DAG node CID (templateCid)
  | 'template'        // a single template file CID inside the templates DAG
  | 'assets-root'     // the assets root CID (assetsCid)
  | 'asset'           // a single asset file CID inside the assets tree
  | 'site-root'       // the current site root CID (decoded contenthash_wrapped)
  | 'site-file'       // a file inside the site tree (html/assets/...)
  | 'archive'         // the archive/cache JSON CID (content_cache_<publication>)
  | 'archive-item';   // a content item CID referenced inside the archive JSON

export interface CidEntry {
  cid: string;                  // IPFS CID (v0 or v1)
  category: CidCategory;
  source: 'deals' | 'config' | 'tree' | 'archive';
  role?: string;                // human description, e.g. "template about/index.html"
  genesis?: string;             // bytes32 id when the entry belongs to a deal/offer
  author?: string;              // author address when known
  timestamp?: number;           // unix seconds when known
  tombstoned?: boolean;         // true for tombstoned versions
  size?: number;                // byte size when known
  path?: string;                // path within a tree/templates/assets
  note?: string;                // free text
}

export interface CidViewSummary {
  total: number;                // entries.length
  uniqueCids: number;           // distinct cid values
  byCategory: Partial<Record<CidCategory, number>>;
}

export interface PublicationCidView {
  publication: string;          // ENS name e.g. 's3ntiment.eth'
  generatedAt: string;          // ISO 8601
  entries: CidEntry[];
  sources: {
    deals: boolean;
    config: boolean;
    tree: boolean;
    archive: boolean;
  };
  summary: CidViewSummary;
}

export interface DealRead {
  genesis: string; author: string; cid: string; timestamp: number; status: 'deal' | 'offer';
}
export interface VersionRead {
  cid: string; timestamp: number; tombstone: boolean;
}
