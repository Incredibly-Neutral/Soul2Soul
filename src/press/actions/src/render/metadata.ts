import {
  S2SContentInfo,
  S2SProtocolInfo,
  canonicalizeProofPayload,
  extractHashableHtml,
  hasHtmlBlock,
  insertJsonLdScript,
  ipfsContentUrl,
  PROOF_CANONICALIZATION_JCS,
  stripUndefinedDeep,
} from '@s2s/soul2soul-shared/lit-actions';
// The one identity normaliser in press: shared's `authorAddress()`. This page
// builder is the last place a pre-change identity can leave for the pinned
// page, so it is normalised here, at the emission point.
import { authorAddress } from '../../../../shared/dist/manuscript/identity/author-address';

/**
 * `S2SContentInfo` plus the v2 signed dates. Shared's interface predates the v2
 * envelope and is out of scope here; the two dates ride alongside it so the
 * page can name the genesis and this version's signing time separately.
 * Both unix seconds, as strings, matching the author node's `dateCreated`.
 */
export type S2SContentInfoWithDates = S2SContentInfo & {
  /** Signing time of the genesis version — the document's birth. */
  creationDate?: string;
  /** Signing time of this version. */
  modifiedDate?: string;
};

/**
 * Build the page's schema.org JSON-LD provenance block and sign it with the
 * protocol PKP.
 *
 * Signed bytes: JCS-RFC8785(schema-without-proof) ++ JCS-RFC8785(proofOptions).
 * The canonicalisation is shared with update/verify.ts (see
 * shared/src/metadata/proof-canonicalization.ts) so signer and verifier cannot
 * drift. `proof.canonicalization` records the scheme on the page so pre-JCS
 * pages can still be verified with the legacy canonicaliser.
 */
