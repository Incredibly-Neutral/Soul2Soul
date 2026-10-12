/**
 * Unit tests for src/factories/note.factory.ts parseNote + slug.
 *
 * Covers the SPEC seam: the frontmatter `slug` override (used in preference
 * to slug(title)), the queryable/toEncrypt split shape, the skipDefault
 * custom bag, and a marked → turndown round-trip of the rendered body.
 *
 * `makeMain`'s `main.content` is replaced with an object that also provides
 * `updateFrontMatter` (the factory calls it directly — it is missing from
 * the shared fake).
 */

import { describe, it, expect, vi } from 'vitest';
import TurndownService from 'turndown';
import { parseNote, slug } from '../../src/factories/note.factory';
import { makeMain, makeVaultFile } from '../helpers/main';

function setupFactory(frontmatter: Record<string, any>, raw: string, name = 'note.md') {
	const main = makeMain();
	const sharedFm: Record<string, any> = { ...frontmatter };
	main.plugin.app.vault.read.mockResolvedValue(raw);
	main.plugin.app.metadataCache.getFileCache.mockReturnValue({ frontmatter: sharedFm });
	main.content = {
		updateFrontMatter: vi.fn(async () => {}),
		parseNote: vi.fn(async () => ({ tags: [] })),
	};
	const file = makeVaultFile(name, raw);
	return { main, file, sharedFm };
}

describe('note.factory.parseNote — slug override (SPEC seam)', () => {
	it('uses the frontmatter slug in preference to slug(title)', async () => {
		const { main, file } = setupFactory(
			{
				slug: 'custom-path',
				tags: ['acme--s2s', 'plain'],
				post_type: 'note',
				language: 'fr',
				parent: '2',
				position: '3',
				stream_id: 'stream-1',
				creation_date: '2026-10-12T10:00:00Z',
			},
			'---\n---\n# My Heading\n\nBody',
		);

		const result = await parseNote(main as any, file);

		expect(result.streamId).toBe('stream-1');
		expect(result.toEncrypt.slug).toBe('custom-path');
		expect(result.toEncrypt.title).toBe('My Heading');
		expect(result.toEncrypt.content).toContain('<p>Body</p>');
	});

	it('falls back to slug(title) when no slug override is set', async () => {
		const { main, file } = setupFactory(
			{ tags: ['x'], stream_id: 's' },
			'---\n---\n# My Heading\n\nBody',
		);
		const result = await parseNote(main as any, file);
		expect(result.toEncrypt.slug).toBe('my-heading');
		expect(result.toEncrypt.title).toBe('My Heading');
	});

	it('builds the queryable split (language/parent/position/publications/tags)', async () => {
		const { main, file } = setupFactory(
			{
				tags: ['acme--s2s', 'plain'],
				language: 'fr',
				parent: '2',
				position: '3',
				creation_date: '2026-10-12T10:00:00Z',
			},
			'---\n---\n# T\n\nBody',
		);
		const result = await parseNote(main as any, file);

		expect(result.queryable.language).toBe('fr');
		expect(result.queryable.parent).toBe(2);
		expect(result.queryable.position).toBe(3);
		expect(result.queryable.publications).toEqual(['acme.soul2soul.eth']);
		expect(result.queryable.tags).toEqual(['acme--s2s', 'plain']);
		expect(result.queryable.creation_date).toBe(1791799200);
	});

	it('applies factory defaults (locale nl, position 0, empty publications)', async () => {
		const { main, file, sharedFm } = setupFactory({}, '---\n---\nBody');
		const result = await parseNote(main as any, file);

		expect(result.streamId).toBeNull();
		expect(result.queryable.language).toBe('nl');
		expect(result.queryable.parent).toBe(0);
		expect(result.queryable.position).toBe(0);
		expect(result.queryable.publications).toEqual([]);
		expect(result.queryable.tags).toEqual([]);
		expect(result.queryable.post_type).toBeUndefined();
		// parseFrontmatter defaulted position to '0' on the shared frontmatter
		expect(sharedFm.position).toBe('0');
		expect(sharedFm.creation_date).toBeDefined();
		expect(sharedFm.modified_date).toBeDefined();
	});

	it('strips a dot from a multi-part file name for title/slug', async () => {
		const { main, file } = setupFactory(
			{ tags: [] },
			'---\n---\nJust body',
			'note.v2.md',
		);
		const result = await parseNote(main as any, file);
		expect(result.toEncrypt.title).toBe('note');
		expect(result.toEncrypt.slug).toBe('note');
	});
});

describe('note.factory.parseNote — custom bag (skipDefault)', () => {
	it('excludes managed keys and nulls from the serialized custom bag', async () => {
		const { main, file } = setupFactory(
			{
				slug: 'custom-path',
				my_flag: true,
				tags: ['x'],
				parent: '1',
				position: '1',
				stream_id: 's',
				post_type: 'note',
				creation_date: '2026-10-12T10:00:00Z',
			},
			'---\n---\n# T\n\nBody',
		);
		const result = await parseNote(main as any, file);
		expect(JSON.parse(result.toEncrypt.custom)).toEqual({
			slug: 'custom-path',
			my_flag: true,
		});
	});

	it('runs distributeImages as a no-op for plain markdown (no pinata writes)', async () => {
		const { main, file } = setupFactory(
			{ tags: [] },
			'---\n---\n# T\n\nBody with no images',
		);
		await parseNote(main as any, file);
		expect(main.oxo.ctrlr.pinata.uploadFileFromPath).not.toHaveBeenCalled();
		expect(main.plugin.app.vault.modify).not.toHaveBeenCalled();
	});
});

describe('note.factory — marked → turndown round-trip shape', () => {
	it('keeps inline markdown formatting through html and back', async () => {
		const { main, file } = setupFactory(
			{ tags: [] },
			'---\n---\n# Title\n\nhello **bold** and *italic*',
		);
		const result = await parseNote(main as any, file);

		// marked renders the body (heading stripped) to html
		expect(result.toEncrypt.content).toContain('<strong>bold</strong>');
		expect(result.toEncrypt.content).toContain('<em>italic</em>');

		// turndown round-trips it back to markdown preserving the formatting
		const back = new TurndownService().turndown(result.toEncrypt.content);
		expect(back).toContain('hello');
		expect(back).toContain('**bold**');
		expect(back).toContain('_italic_');
	});
});

describe('note.factory.slug (pure)', () => {
	it('lowercases, hyphenates and transliterates', () => {
		expect(slug('My Title')).toBe('my-title');
		expect(slug('Héllo Wörld')).toBe('hello-world');
	});
});
