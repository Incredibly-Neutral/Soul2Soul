export interface OnChainRecord {
  key: string,
  value: string,
  type: string
}

export interface RecordMap {
  [key: string]: any;
}

export interface DealMap {
  [genesis: string]: any;
}

export interface AppState {
  records: OnChainRecord[]
}

/**
 * A piece returned by listPublicationStorage, extended with a
 * `confirmed` flag: false when loaded from cache, true after
 * a fresh on-chain fetch.
 */
export interface StoragePiece {
  pieceCid: string;
  pieceId: string;
  rootCid: string | null;
  dataSetId: string;
  provider: string;
  attributed: boolean;
  size: number;
  metadata: Record<string, string>;
  pdpEndEpoch: bigint | null;
  isLive: boolean;
  dataSetMetadata: Record<string, string>;
  scheduledForRemoval: boolean;
  confirmed: boolean;
}

export interface PublicationDataSet {
  dataSetId: string;
  provider: string;
  pieceCount: number;
  pdpEndEpoch: bigint | null;
  isLive: boolean;
  metadata: Record<string, string>;
}