/**
 * Unit tests for ContentController.parseNote (src/content/content.ctrlr.ts)
 * driven through the stubbed main (makeMain): vault.read + metadata cache
 * frontmatter → structured {contentId, postType, locale, tags, parent,
 * position, encryption, title, slug, content, summary, custom}.
 *
 * All fixtures here are plain markdown (no `<img>` tags) so distributeImages
 * is a guaranteed no-op and no vault/pinata writes happen.
 */

import { describe, it, expect } from 'vitest';
import { ContentController } from '../../src/content/content.ctrlr';
import { makeMain, makeVaultFile } from '../helpers/main';

function parse(raw: string, frontmatter: Record<string, any>, name = 'note.md') {
	const main = makeMain();
	main.plugin.app.vault.read.mockResolvedValue(raw);
	main.plugin.app.metadataCache.getFileCache.mockReturnValue({ frontmatter });
	main.plugin.app.fileManager.processFrontMatter.mockImplementation(
		async (_f: any, fn: (fm: Record<string, any>) => void) => fn({}),
	);
	const ctrlr = new ContentController(main as any);
	return ctrlr.parseNote(makeVaultFile(name, raw));
}

describe('ContentController.parseNote — title/slug/body', () => {
	it('extracts title from `# heading`, slug from title, summary from `<!--more-->`', async () => {
		const parsed = await parse(
			'---\ntags: [foo, acme--s2s]\n---\n# My Title\n\nBody <!--more--> rest',
			{ tags: ['foo', 'acme--s2s'] },
		);
		expect(parsed.title).toBe('My Title');
		expect(parsed.slug).toBe('my-title');
		// marked('Body <!--more--> rest') → '<p>Body <!--more--> rest</p>'
		expect(parsed.summary).toBe('<p>Body');
		expect(parsed.content).toContain('rest');
		expect(parsed.content).not.toContain('<!--more-->');
	});

	it('falls back to the file name for the title when there is no heading', async () => {
		const parsed = await parse(
			'---\ntags: []\n---\nJust body without heading',
			{ tags: [] },
			'my-file.md',
		);
		expect(parsed.title).toBe('my-file');
		expect(parsed.slug).toBe('my-file');
		expect(parsed.content).toBe('<p>Just body without heading</p>');
	});

	it('prefers the file name over frontmatter.title for the fallback title', async () => {
		const parsed = await parse(
			'---\ntitle: FM Title\n---\nBody',
			{ title: 'FM Title' },
			'file-name.md',
		);
		expect(parsed.title).toBe('file-name');
	});

	it('uses frontmatter.title when the file name is empty', async () => {
		const parsed = await parse('---\ntitle: FM Title\n---\nBody', {
			title: 'FM Title',
		}, '');
		expect(parsed.title).toBe('FM Title');
	});

	it('returns empty content for a note with no frontmatter delimiters', async () => {
		// raw has no `---` at all → split('---')[2] is undefined → content ''
		const parsed = await parse('# T\n\nBody', {});
		expect(parsed.title).toBe('note');
		expect(parsed.slug).toBe('note');
		expect(parsed.content).toBe('');
		expect(parsed.summary).toBeUndefined();
	});
});

