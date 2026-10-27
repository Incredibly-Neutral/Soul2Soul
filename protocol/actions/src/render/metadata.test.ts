/**
 * JSON-LD emission + PKP signing for the rendered page.
 *
 * Contract under test (specVersion "1"):
 *   - identifier stays the genesis `id` argument
 *   - encoding.sha256 is SHA-256 of the <html>…</html> block (\r\n → \n)
 *   - encoding/sdContent contentUrl only for a real IPFS CID, never ipfs://0x…
 *   - sdContent carries plaintextHash + mediaType + specVersion
 *   - author.proof (EIP-712) nests on the author node; top-level proof stays
 *     the PKP DataIntegrityProof
 *   - signing uses JCS-RFC8785, and the emitted page verifies byte-for-byte
 *     against the same canonicalisation (and NOT against the legacy one)
 */
import { describe, it, expect } from 'vitest';
import * as ethers from 'ethers5';
import {
  canonicalizeProofPayload,
  canonicalizeProofPayloadLegacy,
  verifyBodyHash,
  type S2SContentInfo,
  type S2SProtocolInfo,
} from '@s2s/soul2soul-shared/lit-actions';
import { addAndSignMetadata } from './metadata';

// metadata.ts runs inside a Lit Action: `ethers` and `Lit` are injected globals.
const PRIV = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('s2s-metadata-test-key'));
const PKP = ethers.utils.computeAddress(new ethers.utils.SigningKey(PRIV).publicKey);
(globalThis as unknown as { ethers: unknown }).ethers = ethers;
(globalThis as unknown as { Lit: unknown }).Lit = {
  Actions: { getPrivateKey: async () => PRIV },
};

const GENESIS = '0x' + '55'.repeat(32);
const PLAINTEXT_HASH = '0x' + 'ab'.repeat(32);
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

const PROTOCOL_INFO = {
  pkp: PKP,
  litActions: { render: 'ipfs://bafkreirenderaction' },
} as unknown as S2SProtocolInfo;

const PAGE = `<!DOCTYPE html>
<html lang="en"><head><title>t</title></head><body><h1>Hello</h1></body></html>`;

const contentInfo = (overrides: Partial<S2SContentInfo> = {}): S2SContentInfo => ({
  author: {
    did: 'did:ethr:0x1111111111111111111111111111111111111111',
    createdAt: '2025-01-02T03:04:05.000Z',
  },
  publisher: {
    did: 'did:ethr:0x2222222222222222222222222222222222222222',
    url: 'https://example.org',
  },
  contentCid: CID,
  licenseContract: '0x3333333333333333333333333333333333333333',
  plaintextHash: PLAINTEXT_HASH,
  mediaType: 'text/markdown',
  specVersion: '1',
  ...overrides,
});

type JsonLd = Record<string, any>; // JSON.parse output — shape asserted per-test

function jsonLdOf(html: string): JsonLd {
  const match = /<script type="application\/ld\+json">\s*([\s\S]*?)<\/script>/i.exec(html);
  if (!match) throw new Error('no JSON-LD emitted');
  return JSON.parse(match[1]) as JsonLd;
}

/** Same extraction/normalisation the verifier uses. */
function htmlBody(html: string): string {
  const match = /<html[^>]*>([\s\S]*)<\/html>/i.exec(html);
  return (match?.[0] ?? html).replace(/\r\n/g, '\n');
}

function proofOptionsOf(proof: JsonLd): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(proof)) {
    if (key !== 'proofValue') out[key] = String(proof[key]);
  }
  return out;
}

function withoutProof(schema: JsonLd): JsonLd {
  const { proof: _proof, ...data } = schema;
  return data;
}

function recover(toSign: string, signature: string): string {
  const hash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(toSign));
  return ethers.utils.recoverAddress(ethers.utils.arrayify(hash), signature);
}

async function render(info: S2SContentInfo, html: string = PAGE): Promise<{ html: string; schema: JsonLd }> {
  const out = await addAndSignMetadata(GENESIS, html, PROTOCOL_INFO, info);
  return { html: out, schema: jsonLdOf(out) };
}

