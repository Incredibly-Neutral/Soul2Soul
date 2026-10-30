/**
 * Vitest wiring smoke test — proves the harness end-to-end:
 *   - vitest config + obsidian/electron alias mocks load,
 *   - the monorepo `@s2s/soul2soul-shared` CJS build resolves through modules,
 *   - `makeMain`/`makeVaultFile` helpers work against real source.
 *
 * Real unit suites live in test/content, test/publication, test/service and
 * test/render (written by the component test uplift). Keep this file small.
 */

import { describe, it, expect } from 'vitest';
import {
	isS2sTag,
	publicationEnsFromTags,
	subdomainOf,
	ensNameFromTag,
} from '../src/content/ens-tags';
import { ContentController } from '../src/content/content.ctrlr';
import { makeMain, makeVaultFile } from './helpers/main';

describe('vitest wiring smoke', () => {
	it('loads obsidian-stubbed source and runs pure helpers', () => {
		expect(isS2sTag('acme--s2s')).toBe(true);
		expect(isS2sTag('plain')).toBe(false);
		expect(publicationEnsFromTags(['a--s2s', 'b--s2s', 'plain'])).toEqual([
			'a.soul2soul.eth',
			'b.soul2soul.eth',
		]);
		expect(subdomainOf('acme.soul2soul.eth')).toBe('acme');
		expect(ensNameFromTag('MyPub--s2s')).toBe('mypub.soul2soul.eth');
	});

	it('parses a fixture note through ContentController against a stubbed main', async () => {
		const raw = `---\ntags: [foo, acme--s2s]\npost_type: note\nslug: my-slug\n---\n# My Title\n\nBody <!--more--> rest\n`;
		const main = makeMain();
		main.plugin.app.vault.read.mockResolvedValue(raw);
		main.plugin.app.metadataCache.getFileCache.mockReturnValue({
			frontmatter: { tags: ['foo', 'acme--s2s'], post_type: 'note', slug: 'my-slug' },
		});
		main.plugin.app.fileManager.processFrontMatter.mockImplementation(
			async (_f: any, fn: (fm: Record<string, any>) => void) => fn({}),
		);

		const ctrlr = new ContentController(main);
		const parsed = await ctrlr.parseNote(makeVaultFile('hello.md', raw));

		expect(parsed.slug).toBe('my-slug');
		expect(parsed.tags).toEqual(['foo', 'acme--s2s']);
		expect(parsed.title).toBe('My Title');
		expect(parsed.summary).toContain('Body');
	});
});
