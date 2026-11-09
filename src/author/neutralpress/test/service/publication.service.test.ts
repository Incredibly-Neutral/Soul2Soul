/**
 * Unit tests — PublicationService (src/publication/publication.service.ts).
 *
 * Heavily mocked, no network/chain ever touched:
 *   - L1 ENS reads (getPublicationMultiSig) are stubbed via
 *     main.oxo.ctrlr.account['ETH_MAINNET'].publicClient.readContract.
 *   - L2 reads (getModulesPaginated / NAME / ...) are stubbed via
 *     main.oxo.ctrlr.viem.read.
 *   - All writes (makeOffer/retract) go through
 *     main.oxo.ctrlr.account['BASE'].genericTx.
 *
 * toBytes32Id is exercised only with 64-hex genesis values (the pass-through
 * branch): the keccak branch needs a global `ethers` which is not present
 * under vitest.
 */

import { describe, it, expect, vi } from 'vitest';
import { PublicationService } from '../../src/publication/publication.service';
import { makeMain } from '../helpers/main';
import { safeAbi, toBytes32Id } from '@s2s/soul2soul-shared';
import { S2SPublicationModuleV2 } from '@s2s/publication-contracts';

const MODULE_RECORDS = '0x' + 'a'.repeat(40); // NAME() === 'S2S Records Module'
const MODULE_PUBLICATION = '0x' + 'b'.repeat(40); // NAME() === 'S2S Publication Module V2'
const MANAGER = '0x' + 'd'.repeat(40); // ownerOf → publication Safe multisig
const GENESIS = '0x' + '1'.repeat(64); // 64-hex → toBytes32Id pass-through
const SENTINEL = '0x0000000000000000000000000000000000000001';

/** Build a main whose ENS + viem + tx surfaces return deterministic values. */
function makePublicationMain() {
	const main = makeMain();

	// L1 ENS discovery: nameWrapper → parentNode → ownerOf.
	main.oxo.ctrlr.account.ETH_MAINNET.publicClient = {
		readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
			if (functionName === 'nameWrapper') return '0x' + 'e'.repeat(40);
			if (functionName === 'parentNode') return '0x' + '2'.repeat(64);
			if (functionName === 'ownerOf') return MANAGER;
			return undefined;
		}),
	};

	// L2 view reads through the ViemService.
	main.oxo.ctrlr.viem.read = vi.fn(
		async (address: string, _abi: unknown[], fn: string, _args: unknown[]) => {
			if (fn === 'getModulesPaginated') return [[MODULE_RECORDS, MODULE_PUBLICATION], '0xend'];
			if (fn === 'NAME') {
				if (address === MODULE_RECORDS) return 'S2S Records Module';
				if (address === MODULE_PUBLICATION) return 'S2S Publication Module V2';
				return 'Some Other Module';
			}
			return undefined;
		},
	);

	// L2 writes.
	main.oxo.ctrlr.account.BASE.genericTx = vi.fn(async () => '0xtxhash');

	return main;
}

function makeService(subdomain = 'acme') {
	const main = makePublicationMain();
	const svc = new PublicationService(main, subdomain);
	return { main, svc };
}