describe('addAndSignMetadata — identity, encoding and signing', () => {
  it('keeps identifier = genesis and hashes the <html> body with SHA-256', async () => {
    const { html, schema } = await render(contentInfo());
    expect(schema.identifier).toBe(GENESIS);
    expect(schema.encoding['@type']).toBe('MediaObject');
    const expected = ethers.utils.sha256(ethers.utils.toUtf8Bytes(htmlBody(html))).replace('0x', '');
    expect(schema.encoding.sha256).toBe(expected);
  });

  it('signs with JCS-RFC8785 and the emitted page verifies byte-for-byte', async () => {
    const { schema } = await render(contentInfo());
    expect(schema.proof.canonicalization).toBe('JCS-RFC8785');
    expect(schema.proof.verificationMethod).toBe(`did:pkh:eip155:8453:${PKP}`);

    const toSign = canonicalizeProofPayload(withoutProof(schema), proofOptionsOf(schema.proof));
    expect(recover(toSign, schema.proof.proofValue)).toBe(PKP);
  });

  it('the LEGACY canonicalisation no longer reproduces the signature (nested fields now count)', async () => {
    const { schema } = await render(contentInfo());
    const legacyToSign = canonicalizeProofPayloadLegacy(
      withoutProof(schema),
      proofOptionsOf(schema.proof),
    );
    let legacyRecovered: string | undefined;
    try {
      legacyRecovered = recover(legacyToSign, schema.proof.proofValue);
    } catch {
      legacyRecovered = undefined;
    }
    expect(legacyRecovered).not.toBe(PKP);
    // Sanity: the two payloads genuinely differ (the bug being fixed).
    expect(legacyToSign).not.toBe(
      canonicalizeProofPayload(withoutProof(schema), proofOptionsOf(schema.proof)),
    );
  });

  it('a nested-only metadata change moves the signed payload', async () => {
    const { schema: a } = await render(contentInfo());
    const { schema: b } = await render(contentInfo({ plaintextHash: '0x' + 'cd'.repeat(32) }));
    const payloadOf = (s: JsonLd) =>
      canonicalizeProofPayload(withoutProof(s), proofOptionsOf(s.proof));
    expect(payloadOf(a)).not.toBe(payloadOf(b));
    expect(schemaIdentifier(a)).toBe(schemaIdentifier(b));

    function schemaIdentifier(s: JsonLd): string {
      return s.identifier as string;
    }
  });
});

describe('addAndSignMetadata — sdContent', () => {
  it('emits sdContent when plaintextHash is present', async () => {
    const { schema } = await render(contentInfo());
    expect(schema.sdContent).toEqual({
      '@type': 'CreativeWork',
      identifier: PLAINTEXT_HASH,
      sha256: PLAINTEXT_HASH.replace(/^0x/, ''),
      encodingFormat: 'text/markdown',
      version: '1',
      contentUrl: `ipfs://${CID}`,
    });
  });

  it('omits sdContent entirely when plaintextHash is absent', async () => {
    const { schema } = await render(contentInfo({ plaintextHash: undefined }));
    expect(schema).not.toHaveProperty('sdContent');
  });

  it('sdContent.identifier is the keccak256 of the canonical plaintext body', async () => {
    const body = JSON.stringify({ text: 'hello', tags: ['a'] });
    const hash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(body));
    const { schema } = await render(contentInfo({ plaintextHash: hash }));

    expect(schema.sdContent.identifier).toBe(hash);
    expect(schema.sdContent.sha256).toBe(hash.slice(2));
    expect(verifyBodyHash(body, schema.sdContent.identifier)).toBe(true);
    expect(verifyBodyHash(body + ' ', schema.sdContent.identifier)).toBe(false);
  });

  it('omits optional sdContent fields that were not supplied', async () => {
    const { schema } = await render(
      contentInfo({ mediaType: undefined, specVersion: undefined, contentCid: undefined }),
    );
    expect(schema.sdContent).toEqual({
      '@type': 'CreativeWork',
      identifier: PLAINTEXT_HASH,
      sha256: PLAINTEXT_HASH.replace(/^0x/, ''),
    });
  });
});