export const addAndSignMetadata = async (
  id: string,
  html: string,
  protocolInfo: S2SProtocolInfo,
  contentInfo?: S2SContentInfoWithDates,
) => {
  // console.log("pkp", protocolInfo.pkp.publicKey.replace("0x", ""));

  try {
    // 1. The hashed region — shared with update/verify.ts so that the bytes the
    //    verifier re-derives after injection are exactly the bytes hashed here,
    //    including for pages with no <html> tag.
    const contentToHash = extractHashableHtml(html);
    if (!hasHtmlBlock(html)) {
      console.log('Could not find HTML tags, hashing entire content');
    }

    // 2. Hash the HTML (SHA-256 for Schema.org)
    const htmlBytes = ethers.utils.toUtf8Bytes(contentToHash);
    const sha256Hash = ethers.utils.sha256(htmlBytes).replace('0x', '');

    const pkpAddress = protocolInfo.pkp;

    const timestamp = new Date().toISOString();
    const currentUrl = contentInfo?.publisher?.url || '';

    // 3. Build schema WITHOUT proof first
    const schema: Record<string, unknown> = {
      '@context': ['https://schema.org', 'https://w3id.org/security/data-integrity/v2'],
      '@type': 'Article',
      // Stable document identity (bytes32 genesis / objectId). Unchanged.
      identifier: id,
    };

    // The document's own dates, from the SIGNED envelope (never the chain
    // timestamp): dateCreated is the genesis version's signing time, and
    // dateModified is this version's — a republication moves only the latter.
    if (contentInfo?.creationDate) {
      schema.dateCreated = contentInfo.creationDate;
    }
    if (contentInfo?.modifiedDate) {
      schema.dateModified = contentInfo.modifiedDate;
    }

    // Author (provenance). The author's EIP-712 proof is nested HERE, not on
    // the top-level proof — the top-level proof is the PKP's DataIntegrityProof.
    //
    // The `propertyID` names what the value is: the address the page names as
    // its author. The value is the bare address, whatever form the item was
    // pinned in, so a page rendered from a pre-change item names the same
    // address its signature covers.
    if (contentInfo?.author) {
      const author: Record<string, unknown> = {
        '@type': 'Person',
        identifier: {
          '@type': 'PropertyValue',
          propertyID: 'address',
          value: authorAddress(contentInfo.author.address),
        },
      };

      // The author node keeps the genesis signing time: who authored the
      // document, and when it was born, do not change on republication.
      if (contentInfo.author.createdAt) {
        author.dateCreated = contentInfo.author.createdAt;
      }

      if (contentInfo.author.proof) {
        const authorProof = contentInfo.author.proof;
        // The item's `objectId` is a SIBLING of `proof`, not part of it (a real
        // mint emits proof = {type, signer, signature}). Render copies it onto
        // the nested proof — falling back to the contentInfo sibling here — so
        // the page carries the exact digest the author signed and a reader can
        // verify the attestation without re-fetching the item.
        const objectId = authorProof.objectId ?? contentInfo.objectId;
        author.proof = {
          type: authorProof.type,
          ...(objectId ? { objectId } : {}),
          signer: authorProof.signer,
          signature: authorProof.signature,
        };
      }

      schema.author = author;
    }

    // Publisher. Same rule as the author: the terms name the value (the
    // signer's address, the publication Safe's address), the values are bare
    // addresses.
    if (contentInfo?.publisher) {
      schema.publisher = {
        '@type': 'Organization',
        identifier: [
          {
            '@type': 'PropertyValue',
            propertyID: 'address',
            value: authorAddress(contentInfo.publisher.address),
          },
          ...(contentInfo.publisher.safe
            ? [
                {
                  '@type': 'PropertyValue',
                  propertyID: 'address:safe',
                  value: contentInfo.publisher.safe,
                },
              ]
            : []),
        ],
      };
    }

    // Source attribution (derivative work tracking)
    if (contentInfo?.isBasedOn) {
      schema.isBasedOn = {
        '@type': 'CreativeWork',
        identifier: contentInfo.isBasedOn.genesis,
        sha256: contentInfo.isBasedOn.contentHash,
        dateModified: contentInfo.isBasedOn.timestamp,
      };
    }

    // Licensed URL (domain license proof)
    if (currentUrl) {
      schema.mainEntityOfPage = {
        '@type': 'WebPage',
        '@id': currentUrl,
      };
    }

    // Content integrity (self-authentication of the rendered page).
    //
    // This MediaObject asserts a digest OF THIS HTML, so it must not carry a
    // contentUrl: the only CID we have is the content item's, and nothing is
    // retrievable at that URL with this sha256. The item CID belongs on the
    // sdContent node below, where it is paired with the plaintext hash.
    const contentUrl = ipfsContentUrl(contentInfo?.contentCid);
    const encoding: Record<string, unknown> = {
      '@type': 'MediaObject',
      sha256: sha256Hash,
    };
    if (contentInfo?.mediaType) {
      encoding.encodingFormat = contentInfo.mediaType;
    }
    schema.encoding = encoding;

    // Canonical plaintext identity (specVersion "1"): what the author signed,
    // independent of this render. Emitted only when the body hash is known.
    if (contentInfo?.plaintextHash) {
      const sdContent: Record<string, unknown> = {
        '@type': 'CreativeWork',
        // keccak256 of the canonical body — NOT a schema.org sha256 (that term
        // is taken by encoding.sha256, a real SHA-256 of the HTML). Naming the
        // algorithm explicitly avoids two algorithms under one term.
        identifier: contentInfo.plaintextHash,
        digestMethod: 'keccak256',
      };
      if (contentInfo.mediaType) {
        sdContent.encodingFormat = contentInfo.mediaType;
      }
      if (contentInfo.specVersion) {
        sdContent.version = contentInfo.specVersion;
      }
      if (contentUrl) {
        sdContent.contentUrl = contentUrl;
      }
      schema.sdContent = sdContent;
    }

    // License contract reference
    if (contentInfo?.licenseContract) {
      schema.license = {
        '@type': 'CreativeWork',
        name: 'License via Safe Deals Module',
        identifier: {
          '@type': 'PropertyValue',
          propertyID: 'contract',
          value: contentInfo.licenseContract,
        },
      };
    }

    // Lit Action reference
    schema.sdPublisher = {
      '@type': 'Organization',
      name: 'Soul2Soul Protocol',
      identifier: {
        '@type': 'PropertyValue',
        propertyID: 'litAction',
        value: protocolInfo.litActions.render,
      },
    };

    // 4. Create proof metadata (without proofValue)
    const proofOptions: Record<string, string> = {
      type: 'DataIntegrityProof',
      cryptosuite: 'ecdsa-secp256k1-2019',
      created: timestamp,
      verificationMethod: `did:pkh:eip155:8453:${pkpAddress}`,
      proofPurpose: 'assertionMethod',
      canonicalization: PROOF_CANONICALIZATION_JCS,
    };

    // 5. Hash schema + proof options for signing (W3C Data Integrity approach)
    // Concatenate canonical schema + canonical proof options.
    //
    // JCS has no undefined type and throws on one, while JSON.stringify (used
    // for emission, below) silently drops such a key. A runtime caller leaving
    // an optional field undefined would therefore abort signing here, and the
    // catch-all below would return the page with NO JSON-LD at all — a page the
    // update gate can only ever reject. Strip first, so the signed bytes are
    // exactly the emitted bytes.
    const signable = stripUndefinedDeep(schema);
    const toSign = canonicalizeProofPayload(signable, proofOptions);

    const toSignHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(toSign));

    // 6. Sign with Lit PKP (may fail in preview — that's fine, metadata still gets embedded)
    try {
      const signingKey = new ethers.utils.SigningKey(
        await Lit.Actions.getPrivateKey({ pkpId: protocolInfo.pkp }),
      );
      const signature = ethers.utils.joinSignature(
        signingKey.signDigest(ethers.utils.arrayify(toSignHash)),
      );
      signable.proof = {
        ...proofOptions,
        proofValue: signature,
      };
    } catch (signError) {
      console.log('Signing skipped (preview or shim):', signError);
      signable.proof = proofOptions;
    }

    // 7. Create script tag (with proof if signed, without signature otherwise)
    const scriptTag = `<script type="application/ld+json">
${JSON.stringify(signable, null, 2)}
</script>`;

    // 8. Insert so the block lands outside the hashed region (see
    //    shared/src/metadata/html-block.ts — insert and extract are a pair).
    return insertJsonLdScript(html, scriptTag);
  } catch (error) {
    console.log('Error in addMetadata:', error);
    return html;
  }
};
