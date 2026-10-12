/**
 * Unit tests for src/publication/github.ts — GitHub helpers.
 *
 * Two I/O surfaces:
 *   - `getGitHubFiles` / `getAllFilesRecursive` use the global `fetch` (stubbed
 *     per-test with vi.stubGlobal).
 *   - `getLatestCommitSHA` / `fetchFileFromGithub` use obsidian's `requestUrl`
 *     (overridden in the vi.mock factory below; the rest of the stub is
 *     preserved via importOriginal).
 *
 * We assert URL construction, response parsing and failure behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('obsidian', async (importOriginal) => {
	const actual = await importOriginal<typeof import('obsidian')>();
	return { ...actual, requestUrl: vi.fn() };
});

import { requestUrl } from 'obsidian';
import {
	getGitHubFiles,
	getAllFilesRecursive,
	getLatestCommitSHA,
	fetchFileFromGithub,
} from '../../src/publication/github';

const mockedRequestUrl = vi.mocked(requestUrl);

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	// Mute the source's own console.error on the exercised error paths.
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
function stubFetchOnce(body: unknown, ok = true, statusText = 'OK') {
	const fn = vi.fn().mockResolvedValue({
		ok,
		statusText,
		json: async () => body,
	});
	vi.stubGlobal('fetch', fn);
	return fn;
}

afterEach(() => {
	vi.unstubAllGlobals();
	mockedRequestUrl.mockReset();
	errorSpy.mockRestore();
});

describe('getGitHubFiles', () => {
	it('builds the contents API URL and returns the parsed array', async () => {
		const fetchFn = stubFetchOnce([
			{ name: 'a.md', type: 'file', download_url: 'https://raw/a.md' },
		]);

		const files = await getGitHubFiles('acme', 'publisher', 'main', 'assets');

		expect(files).toHaveLength(1);
		expect(fetchFn).toHaveBeenCalledWith(
			'https://api.github.com/repos/acme/publisher/contents/assets?ref=main',
		);
	});

	it('uses the branch ref and empty path when path is omitted', async () => {
		const fetchFn = stubFetchOnce([]);
		await getGitHubFiles('acme', 'publisher', 'main');
		expect(fetchFn).toHaveBeenCalledWith(
			'https://api.github.com/repos/acme/publisher/contents/?ref=main',
		);
	});

	it('returns [] when the response is not an array', async () => {
		stubFetchOnce({ message: 'not a dir' });
		await expect(getGitHubFiles('acme', 'publisher', 'main')).resolves.toEqual([]);
	});

	it('throws GitHub API error on non-ok response', async () => {
		stubFetchOnce({}, false, 'Not Found');
		await expect(getGitHubFiles('acme', 'publisher', 'main')).rejects.toThrow(
			'GitHub API error: Not Found',
		);
	});

	it('propagates fetch failures', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net down')));
		await expect(getGitHubFiles('acme', 'publisher', 'main')).rejects.toThrow('net down');
	});
});

describe('getAllFilesRecursive', () => {
	it('flattens files and subdirectories, using download_url as url', async () => {
		// route by URL in a single fetch stub (the root call, then the subdir)
		const fetchFn = vi.fn(async (url: string) => {
			const body = url.includes('/contents/sub')
				? [
						{ name: 'b.md', type: 'file', path: 'sub/b.md', download_url: 'https://raw/sub/b.md' },
				  ]
				: [
						{ name: 'a.md', type: 'file', path: 'a.md', download_url: 'https://raw/a.md' },
						{ name: 'sub', type: 'dir', path: 'sub' },
				  ];
			return { ok: true, statusText: 'OK', json: async () => body };
		});
		vi.stubGlobal('fetch', fetchFn);

		const files = await getAllFilesRecursive('acme', 'publisher', 'main');

		expect(files.map((f) => f.path)).toEqual(['a.md', 'sub/b.md']);
		for (const f of files) {
			expect(f.url).toBe(f.download_url);
		}
		// root + subdir calls
		expect(fetchFn.mock.calls.map((c) => c[0])).toEqual([
			'https://api.github.com/repos/acme/publisher/contents/?ref=main',
			'https://api.github.com/repos/acme/publisher/contents/sub?ref=main',
		]);
	});

	it('returns [] for an empty directory tree', async () => {
		stubFetchOnce([]);
		await expect(getAllFilesRecursive('acme', 'publisher', 'main')).resolves.toEqual([]);
	});
});

describe('getLatestCommitSHA', () => {
	const publication = { devRepository: 'https://github.com/acme/publisher', branch: 'main' };

	it('extracts commit.sha from the requestUrl response', async () => {
		mockedRequestUrl.mockResolvedValue({
			text: JSON.stringify({ commit: { sha: 'abc123' } }),
		} as any);

		await expect(getLatestCommitSHA(publication)).resolves.toBe('abc123');

		expect(mockedRequestUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				url: 'https://api.github.com/repos/acme/publisher/branches/main',
				method: 'GET',
			}),
		);
	});

	it('returns null when requestUrl fails', async () => {
		mockedRequestUrl.mockRejectedValue(new Error('bad'));
		await expect(getLatestCommitSHA(publication)).resolves.toBeNull();
	});
});

describe('fetchFileFromGithub', () => {
	it('returns response.text for the raw URL', async () => {
		mockedRequestUrl.mockResolvedValue({ text: '<html>body</html>' } as any);
		await expect(fetchFileFromGithub('https://raw/.../file')).resolves.toBe(
			'<html>body</html>',
		);
		expect(mockedRequestUrl).toHaveBeenCalledWith(
			expect.objectContaining({ url: 'https://raw/.../file', method: 'GET' }),
		);
	});

	it('returns "" when requestUrl fails', async () => {
		mockedRequestUrl.mockRejectedValue(new Error('bad'));
		await expect(fetchFileFromGithub('https://raw/.../file')).resolves.toBe('');
	});
});