describe('addAndSignMetadata — contentUrl', () => {
  it('emits ipfs://<cid> for a real CID on both nodes', async () => {
    const { schema } = await render(contentInfo());
    expect(schema.encoding.contentUrl).toBe(`ipfs://${CID}`);
    expect(schema.sdContent.contentUrl).toBe(`ipfs://${CID}`);
  });

  it('omits contentUrl entirely for a bytes32 contentCid (never ipfs://0x…)', async () => {
    const { html, schema } = await render(contentInfo({ contentCid: GENESIS }));
    expect(schema.encoding).not.toHaveProperty('contentUrl');
    expect(schema.sdContent).not.toHaveProperty('contentUrl');
    expect(html).not.toContain('ipfs://0x');
  });

  it('omits contentUrl when no CID is supplied', async () => {
    const { schema } = await render(contentInfo({ contentCid: '' }));
    expect(schema.encoding).not.toHaveProperty('contentUrl');
    expect(schema.sdContent).not.toHaveProperty('contentUrl');
  });
});

describe('addAndSignMetadata — author proof nesting', () => {
  const authorProof = {
    type: 'eip712' as const,
    objectId: '0x' + 'de'.repeat(32),
    signer: '0x9999999999999999999999999999999999999999',
    signature: '0xsig',
  };

  it('nests the author EIP-712 proof on the author node', async () => {
    const { schema } = await render(
      contentInfo({
        author: {
          did: 'did:ethr:0x1111111111111111111111111111111111111111',
          createdAt: '2025-01-02T03:04:05.000Z',
          proof: authorProof,
        },
      }),
    );
    expect(schema.author.proof).toEqual({
      type: 'eip712',
      objectId: authorProof.objectId,
      signer: authorProof.signer,
      signature: authorProof.signature,
    });
    expect(schema.author.identifier.value).toBe(
      'did:ethr:0x1111111111111111111111111111111111111111',
    );
  });

  it('leaves the top-level proof as the PKP DataIntegrityProof only', async () => {
    const { schema } = await render(
      contentInfo({
        author: {
          did: 'did:ethr:0x1111111111111111111111111111111111111111',
          proof: authorProof,
        },
      }),
    );
    expect(schema.proof.type).toBe('DataIntegrityProof');
    expect(schema.proof.proofValue).toMatch(/^0x[0-9a-f]+$/i);
    expect(schema.proof).not.toHaveProperty('signer');
    expect(schema.proof).not.toHaveProperty('signature');
  });

  it('omits author.proof when the author did not sign', async () => {
    const { schema } = await render(contentInfo());
    expect(schema.author).not.toHaveProperty('proof');
  });

  it('keeps the nested author proof inside the signed bytes', async () => {
    const withProof = await render(
      contentInfo({
        author: { did: 'did:ethr:0x1111', proof: authorProof },
      }),
    );
    const without = await render(contentInfo({ author: { did: 'did:ethr:0x1111' } }));
    expect(
      canonicalizeProofPayload(withoutProof(withProof.schema), proofOptionsOf(withProof.schema.proof)),
    ).not.toBe(
      canonicalizeProofPayload(withoutProof(without.schema), proofOptionsOf(without.schema.proof)),
    );
  });
});

describe('addAndSignMetadata — mediaType', () => {
  it('sets encoding.encodingFormat from mediaType when present', async () => {
    const { schema } = await render(contentInfo());
    expect(schema.encoding.encodingFormat).toBe('text/markdown');
  });

  it('omits encodingFormat when mediaType is absent', async () => {
    const { schema } = await render(contentInfo({ mediaType: undefined }));
    expect(schema.encoding).not.toHaveProperty('encodingFormat');
  });
});

describe('addAndSignMetadata — structural invariants', () => {
  it('keeps sdPublisher / isBasedOn / license / mainEntityOfPage', async () => {
    const { schema } = await render(
      contentInfo({
        isBasedOn: {
          genesis: '0x' + '44'.repeat(32),
          contentHash: 'aa',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
      }),
    );
    expect(schema.sdPublisher.identifier.value).toBe(PROTOCOL_INFO.litActions.render);
    expect(schema.isBasedOn.identifier).toBe('0x' + '44'.repeat(32));
    expect(schema.license.name).toBe('License via Safe Deals Module');
    expect(schema.mainEntityOfPage['@id']).toBe('https://example.org');
  });

  it('does not let the embedded script tag change the hashed html body', async () => {
    const { html } = await render(contentInfo());
    // The script is injected before <html>, so the <html>…</html> block is intact.
    expect(htmlBody(html)).toBe(htmlBody(PAGE));
  });
});
