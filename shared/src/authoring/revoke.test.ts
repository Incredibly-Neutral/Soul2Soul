import { describe, expect, it } from 'vitest';

import { revokedPathFor } from './revoke';

describe('authoring/revoke', () => {
  it('derives /<slug> when the locale is default and no map is present', () => {
    expect(revokedPathFor('hello-world', 'default')).toBe('/hello-world');
  });

  it('derives /<locale>/<slug> for a non-default locale without a map', () => {
    expect(revokedPathFor('hello-world', 'en')).toBe('/en/hello-world');
    expect(revokedPathFor('hello-world', 'fr')).toBe('/fr/hello-world');
  });

  it('honours the on-chain localePaths exactly, including empty prefixes', () => {
    expect(revokedPathFor('hello-world', 'fr', { default: '', fr: '/fr' })).toBe('/fr/hello-world');
    expect(revokedPathFor('hello-world', 'en', { default: '', en: '' })).toBe('/hello-world');
    expect(revokedPathFor('hello-world', 'fr', { default: '', fr: '' })).toBe('/hello-world');
  });
});
