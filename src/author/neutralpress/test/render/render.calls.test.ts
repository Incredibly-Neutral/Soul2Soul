/**
 * Unit tests — renderCalls (src/render/render.helper.ts), the render-envelope
 * guard.
 *
 * The renderer reports a failed later batch as `success: false` with the root
 * an earlier batch DID write. That root is served by the domain but is not the
 * publish the caller asked for: renderCalls must fail instead of pinning,
 * mirroring or linking a partial tree.
 *
 * The pipeline is stubbed at `renderwithLitActions` only; the rest of shared
 * stays real (same pattern as publish.test.ts). `ipfsFromSettings` is stubbed
 * so a stray pin attempt shows up as a spy call instead of a real 4-way
 * backup. The throw happens before any DOM work, so no document/Notice
 * fragments are built in the node environment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { renderwithLitActionsMock, ipfsFromSettingsMock, backupToProvidersMock } = vi.hoisted(() => {
	return {
		renderwithLitActionsMock: vi.fn(),
		ipfsFromSettingsMock: vi.fn(),
		backupToProvidersMock: vi.fn(),
	};
});

vi.mock('@s2s/soul2soul-shared', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, renderwithLitActions: renderwithLitActionsMock };
});

vi.mock('../../src/publication/filecoin', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	ipfsFromSettingsMock.mockReturnValue({ backupToProviders: backupToProvidersMock });
	return { ...actual, ipfsFromSettings: ipfsFromSettingsMock };
});

import { renderCalls } from '../../src/render/render.helper';
import { makeMain } from '../helpers/main';

const PUBLICATION = 'acme.soul2soul.eth';
// Root an earlier batch wrote; the domain serves it.
const PARTIAL_ROOT = 'QmZULkCELmmk5XNfCgTnCyFgAVxBRBXyDHGGMVoLFLiXEN';

describe('renderCalls', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// Preview path: the catch has no publish-only archive mirror to attempt, so
	// neither the pin nor the mirror surface is touched at all.
	it('rejects a failed envelope that carries a root, touching no pin path', async () => {
		const main = makeMain();
		renderwithLitActionsMock.mockResolvedValue({
			success: false,
			cid: PARTIAL_ROOT,
			path: '/posts/hello',
			error: 'update batch 2/2 failed: out of budget',
		});

		await expect(
			renderCalls(main as any, PUBLICATION, ['genesis-1'], 'lit-usage-key', false),
		).rejects.toThrow(
			'render envelope reported failure: update batch 2/2 failed: out of budget (partial root ' +
				PARTIAL_ROOT +
				')',
		);

		expect(ipfsFromSettingsMock).not.toHaveBeenCalled();
		expect(backupToProvidersMock).not.toHaveBeenCalled();
		expect(main.notice.setMessage).not.toHaveBeenCalledWith('5/5 Pinning ...');
	});

	// Publish path: the catch may look up ipfs settings for the archive CID, but
	// the partial render root must never reach backupToProviders.
	it('never pins the partial root on the publish path', async () => {
		const main = makeMain();
		renderwithLitActionsMock.mockResolvedValue({
			success: false,
			cid: PARTIAL_ROOT,
			path: '/posts/hello',
			error: 'update batch 2/2 failed: out of budget',
		});

		await expect(
			renderCalls(main as any, PUBLICATION, ['genesis-1'], 'lit-usage-key', true),
		).rejects.toThrow('(partial root ' + PARTIAL_ROOT + ')');

		expect(backupToProvidersMock).not.toHaveBeenCalled();
		for (const call of backupToProvidersMock.mock.calls) {
			expect(call[0]).not.toBe(PARTIAL_ROOT);
		}
	});

	it('rejects a failed envelope with no root, naming the failure alone', async () => {
		const main = makeMain();
		renderwithLitActionsMock.mockResolvedValue({
			success: false,
			cid: null,
			path: '',
			error: 'update action failed',
		});

		await expect(
			renderCalls(main as any, PUBLICATION, ['genesis-1'], 'lit-usage-key', false),
		).rejects.toThrow('render envelope reported failure: update action failed');

		expect(ipfsFromSettingsMock).not.toHaveBeenCalled();
		expect(backupToProvidersMock).not.toHaveBeenCalled();
	});
});
