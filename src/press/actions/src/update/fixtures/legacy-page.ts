/**
 * FROZEN legacy fixture — captured from render/metadata.ts BEFORE the
 * specVersion-1 metadata change, with the pre-JCS canonicalisation:
 *
 *   JSON.stringify(obj, Object.keys(obj).sort())
 *
 * Do not regenerate this file. Its whole purpose is to be an artifact of the
 * OLD code path so that "pages published yesterday still verify" is a real
 * byte-compatibility test, not a tautology against the current helper.
 *
 * Generated with a throwaway key (derived from a fixed string — NOT a secret).
 * The `created` timestamp and signature are frozen as part of the page.
 *
 * The identity values are the pre-change `did:ethr:0x…` form. A page pinned
 * then carries that form under the same `did:ethr` term, and verify.ts reads it
 * through shared's authorAddress, so this file must keep them: it is the
 * evidence that the old value shape is still read as an address.
 */

/** EOA (test PKP) that signed the frozen page. */
export const LEGACY_FIXTURE_PKP = '0xEBD01A9D5D7D39C6C0cB2f540F6d87FF8283B142';

/** The exact bytes the OLD code signed — schema-without-proof ++ proofOptions. */
export const LEGACY_FIXTURE_TO_SIGN = "{\"@context\":[\"https://schema.org\",\"https://w3id.org/security/data-integrity/v2\"],\"@type\":\"Article\",\"author\":{\"@type\":\"Person\",\"identifier\":{\"@type\":\"PropertyValue\"}},\"encoding\":{\"@type\":\"MediaObject\"},\"identifier\":\"0x5555555555555555555555555555555555555555555555555555555555555555\",\"isBasedOn\":{\"@type\":\"CreativeWork\",\"identifier\":\"0x4444444444444444444444444444444444444444444444444444444444444444\"},\"license\":{\"@type\":\"CreativeWork\",\"identifier\":{\"@type\":\"PropertyValue\"}},\"mainEntityOfPage\":{\"@type\":\"WebPage\"},\"publisher\":{\"@type\":\"Organization\",\"identifier\":[{\"@type\":\"PropertyValue\"}]},\"sdPublisher\":{\"@type\":\"Organization\",\"identifier\":{\"@type\":\"PropertyValue\"}}}{\"created\":\"2026-10-27T15:05:40.628Z\",\"cryptosuite\":\"ecdsa-secp256k1-2019\",\"proofPurpose\":\"assertionMethod\",\"type\":\"DataIntegrityProof\",\"verificationMethod\":\"did:pkh:eip155:8453:0xEBD01A9D5D7D39C6C0cB2f540F6d87FF8283B142\"}";

/** The old canonicaliser, written out literally, applied to the frozen data. */
export const LEGACY_FIXTURE_SCHEMA_WITHOUT_PROOF = {
  "@context": [
    "https://schema.org",
    "https://w3id.org/security/data-integrity/v2"
  ],
  "@type": "Article",
  "identifier": "0x5555555555555555555555555555555555555555555555555555555555555555",
  "author": {
    "@type": "Person",
    "identifier": {
      "@type": "PropertyValue",
      "propertyID": "did:ethr",
      "value": "did:ethr:0x1111111111111111111111111111111111111111"
    },
    "dateCreated": "2025-01-02T03:04:05.000Z"
  },
  "publisher": {
    "@type": "Organization",
    "identifier": [
      {
        "@type": "PropertyValue",
        "propertyID": "did:ethr",
        "value": "did:ethr:0x2222222222222222222222222222222222222222"
      }
    ]
  },
  "isBasedOn": {
    "@type": "CreativeWork",
    "identifier": "0x4444444444444444444444444444444444444444444444444444444444444444",
    "sha256": "aaaaaaaa",
    "dateModified": "2025-01-01T00:00:00.000Z"
  },
  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "https://example.org"
  },
  "encoding": {
    "@type": "MediaObject",
    "sha256": "ccc1692567ed20efe79bd75d544ace4a974e5b4396e23e20e392484c1357c807",
    "contentUrl": "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
  },
  "license": {
    "@type": "CreativeWork",
    "name": "License via Safe Deals Module",
    "identifier": {
      "@type": "PropertyValue",
      "propertyID": "contract",
      "value": "0x3333333333333333333333333333333333333333"
    }
  },
  "sdPublisher": {
    "@type": "Organization",
    "name": "Soul2Soul Protocol",
    "identifier": {
      "@type": "PropertyValue",
      "propertyID": "litAction",
      "value": "ipfs://bafkreilegacyrenderactionxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    }
  }
};

