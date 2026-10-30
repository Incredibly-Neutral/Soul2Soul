/**
 * Unit tests for src/publication/intents.ts — the publication-intent runner.
 *
 * `publishToPublication` (./publish) and `revokeContent` (./revoke) drag in
 * render/obsidian machinery that isn't under test here, so both are mocked
 * and we assert only the dispatch wiring: which function runs for each
 * intent, with which file/publication/options.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/publication/publish', () => ({
	publishToPublication: vi.fn(async () => {}),
}));
vi.mock('../../src/publication/revoke', () => ({
	revokeContent: vi.fn(async () => {}),
}));

import { publishToPublication } from '../../src/publication/publish';
import { revokeContent } from '../../src/publication/revoke';
import {
	resolvePublicationsForFile,
	runIntent,
	uploadIntent,
	publishIntent,
	retractIntent,
} from '../../src/publication/intents';
import { makeMain } from '../helpers/main';

const mockedPublish = vi.mocked(publishToPublication);
const mockedRevoke = vi.mocked(revokeContent);

function noteTags(main: ReturnType<typeof makeMain>, tags: string[] | undefined) {
	main.content.parseNote.mockResolvedValue({ tags } as any);
	return main;
}

describe('resolvePublicationsForFile', () => {
	it('maps --s2s tags to publication ENS names', async () => {
		const main = noteTags(makeMain(), ['foo', 'acme--s2s', 'b--s2s']);
		const ens = await resolvePublicationsForFile(main, {} as any);
		expect(ens).toEqual(['acme.soul2soul.eth', 'b.soul2soul.eth']);
	});

	it('returns [] for a note with no --s2s tags', async () => {
		const main = noteTags(makeMain(), ['foo', 'bar']);
		expect(await resolvePublicationsForFile(main, {} as any)).toEqual([]);
	});

	it('returns [] when parseNote returns no tags (undefined)', async () => {
		const main = noteTags(makeMain(), undefined);
		expect(await resolvePublicationsForFile(main, {} as any)).toEqual([]);
	});
});

describe('runIntent dispatch', () => {
	beforeEach(() => {
		mockedPublish.mockClear();
		mockedRevoke.mockClear();
	});

	it('upload intent calls publishToPublication with { render: false }', async () => {
		const main = noteTags(makeMain(), ['acme--s2s']);
		await runIntent(main, { path: '/vault/note.md' } as any, 'upload');
		expect(mockedPublish).toHaveBeenCalledTimes(1);
		const [, file, publication, opts] = mockedPublish.mock.calls[0];
		expect(file.path).toBe('/vault/note.md');
		expect(publication).toBe('acme.soul2soul.eth');
		expect(opts).toEqual({ render: false });
		expect(mockedRevoke).not.toHaveBeenCalled();
	});

	it('publish intent with publish=true → { render: true, publish: true }', async () => {
		const main = noteTags(makeMain(), ['acme--s2s']);
		await runIntent(main, { path: '/vault/note.md' } as any, 'publish', true);
		expect(mockedPublish).toHaveBeenCalledTimes(1);
		expect(mockedPublish.mock.calls[0][3]).toEqual({ render: true, publish: true });
	});

	it('publish intent with publish=false → preview ({ publish: false })', async () => {
		const main = noteTags(makeMain(), ['acme--s2s']);
		await runIntent(main, { path: '/vault/note.md' } as any, 'publish');
		expect(mockedPublish).toHaveBeenCalledTimes(1);
		expect(mockedPublish.mock.calls[0][3]).toEqual({ render: true, publish: false });
	});

	it('retract intent calls revokeContent (never publishToPublication)', async () => {
		const main = noteTags(makeMain(), ['acme--s2s']);
		await runIntent(main, { path: '/vault/note.md' } as any, 'retract');
		expect(mockedRevoke).toHaveBeenCalledTimes(1);
		const [, file, publication] = mockedRevoke.mock.calls[0];
		expect(file.path).toBe('/vault/note.md');
		expect(publication).toBe('acme.soul2soul.eth');
		expect(mockedPublish).not.toHaveBeenCalled();
	});

	it('dispatches to every claimed publication', async () => {
		const main = noteTags(makeMain(), ['a--s2s', 'b--s2s']);
		await runIntent(main, { path: '/vault/note.md' } as any, 'upload');
		expect(mockedPublish).toHaveBeenCalledTimes(2);
		expect(mockedPublish.mock.calls.map((c) => c[2])).toEqual([
			'a.soul2soul.eth',
			'b.soul2soul.eth',
		]);
	});

	it('skips entirely when isValidForPublishing is false', async () => {
		const main = noteTags(makeMain(), ['acme--s2s']);
		main.isValidForPublishing.mockReturnValue(false);
		await runIntent(main, { path: '/vault/note.md' } as any, 'publish', true);
		expect(mockedPublish).not.toHaveBeenCalled();
		expect(mockedRevoke).not.toHaveBeenCalled();
	});

	it('skips entirely when the note has no --s2s tags', async () => {
		const main = noteTags(makeMain(), []);
		await runIntent(main, { path: '/vault/note.md' } as any, 'publish', true);
		expect(mockedPublish).not.toHaveBeenCalled();
		expect(mockedRevoke).not.toHaveBeenCalled();
	});

	it('resolves the file via vault.getFileByPath before dispatching', async () => {
		const main = noteTags(makeMain(), ['acme--s2s']);
		const getFileByPath = main.plugin.app.vault.getFileByPath;
		await runIntent(main, { path: '/vault/sub/note.md' } as any, 'upload');
		expect(getFileByPath).toHaveBeenCalledWith('/vault/sub/note.md');
	});
});

describe('single-purpose intent helpers', () => {
	beforeEach(() => {
		mockedPublish.mockClear();
		mockedRevoke.mockClear();
	});

	it('uploadIntent → publishToPublication with { render: false }', async () => {
		const main = makeMain();
		await uploadIntent(main, {} as any, 'acme.soul2soul.eth');
		expect(mockedPublish).toHaveBeenCalledWith(
			main,
			{},
			'acme.soul2soul.eth',
			{ render: false },
		);
	});

	it('publishIntent → publishToPublication with { render: true, publish }', async () => {
		const main = makeMain();
		await publishIntent(main, {} as any, 'acme.soul2soul.eth', true);
		expect(mockedPublish).toHaveBeenCalledWith(
			main,
			{},
			'acme.soul2soul.eth',
			{ render: true, publish: true },
		);
	});

	it('retractIntent → revokeContent', async () => {
		const main = makeMain();
		await retractIntent(main, {} as any, 'acme.soul2soul.eth');
		expect(mockedRevoke).toHaveBeenCalledWith(main, {}, 'acme.soul2soul.eth');
	});
});
