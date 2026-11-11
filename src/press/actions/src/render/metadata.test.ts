/**
 * JSON-LD emission + PKP signing for the rendered page.
 *
 * Contract under test (specVersion "1"):
 *   - identifier stays the genesis `id` argument
 *   - encoding.sha256 is SHA-256 of the hashed region (\r\n → \n), and encoding
 *     carries no contentUrl: its digest is of THIS html, not of the item
 *   - the item CID lives on sdContent only, paired with the plaintext hash;
 *     only real CIDs become ipfs:// URLs, never ipfs://0x…
 *   - sdContent carries plaintextHash (as identifier, with digestMethod) +
 *     mediaType + specVersion
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
  extractHashableHtml,
  jcs,
  verifyBodyHash,
  type S2SContentInfo,
  type S2SProtocolInfo,
} from '@s2s/soul2soul-shared/lit-actions';
import { addAndSignMetadata, type S2SContentInfoWithDates } from './metadata';
import { LEGACY_AUTHOR_PREFIX } from '../../../../shared/dist/manuscript/identity/author-address';

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
const PEER_ID = '12D3KooWDpJ7As7BWAwRMfu1VU2WCqNjvq387JEYKDBj4kx6nXTN';

const PROTOCOL_INFO = {
  pkp: PKP,
  litActions: { render: 'ipfs://bafkreirenderaction' },
} as unknown as S2SProtocolInfo;

const PAGE = `<!DOCTYPE html>
<html lang="en"><head><title>t</title></head><body><h1>Hello</h1></body></html>`;

const contentInfo = (overrides: Partial<S2SContentInfoWithDates> = {}): S2SContentInfoWithDates => ({
  author: {
    address: '0x1111111111111111111111111111111111111111',
    createdAt: '2025-01-02T03:04:05.000Z',
  },
  publisher: {
    address: '0x2222222222222222222222222222222222222222',
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

const sha256Of = (value: string): string =>
  ethers.utils.sha256(ethers.utils.toUtf8Bytes(value)).replace('0x', '');

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

const payloadOf = (schema: JsonLd): string =>
  canonicalizeProofPayload(withoutProof(schema), proofOptionsOf(schema.proof));

function recover(toSign: string, signature: string): string {
  const hash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(toSign));
  return ethers.utils.recoverAddress(ethers.utils.arrayify(hash), signature);
}

async function render(
  info: S2SContentInfoWithDates,
  html: string = PAGE,
): Promise<{ html: string; schema: JsonLd }> {
  const out = await addAndSignMetadata(GENESIS, html, PROTOCOL_INFO, info);
  return { html: out, schema: jsonLdOf(out) };
}

describe('addAndSignMetadata — identity, encoding and signing', () => {
  it('keeps identifier = genesis, marks JCS, and digests the hashed region', async () => {
    const { schema } = await render(contentInfo());
    expect(schema.identifier).toBe(GENESIS);
    expect(schema.proof.canonicalization).toBe('JCS-RFC8785');
    expect(schema.encoding['@type']).toBe('MediaObject');
    // Oracle = the INPUT page, not the emitted one, so a drift in what
    // metadata.ts hashes shows up here.
    expect(schema.encoding.sha256).toBe(sha256Of(extractHashableHtml(PAGE)));
  });

  it('signs so that the JCS payload recovers the PKP', async () => {
    const { schema } = await render(contentInfo());
    expect(schema.proof.verificationMethod).toBe(`did:pkh:eip155:8453:${PKP}`);
    expect(recover(payloadOf(schema), schema.proof.proofValue)).toBe(PKP);
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
    expect(legacyToSign).not.toBe(payloadOf(schema));
  });

  it('a nested-only metadata change moves the signed payload', async () => {
    // Render ONCE and mutate the parsed schema: comparing two renders would
    // also differ in proof.created, which proves nothing.
    const { schema } = await render(contentInfo());
    const before = payloadOf(schema);

    const tampered = JSON.parse(JSON.stringify(schema)) as JsonLd;
    tampered.sdContent.identifier = '0x' + 'cd'.repeat(32);
    const after = payloadOf(tampered);

    expect(after).not.toBe(before);
    expect(tampered.identifier).toBe(schema.identifier);
    // …and only the nested value changed.
    expect(payloadOf({ ...schema, sdContent: schema.sdContent })).toBe(before);
  });
});

describe('addAndSignMetadata — sdContent', () => {
  it('emits sdContent keyed on the plaintext hash with an explicit digestMethod', async () => {
    const { schema } = await render(contentInfo());
    expect(schema.sdContent).toEqual({
      '@type': 'CreativeWork',
      identifier: PLAINTEXT_HASH,
      digestMethod: 'keccak256',
      encodingFormat: 'text/markdown',
      version: '1',
      contentUrl: `ipfs://${CID}`,
    });
    // Two algorithms must never share one schema.org term: sdContent carries a
    // keccak256 identifier, encoding.sha256 carries a real SHA-256.
    expect(schema.sdContent).not.toHaveProperty('sha256');
  });

  it('omits sdContent entirely when plaintextHash is absent', async () => {
    const { schema } = await render(contentInfo({ plaintextHash: undefined }));
    expect(schema).not.toHaveProperty('sdContent');
  });

  it('sdContent.identifier is the keccak256 of the canonical body', async () => {
    const body = { text: 'hello', tags: ['a'] };
    const bodyJson = jcs(body); // what sign-content.ts stores and hashes
    const hash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(bodyJson));
    const { schema } = await render(contentInfo({ plaintextHash: hash }));

    expect(schema.sdContent.identifier).toBe(hash);
    expect(verifyBodyHash(bodyJson, schema.sdContent.identifier)).toBe(true);
    expect(verifyBodyHash(bodyJson + ' ', schema.sdContent.identifier)).toBe(false);
  });

  it('omits optional sdContent fields that were not supplied', async () => {
    const { schema } = await render(
      contentInfo({ mediaType: undefined, specVersion: undefined, contentCid: undefined }),
    );
    expect(schema.sdContent).toEqual({
      '@type': 'CreativeWork',
      identifier: PLAINTEXT_HASH,
      digestMethod: 'keccak256',
    });
  });
});

describe('addAndSignMetadata — contentUrl', () => {
  it('pairs the item CID with the plaintext hash on sdContent only', async () => {
    const { schema } = await render(contentInfo());
    expect(schema.sdContent.contentUrl).toBe(`ipfs://${CID}`);
    // encoding asserts a digest of this HTML; nothing is retrievable at the
    // item CID with that digest, so it must not claim a URL.
    expect(schema.encoding).not.toHaveProperty('contentUrl');
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

  it('omits contentUrl for a libp2p peer id (a multihash is not content)', async () => {
    const { schema } = await render(contentInfo({ contentCid: PEER_ID }));
    expect(schema.sdContent).not.toHaveProperty('contentUrl');
  });
});

describe('addAndSignMetadata — author proof nesting', () => {
  // THE REAL SHAPE: a minted item's proof is {type, signer, signature}; the
  // objectId is a SIBLING field on the item. Fixtures used to put objectId
  // inside proof, which pinned a shape production never emits (and hid the
  // fact that the page never carried the digest at all).
  const ITEM_OBJECT_ID = '0x' + 'de'.repeat(32);
  const authorProof = {
    type: 'eip712' as const,
    signer: '0x9999999999999999999999999999999999999999',
    signature: '0xsig',
  };

  it('nests the author EIP-712 proof on the author node', async () => {
    const { schema } = await render(
      contentInfo({
        objectId: ITEM_OBJECT_ID,
        author: {
          address: '0x1111111111111111111111111111111111111111',
          createdAt: '2025-01-02T03:04:05.000Z',
          proof: authorProof,
        },
      }),
    );
    expect(schema.author.proof).toEqual({
      type: 'eip712',
      objectId: ITEM_OBJECT_ID,
      signer: authorProof.signer,
      signature: authorProof.signature,
    });
    // The term names what the value is; the value is the bare address.
    expect(schema.author.identifier).toEqual({
      '@type': 'PropertyValue',
      propertyID: 'address',
      value: '0x1111111111111111111111111111111111111111',
    });
  });

  it('writes author and publisher as bare addresses under the address terms', async () => {
    // A pre-change identity arrives prefixed and checksummed; the page value is
    // the address, not the form it was pinned in.
    const { schema } = await render(
      contentInfo({
        author: {
          address: `${LEGACY_AUTHOR_PREFIX}0xAbCdEf0123456789012345678901234567890123`,
          createdAt: '2025-01-02T03:04:05.000Z',
        },
      }),
    );
    expect(schema.author.identifier).toEqual({
      '@type': 'PropertyValue',
      propertyID: 'address',
      value: '0xabcdef0123456789012345678901234567890123',
    });
    expect(schema.publisher.identifier[0]).toEqual({
      '@type': 'PropertyValue',
      propertyID: 'address',
      value: '0x2222222222222222222222222222222222222222',
    });
  });

  it('lets the page carry the item digest even without a proof.objectId', async () => {
    // What render/main.ts hands over: proof from the item (no objectId) plus
    // the sibling objectId. A reader must be able to recover the digest.
    const { schema } = await render(
      contentInfo({
        objectId: ITEM_OBJECT_ID,
        author: { address: '0x1111111111111111111111111111111111111111', proof: authorProof },
      }),
    );
    expect(schema.author.proof.objectId).toBe(ITEM_OBJECT_ID);
  });

  it('omits the digest when neither the proof nor the item carries one', async () => {
    const { schema } = await render(
      contentInfo({
        author: { address: '0x1111111111111111111111111111111111111111', proof: authorProof },
      }),
    );
    expect(schema.author.proof).not.toHaveProperty('objectId');
  });

  it('leaves the top-level proof as the PKP DataIntegrityProof only', async () => {
    const { schema } = await render(
      contentInfo({
        author: {
          address: '0x1111111111111111111111111111111111111111',
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
    // One render, then remove the attestation from a copy: the payload must
    // move. (Two renders would differ in proof.created and prove nothing.)
    const { schema } = await render(
      contentInfo({ author: { address: '0x1111', proof: authorProof } }),
    );
    const before = payloadOf(schema);

    const stripped = JSON.parse(JSON.stringify(schema)) as JsonLd;
    delete stripped.author.proof;
    expect(payloadOf(stripped)).not.toBe(before);

    // Tampering with the attestation also moves it.
    const forged = JSON.parse(JSON.stringify(schema)) as JsonLd;
    forged.author.proof.signature = '0xdeadbeef';
    expect(payloadOf(forged)).not.toBe(before);
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

  it('injects the block outside the hashed region', async () => {
    const { html } = await render(contentInfo());
    // Same extraction on the way in and on the way out.
    expect(extractHashableHtml(html)).toBe(extractHashableHtml(PAGE));
    expect(extractHashableHtml(html)).not.toContain('application/ld+json');
  });

  it('still emits a signed block when an optional field is undefined at runtime', async () => {
    // JCS throws on undefined where JSON.stringify drops it: before the strip,
    // this produced a page with NO JSON-LD at all (un-updatable forever).
    const { schema } = await render(
      contentInfo({
        isBasedOn: {
          genesis: '0x' + '44'.repeat(32),
          timestamp: '2025-01-01T00:00:00.000Z',
        } as unknown as S2SContentInfo['isBasedOn'],
      }),
    );
    expect(schema.proof.proofValue).toMatch(/^0x[0-9a-f]+$/i);
    expect(schema.isBasedOn).toEqual({
      '@type': 'CreativeWork',
      identifier: '0x' + '44'.repeat(32),
      dateModified: '2025-01-01T00:00:00.000Z',
    });
    expect(recover(payloadOf(schema), schema.proof.proofValue)).toBe(PKP);
  });

  it('hashes exactly the region the verifier will re-derive, with no <html> tag', async () => {
    const fragment = `<div>no html tag here</div>`;
    const { html, schema } = await render(contentInfo(), fragment);
    expect(schema.encoding.sha256).toBe(sha256Of(fragment));
    expect(extractHashableHtml(html)).toBe(fragment);
    expect(recover(payloadOf(schema), schema.proof.proofValue)).toBe(PKP);
  });
});

describe('addAndSignMetadata — the two signed dates', () => {
  it('page dateCreated is creationDate (genesis), dateModified is modifiedDate (this version)', async () => {
    const { schema } = await render(
      contentInfo({ creationDate: '1600000000', modifiedDate: '1700000100' }),
    );

    // Unix-second strings, as the rest of the block uses them.
    expect(schema.dateCreated).toBe('1600000000');
    expect(schema.dateModified).toBe('1700000100');
    // The author node keeps its own dateCreated (the genesis signing time).
    expect(schema.author.dateCreated).toBe('2025-01-02T03:04:05.000Z');
  });

  it('a v1 item, whose two dates are equal, emits them equal', async () => {
    const { schema } = await render(
      contentInfo({ creationDate: '1700000000', modifiedDate: '1700000000' }),
    );
    expect(schema.dateCreated).toBe('1700000000');
    expect(schema.dateModified).toBe('1700000000');
  });

  it('omits both when the envelope carries no dates', async () => {
    const { schema } = await render(contentInfo());
    expect(schema.dateCreated).toBeUndefined();
    expect(schema.dateModified).toBeUndefined();
  });

  it('signs the dates INTO the payload, so a later edit to either breaks the proof', async () => {
    const { schema } = await render(
      contentInfo({ creationDate: '1600000000', modifiedDate: '1700000100' }),
    );

    // The signed bytes must contain both dates, not just the emitted page.
    const payload = payloadOf(schema);
    expect(payload).toContain('1600000000');
    expect(payload).toContain('1700000100');
    expect(recover(payload, schema.proof.proofValue)).toBe(PKP);

    // Editing dateModified after signing invalidates the proof: this fails if
    // the dates ever leave the canonical payload.
    const tampered = { ...schema, dateModified: '1800000000' };
    expect(recover(payloadOf(tampered), schema.proof.proofValue)).not.toBe(PKP);
  });

  it('leaves isBasedOn.dateModified as the parent timestamp', async () => {
    const { schema } = await render(
      contentInfo({
        creationDate: '1600000000',
        modifiedDate: '1700000100',
        isBasedOn: {
          genesis: '0x' + '44'.repeat(32),
          contentHash: 'aa',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
      }),
    );
    expect(schema.isBasedOn.dateModified).toBe('2025-01-01T00:00:00.000Z');
  });
});
