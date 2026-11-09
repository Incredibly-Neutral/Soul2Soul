import { describe, it, expect } from 'vitest';
import { isPublicationModuleName } from './module-name';

// The strings below are what the deployed implementations answer, read off
// NAME() in each contract (src/publication/contracts/src/S2SPublicationModule*.sol).
describe('isPublicationModuleName', () => {
  it('accepts V1, V2 and V3 — all three are live', () => {
    expect(isPublicationModuleName('S2S Publication Module')).toBe(true);
    expect(isPublicationModuleName('S2S Publication Module V2')).toBe(true);
    expect(isPublicationModuleName('S2S Publication Module V3')).toBe(true);
  });

  it('accepts a version the predicate has never seen, so V4 needs no code change', () => {
    expect(isPublicationModuleName('S2S Publication Module V4')).toBe(true);
    expect(isPublicationModuleName('S2S Publication Module V12')).toBe(true);
  });

  it('refuses the records module, which shares the S2S prefix', () => {
    expect(isPublicationModuleName('S2S Records Module')).toBe(false);
  });

  it('refuses near misses: no space before the version, factory suffix, other text', () => {
    expect(isPublicationModuleName('S2S Publication ModuleV2')).toBe(false);
    expect(isPublicationModuleName('S2S Publication Module V2 Factory')).toBe(false);
    expect(isPublicationModuleName('Publication Module V3')).toBe(false);
    expect(isPublicationModuleName('S2S Publication Module V')).toBe(false);
    expect(isPublicationModuleName('s2s publication module v3')).toBe(false);
  });

  it('refuses a module that answered nothing', () => {
    expect(isPublicationModuleName('')).toBe(false);
    expect(isPublicationModuleName(undefined)).toBe(false);
    expect(isPublicationModuleName(null)).toBe(false);
  });
});
