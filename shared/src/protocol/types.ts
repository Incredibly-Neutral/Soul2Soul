// ============================================================================
// Protocol types — single source of truth for all shared types in s2s.
// Every other package imports these; no type is defined in more than one place.
// ============================================================================

export interface PKP {
  tokenId: string;
  publicKey: string;
  ethAddress: string;
}

export interface S2SProtocolInfo {
    addr: string | undefined,
    recordsModule: string,
    dataGateway: string,
    assetsGateway: string,
    lensApp: string,
    ensRecords: string,
    pkp: PKP
    litActionPrep: string,
    litActionCbor: string,
    litActionSingle: string,
    litActionRootUpdate: string
}

// ============================================================================
// Body — discriminated union on encryption
// ============================================================================

export interface S2SBodyBase {
  id: string;              // Lens post ID
  author: string;          // Ethereum address
  locale: string;          // language code
  parent: string;          // stored as string in Lens
  position: string;        // stored as string in Lens
  postType: string;
  creationDate: string;    // Unix timestamp as string
  modifiedDate: string;
  tags: string[];
  attributes?: any;        // raw Lens metadata (uncommon)
  publication?: string;
  base?: string;
}

export interface S2SBodyPlain extends S2SBodyBase {
  encryption: false;
  content: string;         // readable plaintext
  title: string;
  slug: string;
  custom?: any;
}

export interface S2SBodyEncrypted extends S2SBodyBase {
  encryption: true;
  // title, slug, content live inside the ciphertext — decrypt first
}

export type S2SBody = S2SBodyPlain | S2SBodyEncrypted;

// ============================================================================
// Template Data
// ============================================================================

export interface S2STemplateData {
  id: string;
  controller: string;
  tags: string[];
  parent: number;
  language: string;
  position: number;
  encrypted: string;
  postType: string;
  publications: string[];
  collections?: any;
  path: string;
  base?: string;
  custom: any;
  content: string;
  creationDate: string;
  modifiedDate: string;
}

// ============================================================================
// Collection
// ============================================================================

export interface S2SCollection {
  source: string;
  query: any;
  filters?: any[];
  key: string;
  value: string;
  slug: string;
}

// ============================================================================
// Ripple
// ============================================================================

export interface S2SRipple {
  origins: string[];
  destination: string;
  reference: string;
  query: any;
}

// ============================================================================
// Template Config
// ============================================================================

export interface S2STemplateConfig {
  reference: string;
  file: string;
  path: string;
  collections?: S2SCollection[];
  filters?: any[];
}

// ============================================================================
// Mapping
// ============================================================================

export interface IMapping {
  templateConfig: S2STemplateConfig[];
  ripples: S2SRipple[];
}

// ============================================================================
// Job
// ============================================================================

export interface S2SJob {
  id: string;
  templateConfig: S2STemplateConfig;
  path?: string;
  templateData?: S2STemplateData;
  html: string;
  revoked?: boolean;
}