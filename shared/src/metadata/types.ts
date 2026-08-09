export interface S2SContentInfo {
  author?: {
    did: string; // did:ethr:0x... or did:ethr:safe:0x...
    createdAt?: string;
  };
  publisher?: {
    did: string; // did:ethr:0x...
    safe?: string; // did:ethr:safe:0x...
    url: string;
  };
  contentCid?: string;
  licenseContract?: string;
  isBasedOn?: {
    genesis: string; // bytes32 hex or IPFS CID
    contentHash: string; // sha256 of source content
    timestamp: string;
  };
}
