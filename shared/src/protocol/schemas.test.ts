import { describe, it, expect } from 'vitest';
import { collectionSchema, templateConfigSchema } from './schemas';

// ============================================================================
// Template-config schema validation — collection `sortBy`.
//
// zod strips UNKNOWN keys from object schemas by default (non-passthrough), so
// a published config's `sortBy` is only preserved through validation if it is
// DECLARED on the schema. These tests lock that contract in: the key must
// survive parse, and unsupported values must be rejected.
// ============================================================================

describe('collectionSchema / templateConfigSchema: sortBy', () => {
  it('preserves a collection sortBy through templateConfigSchema parse', () => {
    const result = templateConfigSchema.safeParse({
      reference: 'post',
      file: 'post',
      path: '/posts',
      collections: [{ slug: 'featured', filters: [{ featured: true }], sortBy: 'position' }],
    });
    expect(result.success).toBe(true);
    expect(result.data?.collections?.[0]?.sortBy).toBe('position');
    expect(result.data?.collections?.[0]?.slug).toBe('featured');
  });

  it('accepts every valid sortBy value through collectionSchema', () => {
    for (const sortBy of ['position', 'creationDate', 'modifiedDate', 'title']) {
      const result = collectionSchema.safeParse({ slug: 'x', sortBy });
      expect(result.success).toBe(true);
    }
  });

  it('is optional: a collection with no sortBy parses with sortBy undefined', () => {
    const result = collectionSchema.safeParse({ slug: 'x', filters: [] });
    expect(result.success).toBe(true);
    expect(result.data?.sortBy).toBeUndefined();
  });

  it('rejects an unsupported sortBy value', () => {
    const result = collectionSchema.safeParse({ slug: 'x', sortBy: 'weight' });
    expect(result.success).toBe(false);
  });

  it('drops undeclared keys on parse (documents why sortBy must be declared)', () => {
    // A random undeclared key is stripped by default (non-passthrough) —
    // this is exactly why `sortBy` must be declared on the schema.
    const result = collectionSchema.safeParse({ slug: 'x', unknownKey: 'boom', sortBy: 'title' });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('unknownKey');
    expect(result.data?.sortBy).toBe('title');
  });
});
