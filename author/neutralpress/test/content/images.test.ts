/**
 * Unit tests for src/content/images.ts distributeImages.
 *
 * Focus:
 *   - plain-markdown HTML (no `<img>` tags) is a safe no-op — no pinata,
 *     no second vault.read, no vault.modify.
 *   - `file://` image sources are pushed to pinata and rewritten to the
 *     gateway `/ipfs/<cid>` URL; the file on disk is rewritten to markdown.
 *   - non-file:// sources are left alone (though the note still gets
 *     turndowned + rewritten because imgTags matched — see the remark).
 */

import { describe, it, expect } from 'vitest';
import { distributeImages } from '../../src/content/images';
import { makeMain, makeVaultFile } from '../helpers/main';

const GATEWAY = 'https://ipfs.transport-union.dev';

describe('distributeImages', () => {
	it('is a safe no-op for plain markdown HTML (no img tags)', async () => {
		const main = makeMain();
		const html = '<p>Just text, no images here.</p>';
		const file = makeVaultFile('note.md', 'Body');
		const out = await distributeImages(
			main as any,
			main.plugin.app,
			file,
			html,
			GATEWAY,
		);

		expect(out).toBe(html);
		expect(main.oxo.ctrlr.pinata.uploadFileFromPath).not.toHaveBeenCalled();
		expect(main.plugin.app.vault.read).not.toHaveBeenCalled();
		expect(main.plugin.app.vault.modify).not.toHaveBeenCalled();
	});

	it('rewrites a file:// image through pinata and rewrites the note to markdown', async () => {
		const main = makeMain();
		const raw = '---\ntags: []\n---\n![A photo](file:///vault/img/p.png)';
		main.plugin.app.vault.read.mockResolvedValue(raw);
		const file = makeVaultFile('note.md', raw);
		const html = '<p><img src="file:///vault/img/p.png" alt="A photo"></p>';

		const out = await distributeImages(
			main as any,
			main.plugin.app,
			file,
			html,
			GATEWAY,
		);

		// pinata was asked to upload the file:// path (scheme stripped) non-encrypted
		expect(main.oxo.ctrlr.pinata.uploadFileFromPath).toHaveBeenCalledTimes(1);
		expect(main.oxo.ctrlr.pinata.uploadFileFromPath).toHaveBeenCalledWith(
			'/vault/img/p.png',
			false,
		);

		// the returned html carries the gateway URL, no file:// remains
		expect(out).toContain(`${GATEWAY}/ipfs/QmStub`);
		expect(out).not.toContain('file://');

		// note rewritten to markdown, frontmatter preserved
		expect(main.plugin.app.vault.modify).toHaveBeenCalledTimes(1);
		const [modFile, modContent] = main.plugin.app.vault.modify.mock.calls[0];
		expect(modFile).toBe(file);
		expect(modContent.startsWith('---\ntags: []\n---\n')).toBe(true);
		expect(modContent).toContain(`![](${GATEWAY}/ipfs/QmStub)`);
	});

	// Documents current behavior: alt text is dropped because the extraction
	// regex (markdown `![alt](src)`) runs against the already-rendered HTML,
	// which never contains markdown image syntax.
	it('drops alt text when rewriting (extraction runs on rendered HTML)', async () => {
		const main = makeMain();
		const raw = '---\n---\n![A photo](file:///vault/img/p.png)';
		main.plugin.app.vault.read.mockResolvedValue(raw);
		const html = '<p><img src="file:///vault/img/p.png" alt="A photo"></p>';

		const out = await distributeImages(
			main as any,
			main.plugin.app,
			makeVaultFile('note.md', raw),
			html,
			GATEWAY,
		);
		expect(out).toBe('<img src="https://ipfs.transport-union.dev/ipfs/QmStub" alt="">');
	});

	it('handles multiple images and rewrites each file:// source', async () => {
		const main = makeMain();
		const raw = '---\n---\n![a](file:///a.png)\n![b](file:///b.png)';
		main.plugin.app.vault.read.mockResolvedValue(raw);
		const html =
			'<p><img src="file:///a.png" alt="A"></p>\n<p><img src="file:///b.png" alt="B"></p>';

		const out = await distributeImages(
			main as any,
			main.plugin.app,
			makeVaultFile('note.md', raw),
			html,
			GATEWAY,
		);

		expect(main.oxo.ctrlr.pinata.uploadFileFromPath).toHaveBeenCalledTimes(2);
		expect(main.oxo.ctrlr.pinata.uploadFileFromPath).toHaveBeenCalledWith('/a.png', false);
		expect(main.oxo.ctrlr.pinata.uploadFileFromPath).toHaveBeenCalledWith('/b.png', false);
		expect(out.match(/<img/g)?.length).toBe(2);
		expect(out).not.toContain('file://');
	});

	it('skips non-file:// sources (no pinata call) but still turndowns the note', async () => {
		const main = makeMain();
		const raw = 'Body text';
		main.plugin.app.vault.read.mockResolvedValue(raw);
		const html = '<p><img src="https://cdn.example/x.png" alt="X"></p>';

		const out = await distributeImages(
			main as any,
			main.plugin.app,
			makeVaultFile('note.md', raw),
			html,
			GATEWAY,
		);

		expect(main.oxo.ctrlr.pinata.uploadFileFromPath).not.toHaveBeenCalled();
		expect(out).toBe(html); // content untouched
		// but because imgTags matched, the file is still rewritten to markdown
		expect(main.plugin.app.vault.modify).toHaveBeenCalledTimes(1);
		const [, modContent] = main.plugin.app.vault.modify.mock.calls[0];
		expect(modContent).toContain('![X](https://cdn.example/x.png)');
	});

	it('rewrites without frontmatter prefix when the original has none', async () => {
		const main = makeMain();
		const raw = 'Body text';
		main.plugin.app.vault.read.mockResolvedValue(raw);
		const html = '<p><img src="file:///vault/img/p.png" alt=""></p>';

		await distributeImages(
			main as any,
			main.plugin.app,
			makeVaultFile('note.md', raw),
			html,
			GATEWAY,
		);

		const [, modContent] = main.plugin.app.vault.modify.mock.calls[0];
		expect(modContent.startsWith('---')).toBe(false);
		expect(modContent).toContain(`${GATEWAY}/ipfs/QmStub`);
	});
});
