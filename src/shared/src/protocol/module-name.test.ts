import { describe, it, expect } from 'vitest';
import { isPublicationModuleName, publicationModuleVersion } from './module-name';

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

// The version decides the ABI and the verbs a caller may send (V1 has no
// agreements surface, V2 has acceptOffer/retract, V3 has admit/reject), so the
// mapping back to a number has to be exact.
describe('publicationModuleVersion', () => {
  it('reads V1 as 1 and the suffix as the number', () => {
    expect(publicationModuleVersion('S2S Publication Module')).toBe(1);
    expect(publicationModuleVersion('S2S Publication Module V2')).toBe(2);
    expect(publicationModuleVersion('S2S Publication Module V3')).toBe(3);
    expect(publicationModuleVersion('S2S Publication Module V12')).toBe(12);
  });

  it('is undefined for anything that is not a publication module', () => {
    expect(publicationModuleVersion('S2S Records Module')).toBeUndefined();
    expect(publicationModuleVersion('S2S Publication Module V2 Factory')).toBeUndefined();
    expect(publicationModuleVersion('')).toBeUndefined();
    expect(publicationModuleVersion(undefined)).toBeUndefined();
    expect(publicationModuleVersion(null)).toBeUndefined();
  });
});
