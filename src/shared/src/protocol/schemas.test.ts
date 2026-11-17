import { describe, expect, it } from 'vitest';
import { manifestSchema } from './schemas';

/**
 * The document as the other worker writes it under the record keys `manifest`
 * and `manifest@x.y.z`. Optional action CIDs are absent, never ''.
 */
const DOCUMENT = {
  version: '2.1.0',
  gateway: 'https://ipfs.example',
  ensRegistry: '0x0000000000000000000000000000000000000001',
  ensRecords: '0x0000000000000000000000000000000000000002',
  publicationFactory: '0x0000000000000000000000000000000000000003',
  recordsFactory: '0x0000000000000000000000000000000000000004',
  pkp: '0x0000000000000000000000000000000000000005',
  litActions: { prep: 'cid-prep', render: 'cid-render', update: 'cid-update' },
};

describe('manifestSchema', () => {
  it('accepts the document with the optional actions omitted', () => {
    const parsed = manifestSchema.parse(DOCUMENT);
    expect(parsed.version).toBe('2.1.0');
    expect(parsed.litActions.maintainCache).toBeUndefined();
  });

  it('keeps the optional action CIDs when the document names them', () => {
    const parsed = manifestSchema.parse({
      ...DOCUMENT,
      litActions: {
        ...DOCUMENT.litActions,
        maintainCache: 'cid-cache',
        repointArchive: 'cid-repoint',
        encrypt: 'cid-encrypt',
        decrypt: 'cid-decrypt',
      },
    });
    expect(parsed.litActions).toEqual({
      prep: 'cid-prep',
      render: 'cid-render',
      update: 'cid-update',
      maintainCache: 'cid-cache',
      repointArchive: 'cid-repoint',
      encrypt: 'cid-encrypt',
      decrypt: 'cid-decrypt',
    });
  });

  it('requires a version of the form x.y.z', () => {
    for (const version of ['2.1', '2.1.0.1', 'v2.1.0', '', 'latest']) {
      expect(() => manifestSchema.parse({ ...DOCUMENT, version })).toThrow(/version/);
    }
  });

  it('requires the actions every render needs', () => {
    const { prep: _dropped, ...withoutPrep } = DOCUMENT.litActions;
    expect(() => manifestSchema.parse({ ...DOCUMENT, litActions: withoutPrep })).toThrow(/prep/);
  });

  it('rejects a document missing the publication factory', () => {
    const { publicationFactory: _dropped, ...withoutFactory } = DOCUMENT;
    expect(() => manifestSchema.parse(withoutFactory)).toThrow(/publicationFactory/);
  });
});
