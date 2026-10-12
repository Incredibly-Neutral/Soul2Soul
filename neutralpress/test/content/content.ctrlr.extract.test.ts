/**
 * Unit tests for the pure helpers on ContentController:
 *   - extractTitleAndBase  (title/body split, `.base` embed stripping)
 *   - slug                 (slugify wrapper)
 *
 * These are DOM-free and callable on a constructed controller — no vault,
 * no metadata cache, no marked/distributeImages involved.
 */

import { describe, it, expect } from 'vitest';
import { ContentController } from '../../src/content/content.ctrlr';
import { makeMain } from '../helpers/main';

const ctrl = () => new ContentController(makeMain() as any);

describe('ContentController.extractTitleAndBase', () => {
	it('splits a `# heading` title from the body after frontmatter', () => {
		const [content, title, base] = ctrl().extractTitleAndBase(
			'---\ntags: []\n---\n# My Heading\n\nBody text',
			'fallback',
		);
		expect(title).toBe('My Heading');
		expect(content).toBe('Body text');
		expect(base).toBeUndefined();
	});

	it('keeps the fallback title when the body has no heading', () => {
		const [content, title, base] = ctrl().extractTitleAndBase(
			'---\n---\nBody only',
			'from-file',
		);
		expect(title).toBe('from-file');
		expect(content).toBe('Body only');
		expect(base).toBeUndefined();
	});

	it('strips an embedded `![[name.base]]` and reports the base filename', () => {
		const [content, title, base] = ctrl().extractTitleAndBase(
			'---\n---\n![[data.base]]\n\n# T\n\nBody',
			'fallback',
		);
		expect(base).toBe('data.base');
		expect(title).toBe('T');
		expect(content).toBe('Body');
	});

	it('reports the full embed for `![[name.base.md]]`', () => {
		const [, , base] = ctrl().extractTitleAndBase(
			'---\n---\n![[tables.base.md]]\n\nBody',
			'fallback',
		);
		expect(base).toBe('tables.base.md');
	});

	it('returns empty content when the raw note has no frontmatter', () => {
		const [content, title] = ctrl().extractTitleAndBase(
			'plain body, no frontmatter',
			'file',
		);
		expect(content).toBe('');
		expect(title).toBe('file');
	});

	// Documents a known limitation: frontmatter is stripped with a naive
	// `split('---')[2]`, so a horizontal rule (`---`) inside the body
	// truncates the content at the third separator.
	it('truncates content at a `---` horizontal rule (naive split)', () => {
		const [content, title] = ctrl().extractTitleAndBase(
			'---\na: 1\n---\n# T\n\npara one\n\n---\n\npara two',
			'fallback',
		);
		expect(title).toBe('T');
		expect(content).toBe('para one');
	});
});

describe('ContentController.slug', () => {
	it('lowercases and hyphenates', () => {
		expect(ctrl().slug('My Title')).toBe('my-title');
	});

	it('transliterates unicode to ASCII via slugify', () => {
		expect(ctrl().slug('Héllo Wörld Crème')).toBe('hello-world-creme');
		expect(ctrl().slug('Café 100% #1!')).toBe('cafe-100percent-1');
	});

	it('strips punctuation and special characters', () => {
		expect(ctrl().slug('Hello, World! (v2)')).toBe('hello-world-v2');
		expect(ctrl().slug('Caps & Spaces')).toBe('caps-and-spaces');
	});

	it('collapses repeated dashes', () => {
		expect(ctrl().slug('a---b')).toBe('a-b');
	});

	it('handles empty input', () => {
		expect(ctrl().slug('')).toBe('');
	});
});