describe('PublicationService', () => {
	describe('constructor', () => {
		it('builds L1/L2 safeInstance runners', () => {
			const main = makePublicationMain();
			const svc = new PublicationService(main, 'acme');
			expect(svc.subdomain).toBe('acme');
			expect(main.oxo.ctrlr.safeInstance).toHaveBeenCalledWith('ETH_MAINNET');
			expect(main.oxo.ctrlr.safeInstance).toHaveBeenCalledWith('BASE');
			expect(svc.L1).toBeDefined();
			expect(svc.L2).toBeDefined();
		});
	});

	describe('init', () => {
		it('resolves multisig via ENS discovery, then records + publication modules', async () => {
			const { main, svc } = makeService();
			expect(svc.multisig).toBeUndefined();
			expect(svc.configModule).toBeUndefined();
			expect(svc.publicationModule).toBeUndefined();

			await svc.init();

			expect(svc.multisig).toBe(MANAGER);
			expect(svc.configModule).toBe(MODULE_RECORDS);
			expect(svc.publicationModule).toBe(MODULE_PUBLICATION);

			// ENS flow: nameWrapper, parentNode, ownerOf on the L1 publicClient.
			const readContract = main.oxo.ctrlr.account.ETH_MAINNET.publicClient.readContract;
			expect(readContract).toHaveBeenCalledTimes(3);
			expect(readContract.mock.calls.map((c: any) => c[0].functionName)).toEqual([
				'nameWrapper',
				'parentNode',
				'ownerOf',
			]);

			// Module scan: getModulesPaginated on the multisig, then NAME per module.
			const viemRead = main.oxo.ctrlr.viem.read;
			expect(viemRead).toHaveBeenNthCalledWith(
				1,
				MANAGER,
				safeAbi,
				'getModulesPaginated',
				[SENTINEL, '10'],
			);
			expect(viemRead).toHaveBeenNthCalledWith(
				2,
				MODULE_RECORDS,
				expect.any(Array),
				'NAME',
				[],
			);
			expect(viemRead).toHaveBeenNthCalledWith(
				3,
				MODULE_PUBLICATION,
				expect.any(Array),
				'NAME',
				[],
			);
		});

		it('is idempotent — re-initializing an already-initialized service re-derives the same addresses', async () => {
			const { svc } = makeService();
			await svc.init();
			const first = { multisig: svc.multisig, configModule: svc.configModule, publicationModule: svc.publicationModule };
			await svc.init();
			expect(svc.multisig).toBe(first.multisig);
			expect(svc.configModule).toBe(first.configModule);
			expect(svc.publicationModule).toBe(first.publicationModule);
		});

		it('propagates ENS discovery failures (L1 read error)', async () => {
			const { main, svc } = makeService();
			main.oxo.ctrlr.account.ETH_MAINNET.publicClient.readContract.mockRejectedValue(
				new Error('rpc down'),
			);
			await expect(svc.init()).rejects.toThrow('rpc down');
		});
	});

	describe('getModuleAdresses', () => {
		it('discovers S2S Records + S2S Publication Module V2', async () => {
			const { svc } = makeService();
			await svc.init();
			expect(svc.configModule).toBe(MODULE_RECORDS);
			expect(svc.publicationModule).toBe(MODULE_PUBLICATION);
		});

		it('discovers a V3 publication module (the name the live V3 answers)', async () => {
			const { main, svc } = makeService();
			main.oxo.ctrlr.viem.read.mockImplementation(
				async (address: string, _abi: unknown[], fn: string) => {
					if (fn === 'getModulesPaginated') return [[MODULE_RECORDS, MODULE_PUBLICATION], '0xend'];
					if (fn === 'NAME') {
						if (address === MODULE_PUBLICATION) return 'S2S Publication Module V3';
						return 'S2S Records Module';
					}
					return undefined;
				},
			);
			await svc.init();
			expect(svc.publicationModule).toBe(MODULE_PUBLICATION);
		});

		it('accepts the legacy "S2S Publication Module" name for backwards compat', async () => {
			const { main, svc } = makeService();
			main.oxo.ctrlr.viem.read.mockImplementation(
				async (address: string, _abi: unknown[], fn: string) => {
					if (fn === 'getModulesPaginated') return [[MODULE_RECORDS, MODULE_PUBLICATION], '0xend'];
					if (fn === 'NAME') {
						if (address === MODULE_PUBLICATION) return 'S2S Publication Module';
						return 'S2S Records Module';
					}
					return undefined;
				},
			);
			await svc.init();
			expect(svc.publicationModule).toBe(MODULE_PUBLICATION);
		});

		it('skips modules whose NAME() call fails (missing/renamed NAME function)', async () => {
			const { main, svc } = makeService();
			main.oxo.ctrlr.viem.read.mockImplementation(
				async (address: string, _abi: unknown[], fn: string) => {
					if (fn === 'getModulesPaginated') return [[MODULE_RECORDS, MODULE_PUBLICATION], '0xend'];
					if (fn === 'NAME') {
						if (address === MODULE_RECORDS) throw new Error('no NAME()');
						return 'S2S Publication Module V2';
					}
					return undefined;
				},
			);
			await svc.init();
			// Records module unreadable → configModule left undefined; publication still found.
			expect(svc.configModule).toBeUndefined();
			expect(svc.publicationModule).toBe(MODULE_PUBLICATION);
		});

		it('propagates getModulesPaginated failures (multisig read error)', async () => {
			const { main, svc } = makeService();
			main.oxo.ctrlr.viem.read.mockImplementation(async (_a: string, _b: unknown[], fn: string) => {
				if (fn === 'getModulesPaginated') throw new Error('multisig read failed');
				return undefined;
			});
			await expect(svc.getModuleAdresses()).rejects.toThrow('multisig read failed');
		});
	});

	describe('makeOffer / retract (L2 genericTx dispatch)', () => {
		it('makeOffer dispatches to the publication module with bytes32 genesis + cid', async () => {
			const { main, svc } = makeService();
			await svc.init();
			const result = await svc.makeOffer(GENESIS, 'QmRootCid');

			expect(result).toBe('0xtxhash');
			expect(main.oxo.ctrlr.account.BASE.genericTx).toHaveBeenCalledWith(
				MODULE_PUBLICATION,
				JSON.stringify(S2SPublicationModuleV2),
				'makeOffer',
				[toBytes32Id(GENESIS), 'QmRootCid'],
				false,
			);
		});

		it('retract dispatches retract with only the genesis', async () => {
			const { main, svc } = makeService();
			await svc.init();
			await svc.retract(GENESIS);

			expect(main.oxo.ctrlr.account.BASE.genericTx).toHaveBeenCalledWith(
				MODULE_PUBLICATION,
				JSON.stringify(S2SPublicationModuleV2),
				'retract',
				[toBytes32Id(GENESIS)],
				false,
			);
		});

		it('propagates genericTx failures', async () => {
			const { main, svc } = makeService();
			await svc.init();
			main.oxo.ctrlr.account.BASE.genericTx.mockRejectedValue(new Error('tx reverted'));
			await expect(svc.makeOffer(GENESIS, 'QmRootCid')).rejects.toThrow('tx reverted');
		});
	});

	describe('getMultiSig', () => {
		it('is undefined before init, resolves after', async () => {
			const { svc } = makeService();
			await expect(svc.getMultiSig()).resolves.toBeUndefined();
			await svc.init();
			await expect(svc.getMultiSig()).resolves.toBe(MANAGER);
		});
	});
});
