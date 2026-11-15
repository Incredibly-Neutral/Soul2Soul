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

	/**
	 * CREATE2 prediction (SPEC-publication-account.md: the factory names the
	 * module address). `moduleAddress(safe)` is exact for a create that has not
	 * happened yet, so discovery accepts it only where code sits — otherwise it
	 * falls back to the NAME() scan, which is all a V2 publication has.
	 */
	describe('getModuleAdresses — CREATE2 prediction', () => {
		const FACTORY = '0x' + 'f'.repeat(40);
		const PREDICTED = '0x' + 'c'.repeat(40);
		const OLDER = '0x' + '3'.repeat(40);

		/**
		 * L2 reads that answer the create2 selectors. `answers` decides which of the
		 * three exist: a pre-create2 factory throws on all of them.
		 */
		function makeCreate2Main(opts: {
			modules: string[];
			moduleAddress?: string | Error;
			count?: number;
			forVersion?: Record<number, string>;
			code?: string[];
		}) {
			const main = makePublicationMain();
			main.protocolInfo = { gateway: 'https://ipfs.transport-union.dev', publicationFactory: FACTORY };
			main.oxo.ctrlr.viem.read = vi.fn(
				async (address: string, _abi: unknown[], fn: string, args: unknown[] = []) => {
					if (fn === 'getModulesPaginated') return [opts.modules, '0xend'];
					if (fn === 'NAME') {
						if (address === MODULE_RECORDS) return 'S2S Records Module';
						if (address === MODULE_PUBLICATION) return 'S2S Publication Module V3';
						return 'Some Other Module';
					}
					if (fn === 'moduleAddress') {
						if (opts.moduleAddress instanceof Error) throw opts.moduleAddress;
						return opts.moduleAddress;
					}
					if (fn === 'implementationCount') {
						if (opts.count === undefined) throw new Error('no implementationCount()');
						return BigInt(opts.count);
					}
					if (fn === 'moduleAddressForVersion') {
						const version = Number(args[1]);
						const answer = opts.forVersion?.[version];
						if (!answer) throw new Error('execution reverted');
						return answer;
					}
					return undefined;
				},
			);
			main.oxo.ctrlr.viem.publicClient = {
				getCode: vi.fn(async ({ address }: { address: string }) =>
					(opts.code ?? []).includes(address) ? '0x60806040' : '0x',
				),
			};
			return main;
		}

		it('takes the predicted address when the Safe lists it and it has code', async () => {
			const main = makeCreate2Main({
				modules: [MODULE_RECORDS, PREDICTED],
				moduleAddress: PREDICTED,
				code: [PREDICTED],
			});
			const svc = new PublicationService(main, 'acme');
			await svc.init();

			expect(svc.publicationModule).toBe(PREDICTED);
			expect(svc.configModule).toBe(MODULE_RECORDS);
			expect(main.oxo.ctrlr.viem.read).toHaveBeenCalledWith(
				FACTORY,
				expect.anything(),
				'moduleAddress',
				[MANAGER],
			);
		});

		it('falls back to the NAME() scan when the factory answers no create2 selector', async () => {
			const main = makeCreate2Main({
				modules: [MODULE_RECORDS, MODULE_PUBLICATION],
				moduleAddress: new Error('function selector was not recognized'),
			});
			const svc = new PublicationService(main, 'acme');
			await svc.init();

			expect(svc.publicationModule).toBe(MODULE_PUBLICATION);
		});

		it('ignores a predicted address that has no code (the next create, not this publication)', async () => {
			const main = makeCreate2Main({
				modules: [MODULE_RECORDS, MODULE_PUBLICATION],
				moduleAddress: PREDICTED,
				code: [],
			});
			const svc = new PublicationService(main, 'acme');
			await svc.init();

			expect(svc.publicationModule).toBe(MODULE_PUBLICATION);
		});

		it('ignores a confirmed prediction the Safe no longer lists (disabled module)', async () => {
			const main = makeCreate2Main({
				modules: [MODULE_RECORDS, MODULE_PUBLICATION],
				moduleAddress: PREDICTED,
				code: [PREDICTED],
			});
			const svc = new PublicationService(main, 'acme');
			await svc.init();

			expect(svc.publicationModule).toBe(MODULE_PUBLICATION);
		});

		it('walks implementationCount for a publication made under an older implementation', async () => {
			const main = makeCreate2Main({
				modules: [MODULE_RECORDS, OLDER],
				// moduleAddress now names the address the NEXT create would use.
				moduleAddress: PREDICTED,
				count: 2,
				forVersion: { 1: OLDER },
				code: [OLDER],
			});
			const svc = new PublicationService(main, 'acme');
			await svc.init();

			expect(svc.publicationModule).toBe(OLDER);
		});

		it('stops at the first read when moduleAddress reverts (a plain-CREATE factory)', async () => {
			const main = makeCreate2Main({
				modules: [MODULE_RECORDS, MODULE_PUBLICATION],
				moduleAddress: new Error('function selector was not recognized'),
				count: 3,
			});
			const svc = new PublicationService(main, 'acme');
			await svc.init();

			expect(svc.publicationModule).toBe(MODULE_PUBLICATION);
			const create2Calls = (main.oxo.ctrlr.viem.read as any).mock.calls
				.map((call: unknown[]) => call[2])
				.filter((fn: string) => fn === 'moduleAddress' || fn === 'implementationCount' || fn === 'moduleAddressForVersion');
			// The revert is the answer: no implementationCount, no version walk.
			expect(create2Calls).toEqual(['moduleAddress']);
		});

		it('keeps the scan tie-break: the last publication module listed wins', async () => {
			const SECOND = '0x' + '9'.repeat(40);
			const main = makeCreate2Main({
				modules: [MODULE_RECORDS, MODULE_PUBLICATION, SECOND],
				moduleAddress: new Error('function selector was not recognized'),
			});
			// The second module is also a publication module.
			const read = main.oxo.ctrlr.viem.read as any;
			const original = read.getMockImplementation();
			read.mockImplementation(async (address: string, abi: unknown[], fn: string, args: unknown[]) => {
				if (fn === 'NAME' && address === SECOND) return 'S2S Publication Module V3';
				return original(address, abi, fn, args);
			});

			const svc = new PublicationService(main, 'acme');
			await svc.init();

			expect(svc.publicationModule).toBe(SECOND);
		});

		it('lets a confirmed prediction beat the scan when two publication modules are listed', async () => {
			const main = makeCreate2Main({
				// PREDICTED is listed before the scanned module, so the scan alone
				// would land on MODULE_PUBLICATION.
				modules: [MODULE_RECORDS, PREDICTED, MODULE_PUBLICATION],
				moduleAddress: PREDICTED,
				code: [PREDICTED],
			});
			const svc = new PublicationService(main, 'acme');
			await svc.init();

			expect(svc.publicationModule).toBe(PREDICTED);
		});

		it('leaves publicationModule unset when nothing is predicted and no name matches', async () => {
			const main = makeCreate2Main({
				modules: [MODULE_RECORDS],
				moduleAddress: PREDICTED,
				code: [],
				count: 1,
			});
			const svc = new PublicationService(main, 'acme');
			await svc.init();

			expect(svc.publicationModule).toBeUndefined();
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
