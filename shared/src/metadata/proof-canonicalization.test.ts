/**
 * Proof canonicalisation — the bytes the renderer signs and the update gate
 * re-derives.
 *
 * The bug being fixed: `JSON.stringify(obj, Object.keys(obj).sort())` is a
 * *recursive key whitelist*, so nested keys that do not also exist at the top
 * level (sha256, contentUrl, DID values, dates) never entered the signed bytes.
 * A signature over that payload attests the document's shape, not its content.
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalizeLegacy,
  canonicalizeProofPayload,
  canonicalizeProofPayloadLegacy,
  proofCanonicalizationOf,
  PROOF_CANONICALIZATION_JCS,
} from './proof-canonicalization';
import { isIpfsCid, ipfsContentUrl } from './content-url';
import { keccakOfJson } from '../identity/jcs';

const IPFS_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

const schema = {
  '@context': ['https://schema.org'],
  '@type': 'Article',
  identifier: '0x' + '55'.repeat(32),
  author: {
    '@type': 'Person',
    identifier: { '@type': 'PropertyValue', propertyID: 'did:ethr', value: 'did:ethr:0xabc' },
    dateCreated: '2025-01-02T03:04:05.000Z',
  },
  encoding: {
    '@type': 'MediaObject',
    sha256: 'ccc1692567ed20efe79bd75d544ace4a974e5b4396e23e20e392484c1357c807',
    contentUrl: `ipfs://${IPFS_CID}`,
  },
  sdContent: {
    '@type': 'CreativeWork',
    identifier: '0x' + '66'.repeat(32),
    digestMethod: 'keccak256',
    encodingFormat: 'text/markdown',
    version: '1',
  },
};

const proofOptions = {
  type: 'DataIntegrityProof',
  cryptosuite: 'ecdsa-secp256k1-2019',
  created: '2025-01-02T03:04:05.000Z',
  verificationMethod: 'did:pkh:eip155:8453:0xPKP',
  proofPurpose: 'assertionMethod',
  canonicalization: PROOF_CANONICALIZATION_JCS,
};

const proofOptionsLegacy = {
  type: 'DataIntegrityProof',
  cryptosuite: 'ecdsa-secp256k1-2019',
  created: '2025-01-02T03:04:05.000Z',
  verificationMethod: 'did:pkh:eip155:8453:0xPKP',
  proofPurpose: 'assertionMethod',
};

describe('canonicalizeProofPayloadLegacy — frozen history', () => {
  it('is byte-identical to the shipped stringify-with-key-array payload', () => {
    // Written out literally, exactly as the old render/verify pair did it.
    const expected =
      JSON.stringify(schema, Object.keys(schema).sort()) +
      JSON.stringify(proofOptionsLegacy, Object.keys(proofOptionsLegacy).sort());
    expect(canonicalizeProofPayloadLegacy(schema, proofOptionsLegacy)).toBe(expected);
  });

  it('drops nested keys that do not exist at the top level (the bug)', () => {
    // The exact bytes the old scheme produced for the schema half.
    const payload = canonicalizeLegacy(schema);
    const schemaHalf = JSON.parse(payload) as {
      encoding: Record<string, unknown>;
      author: Record<string, unknown>;
      sdContent: Record<string, unknown>;
    };

    expect(payload).not.toContain('ccc1692567ed20efe79bd75d544ace4a974e5b4396e23e20e392484c1357c807');
    expect(payload).not.toContain(IPFS_CID);
    expect(payload).not.toContain('did:ethr:0xabc');
    expect(payload).not.toContain('2025-01-02T03:04:05.000Z');
    expect(payload).not.toContain('text/markdown');

    // …and collapses the nested objects to their whitelisted skeleton.
    expect(schemaHalf.encoding).toEqual({ '@type': 'MediaObject' });
    expect(schemaHalf.author).toEqual({
      '@type': 'Person',
      identifier: { '@type': 'PropertyValue' },
    });
    expect(schemaHalf.sdContent).not.toHaveProperty('digestMethod');
    expect(schemaHalf.sdContent).not.toHaveProperty('encodingFormat');
    expect(schemaHalf.sdContent).not.toHaveProperty('version');
    // Nuance worth pinning: a nested key survives the whitelist only when the
    // same NAME also exists at the top level — `identifier` and `@type` do.
    expect(schemaHalf.sdContent.identifier).toBe(schema.sdContent.identifier);
  });

  it('cannot distinguish two documents that differ only in nested values', () => {
    const tweaked = {
      ...schema,
      author: { ...schema.author, dateCreated: '2030-01-01T00:00:00.000Z' },
      encoding: { ...schema.encoding, sha256: 'ff'.repeat(32), encodingFormat: 'text/html' },
      // `identifier` is top-level so it survives the whitelist; digestMethod,
      // version and contentUrl are nested-only and vanish.
      sdContent: {
        ...schema.sdContent,
        digestMethod: 'sha3-512',
        version: '2',
        contentUrl: 'ipfs://bafkother',
      },
    };
    expect(canonicalizeProofPayloadLegacy(tweaked, proofOptionsLegacy)).toBe(
      canonicalizeProofPayloadLegacy(schema, proofOptionsLegacy),
    );
  });
});

describe('canonicalizeProofPayload — JCS-RFC8785', () => {
  it('is independent of key insertion order', () => {
    const reordered = {
      sdContent: schema.sdContent,
      encoding: schema.encoding,
      author: schema.author,
      identifier: schema.identifier,
      '@type': schema['@type'],
      '@context': schema['@context'],
    };
    expect(canonicalizeProofPayload(reordered, proofOptions)).toBe(
      canonicalizeProofPayload(schema, proofOptions),
    );
  });

  it('actually covers nested fields (unlike legacy)', () => {
    const jcsPayload = canonicalizeProofPayload(schema, proofOptions);
    expect(jcsPayload).toContain('ccc1692567ed20efe79bd75d544ace4a974e5b4396e23e20e392484c1357c807');
    expect(jcsPayload).toContain(`ipfs://${IPFS_CID}`);
    expect(jcsPayload).toContain('did:ethr:0xabc');
    expect(jcsPayload).toContain('text/markdown');
    expect(jcsPayload).toContain(PROOF_CANONICALIZATION_JCS);

    const tweaked = { ...schema, sdContent: { ...schema.sdContent, identifier: '0x' + '99'.repeat(32) } };
    expect(canonicalizeProofPayload(tweaked, proofOptions)).not.toBe(jcsPayload);
  });

  it('a nested-only change moves the signed digest', () => {
    const base = keccakOfJson(canonicalizeProofPayload(schema, proofOptions));
    const tweaked = { ...schema, author: { ...schema.author, dateCreated: '2030-01-01T00:00:00.000Z' } };
    const moved = keccakOfJson(canonicalizeProofPayload(tweaked, proofOptions));
    expect(moved).not.toBe(base);
    // …while the legacy digest does not move at all.
    expect(keccakOfJson(canonicalizeProofPayloadLegacy(tweaked, proofOptionsLegacy))).toBe(
      keccakOfJson(canonicalizeProofPayloadLegacy(schema, proofOptionsLegacy)),
    );
  });
});

describe('proofCanonicalizationOf', () => {
  it('reads the marker off proof options', () => {
    expect(proofCanonicalizationOf(proofOptions)).toBe('JCS-RFC8785');
  });

  it('defaults to LEGACY when the marker is absent', () => {
    expect(proofCanonicalizationOf(proofOptionsLegacy)).toBe('LEGACY');
    // A whole schema is NOT a marker source: proof.canonicalization is the only
    // one, so a schema handed in by mistake degrades to LEGACY (fail closed).
    expect(proofCanonicalizationOf({ ...schema, proof: proofOptions })).toBe('LEGACY');
  });

  it('never guesses JCS from anything but the exact marker', () => {
    expect(proofCanonicalizationOf({ ...proofOptionsLegacy, canonicalization: 'jcs' })).toBe('LEGACY');
    expect(proofCanonicalizationOf({ ...proofOptionsLegacy, canonicalization: 'JCS' })).toBe('LEGACY');
  });
});

describe('ipfsContentUrl / isIpfsCid', () => {
  it('accepts CIDv0 (base58btc) and CIDv1 (base32, dag-pb / raw)', () => {
    const v0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const bafk = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
    for (const cid of [v0, IPFS_CID, bafk]) {
      expect(isIpfsCid(cid)).toBe(true);
      expect(ipfsContentUrl(cid)).toBe(`ipfs://${cid}`);
    }
  });

  it('omits the URL for libp2p peer ids (a multihash is not content)', () => {
    const peer = '12D3KooWDpJ7As7BWAwRMfu1VU2WCqNjvq387JEYKDBj4kx6nXTN';
    expect(isIpfsCid(peer)).toBe(false);
    expect(ipfsContentUrl(peer)).toBeUndefined();
  });

  it('omits the URL for bytes32 ids, http urls, empties and near-misses', () => {
    const rejected = [
      '0x' + '55'.repeat(32),
      '0x5555',
      'https://example.org/x',
      '',
      undefined,
      null,
      // Real parse, not a prefix match: these all start like a CID and fail.
      'QmTooShort',
      'bafynot-base32!',
      'notacid',
      'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdiX',
      'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbd0',
    ];
    for (const value of rejected) {
      expect(isIpfsCid(value)).toBe(false);
      expect(ipfsContentUrl(value)).toBeUndefined();
    }
  });
});
