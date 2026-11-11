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
import { parse, stringify } from 'yaml';
import { ContentController } from '../../src/content/content.ctrlr';
import { makeMain, makeVaultFile } from '../helpers/main';

// The writer hard-codes `noOpEncrypt`, so an encrypted publish cannot be reached
// through the controller: it is modelled at the signed item the write-back reads
// its flag from. Off by default, so the other tests see the real builder.
const signedItemFixture = vi.hoisted(() => ({ encrypted: false }));
vi.mock('@s2s/soul2soul-shared', async (importOriginal) => {
	const actual = await importOriginal<Record<string, any>>();
	return {
		...actual,
		buildSignedContentItem: async (...args: any[]) => {
			const item = await actual.buildSignedContentItem(...args);
			return signedItemFixture.encrypted ? { ...item, encryption: true } : item;
		},
	};
});

const ADDR = '0x111122223333444455556666777788889999AaaA';

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

/** Serialise frontmatter the way Obsidian does, then read it back. */
function yamlRoundTrip(frontmatter: Record<string, any>): Record<string, any> {
	return parse(stringify(frontmatter)) as Record<string, any>;
}

describe('ContentController.publishContent', () => {
	it('builds a signed content item and writes genesis/author to frontmatter', async () => {
		const { ctrlr, sharedFm, signTypedData } = setupPublish({}, RAW);
		const before = Math.floor(Date.now() / 1000);
		const result = await ctrlr.publishContent(
			makeVaultFile('note.md', RAW),
			'acme.soul2soul.eth',
		);
		const after = Math.floor(Date.now() / 1000);

		expect(result).not.toBeNull();
		expect(result!.objectId).toMatch(/^0x[0-9a-f]{64}$/);
		expect(result!.proof.signer).toBe(`0x${ADDR.replace('0x', '')}`);
		expect(result!.encryption).toBe(false); // noOpEncrypt used → not encrypted

		// public metadata
		expect(result!.public.author).toBe(ADDR);
		expect(result!.public.publication).toBe('acme.soul2soul.eth');
		expect(result!.public.mediaType).toBe('text/markdown');
		expect(result!.public.postType).toBe('post');
		expect(result!.public.parent).toBe('0');
		expect(result!.public.position).toBe('0');
		expect(result!.public.locale).toBe('en');
		expect(result!.public.specVersion).toBe('2');
		expect(result!.public.creationDate).toBeGreaterThanOrEqual(before);
		expect(result!.public.creationDate).toBeLessThanOrEqual(after);
		expect(result!.public.modifiedDate).toBeGreaterThanOrEqual(result!.public.creationDate);
		expect('createdAt' in result!.public).toBe(false);

		// body is the JSON string of {title, slug, content, custom}
		const body = JSON.parse(result!.body);
		expect(body.title).toBe('My Title');
		expect(body.slug).toBe('my-title');
		expect(body.content).toContain('rest');
		expect(body.custom.summary).toBe('<p>Body');

		// frontmatter genesis round-trip (genesis publish only)
		expect(sharedFm.genesis).toBe(result!.objectId);
		expect(sharedFm.author).toBe(ADDR);
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

	it('signs a revision with the note\'s creation_date, not now', async () => {
		const existing = '0x' + 'cd'.repeat(32);
		const { ctrlr } = setupPublish(
			{ genesis: existing, creation_date: '2021-03-04T05:06:07' },
			RAW,
		);
		const before = Math.floor(Date.now() / 1000);
		const result = await ctrlr.publishContent(
			makeVaultFile('note.md', RAW),
			'acme.soul2soul.eth',
		);
		const after = Math.floor(Date.now() / 1000);

		expect(result).not.toBeNull();
		expect(result!.objectId).toBe(existing);
		expect(result!.public.specVersion).toBe('2');
		// the note's own birth, not the publish time
		expect(result!.public.creationDate).toBe(Date.UTC(2021, 2, 4, 5, 6, 7) / 1000);
		expect(result!.public.modifiedDate).toBeGreaterThanOrEqual(before);
		expect(result!.public.modifiedDate).toBeLessThanOrEqual(after);
		expect(result!.public.modifiedDate).not.toBe(result!.public.creationDate);
	});

	it('signs one instant as both dates on a first publish', async () => {
		const { ctrlr } = setupPublish({}, RAW);
		const result = await ctrlr.publishContent(
			makeVaultFile('note.md', RAW),
			'acme.soul2soul.eth',
		);

		expect(result).not.toBeNull();
		expect(result!.public.creationDate).toBe(result!.public.modifiedDate);
	});

	it('records the signed birth, not a second clock sample taken during parse', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const T0 = 1_764_234_567;
			vi.setSystemTime(T0 * 1000);
			const { ctrlr, sharedFm, main } = setupPublish({}, RAW);
			// Move the clock while parseNote waits on the vault read: a write-back
			// that sampled its own `new Date()` would record T0 + 1.5s.
			main.plugin.app.vault.read.mockImplementation(async () => {
				vi.setSystemTime(T0 * 1000 + 1500);
				return RAW;
			});

			const result = await ctrlr.publishContent(
				makeVaultFile('note.md', RAW),
				'acme.soul2soul.eth',
			);

			expect(result).not.toBeNull();
			expect(result!.public.creationDate).toBe(T0);
			expect(result!.public.modifiedDate).toBe(T0);
			// creation_date is written as UTC with the zone stripped; append it
			// back so the comparison does not depend on the machine's zone.
			expect(sharedFm.creation_date).toBe('2025-11-27T09:09:27');
			expect(Date.parse(`${sharedFm.creation_date}Z`) / 1000).toBe(
				result!.public.creationDate,
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it('refuses an unparseable creation_date instead of re-birthing the note', async () => {
		const existing = '0x' + 'cd'.repeat(32);
		const { ctrlr } = setupPublish({ genesis: existing, creation_date: 'last tuesday' }, RAW);

		await expect(
			ctrlr.publishContent(makeVaultFile('note.md', RAW), 'acme.soul2soul.eth'),
		).rejects.toThrow(/not a date/);
	});

	it('writes encrypted: false for a plaintext publish, as a real boolean', async () => {
		const { ctrlr, sharedFm } = setupPublish({}, RAW);
		const result = await ctrlr.publishContent(
			makeVaultFile('note.md', RAW),
			'acme.soul2soul.eth',
		);

		expect(result!.encryption).toBe(false);
		expect(sharedFm.encrypted).toBe(false);
		expect(typeof sharedFm.encrypted).toBe('boolean');
		// Unquoted: a string 'false' is truthy and would encrypt the next publish.
		expect(stringify({ encrypted: sharedFm.encrypted }).trim()).toBe('encrypted: false');
		const reread = yamlRoundTrip(sharedFm);
		expect(reread.encrypted).toBe(false);
		expect(typeof reread.encrypted).toBe('boolean');
	});

	it('writes encrypted: true when the signed item is encrypted', async () => {
		signedItemFixture.encrypted = true;
		try {
			const { ctrlr, sharedFm } = setupPublish({}, RAW);
			const result = await ctrlr.publishContent(
				makeVaultFile('note.md', RAW),
				'acme.soul2soul.eth',
			);

			expect(result!.encryption).toBe(true);
			expect(sharedFm.encrypted).toBe(true);
			expect(typeof sharedFm.encrypted).toBe('boolean');
			expect(stringify({ encrypted: sharedFm.encrypted }).trim()).toBe('encrypted: true');
			const reread = yamlRoundTrip(sharedFm);
			expect(reread.encrypted).toBe(true);
			expect(typeof reread.encrypted).toBe('boolean');
		} finally {
			signedItemFixture.encrypted = false;
		}
	});

	it('records the signed state, not what the note asked for', async () => {
		// The note says encrypted, but this writer signs plaintext: the file
		// states what the publish produced.
		const { ctrlr, sharedFm } = setupPublish({ encrypted: true }, RAW);
		const result = await ctrlr.publishContent(
			makeVaultFile('note.md', RAW),
			'acme.soul2soul.eth',
		);

		expect(result!.encryption).toBe(false);
		expect(sharedFm.encrypted).toBe(false);
	});

	it('migrates a legacy encryption key on the next publish: one key, no legacy', async () => {
		const { ctrlr, sharedFm } = setupPublish({ encryption: true }, RAW);
		await ctrlr.publishContent(makeVaultFile('note.md', RAW), 'acme.soul2soul.eth');

		expect('encryption' in sharedFm).toBe(false);
		expect(sharedFm.encrypted).toBe(false); // noOpEncrypt: this publish was plaintext
		expect(Object.keys(sharedFm).filter((k) => k === 'encrypted')).toHaveLength(1);
	});

	it('does not duplicate the key on a second publish', async () => {
		const { ctrlr, sharedFm } = setupPublish({}, RAW);
		await ctrlr.publishContent(makeVaultFile('note.md', RAW), 'acme.soul2soul.eth');
		await ctrlr.publishContent(makeVaultFile('note.md', RAW), 'acme.soul2soul.eth');

		expect(Object.keys(sharedFm).filter((k) => k === 'encrypted')).toHaveLength(1);
		expect(sharedFm.encrypted).toBe(false);
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
