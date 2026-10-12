/**
 * Unit tests for ContentController.publishContent (src/content/content.ctrlr.ts)
 * — the signing path that wraps parseNote output in a signed S2SContentItem
 * via @s2s/soul2soul-shared buildSignedContentItem and writes the genesis
 * back to frontmatter.
 *
 * No real wallet: `main.oxo.ctrlr.account.BASE.asTypedDataSigner` is stubbed
 * to a deterministic signer, and frontmatter writes flow through a shared
 * mutable object so we can assert the genesis/author round-trip.
 */

import { describe, it, expect, vi } from 'vitest';
import { ContentController } from '../../src/content/content.ctrlr';
import { makeMain, makeVaultFile } from '../helpers/main';

const ADDR = '0x111122223333444455556666777788889999AaaA';
const DID = `did:ethr:${ADDR}`;

function setupPublish(frontmatter: Record<string, any>, raw: string) {
	const main = makeMain();
	// Single shared frontmatter object: the cache hands it out AND
	// processFrontMatter mutates it, so writes are observable.
	const sharedFm: Record<string, any> = { ...frontmatter };
	main.plugin.app.vault.read.mockResolvedValue(raw);
	main.plugin.app.metadataCache.getFileCache.mockReturnValue({ frontmatter: sharedFm });
	main.plugin.app.fileManager.processFrontMatter.mockImplementation(
		async (_f: any, fn: (fm: Record<string, any>) => void) => fn(sharedFm),
	);

	const signTypedData = vi.fn(async () => '0x' + 'ab'.repeat(32));
	main.oxo.ctrlr.account['BASE'].address = ADDR;
	main.oxo.ctrlr.account['BASE'].asTypedDataSigner = () => ({
		signTypedData,
		getAddress: () => ADDR,
	});

	const ctrlr = new ContentController(main as any);
	return { main, ctrlr, sharedFm, signTypedData };
}

const RAW = '---\ntags: [acme--s2s]\n---\n# My Title\n\nBody <!--more--> rest';

describe('ContentController.publishContent', () => {
	it('builds a signed content item and writes genesis/author to frontmatter', async () => {
		const { ctrlr, sharedFm, signTypedData } = setupPublish({}, RAW);
		const result = await ctrlr.publishContent(
			makeVaultFile('note.md', RAW),
			'acme.soul2soul.eth',
		);

		expect(result).not.toBeNull();
		expect(result!.objectId).toMatch(/^0x[0-9a-f]{64}$/);
		expect(result!.proof.signer).toBe(`0x${ADDR.replace('0x', '')}`);
		expect(result!.encryption).toBe(false); // noOpEncrypt used → not encrypted

		// public metadata
		expect(result!.public.author).toBe(DID);
		expect(result!.public.publication).toBe('acme.soul2soul.eth');
		expect(result!.public.mediaType).toBe('text/markdown');
		expect(result!.public.postType).toBe('post');
		expect(result!.public.parent).toBe('0');
		expect(result!.public.position).toBe('0');
		expect(result!.public.locale).toBe('en');
		expect(result!.public.specVersion).toBe('1');
		expect(result!.public.createdAt).toBeGreaterThan(1_700_000_000);

		// body is the JSON string of {title, slug, content, custom}
		const body = JSON.parse(result!.body);
		expect(body.title).toBe('My Title');
		expect(body.slug).toBe('my-title');
		expect(body.content).toContain('rest');
		expect(body.custom.summary).toBe('<p>Body');

		// frontmatter genesis round-trip (genesis publish only)
		expect(sharedFm.genesis).toBe(result!.objectId);
		expect(sharedFm.author).toBe(DID);
		// modified_date from file.stat.mtime (makeVaultFile → 1700000000000)
		expect(sharedFm.modified_date).toBe('2023-11-14T22:13:20');

		// the signer was actually used for the EIP-712 signature
		expect(signTypedData).toHaveBeenCalledTimes(1);
	});

	it('preserves an existing genesis on re-publish (updates do not create new identity)', async () => {
		const existing = '0x' + 'cd'.repeat(32);
		const { ctrlr, sharedFm } = setupPublish({ genesis: existing }, RAW);
		const result = await ctrlr.publishContent(
			makeVaultFile('note.md', RAW),
			'acme.soul2soul.eth',
		);

		expect(result).not.toBeNull();
		expect(result!.objectId).toBe(existing);
		expect(sharedFm.genesis).toBe(existing); // untouched
		expect(sharedFm.author).toBeUndefined(); // not re-written
	});

	it('returns null when no BASE signer is available', async () => {
		const main = makeMain();
		main.oxo.ctrlr.account['BASE'] = { provider: {} }; // no signTypedData
		main.plugin.app.vault.read.mockResolvedValue(RAW);
		main.plugin.app.metadataCache.getFileCache.mockReturnValue({ frontmatter: {} });
		main.plugin.app.fileManager.processFrontMatter.mockImplementation(
			async (_f: any, fn: (fm: Record<string, any>) => void) => fn({}),
		);

		const ctrlr = new ContentController(main as any);
		const result = await ctrlr.publishContent(
			makeVaultFile('note.md', RAW),
			'acme.soul2soul.eth',
		);
		expect(result).toBeNull();
	});
});
