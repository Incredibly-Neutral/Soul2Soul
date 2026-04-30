export interface S2SContentInfo {
  author?: { 
    lens: string; 
    address: string;
    createdAt?: string; // Lens profile creation timestamp
  };
  publisher?: { 
    ens: string; 
    safe: string;
    url: string;
  };
  contentCid?: string;
  licenseContract?: string;
  isBasedOn?: {
    lensPublicationId: string; // persistent Lens ID like "0x01-0x02"
    contentHash: string; // sha256 of source content
    timestamp: string; // when this version was fetched
  };
}