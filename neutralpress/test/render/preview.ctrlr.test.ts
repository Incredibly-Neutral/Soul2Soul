/**
 * Unit tests for src/preview.ctrlr.ts — the headless-testable seams only.
 *
 * Covered:
 *   - PreviewCtrlr.renderHTML: the requestUrl POST to the local preview
 *     server (URL/method/headers/body) + the error rethrow path.
 *   - PreviewCtrlr.injectStylesheet: the typography CDN skip, the CSS fetch
 *     + `<style>` injection into document.head, and the !ok / throw paths.
 *
 * Not covered (DOM/class-bound, documented):
 *   - HTMLView and PreviewCtrlr.display(): `display()` branches on
 *     `leaf.view instanceof HTMLView` and HTMLView is module-private (not
 *     exported), and it needs DOMParser/document plus workspace leaf state —
 *     untestable headlessly without exposing the class or a DOM shim.
 *   - The PreviewCtrlr constructor's registerView wiring is exercised
 *     implicitly (constructed in every test) but the view factory callback
 *     is not invoked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Swap requestUrl for a controllable spy (the stock stub ignores its arg and
// returns { json: {} }, which is not the shape renderHTML reads).
vi.mock('obsidian', async () => {
	const actual = await vi.importActual<typeof import('obsidian')>('obsidian');
	return { ...actual, requestUrl: vi.fn(async () => ({ text: '' })) };
});

import { requestUrl } from 'obsidian';
import { PreviewCtrlr } from '../../src/preview.ctrlr';
import { makeMain } from '../helpers/main';

function makePreviewMain() {
	const main = makeMain();
	(main.plugin as any).registerView = vi.fn();
	return main;
}

function makeCtrlr() {
	return new PreviewCtrlr(makePreviewMain() as any);
}

describe('PreviewCtrlr.renderHTML', () => {
	beforeEach(() => {
		(requestUrl as any).mockClear();
	});

	it('POSTs stream_id + publication to the local preview server and returns the text', async () => {
		(requestUrl as any).mockResolvedValue({ text: '<html><body>preview</body></html>' });

		const ctrlr = makeCtrlr();
		const html = await ctrlr.renderHTML('genesis-123', 'acme.soul2soul.eth');

		expect(html).toBe('<html><body>preview</body></html>');
		expect(requestUrl).toHaveBeenCalledTimes(1);
		expect(requestUrl).toHaveBeenCalledWith({
			url: 'http://localhost:3004/preview',
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				stream_id: 'genesis-123',
				publication: 'acme.soul2soul.eth',
			}),
		});
	});

	it('rethrows when the preview server request fails', async () => {
		(requestUrl as any).mockRejectedValue(new Error('ECONNREFUSED localhost:3004'));
		// renderHTML logs the error via console.error before rethrowing — expected
		// output from the code under test; keep the suite output clean.
		const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const ctrlr = makeCtrlr();
		await expect(ctrlr.renderHTML('s', 'p')).rejects.toThrow('ECONNREFUSED localhost:3004');
		expect(logSpy).toHaveBeenCalledWith('HTTP request error:', expect.any(Error));
		logSpy.mockRestore();
	});
});

describe('PreviewCtrlr.injectStylesheet', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('skips the Cloud Typography CDN entirely (no fetch, no injection)', async () => {
		const fetchSpy = vi.fn();
		const appendChild = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		vi.stubGlobal('document', { createElement: vi.fn(() => ({})), head: { appendChild } });
		const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const ctrlr = makeCtrlr();
		await ctrlr.injectStylesheet('https://cloud.typography.com/css/123456.css');

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(appendChild).not.toHaveBeenCalled();
		expect(logSpy).not.toHaveBeenCalled();
	});

	it('fetches the stylesheet and injects it as a <style> into document.head', async () => {
		const css = 'body{color:red} a{color:blue}';
		const styleTag = { textContent: '' };
		const appendChild = vi.fn();
		vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => css })));
		vi.stubGlobal('document', {
			createElement: vi.fn(() => styleTag),
			head: { appendChild },
		});

		const ctrlr = makeCtrlr();
		await ctrlr.injectStylesheet('https://cdn.example.com/site.css');

		expect(fetch).toHaveBeenCalledWith('https://cdn.example.com/site.css');
		expect(styleTag.textContent).toBe(css);
		expect(appendChild).toHaveBeenCalledWith(styleTag);
	});

	it('does not inject when the stylesheet fetch returns !ok', async () => {
		const appendChild = vi.fn();
		vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, statusText: '404' })));
		vi.stubGlobal('document', { createElement: vi.fn(() => ({})), head: { appendChild } });
		const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const ctrlr = makeCtrlr();
		await ctrlr.injectStylesheet('https://cdn.example.com/missing.css');

		expect(appendChild).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledWith('Failed to fetch stylesheet:', '404');
	});

	it('does not throw when the stylesheet fetch rejects', async () => {
		const appendChild = vi.fn();
		vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('network down'))));
		vi.stubGlobal('document', { createElement: vi.fn(() => ({})), head: { appendChild } });
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const ctrlr = makeCtrlr();
		await expect(ctrlr.injectStylesheet('https://cdn.example.com/site.css')).resolves.toBeUndefined();
		expect(appendChild).not.toHaveBeenCalled();
	});
});
