/**
 * JSON-LD schema shape helpers.
 *
 * Regression target: JCS throws on `undefined` while JSON.stringify drops it,
 * so one undefined optional field aborted signing, the renderer's catch-all
 * returned the page untouched, and the update gate could then only ever answer
 * "No JSON-LD schema found" — the page was permanently un-updatable.
 */
import { describe, it, expect } from 'vitest';
import { hasSpecV1Terms, stripUndefinedDeep } from './jsonld';
import { jcs } from '../manuscript/identity/jcs';

describe('stripUndefinedDeep', () => {
  it('drops undefined-valued keys and makes the JCS payload serialisable', () => {
    const schema = {
      '@type': 'Article',
      isBasedOn: { '@type': 'CreativeWork', identifier: '0x44', sha256: undefined },
      encoding: { '@type': 'MediaObject', sha256: 'aa' },
    };

    // The bug: no payload at all.
    expect(() => jcs(schema)).toThrow(/undefined/);

    const stripped = stripUndefinedDeep(schema);
    expect(jcs(stripped)).toBe(jcs(JSON.parse(JSON.stringify(schema))));
    expect(stripped.isBasedOn).toEqual({ '@type': 'CreativeWork', identifier: '0x44' });
  });

  it('preserves array length and order (no filtering of elements)', () => {
    const input = { list: [{ a: 1, b: undefined }, undefined, 'x', [{ c: undefined }]] };
    expect(stripUndefinedDeep(input)).toEqual({ list: [{ a: 1 }, undefined, 'x', [{}]] });
  });

  it('keeps null, false, 0 and the empty string (only undefined is dropped)', () => {
    const input = { a: null, b: false, c: 0, d: '', e: undefined };
    expect(stripUndefinedDeep(input)).toEqual({ a: null, b: false, c: 0, d: '' });
  });

  it('leaves a schema with no undefined values byte-identical under JCS', () => {
    const schema = { '@type': 'Article', identifier: '0x55', author: { '@type': 'Person' } };
    expect(jcs(stripUndefinedDeep(schema))).toBe(jcs(schema));
  });
});

describe('hasSpecV1Terms', () => {
  it('detects the sdContent node', () => {
    expect(hasSpecV1Terms({ identifier: '0x', sdContent: { identifier: '0xaa' } })).toBe(true);
  });

  it('detects a nested author.proof', () => {
    expect(hasSpecV1Terms({ author: { '@type': 'Person', proof: { signature: '0x' } } })).toBe(true);
  });

  it('is false for a marker-less page with no specVersion-1 terms', () => {
    expect(hasSpecV1Terms({ identifier: '0x', author: { '@type': 'Person', dateCreated: 'x' } })).toBe(
      false,
    );
    expect(hasSpecV1Terms({})).toBe(false);
    expect(hasSpecV1Terms(undefined)).toBe(false);
    expect(hasSpecV1Terms(null)).toBe(false);
  });
});
