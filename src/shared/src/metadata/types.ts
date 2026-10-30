export interface S2SContentInfo {
  author?: {
    did: string; // did:ethr:0x... or did:ethr:safe:0x...
    createdAt?: string;
    /**
     * The author's EIP-712 signature over this version's content item.
     * Emitted nested on the JSON-LD author node (NOT as the top-level proof,
     * which stays the PKP DataIntegrityProof).
     */
    proof?: {
      type: 'eip712';
      /**
       * EIP-712 digest the author signed — the content item's `objectId`. It is
       * a SIBLING of `proof` on a real item, so render/main.ts copies it in from
       * there; a reader recovers the item digest from the page here.
       */
      objectId?: string;
      signer: string;
      signature: string;
    };
  };
  publisher?: {
    did: string; // did:ethr:0x...
    safe?: string; // did:ethr:safe:0x...
    url: string;
  };
  /** bytes32 genesis / objectId of the document — the stable document identity. */
  contentGenesis?: string;
  /**
   * EIP-712 digest of the content item's `public` block (the item's `objectId`
   * sibling field). Distinct from contentGenesis (the on-chain deal id) and from
   * plaintextHash (the body). Emitted on the page as author.proof.objectId so a
   * reader can check the author's signature without re-fetching the item.
   */
  objectId?: string;
  /** The real IPFS deal CID of the encrypted content item (NOT a bytes32 id). */
  contentCid?: string;
  /** 0x-prefixed keccak256 of the canonical plaintext body JSON. */
  plaintextHash?: string;
  /** e.g. "text/markdown" */
  mediaType?: string;
  /** e.g. "1" — pins canonicalisation (JCS-RFC8785) + hashing. */
  specVersion?: string;
  licenseContract?: string;
  isBasedOn?: {
    genesis: string; // bytes32 hex or IPFS CID
    contentHash: string; // sha256 of source content
    timestamp: string;
  };
}
