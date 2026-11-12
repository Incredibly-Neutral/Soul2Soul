/**
 * The public, unsigned `label` on the action-io schemas.
 *
 * A v2 item carrying `public.label` round-trips through s2sContentItemSchema,
 * with the label kept as given. An item without one parses as it always did, so
 * the field stays optional on the wire.
 */
import { describe, it, expect } from 'vitest';

import { s2sContentItemSchema, s2sPublicContentSchemaV2 } from './action-io';

const PUBLIC_V2 = {
  specVersion: '2',
  author: '0x1111111111111111111111111111111111111111',
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

interface ItemV3 {
  public: typeof PUBLIC_V2 & { label?: string };
  objectId: string;
  proof: typeof PROOF;
  encryption: boolean;
  bodies: Record<string, string>;
}

const ITEM_V3: ItemV3 = {
  public: { ...PUBLIC_V2, label: 'Field notes' },
  objectId: `0x${'aa'.repeat(32)}`,
  proof: PROOF,
  encryption: true,
  bodies: { s2s: 'ciphertext' },
};

/** The same item with no label on its public part. */
function unlabelled(): ItemV3 {
  const pub: ItemV3['public'] = { ...ITEM_V3.public };
  delete pub.label;
  return { ...ITEM_V3, public: pub };
}

/** The label a parsed item carries, read past the union of the two public parts. */
function labelOf(item: unknown): string | undefined {
  return (item as { public?: { label?: string } }).public?.label;
}

describe('label on the v2 public content schema', () => {
  it('parses a public part with a label and keeps it', () => {
    const parsed = s2sPublicContentSchemaV2.parse(ITEM_V3.public);

    expect(parsed.label).toBe('Field notes');
  });

  it('round-trips a v3 item carrying the label as given', () => {
    const parsed = s2sContentItemSchema.parse(ITEM_V3);

    expect(labelOf(parsed)).toBe('Field notes');
    expect(parsed.objectId).toBe(ITEM_V3.objectId);
    expect(labelOf(s2sContentItemSchema.parse(parsed))).toBe('Field notes');
  });

  it('parses an item without a label and invents nothing', () => {
    const parsed = s2sContentItemSchema.parse(unlabelled());

    expect(labelOf(parsed)).toBeUndefined();
    expect('label' in parsed.public).toBe(false);
  });
});
