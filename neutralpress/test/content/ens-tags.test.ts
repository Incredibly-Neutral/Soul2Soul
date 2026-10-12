/**
 * Unit tests for the pure ENS-tag helpers (src/content/ens-tags.ts).
 *
 * These map between a note's `--s2s` frontmatter tags and the publication
 * ENS name they target (`acme--s2s` ⇄ `acme.soul2soul.eth`). The smoke test
 * covers the happy path; this file pins down the edge cases.
 */

import { describe, it, expect } from 'vitest';
import {
	isS2sTag,
	publicationEnsFromTags,
	subdomainOf,
	ensNameFromTag,
	S2S_TAG_SUFFIX,
	S2S_ENS_SUFFIX,
} from '../../src/content/ens-tags';

describe('ens-tags: constants', () => {
	it('exposes the documented suffix constants', () => {
		expect(S2S_TAG_SUFFIX).toBe('--s2s');
		expect(S2S_ENS_SUFFIX).toBe('.soul2soul.eth');
	});
});

describe('isS2sTag', () => {
	it('accepts a plain `name--s2s` tag', () => {
		expect(isS2sTag('acme--s2s')).toBe(true);
	});

	it('rejects tags without the suffix', () => {
		expect(isS2sTag('plain')).toBe(false);
		expect(isS2sTag('acme')).toBe(false);
		expect(isS2sTag('acme--s2s-extra')).toBe(false);
		expect(isS2sTag('-s2s')).toBe(false);
	});

	it('is case-sensitive on the suffix (no normalisation)', () => {
		expect(isS2sTag('acme--S2S')).toBe(false);
		expect(isS2sTag('acme--S2s')).toBe(false);
	});

	it('accepts the bare suffix and rejects empty string', () => {
		expect(isS2sTag('--s2s')).toBe(true);
		expect(isS2sTag('')).toBe(false);
	});
});

describe('publicationEnsFromTags', () => {
	it('maps s2s tags to ENS names and drops everything else', () => {
		expect(
			publicationEnsFromTags(['acme--s2s', 'plain', 'beta--s2s']),
		).toEqual(['acme.soul2soul.eth', 'beta.soul2soul.eth']);
	});

	it('returns an empty array when nothing matches', () => {
		expect(publicationEnsFromTags([])).toEqual([]);
		expect(publicationEnsFromTags(['plain', 'x--nope'])).toEqual([]);
	});

	it('preserves the source casing of the tag (no lowercasing)', () => {
		expect(publicationEnsFromTags(['MyPub--s2s'])).toEqual([
			'MyPub.soul2soul.eth',
		]);
	});

	it('drops uppercase-suffix tags because the filter is case-sensitive', () => {
		expect(publicationEnsFromTags(['acme--S2S'])).toEqual([]);
	});
});

describe('subdomainOf', () => {
	it('extracts the leftmost label', () => {
		expect(subdomainOf('acme.soul2soul.eth')).toBe('acme');
		expect(subdomainOf('a.b.soul2soul.eth')).toBe('a');
	});

	it('works for arbitrary ENS shapes too', () => {
		expect(subdomainOf('acme.s2s.eth')).toBe('acme');
		expect(subdomainOf('soul2soul.eth')).toBe('soul2soul');
	});
});

describe('ensNameFromTag', () => {
	it('normalises a raw `--s2s` tag to a lowercase ENS name', () => {
		expect(ensNameFromTag('MyPub--s2s')).toBe('mypub.soul2soul.eth');
		expect(ensNameFromTag('acme--s2s')).toBe('acme.soul2soul.eth');
	});

	// NOTE: unlike isS2sTag/publicationEnsFromTags, this helper lowercases the
	// input first, so an uppercase suffix IS normalised here.
	it('normalises an uppercase suffix because it lowercases first', () => {
		expect(ensNameFromTag('MyPub--S2S')).toBe('mypub.soul2soul.eth');
	});

	it('blindly appends the ENS suffix to non-s2s tags', () => {
		expect(ensNameFromTag('plain')).toBe('plain.soul2soul.eth');
		expect(ensNameFromTag('')).toBe('.soul2soul.eth');
	});
});
