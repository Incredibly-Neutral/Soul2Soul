/**
 * Unit tests — publishToPublication (src/publication/publish.ts).
 *
 * Full pipeline: getInitializedService → publishContent (sign) → Kubo upload →
 * service.makeOffer → (render gate) → notice hide → fire-and-forget Filecoin
 * durability. Everything is mocked; no network/chain/DOM ever touched.
 *
 * renderCalls is stubbed via vi.mock (never the real one — it needs DOM +
 * Lit); ipfsFromSettings is stubbed to return a fake ipfs whose
 * backupToProviders is a shared spy (fire-and-forget would otherwise run a
 * real 4-way backup); kuboBaseUrl stays real (pure URL normalisation).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { SpyNotice, ipfsFromSettingsMock, backupToProvidersMock } = vi.hoisted(() => {
	class SpyNotice {
		static calls: string[] = [];
		static constructed: string[] = [];
		static reset() {
			SpyNotice.calls = [];
			SpyNotice.constructed = [];
		}
		constructor(msg?: string) {
			if (msg) SpyNotice.constructed.push(msg);
		}
		setMessage(m: string) {
			SpyNotice.calls.push(`setMessage:${m}`);
		}
		hide() {
			SpyNotice.calls.push('hide');
		}
	}
	return {
		SpyNotice,
		ipfsFromSettingsMock: vi.fn(),
		backupToProvidersMock: vi.fn(),
	};
});

vi.mock('obsidian', () => ({ Notice: SpyNotice, TFile: class TFile {} }));
vi.mock('../../src/render/render.helper', () => ({ renderCalls: vi.fn() }));
vi.mock('../../src/publication/filecoin', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	ipfsFromSettingsMock.mockReturnValue({ backupToProviders: backupToProvidersMock });
	return { ...actual, ipfsFromSettings: ipfsFromSettingsMock };
});

import { publishToPublication } from '../../src/publication/publish';
import { renderCalls } from '../../src/render/render.helper';
import { ipfsFromSettings, kuboBaseUrl } from '../../src/publication/filecoin';
import { runFilecoinLeg } from '@s2s/soul2soul-shared';
import { makeMain, makeVaultFile } from '../helpers/main';

const OBJECT_ID = '0x' + '3'.repeat(64);
const PUBLICATION = 'acme.soul2soul.eth';
const KUBO_URL = 'https://ipfs.transport-union.dev';

function makePublishMain() {
	const main = makeMain();
	const service = {
		makeOffer: vi.fn(async () => '0xappend'),
		getMultiSig: vi.fn(async () => '0xpub'),
	};
	main.content.publishContent = vi.fn(async () => ({ objectId: OBJECT_ID }));
	main.getInitializedService = vi.fn(async () => service);
	main.oxo.ctrlr.storage.uploadToKubo = vi.fn(async () => 'QmKuboCid');
	main.oxo.ctrlr.storage.uploadJson = vi.fn(async () => ({ rootCid: 'QmKuboCid' }));
	return { main, service };
}

describe('publishToPublication', () => {
	beforeEach(() => {
		SpyNotice.reset();
		vi.clearAllMocks();
	});

	it('runs the full pipeline and renders (render=true, default publish=false)', async () => {
		const { main, service } = makePublishMain();
		const file = makeVaultFile('post.md', '# hi');

		await publishToPublication(main, file, PUBLICATION);

		// Service resolved for the subdomain; notice swapped for a fresh instance.
		expect(main.getInitializedService).toHaveBeenCalledWith('acme');
		expect(main.notice).toBeInstanceOf(SpyNotice);

		// Sign, then upload to Kubo with the normalised gateway URL.
		expect(main.content.publishContent).toHaveBeenCalledWith(file, 'acme');
		expect(main.oxo.ctrlr.storage.uploadToKubo).toHaveBeenCalledWith(
			{ objectId: OBJECT_ID },
			KUBO_URL,
		);

		// On-chain append via service.makeOffer(objectId, kuboCid).
		expect(service.makeOffer).toHaveBeenCalledWith(OBJECT_ID, 'QmKuboCid');

		// Render gate (default opts.render=true, publish=false).
		expect(renderCalls).toHaveBeenCalledWith(
			main,
			PUBLICATION,
			[OBJECT_ID],
			'test-lit-usage-key',
			false,
		);

		// 4-way backup kicked off from the built client with the kubo cid.
		expect(ipfsFromSettings).toHaveBeenCalledWith(main);
		expect(backupToProvidersMock).toHaveBeenCalledWith(
			'QmKuboCid',
			expect.objectContaining({ filecoin: expect.any(Function) }),
		);

		// Notice lifecycle: 1/5 (ctor) → 2/5 → 3/5 → 4/5 → hide.
		expect(SpyNotice.calls).toEqual([
			'setMessage:2/5 storing content item on Filecoin ... ',
			'setMessage:3/5 appending version to publication contract ...',
			'setMessage:4/5 Authorizing ...',
			'hide',
		]);
	});

	it('preview (publish=false) skips the 4-way backup entirely', async () => {
		const { main, service } = makePublishMain();

		await publishToPublication(main, makeVaultFile('post.md', ''), PUBLICATION, {
			render: true,
			publish: false,
		});

		expect(service.makeOffer).toHaveBeenCalledWith(OBJECT_ID, 'QmKuboCid');
		expect(renderCalls).toHaveBeenCalledWith(
			main,
			PUBLICATION,
			[OBJECT_ID],
			'test-lit-usage-key',
			false,
		);
		expect(backupToProvidersMock).not.toHaveBeenCalled();
	});

	it('render=true, publish=true → renderCalls gets publish=true (prod update)', async () => {
		const { main } = makePublishMain();
		await publishToPublication(main, makeVaultFile('post.md', ''), PUBLICATION, {
			render: true,
			publish: true,
		});
		expect(renderCalls).toHaveBeenCalledWith(
			main,
			PUBLICATION,
			[OBJECT_ID],
			'test-lit-usage-key',
			true,
		);
	});

	it('render=false → upload path: skips renderCalls entirely, still appends + hides notice', async () => {
		const { main, service } = makePublishMain();
		const file = makeVaultFile('post.md', '');

		await publishToPublication(main, file, PUBLICATION, { render: false });

		expect(service.makeOffer).toHaveBeenCalledWith(OBJECT_ID, 'QmKuboCid');
		expect(renderCalls).not.toHaveBeenCalled();
		expect(main.notice).toBeInstanceOf(SpyNotice);
		expect(SpyNotice.calls).toEqual([
			'setMessage:2/5 storing content item on Filecoin ... ',
			'setMessage:3/5 appending version to publication contract ...',
			'hide',
		]);
		expect(backupToProvidersMock).toHaveBeenCalled();
	});

	it('aborts cleanly when signing produces no item (publishContent falsy)', async () => {
		const { main } = makePublishMain();
		main.content.publishContent = vi.fn(async () => null);

		await publishToPublication(main, makeVaultFile('post.md', ''), PUBLICATION);

		expect(main.oxo.ctrlr.storage.uploadToKubo).not.toHaveBeenCalled();
		expect(renderCalls).not.toHaveBeenCalled();
		expect(backupToProvidersMock).not.toHaveBeenCalled();
		// Notice hidden so '1/5…' never sticks.
		expect(SpyNotice.calls).toContain('hide');
	});

	it('propagates a failed makeOffer (on-chain append error)', async () => {
		const { main, service } = makePublishMain();
		service.makeOffer.mockRejectedValue(new Error('append reverted'));

		await expect(
			publishToPublication(main, makeVaultFile('post.md', ''), PUBLICATION),
		).rejects.toThrow('append reverted');
	});

	it('filecoin leg resolves and pins when storage is initialised', async () => {
		const { main } = makePublishMain();
		await publishToPublication(main, makeVaultFile('post.md', ''), PUBLICATION, {
			render: false,
		});

		const logSpy = vi.spyOn(console, 'log');
		const opts = backupToProvidersMock.mock.calls[0][1] as { filecoin: () => Promise<unknown> };
		await expect(opts.filecoin()).resolves.toMatchObject({ rootCid: 'QmKuboCid' });
		expect(main.oxo.ctrlr.storage.uploadJson).toHaveBeenCalledWith(
			{ objectId: OBJECT_ID },
			['0xpub', '0xEoa'],
			'article',
		);
		// The leg is now observable: it logs started + ok(rootCid) on success.
		expect(logSpy).toHaveBeenCalledWith('[filecoin] article: leg started');
		expect(logSpy).toHaveBeenCalledWith('[filecoin] article: leg ok, rootCid=QmKuboCid');
		logSpy.mockRestore();
		// No failure notice on the happy path.
		expect(SpyNotice.constructed.some((m) => m.includes('Filecoin backup failed'))).toBe(false);
	});

	it('filecoin leg fails loudly (notice + reject) when 0xobsidian storage is missing', async () => {
		const { main } = makePublishMain();
		await publishToPublication(main, makeVaultFile('post.md', ''), PUBLICATION, {
			render: false,
		});

		// Simulate 0xobsidian failing to init Filecoin (no session-key.json):
		// the 4-way backup still fires (pins unaffected)…
		delete (main.oxo.ctrlr as { storage?: unknown }).storage;
		const errorSpy = vi.spyOn(console, 'error');
		const opts = backupToProvidersMock.mock.calls[0][1] as { filecoin: () => Promise<unknown> };

		// …but the filecoin leg rejects with the diagnosable message and surfaces
		// a user-visible notice + error log instead of being silently swallowed.
		await expect(opts.filecoin()).rejects.toThrow(/Filecoin storage not initialised/);
		expect(errorSpy).toHaveBeenCalledWith(
			'[filecoin] article backup failed:',
			expect.stringMatching(/Filecoin storage not initialised/),
		);
		errorSpy.mockRestore();
		expect(
			SpyNotice.constructed.some((m) => m.includes('Filecoin backup failed') && m.includes('not initialised')),
		).toBe(true);
	});

	it('filecoin leg fails loudly when uploadJson rejects', async () => {
		const { main } = makePublishMain();
		(main.oxo.ctrlr.storage as { uploadJson: unknown }).uploadJson = vi
			.fn()
			.mockRejectedValue(new Error('could not store 2 Filecoin copies'));
		await publishToPublication(main, makeVaultFile('post.md', ''), PUBLICATION, {
			render: false,
		});

		const opts = backupToProvidersMock.mock.calls[0][1] as { filecoin: () => Promise<unknown> };
		await expect(opts.filecoin()).rejects.toThrow('could not store 2 Filecoin copies');
		expect(
			SpyNotice.constructed.some((m) => m.includes('Filecoin backup failed') && m.includes('2 Filecoin copies')),
		).toBe(true);
	});

	it('runFilecoinLeg turns a hang into a visible, time-boxed failure', async () => {
		// An upload that never settles would previously hang forever with zero
		// logs (the leg is fire-and-forget). Now it is capped and surfaced. The
		// Notice is the CALLER's job (shared can't import obsidian) — the test
		// passes the same onFailure publish.ts/render.helper.ts use.
		await expect(
			runFilecoinLeg('article', () => new Promise(() => {}), {
				timeoutMs: 50,
				onFailure: (msg) => new SpyNotice(`⚠️ Filecoin backup failed: ${msg}`),
			}),
		).rejects.toThrow(/timed out after 0.05s/);
		expect(
			SpyNotice.constructed.some((m) => m.includes('Filecoin backup failed') && m.includes('timed out')),
		).toBe(true);
	});

	it('kuboBaseUrl normalises a bare host to https', () => {
		const { main } = makePublishMain();
		main.oxo.settings.kubo_url = 'ipfs.transport-union.dev';
		expect(kuboBaseUrl(main)).toBe(KUBO_URL);
		main.oxo.settings.kubo_url = 'https://custom.gateway.dev';
		expect(kuboBaseUrl(main)).toBe('https://custom.gateway.dev');
	});
});
