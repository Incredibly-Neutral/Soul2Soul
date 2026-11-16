import { describe, expect, it } from 'vitest';
import { protocolSchema } from './schemas';

const RECORD = {
  gateway: 'https://ipfs.example',
  ensRegistry: '0x0000000000000000000000000000000000000001',
  ensRecords: '0x0000000000000000000000000000000000000002',
  publicationFactory: '0x0000000000000000000000000000000000000003',
  recordsFactory: '0x0000000000000000000000000000000000000004',
  moduleFactory: '0x0000000000000000000000000000000000000005',
  pkp: '0x0000000000000000000000000000000000000006',
  litActions: { prep: 'cid-prep', render: 'cid-render', update: 'cid-update' },
};

describe('protocolSchema', () => {
  it('accepts a record that names the module factory', () => {
    expect(protocolSchema.parse(RECORD).moduleFactory).toBe(
      '0x0000000000000000000000000000000000000005',
    );
  });

  it('rejects a record that names no module factory', () => {
    const { moduleFactory: _dropped, ...withoutFactory } = RECORD;
    expect(() => protocolSchema.parse(withoutFactory)).toThrow(/moduleFactory/);
  });
});
