import {
  S2SContentInfo,
  S2SProtocolInfo,
  canonicalizeProofPayload,
  ipfsContentUrl,
  PROOF_CANONICALIZATION_JCS,
} from '@s2s/soul2soul-shared/lit-actions';

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
  contentInfo?: S2SContentInfo,
) => {
  // console.log("pkp", protocolInfo.pkp.publicKey.replace("0x", ""));

  try {
    // 1. Extract HTML content between <html> and </html> tags
    let contentToHash = html;
    const htmlMatch = /<html[^>]*>([\s\S]*)<\/html>/i.exec(html);

    if (htmlMatch && htmlMatch[0]) {
      contentToHash = htmlMatch[0];
    } else {
      console.log('Could not find HTML tags, hashing entire content');
    }

    // Normalise line endings — IPFS gateways may insert \r\n
    contentToHash = contentToHash.replace(/\r\n/g, '\n');

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

    // Author (provenance). The author's EIP-712 proof is nested HERE, not on
    // the top-level proof — the top-level proof is the PKP's DataIntegrityProof.
    if (contentInfo?.author) {
      const author: Record<string, unknown> = {
        '@type': 'Person',
        identifier: {
          '@type': 'PropertyValue',
          propertyID: 'did:ethr',
          value: contentInfo.author.did,
        },
      };

      // Add profile creation timestamp if available
      if (contentInfo.author.createdAt) {
        author.dateCreated = contentInfo.author.createdAt;
      }

      if (contentInfo.author.proof) {
        const authorProof = contentInfo.author.proof;
        author.proof = {
          type: authorProof.type,
          ...(authorProof.objectId ? { objectId: authorProof.objectId } : {}),
          signer: authorProof.signer,
          signature: authorProof.signature,
        };
      }

      schema.author = author;
    }

    // Publisher
    if (contentInfo?.publisher) {
      schema.publisher = {
        '@type': 'Organization',
        identifier: [
          {
            '@type': 'PropertyValue',
            propertyID: 'did:ethr',
            value: contentInfo.publisher.did,
          },
          ...(contentInfo.publisher.safe
            ? [
                {
                  '@type': 'PropertyValue',
                  propertyID: 'did:ethr:safe',
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

    // Content integrity (self-authentication of the rendered page)
    const contentUrl = ipfsContentUrl(contentInfo?.contentCid);
    const encoding: Record<string, unknown> = {
      '@type': 'MediaObject',
      sha256: sha256Hash,
    };
    if (contentInfo?.mediaType) {
      encoding.encodingFormat = contentInfo.mediaType;
    }
    // Only a real IPFS CID becomes a contentUrl — never `ipfs://0x…`.
    if (contentUrl) {
      encoding.contentUrl = contentUrl;
    }
    schema.encoding = encoding;

    // Canonical plaintext identity (specVersion "1"): what the author signed,
    // independent of this render. Emitted only when the body hash is known.
    if (contentInfo?.plaintextHash) {
      const sdContent: Record<string, unknown> = {
        '@type': 'CreativeWork',
        identifier: contentInfo.plaintextHash,
        sha256: contentInfo.plaintextHash.replace(/^0x/i, ''),
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
    const toSign = canonicalizeProofPayload(schema, proofOptions);

    const toSignHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(toSign));

    // 6. Sign with Lit PKP (may fail in preview — that's fine, metadata still gets embedded)
    const sigName = `sign-${id.slice(0, 4)}`;

    try {
      const signingKey = new ethers.utils.SigningKey(
        await Lit.Actions.getPrivateKey({ pkpId: protocolInfo.pkp }),
      );
      const signature = ethers.utils.joinSignature(
        signingKey.signDigest(ethers.utils.arrayify(toSignHash)),
      );
      schema.proof = {
        ...proofOptions,
        proofValue: signature,
      };
    } catch (signError) {
      console.log('Signing skipped (preview or shim):', signError);
      schema.proof = proofOptions;
    }

    // 7. Create script tag (with proof if signed, without signature otherwise)
    const scriptTag = `<script type="application/ld+json">
${JSON.stringify(schema, null, 2)}
</script>`;

    // 8. Insert into HTML after DOCTYPE, before <html>
    if (html.includes('<!DOCTYPE html>')) {
      const parts = html.split('<!DOCTYPE html>');
      let htmlContent = parts[1];

      if (htmlContent.includes('<html')) {
        htmlContent = htmlContent.replace(/(\s*<html)/i, `\n${scriptTag}\n$1`);
      }

      html = '<!DOCTYPE html>' + htmlContent;
    } else if (html.includes('<html')) {
      html = html.replace(/(<html)/i, `${scriptTag}\n$1`);
    } else {
      html = scriptTag + '\n' + html;
    }

    return html;
  } catch (error) {
    console.log('Error in addMetadata:', error);
    return html;
  }
};
