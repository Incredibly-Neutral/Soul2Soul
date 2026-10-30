import { describe, expect, it } from 'vitest';

import {
  S2S_ENS_SUFFIX,
  S2S_TAG_SUFFIX,
  ensNameFromTag,
  isS2sTag,
  publicationEnsFromTags,
  subdomainOf,
} from './tags';

describe('authoring/tags', () => {
  it('isS2sTag matches the --s2s suffix only', () => {
    expect(isS2sTag('acme--s2s')).toBe(true);
    expect(isS2sTag('acme')).toBe(false);
    expect(isS2sTag('acme-s2s')).toBe(false);
    expect(isS2sTag('--s2s')).toBe(true);
  });

  it('publicationEnsFromTags maps s2s tags to ENS names and drops the rest', () => {
    expect(
      publicationEnsFromTags(['acme--s2s', 'personal', 'notes', 'hello--s2s']),
    ).toEqual(['acme.soul2soul.eth', 'hello.soul2soul.eth']);
    expect(publicationEnsFromTags(['personal', 'notes'])).toEqual([]);
  });

  it('subdomainOf extracts the leftmost label', () => {
    expect(subdomainOf('acme.soul2soul.eth')).toBe('acme');
    expect(subdomainOf('a.b.c')).toBe('a');
  });

  it('ensNameFromTag lowercases and normalises the suffix', () => {
    expect(ensNameFromTag('MyPub--s2s')).toBe('mypub.soul2soul.eth');
    expect(ensNameFromTag('ACME' + S2S_TAG_SUFFIX)).toBe('acme' + S2S_ENS_SUFFIX);
  });
});
