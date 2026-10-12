/**
 * Unit tests for src/publication/ens.ts — ENS registry reads via the L1
 * (ETH_MAINNET) account's viem publicClient.
 *
 * `readEns` calls `main.oxo.ctrlr.account["ETH_MAINNET"].publicClient.readContract`,
 * so we stub that surface on the makeMain fixture. `@s2s/soul2soul-shared` is
 * mocked (the real import drags the whole shared index in; the ABI content is
 * not what's under test here — only which calls ens.ts makes).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('@s2s/soul2soul-shared', () => ({
	// Minimal stand-in: ens.ts only passes this to the (mocked) readContract.
	ensSubdomainRegistryAbi: [],
}));

import { isAvailableEnsName, getPublicationMultiSig } from '../../src/publication/ens';
import { makeMain } from '../helpers/main';

function mainWithPublicClient() {
	const main = makeMain();
	main.oxo.ctrlr.account['ETH_MAINNET'].publicClient = { readContract: vi.fn() };
	return main;
}
function readContractOf(main: ReturnType<typeof makeMain>) {
	return main.oxo.ctrlr.account['ETH_MAINNET'].publicClient.readContract as ReturnType<
		typeof vi.fn
	>;
}

const PARENT_NODE = '0x' + 'ab'.repeat(32); // 0xab…ab (bytes32)
const WRAPPER = '0xWraPper0000000000000000000000000000';
const MANAGER = '0xManageR000000000000000000000000000000';

let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
	// Mute the source's console.log/console.error debug output so the suite
	// stays quiet; each test installs its own fresh readContract stub.
	consoleSpies = [
		vi.spyOn(console, 'log').mockImplementation(() => {}),
		vi.spyOn(console, 'error').mockImplementation(() => {}),
	];
});

afterEach(() => {
	for (const spy of consoleSpies) spy.mockRestore();
});

describe('isAvailableEnsName', () => {
	it('returns the contract result when the subdomain is available', async () => {
		const main = mainWithPublicClient();
		readContractOf(main).mockResolvedValue(true);

		await expect(isAvailableEnsName(main, 'acme--s2s')).resolves.toBe(true);

		// readContract is called with a single options object: address/abi/functionName/args.
		const arg = readContractOf(main).mock.calls[0][0];
		expect(arg.address).toBe(main.plugin.settings.ens_registry);
		expect(arg.functionName).toBe('isSubdomainAvailable');
		expect(arg.args).toEqual(['acme']);
		expect(Array.isArray(arg.abi)).toBe(true);
	});

	it('propagates a false/unavailable result', async () => {
		const main = mainWithPublicClient();
		readContractOf(main).mockResolvedValue(false);
		await expect(isAvailableEnsName(main, 'acme--s2s')).resolves.toBe(false);
	});

	it('re-throws when the contract read fails', async () => {
		const main = mainWithPublicClient();
		readContractOf(main).mockRejectedValue(new Error('rpc down'));
		await expect(isAvailableEnsName(main, 'acme--s2s')).rejects.toThrow('rpc down');
	});
});

describe('getPublicationMultiSig', () => {
	it('returns { addr, chainId: 1 } from the three readContract calls', async () => {
		const main = mainWithPublicClient();
		// call order: nameWrapper → parentNode → ownerOf
		readContractOf(main)
			.mockResolvedValueOnce(WRAPPER)
			.mockResolvedValueOnce(PARENT_NODE)
			.mockResolvedValueOnce(MANAGER);

		const result = await getPublicationMultiSig(main, 'acme');

		expect(result).toEqual({ addr: MANAGER, chainId: 1 });

		const calls = readContractOf(main).mock.calls;
		expect(calls).toHaveLength(3);
		// 1. nameWrapper against the registry
		expect(calls[0][0].address).toBe(main.plugin.settings.ens_registry);
		expect(calls[0][0].functionName).toBe('nameWrapper');
		expect(calls[0][0].args).toEqual([]);
		// 2. parentNode against the registry
		expect(calls[1][0].address).toBe(main.plugin.settings.ens_registry);
		expect(calls[1][0].functionName).toBe('parentNode');
		// 3. ownerOf on the resolved wrapper, with the subdomain node id
		expect(calls[2][0].address).toBe(WRAPPER);
		expect(calls[2][0].functionName).toBe('ownerOf');
		expect(calls[2][0].args).toHaveLength(1);
		expect(calls[2][0].args[0]).toMatch(/^0x[0-9a-fA-F]{64}$/); // keccak node id
	});

	it('re-throws when the first read fails', async () => {
		const main = mainWithPublicClient();
		readContractOf(main).mockRejectedValue(new Error('bad rpc'));
		await expect(getPublicationMultiSig(main, 'acme')).rejects.toThrow('bad rpc');
	});
});
