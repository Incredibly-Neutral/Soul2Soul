/**
 * Unit tests — revokeContent (src/publication/revoke.ts).
 *
 * Sequence under test: service.retract(genesis) FIRST → derive the remove
 * path (on-chain localePaths when readable, legacy scheme otherwise) → re-render
 * the revoked id via renderCalls with the remove entry. Never calls makeOffer /
 * publishContent for the revoked item.
 *
 * The on-chain retract and the localePaths read are fully mocked. renderCalls
 * is stubbed via vi.mock — the real one needs DOM + Lit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { SpyNotice } = vi.hoisted(() => {
	class SpyNotice {
		static messages: string[] = [];
		static reset() {
			SpyNotice.messages = [];
		}
		constructor(msg?: string, _timeout?: number) {
			if (msg) SpyNotice.messages.push(msg);
		}
		setMessage(_m: string) {}
		hide() {}
	}
	return { SpyNotice };
});

vi.mock('obsidian', () => ({ Notice: SpyNotice, TFile: class TFile {} }));
vi.mock('../../src/render/render.helper', () => ({ renderCalls: vi.fn() }));

import { revokeContent, revokedPathFor } from '../../src/publication/revoke';
import { renderCalls } from '../../src/render/render.helper';
import { makeMain, makeVaultFile } from '../helpers/main';

const GENESIS = '0x' + '4'.repeat(64);
const MODULE_RECORDS = '0x' + 'a'.repeat(40);
const PUBLICATION = 'acme.soul2soul.eth';

type Service = { retract: ReturnType<typeof vi.fn>; configModule?: string };

function makeRevokeMain(overrides: { service?: Partial<Service> } = {}) {
	const main = makeMain();
	main.content.parseNote = vi.fn(async () => ({
		slug: 'my-post',
		locale: 'en',
		contentId: GENESIS,
	}));
	main.content.publishContent = vi.fn(async () => ({ objectId: GENESIS }));
	main.plugin.app.metadataCache.getFileCache = vi.fn(() => ({
		frontmatter: { genesis: GENESIS },
	}));
	const service: Service = {
		retract: vi.fn(async () => '0xtx'),
		configModule: MODULE_RECORDS,
		...overrides.service,
	};
	main.getInitializedService = vi.fn(async () => service as any);
	main.oxo.ctrlr.viem.read = vi.fn(async () => 'QmConfigCid');
	main.oxo.ctrlr.ipfs = {
		getJsonLike: vi.fn(async () => ({ localePaths: { default: '', en: '/en' } })),
	};
	return { main, service };
}

describe('revokeContent', () => {
	beforeEach(() => {
		SpyNotice.reset();
		vi.clearAllMocks();
	});

	it('retracts on-chain first, then re-renders the revoked id with the locale-prefixed remove path', async () => {
		const { main, service } = makeRevokeMain();
		const file = makeVaultFile('my-post.md', '');

		await revokeContent(main, file, PUBLICATION);

		// Service resolved for the subdomain; genesis comes from frontmatter.
		expect(main.getInitializedService).toHaveBeenCalledWith('acme');
		expect(service.retract).toHaveBeenCalledWith(GENESIS);

		// On-chain localePaths read for the exact remove path.
		expect(main.oxo.ctrlr.viem.read).toHaveBeenCalledWith(
			MODULE_RECORDS,
			expect.any(Array),
			'getRecord',
			['config'],
		);
		expect(main.oxo.ctrlr.ipfs.getJsonLike).toHaveBeenCalledWith(
			'QmConfigCid',
			'https://ipfs.transport-union.dev',
		);

		// Render the REVOKED id itself with the remove entry.
		expect(renderCalls).toHaveBeenCalledWith(
			main,
			PUBLICATION,
			[GENESIS],
			'test-lit-usage-key',
			true,
			[{ path: '/en/my-post' }],
		);

		// Two user-facing Notices (completion + re-render).
		expect(SpyNotice.messages).toHaveLength(2);
		expect(SpyNotice.messages[0]).toContain(`Revoked 'my-post' from ${PUBLICATION}`);
		expect(SpyNotice.messages[1]).toContain(`Revoked 'my-post' from ${PUBLICATION}`);

		// Never re-adds the deal: no publishContent / makeOffer for the item.
		expect(main.content.publishContent).not.toHaveBeenCalled();
	});

	it('falls back to the note contentId as genesis when frontmatter has none', async () => {
		const { main, service } = makeRevokeMain();
		main.plugin.app.metadataCache.getFileCache = vi.fn(() => ({ frontmatter: {} }));

		await revokeContent(main, makeVaultFile('my-post.md', ''), PUBLICATION);

		expect(service.retract).toHaveBeenCalledWith(GENESIS);
		// parseNote called once for slug/locale and again inside resolveGenesis.
		expect(main.content.parseNote).toHaveBeenCalledTimes(2);
	});

	it('uses the subdomain as genesis when neither frontmatter nor contentId is available', async () => {
		const { main, service } = makeRevokeMain();
		main.plugin.app.metadataCache.getFileCache = vi.fn(() => ({ frontmatter: {} }));
		main.content.parseNote = vi.fn(async () => ({
			slug: 'my-post',
			locale: 'en',
			contentId: undefined,
		}));

		await revokeContent(main, makeVaultFile('my-post.md', ''), PUBLICATION);

		expect(service.retract).toHaveBeenCalledWith('acme');
	});

	it('NOT-ELIGIBLE PATH: falls back to the legacy path scheme when the records module is unavailable', async () => {
		// No configModule on the service → on-chain localePaths can't be read →
		// legacy scheme (`/<locale>/<slug>`), but the retract + re-render still run.
		const { main, service } = makeRevokeMain({ service: { configModule: undefined } });

		await revokeContent(main, makeVaultFile('my-post.md', ''), PUBLICATION);

		expect(service.retract).toHaveBeenCalledWith(GENESIS);
		expect(main.oxo.ctrlr.viem.read).not.toHaveBeenCalled();
		expect(renderCalls).toHaveBeenCalledWith(
			main,
			PUBLICATION,
			[GENESIS],
			'test-lit-usage-key',
			true,
			[{ path: '/en/my-post' }],
		);
	});

	it('NOT-ELIGIBLE PATH: falls back to the legacy scheme when the config record is empty', async () => {
		const { main, service } = makeRevokeMain();
		main.oxo.ctrlr.viem.read = vi.fn(async () => null); // getRecord('config') → null

		await revokeContent(main, makeVaultFile('my-post.md', ''), PUBLICATION);

		expect(service.retract).toHaveBeenCalledWith(GENESIS);
		expect(renderCalls).toHaveBeenCalledWith(
			main,
			PUBLICATION,
			[GENESIS],
			'test-lit-usage-key',
			true,
			[{ path: '/en/my-post' }],
		);
	});

	it('NOT-ELIGIBLE PATH: falls back when the on-chain config is an ipfs error envelope', async () => {
		const { main, service } = makeRevokeMain();
		main.oxo.ctrlr.ipfs.getJsonLike = vi.fn(async () => ({ Type: 'error', Message: 'nope' }));

		await revokeContent(main, makeVaultFile('my-post.md', ''), PUBLICATION);

		expect(service.retract).toHaveBeenCalledWith(GENESIS);
		expect(renderCalls).toHaveBeenCalledWith(
			main,
			PUBLICATION,
			[GENESIS],
			'test-lit-usage-key',
			true,
			[{ path: '/en/my-post' }],
		);
	});

	it('propagates on-chain retract failures (does not attempt the re-render)', async () => {
		const { main, service } = makeRevokeMain();
		service.retract.mockRejectedValue(new Error('retract reverted'));

		await expect(revokeContent(main, makeVaultFile('my-post.md', ''), PUBLICATION)).rejects.toThrow(
			'retract reverted',
		);
		expect(renderCalls).not.toHaveBeenCalled();
	});
});

describe('revokedPathFor (pure path derivation)', () => {
	it('uses localePaths prefix exactly when provided', () => {
		const localePaths = { default: '', en: '/en', fr: '/fr' };
		expect(revokedPathFor('hello', 'en', localePaths)).toBe('/en/hello');
		expect(revokedPathFor('hello', 'fr', localePaths)).toBe('/fr/hello');
		expect(revokedPathFor('hello', 'default', localePaths)).toBe('/hello');
	});

	it('a non-default locale mapped to an EMPTY prefix yields /<slug>, not /<locale>/<slug>', () => {
		const localePaths = { default: '', en: '' };
		expect(revokedPathFor('hello', 'en', localePaths)).toBe('/hello');
	});

	it('falls back to the legacy /<locale> prefix scheme without localePaths', () => {
		expect(revokedPathFor('hello', 'en')).toBe('/en/hello');
		expect(revokedPathFor('hello', 'default')).toBe('/hello');
		expect(revokedPathFor('hello')).toBe('/hello');
	});
});
