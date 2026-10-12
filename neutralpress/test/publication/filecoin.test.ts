/**
 * Unit tests for src/publication/filecoin.ts — Kubo base URL normalisation and
 * the fire-and-forget Filecoin durability upload.
 *
 * `filecoinUploadBackground` never throws and never blocks: it wraps the
 * upload in an async IIFE that logs (and, on CID mismatch, raises a Notice).
 * We override the obsidian `Notice` stub so we can assert the mismatch notice
 * is actually constructed, and drive the background work to completion with
 * vi.waitFor.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { noticeMessages } = vi.hoisted(() => ({ noticeMessages: [] as string[] }));

vi.mock('obsidian', async (importOriginal) => {
	const actual = await importOriginal<typeof import('obsidian')>();
	return {
		...actual,
		Notice: class {
			noticeEl: any = {};
			setMessage = () => {};
			hide = () => {};
			constructor(message?: string, _timeout?: number) {
				noticeMessages.push(message ?? '');
			}
		},
	};
});

import { kuboBaseUrl, filecoinUploadBackground } from '../../src/publication/filecoin';
import { makeMain } from '../helpers/main';

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	// Fresh spy per test so console.error calls are captured and muted.
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	noticeMessages.length = 0;
});

afterEach(() => {
	errorSpy.mockRestore();
});

describe('kuboBaseUrl', () => {
	it('falls back to the transport-union default when kubo_url is unset', () => {
		const main = makeMain(); // oxo.settings.kubo_url is undefined
		expect(kuboBaseUrl(main)).toBe('https://ipfs.transport-union.dev');
	});

	it('keeps an already-schemed URL as-is', () => {
		const main = makeMain();
		main.oxo.settings.kubo_url = 'https://custom.ipfs.example';
		expect(kuboBaseUrl(main)).toBe('https://custom.ipfs.example');
	});

	it('prepends https:// to a bare host', () => {
		const main = makeMain();
		main.oxo.settings.kubo_url = 'custom.ipfs.example';
		expect(kuboBaseUrl(main)).toBe('https://custom.ipfs.example');
	});
});

describe('filecoinUploadBackground', () => {
	it('is fire-and-forget: returns synchronously and never throws on upload failure', () => {
		const main = makeMain();
		const upload = vi.fn(async () => {
			throw new Error('boom');
		});
		expect(() => filecoinUploadBackground(main, 'article', upload)).not.toThrow();
	});

	it('calls the upload closure once and stays quiet on success (CID parity)', async () => {
		const main = makeMain();
		const upload = vi.fn(async () => ({
			rootCid: '0xabc123',
			pieceCid: '',
			size: 0,
			complete: true,
			copies: [],
		}));

		filecoinUploadBackground(main, 'article', upload, '0xabc123');

		await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
		// small settle window for the post-upload branch
		await new Promise((r) => setTimeout(r, 5));
		expect(errorSpy).not.toHaveBeenCalled();
		expect(noticeMessages).toHaveLength(0);
	});

	it('raises a CID-mismatch notice and logs [cid-mismatch] when rootCid differs', async () => {
		const main = makeMain();
		const upload = vi.fn(async () => ({
			rootCid: '0xDIFFERENT',
			pieceCid: '',
			size: 0,
			complete: true,
			copies: [],
		}));

		filecoinUploadBackground(main, 'article', upload, '0xabc123');

		await vi.waitFor(() => expect(noticeMessages.length).toBe(1));
		expect(noticeMessages[0]).toContain('CID mismatch (article)');
		expect(noticeMessages[0]).toContain('0xabc123…');
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy.mock.calls[0][0]).toContain('[cid-mismatch] article');
	});

	it('logs a generic one-line failure when the upload rejects', async () => {
		const main = makeMain();
		const upload = vi.fn(async () => {
			throw new Error('kubo timeout');
		});

		filecoinUploadBackground(main, 'article', upload);

		await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1));
		expect(errorSpy.mock.calls[0][0]).toBe(
			'[filecoin] article background upload failed: kubo timeout',
		);
		expect(noticeMessages).toHaveLength(0);
	});

	it('uses the stable error name branch for FilecoinMinCopiesError', async () => {
		const main = makeMain();
		const upload = vi.fn(async () => {
			const err = new Error('only 1 of 2 copies');
			err.name = 'FilecoinMinCopiesError';
			throw err;
		});

		filecoinUploadBackground(main, 'article', upload);

		await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1));
		expect(errorSpy.mock.calls[0][0]).toBe(
			'[filecoin] article background upload failed: only 1 of 2 copies',
		);
	});

	it('does not raise a notice when expectedCid is undefined (pure fire-and-forget)', async () => {
		const main = makeMain();
		const upload = vi.fn(async () => ({
			rootCid: 'anything',
			pieceCid: '',
			size: 0,
			complete: true,
			copies: [],
		}));

		filecoinUploadBackground(main, 'article', upload);

		await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
		await new Promise((r) => setTimeout(r, 5));
		expect(noticeMessages).toHaveLength(0);
		expect(errorSpy).not.toHaveBeenCalled();
	});
});
