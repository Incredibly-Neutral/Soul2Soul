import { describe, it, expect } from 'vitest';
import { validateConfig } from './validation';

const baseConfig = {
  assetsCid: 'QmAssets',
  contract: '0x1234',
  dataGateway: 'ipfs.mock',
  mapping: { templateConfig: [], ripples: [] },
  name: 'alice.soul2soul.eth',
  templateCid: 'QmTemplate',
};

describe('validateConfig — optional domain field', () => {
  it('accepts a config without a domain (backward compatible)', () => {
    expect(() => {
      validateConfig({ ...baseConfig });
    }).not.toThrow();
  });

  it('accepts a config with an optional domain string', () => {
    expect(() => {
      validateConfig({ ...baseConfig, domain: 'custom.soul2soul.eth' });
    }).not.toThrow();
  });

  it('rejects a non-string domain', () => {
    expect(() => {
      validateConfig({ ...baseConfig, domain: 123 as unknown as string });
    }).toThrow(/Invalid config structure/);
  });
});