export const LEGACY_FIXTURE_PROOF_OPTIONS = {
  "type": "DataIntegrityProof",
  "cryptosuite": "ecdsa-secp256k1-2019",
  "created": "2026-10-27T15:05:40.628Z",
  "verificationMethod": "did:pkh:eip155:8453:0xEBD01A9D5D7D39C6C0cB2f540F6d87FF8283B142",
  "proofPurpose": "assertionMethod"
};

/** The complete rendered page (JSON-LD already injected), frozen verbatim. */
export const LEGACY_FIXTURE_HTML = "<!DOCTYPE html>\n<script type=\"application/ld+json\">\n{\n  \"@context\": [\n    \"https://schema.org\",\n    \"https://w3id.org/security/data-integrity/v2\"\n  ],\n  \"@type\": \"Article\",\n  \"identifier\": \"0x5555555555555555555555555555555555555555555555555555555555555555\",\n  \"author\": {\n    \"@type\": \"Person\",\n    \"identifier\": {\n      \"@type\": \"PropertyValue\",\n      \"propertyID\": \"did:ethr\",\n      \"value\": \"did:ethr:0x1111111111111111111111111111111111111111\"\n    },\n    \"dateCreated\": \"2025-01-02T03:04:05.000Z\"\n  },\n  \"publisher\": {\n    \"@type\": \"Organization\",\n    \"identifier\": [\n      {\n        \"@type\": \"PropertyValue\",\n        \"propertyID\": \"did:ethr\",\n        \"value\": \"did:ethr:0x2222222222222222222222222222222222222222\"\n      }\n    ]\n  },\n  \"isBasedOn\": {\n    \"@type\": \"CreativeWork\",\n    \"identifier\": \"0x4444444444444444444444444444444444444444444444444444444444444444\",\n    \"sha256\": \"aaaaaaaa\",\n    \"dateModified\": \"2025-01-01T00:00:00.000Z\"\n  },\n  \"mainEntityOfPage\": {\n    \"@type\": \"WebPage\",\n    \"@id\": \"https://example.org\"\n  },\n  \"encoding\": {\n    \"@type\": \"MediaObject\",\n    \"sha256\": \"ccc1692567ed20efe79bd75d544ace4a974e5b4396e23e20e392484c1357c807\",\n    \"contentUrl\": \"ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi\"\n  },\n  \"license\": {\n    \"@type\": \"CreativeWork\",\n    \"name\": \"License via Safe Deals Module\",\n    \"identifier\": {\n      \"@type\": \"PropertyValue\",\n      \"propertyID\": \"contract\",\n      \"value\": \"0x3333333333333333333333333333333333333333\"\n    }\n  },\n  \"sdPublisher\": {\n    \"@type\": \"Organization\",\n    \"name\": \"Soul2Soul Protocol\",\n    \"identifier\": {\n      \"@type\": \"PropertyValue\",\n      \"propertyID\": \"litAction\",\n      \"value\": \"ipfs://bafkreilegacyrenderactionxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"\n    }\n  },\n  \"proof\": {\n    \"type\": \"DataIntegrityProof\",\n    \"cryptosuite\": \"ecdsa-secp256k1-2019\",\n    \"created\": \"2026-10-27T15:05:40.628Z\",\n    \"verificationMethod\": \"did:pkh:eip155:8453:0xEBD01A9D5D7D39C6C0cB2f540F6d87FF8283B142\",\n    \"proofPurpose\": \"assertionMethod\",\n    \"proofValue\": \"0xe83dc7e1af228da5fa2318bd4cbf93b5da3df5e7291d713c0fab79bb958177fd454dba08fbeec9e2a00ea4d9485f70cab456c2e617a6ff6a6d10ebf1687026631b\"\n  }\n}\n</script>\n\n<html lang=\"en\"><head><title>Legacy page</title></head><body><h1>Hello</h1><p>legacy fixture</p></body></html>\n";
