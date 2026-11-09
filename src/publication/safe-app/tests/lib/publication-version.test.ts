import { describe, expect, it } from 'vitest';
import { Abi_S2SPublicationModuleV2 } from '@s2s/publication-contracts/abis/S2SPublicationModuleV2';
import { Abi_S2SPublicationModuleV3 } from '@s2s/publication-contracts/abis/S2SPublicationModuleV3';
import { publicationBindingFor } from '../../src/lib/publication-version';

// The one place the app decides which verbs a publication module has. Every
// wrong answer here is a reverting transaction on a live publication, so the
// table is asserted in full rather than through the callers.
describe('publicationBindingFor', () => {
  it('binds V3 to admit/reject with the V3 ABI', () => {
    const b = publicationBindingFor('S2S Publication Module V3')!;
    expect(b.version).toBe(3);
    expect(b.abi).toBe(Abi_S2SPublicationModuleV3);
    expect(b.accept).toBe('admit');
    expect(b.reject).toBe('reject');
  });

  it('binds V2 to acceptOffer/retract with the V2 ABI', () => {
    const b = publicationBindingFor('S2S Publication Module V2')!;
    expect(b.version).toBe(2);
    expect(b.abi).toBe(Abi_S2SPublicationModuleV2);
    expect(b.accept).toBe('acceptOffer');
    expect(b.reject).toBe('retract');
  });

  it('binds nothing for V1 (bare name): it has no agreements surface', () => {
    expect(publicationBindingFor('S2S Publication Module')).toBeUndefined();
  });

  it('binds nothing for a non-publication name', () => {
    expect(publicationBindingFor('S2S Records Module')).toBeUndefined();
    expect(publicationBindingFor('')).toBeUndefined();
    expect(publicationBindingFor(undefined)).toBeUndefined();
    expect(publicationBindingFor(null)).toBeUndefined();
  });

  it('binds a later version to the current surface, and reports the module\'s own version', () => {
    const b = publicationBindingFor('S2S Publication Module V4')!;
    expect(b.version).toBe(4);
    expect(b.abi).toBe(Abi_S2SPublicationModuleV3);
    expect(b.accept).toBe('admit');
    expect(b.reject).toBe('reject');
  });
});
