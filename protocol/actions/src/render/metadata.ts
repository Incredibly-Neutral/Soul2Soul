import { S2SContentInfo, S2SProtocolInfo } from "@s2s/soul2soul-shared/lit-actions";

// Canonical JSON for consistent hashing
const canonicalize = (obj: any): string => {
  return JSON.stringify(obj, Object.keys(obj).sort());
};

export const addAndSignMetadata = async (
  id: string,
  html: string,
  protocolInfo: S2SProtocolInfo,
  contentInfo?: S2SContentInfo
) => {
  
  // console.log("pkp", protocolInfo.pkp.publicKey.replace("0x", ""));

  try {
    // 1. Extract HTML content between <html> and </html> tags
    let contentToHash = html;
    const htmlMatch = /<html[^>]*>([\s\S]*)<\/html>/i.exec(html);

    if (htmlMatch && htmlMatch[0]) {
      contentToHash = htmlMatch[0];
    } else {
      console.log("Could not find HTML tags, hashing entire content");
    }

    // 2. Hash the HTML (SHA-256 for Schema.org)
    const htmlBytes = ethers.utils.toUtf8Bytes(contentToHash);
    const sha256Hash = ethers.utils.sha256(htmlBytes).replace("0x", "");

    const pkpAddress = protocolInfo.pkp

    const timestamp = new Date().toISOString();
    const currentUrl = contentInfo?.publisher?.url || "";

    // 4. Build schema WITHOUT proof first
    const schema: any = {
      "@context": [
        "https://schema.org",
        "https://w3id.org/security/data-integrity/v2"
      ],
      "@type": "Article"
    };

    // Author (provenance)
    if (contentInfo?.author) {
      schema.author = {
        "@type": "Person",
        "identifier": {
          "@type": "PropertyValue",
          "propertyID": "did:ethr",
          "value": contentInfo.author.did
        }
      };
      
      // Add profile creation timestamp if available
      if (contentInfo.author.createdAt) {
        schema.author.dateCreated = contentInfo.author.createdAt;
      }
    }

    // Publisher
    if (contentInfo?.publisher) {
      schema.publisher = {
        "@type": "Organization",
        "identifier": [
          {
            "@type": "PropertyValue",
            "propertyID": "did:ethr",
            "value": contentInfo.publisher.did
          },
          ...(contentInfo.publisher.safe ? [{
            "@type": "PropertyValue",
            "propertyID": "did:ethr:safe",
            "value": contentInfo.publisher.safe
          }] : [])
        ]
      };
    }

    // Source attribution (derivative work tracking)
    if (contentInfo?.isBasedOn) {
      schema.isBasedOn = {
        "@type": "CreativeWork",
        "identifier": contentInfo.isBasedOn.genesis,
        "sha256": contentInfo.isBasedOn.contentHash,
        "dateModified": contentInfo.isBasedOn.timestamp
      };
    }

    // Licensed URL (domain license proof)
    if (currentUrl) {
      schema.mainEntityOfPage = {
        "@type": "WebPage",
        "@id": currentUrl
      };
    }

    // Content integrity (self-authentication)
    schema.encoding = {
      "@type": "MediaObject",
      "sha256": sha256Hash
    };

    if (contentInfo?.contentCid) {
      schema.encoding.contentUrl = `ipfs://${contentInfo.contentCid}`;
    }

    // License contract reference
    if (contentInfo?.licenseContract) {
      schema.license = {
        "@type": "CreativeWork",
        "name": "License via Safe Deals Module",
        "identifier": {
          "@type": "PropertyValue",
          "propertyID": "contract",
          "value": contentInfo.licenseContract
        }
      };
    }

    // Lit Action reference
    schema.sdPublisher = {
      "@type": "Organization",
      "name": "Soul2Soul Protocol",
      "identifier": {
        "@type": "PropertyValue",
        "propertyID": "litAction",
        "value": protocolInfo.litActions.render
      }
    };

    // 5. Create proof metadata (without proofValue)
    const proofOptions: Record<string, string> = {
      "type": "DataIntegrityProof",
      "cryptosuite": "ecdsa-secp256k1-2019",
      "created": timestamp,
      "verificationMethod": `did:pkh:eip155:8453:${pkpAddress}`,
      "proofPurpose": "assertionMethod"
    };

    // 6. Hash schema + proof options for signing (W3C Data Integrity approach)
    // Concatenate canonical schema + canonical proof options
    const schemaCanonical = canonicalize(schema);
    const proofOptionsCanonical = canonicalize(proofOptions);
    const toSign = schemaCanonical + proofOptionsCanonical;
    
    const toSignHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(toSign)
    );

    // 7. Sign with Lit PKP (may fail in preview — that's fine, metadata still gets embedded)
    const sigName = `sign-${id.slice(0, 4)}`;
    
    try {
      const signingKey = new ethers.utils.SigningKey(
          await Lit.Actions.getPrivateKey({ pkpId: protocolInfo.pkp })
      );
      const signature = ethers.utils.joinSignature(
          signingKey.signDigest(ethers.utils.arrayify(toSignHash))
      );
      schema.proof = {
        ...proofOptions,
        "proofValue": signature
      };
    } catch (signError) {
      console.log("Signing skipped (preview or shim):", signError);
      schema.proof = proofOptions;
    }

    // 8. Create script tag (with proof if signed, without signature otherwise)
    const scriptTag = `<script type="application/ld+json">
${JSON.stringify(schema, null, 2)}
</script>`;

    // 10. Insert into HTML after DOCTYPE, before <html>
    if (html.includes("<!DOCTYPE html>")) {
      const parts = html.split("<!DOCTYPE html>");
      let htmlContent = parts[1];

      if (htmlContent.includes("<html")) {
        htmlContent = htmlContent.replace(
          /(\s*<html)/i,
          `\n${scriptTag}\n$1`
        );
      }

      html = "<!DOCTYPE html>" + htmlContent;
    } else if (html.includes("<html")) {
      html = html.replace(
        /(<html)/i,
        `${scriptTag}\n$1`
      );
    } else {
      html = scriptTag + "\n" + html;
    }

    return html;

  } catch (error) {
    console.log("Error in addMetadata:", error);
    return html;
  }
};