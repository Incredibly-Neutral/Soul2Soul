/**
 * s2sContentItemSchema — three storage layouts, one union.
 *
 * A v1/v2 item carries a single `body` and parses as it always did. A v3 item
 * carries `bodies` keyed by key holder name and must be all strings. The union
 * is discriminated by which key is present, not by public.specVersion.
 */
import { describe, it, expect } from 'vitest';
import {
  s2sContentItemSchema,
  s2sContentItemSchemaV3,
  s2sPublicContentSchemaV1,
  s2sPublicContentSchemaV2,
} from './action-io';

const PUBLIC_V1 = {
  specVersion: '1',
  author: 'did:ethr:0x1111111111111111111111111111111111111111',
  postType: 'post',
  mediaType: 'text/markdown',
  parent: '',
  position: '',
  publication: 'example.eth',
  locale: 'en',
  createdAt: 1700000000,
  tags: ['a'],
  plaintextHash: `0x${'ab'.repeat(32)}`,
};

const PUBLIC_V2 = {
  specVersion: '2',
  author: 'did:ethr:0x1111111111111111111111111111111111111111',
  postType: 'post',
  mediaType: 'text/markdown',
  parent: '',
  position: '',
  publication: 'example.eth',
  locale: 'en',
  creationDate: 1700000000,
  modifiedDate: 1700000100,
  tags: ['a'],
  plaintextHash: `0x${'ab'.repeat(32)}`,
};

const PROOF = {
  type: 'eip712',
  signer: '0x1234567890123456789012345678901234567890',
  signature: `0x${'11'.repeat(65)}`,
};

const V1_ITEM = {
  public: PUBLIC_V1,
  objectId: `0x${'aa'.repeat(32)}`,
  proof: PROOF,
  encryption: false,
  body: '{"title":"v1"}',
};

const V2_ITEM = {
  public: PUBLIC_V2,
  objectId: `0x${'bb'.repeat(32)}`,
  proof: PROOF,
  encryption: true,
  body: 'ciphertext',
};

const V3_ITEM = {
  public: PUBLIC_V2,
  objectId: `0x${'cc'.repeat(32)}`,
  proof: PROOF,
  encryption: true,
  bodies: { s2s: 'ciphertext-for-s2s', 'pub.eth': 'ciphertext-for-pub' },
};

describe('s2sContentItemSchema accepts all three storage layouts', () => {
  it('accepts a v1 item with a single body', () => {
    expect(s2sContentItemSchema.safeParse(V1_ITEM).success).toBe(true);
  });

  it('accepts a v2 item with a single body', () => {
    expect(s2sContentItemSchema.safeParse(V2_ITEM).success).toBe(true);
  });

  it('accepts a v3 item with a per-key body map', () => {
    const parsed = s2sContentItemSchema.safeParse(V3_ITEM);
    expect(parsed.success).toBe(true);
    const bodies = parsed.success && 'bodies' in parsed.data ? parsed.data.bodies : undefined;
    expect(bodies).toEqual({
      s2s: 'ciphertext-for-s2s',
      'pub.eth': 'ciphertext-for-pub',
    });
  });

  it('accepts a v3 item holding only the protocol body', () => {
    const single = { ...V3_ITEM, bodies: { s2s: 'ciphertext' } };
    expect(s2sContentItemSchema.safeParse(single).success).toBe(true);
  });
});

describe('s2sContentItemSchema rejects an item carrying both layouts', () => {
  // The two branches strip each other's key, so whichever ran would silently
  // drop a body. Refusing is the only outcome that cannot lose a ciphertext.
  it('rejects a v3 item that also carries a body', () => {
    const both = { ...V3_ITEM, body: 'stale' };
    expect(s2sContentItemSchema.safeParse(both).success).toBe(false);
  });

  it('rejects a v1 public part carrying a body map beside a body', () => {
    // Without the guard this parsed as the body branch and the map was dropped:
    // the union hole ran the other way from the v3 branch.
    const v1WithMap = {
      public: PUBLIC_V1,
      objectId: `0x${'dd'.repeat(32)}`,
      proof: PROOF,
      encryption: false,
      body: 'b',
      bodies: { s2s: 'c' },
    };
    expect(s2sContentItemSchema.safeParse(v1WithMap).success).toBe(false);
  });
});

describe('s2sContentItemSchema rejects malformed items', () => {
  it('rejects a v3 item whose bodies holds a non-string', () => {
    const bad = { ...V3_ITEM, bodies: { s2s: 'ciphertext', 'pub.eth': 42 } };
    expect(s2sContentItemSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a v3 item whose bodies is not an object', () => {
    expect(s2sContentItemSchema.safeParse({ ...V3_ITEM, bodies: 'ciphertext' }).success).toBe(
      false,
    );
  });

  it('rejects a v3 item without bodies', () => {
    const { bodies: _bodies, ...noBodies } = V3_ITEM;
    expect(s2sContentItemSchema.safeParse(noBodies).success).toBe(false);
  });
});

describe('s2sContentItemSchemaV3', () => {
  it('pins the v2 public envelope', () => {
    const v1Public = { ...V3_ITEM, public: PUBLIC_V1 };
    expect(s2sContentItemSchemaV3.safeParse(V3_ITEM).success).toBe(true);
    expect(s2sContentItemSchemaV3.safeParse(v1Public).success).toBe(false);
  });

  it('requires objectId, proof and encryption', () => {
    const { objectId: _objectId, ...noObjectId } = V3_ITEM;
    const { proof: _proof, ...noProof } = V3_ITEM;
    const { encryption: _encryption, ...noEncryption } = V3_ITEM;

    expect(s2sContentItemSchemaV3.safeParse(V3_ITEM).success).toBe(true);
    expect(s2sContentItemSchemaV3.safeParse(noObjectId).success).toBe(false);
    expect(s2sContentItemSchemaV3.safeParse(noProof).success).toBe(false);
    expect(s2sContentItemSchemaV3.safeParse(noEncryption).success).toBe(false);
  });
});

describe('public content schemas are unchanged', () => {
  it('keeps v1 and v2 acceptance as before', () => {
    expect(s2sPublicContentSchemaV1.safeParse(PUBLIC_V1).success).toBe(true);
    expect(s2sPublicContentSchemaV2.safeParse(PUBLIC_V2).success).toBe(true);
    // v1 branch still refuses the v2 literal, and v2 pins it.
    expect(s2sPublicContentSchemaV1.safeParse(PUBLIC_V2).success).toBe(false);
    expect(s2sPublicContentSchemaV2.safeParse(PUBLIC_V1).success).toBe(false);
  });
});