describe('ContentController.parseNote — frontmatter-driven fields', () => {
	it('reads contentId, postType, locale, parent, position, encryption, slug override', async () => {
		const frontmatter = {
			content_id: '0xabc123',
			post_type: 'painting',
			language: 'de',
			parent: '5',
			position: '2',
			encryption: true,
			slug: 'custom-slug',
			tags: ['art'],
		};
		const parsed = await parse(
			'---\n' +
				Object.entries(frontmatter)
					.map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`)
					.join('\n') +
				'\n---\n# Title\n\nBody',
			frontmatter,
		);
		expect(parsed.contentId).toBe('0xabc123');
		expect(parsed.postType).toBe('painting');
		expect(parsed.locale).toBe('de');
		expect(parsed.parent).toBe(5);
		expect(parsed.position).toBe(2);
		expect(parsed.encryption).toBe(true);
		expect(parsed.slug).toBe('custom-slug');
		expect(parsed.tags).toEqual(['art']);
	});

	it('reads encrypted first, then the legacy encryption key', async () => {
		const encrypted = await parse('---\nencrypted: true\n---\n# T\n\nBody', {
			encrypted: true,
		});
		expect(encrypted.encryption).toBe(true);

		const legacy = await parse('---\nencryption: true\n---\n# T\n\nBody', {
			encryption: true,
		});
		expect(legacy.encryption).toBe(true);

		const legacyFalse = await parse('---\nencryption: false\n---\n# T\n\nBody', {
			encryption: false,
		});
		expect(legacyFalse.encryption).toBe(false);

		// The new key wins when a note somehow carries both.
		const both = await parse('---\nencrypted: false\nencryption: true\n---\n# T\n\nBody', {
			encrypted: false,
			encryption: true,
		});
		expect(both.encryption).toBe(false);
	});

	it('keeps both encryption keys out of the custom bag', async () => {
		const parsed = await parse('---\n---\n# T\n\nBody', {
			encrypted: true,
			encryption: false,
		});
		expect(parsed.custom).toEqual({});
	});

	it('applies defaults when frontmatter fields are absent', async () => {
		const parsed = await parse('---\ntags: []\n---\n# T\n\nBody', {
			tags: [],
		});
		expect(parsed.contentId).toBeNull();
		expect(parsed.postType).toBe('post');
		expect(parsed.locale).toBe('en');
		expect(parsed.parent).toBe(0);
		expect(parsed.position).toBe(0);
		expect(parsed.encryption).toBe(false);
	});

	it('deep-copies tags so callers cannot mutate the cache', async () => {
		const tags = ['a', 'b'];
		const parsed = await parse('---\ntags: []\n---\n# T\n\nBody', { tags });
		parsed.tags.push('mutated');
		expect(tags).toEqual(['a', 'b']);
	});
});

describe('ContentController.parseNote — custom bag', () => {
	it('collects unknown frontmatter keys into custom, excluding known keys', async () => {
		const parsed = await parse('---\n---\n# T\n\nBody', {
			my_custom: { nested: true },
			summary: 'fm summary',
			title: 'ignored-title', // known key → excluded
			tags: ['x'],
		});
		expect(parsed.custom).toEqual({
			my_custom: { nested: true },
			summary: 'fm summary',
		});
	});

	// slug is NOT in the knownKeys set, so a slug override leaks into the
	// custom bag alongside being used as the slug. Documents current behavior.
	it('includes slug in the custom bag because it is not a known key', async () => {
		const parsed = await parse(
			'---\nslug: my-path\n---\n# T\n\nBody',
			{ slug: 'my-path' },
		);
		expect(parsed.slug).toBe('my-path');
		expect(parsed.custom.slug).toBe('my-path');
	});

	it('excludes frontmatter-managed fields from the custom bag', async () => {
		const parsed = await parse('---\n---\n# T\n\nBody', {
			content_id: '0x1',
			post_type: 'note',
			language: 'fr',
			parent: '1',
			position: '1',
			encryption: false,
			genesis: '0x2',
			author: '0x3',
			modified_date: '2026-01-01T00:00:00',
			creation_date: '2026-01-01T00:00:00',
			tags: ['a'],
		});
		expect(parsed.custom).toEqual({});
	});
});

describe('ContentController.parseNote — summary splitting', () => {
	it('`<!--split-->` cuts content to everything after the split', async () => {
		const parsed = await parse(
			'---\ntags: []\n---\n# T\n\nA <!--split--> B',
			{ tags: [] },
		);
		// marked('A <!--split--> B') → '<p>A <!--split--> B</p>'
		expect(parsed.summary).toBe('<p>A');
		expect(parsed.content).toBe('B</p>');
		expect(parsed.content).not.toContain('<!--split-->');
	});

	it('keeps summary undefined when neither marker is present', async () => {
		const parsed = await parse('---\ntags: []\n---\n# T\n\nJust body', {
			tags: [],
		});
		expect(parsed.summary).toBeUndefined();
		expect(parsed.content).toBe('<p>Just body</p>');
	});
});

describe('ContentController.parseNote — markdown/html body variations', () => {
	it('renders plain markdown to HTML', async () => {
		const parsed = await parse(
			'---\ntags: []\n---\n# T\n\n- a\n- b',
			{ tags: [] },
		);
		expect(parsed.content).toContain('<ul>');
		expect(parsed.content).toContain('<li>a</li>');
		expect(parsed.content).toContain('<li>b</li>');
	});

	it('passes raw html blocks through and splits summaries around them', async () => {
		const parsed = await parse(
			'---\ntags: []\n---\n# T\n\n<div class="x">Hello</div> <!--more--> <b>bold</b>',
			{ tags: [] },
		);
		expect(parsed.summary).toBe('<div class="x">Hello</div>');
		expect(parsed.content).toContain('<div class="x">Hello</div>');
		expect(parsed.content).toContain('<b>bold</b>');
	});

	it('strips `.base` embeds from the content', async () => {
		const parsed = await parse(
			'---\ntags: []\n---\n![[data.base]]\n\n# T\n\nBody',
			{ tags: [] },
		);
		expect(parsed.title).toBe('T');
		expect(parsed.content).not.toContain('data.base');
		expect(parsed.content).not.toContain('[[');
	});
});
