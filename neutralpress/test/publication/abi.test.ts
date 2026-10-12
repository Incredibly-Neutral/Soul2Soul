/**
 * ABI structural sanity checks for neutralpress.
 *
 * Pure, no-chain assertions that the ABI modules export non-empty arrays and
 * that expected function names + their 4-byte selectors are present. These
 * catch accidental ABI drift (renamed/removed functions) without trying to
 * encode calls (that needs a chain fork).
 *
 * Selectors are computed with viem's `toFunctionSignature`/`toFunctionSelector`
 * from the canonical `name(inputTypes...)` signature and compared against
 * hardcoded values derived from the contracts.
 */

import { describe, it, expect } from 'vitest';
import { toFunctionSelector } from 'viem';
import { protocolABI } from '../../src/protocol.abi';
import { safeAbi, publicationAbi } from '../../src/publication/abi';
import * as proxyAdminModule from '../../src/contracts/abi_proxy_admin';

/** Find the ABI entry for a function and derive its selector from inputs. */
function functionSelector(abi: any[], name: string): string {
	const entry = abi.find((e) => e.type === 'function' && e.name === name);
	expect(entry, `function ${name} missing from ABI`).toBeTruthy();
	const inputs = (entry.inputs ?? []).map((i: any) => i.type);
	return toFunctionSelector(`${name}(${inputs.join(',')})`);
}

const fnNames = (abi: any[]) =>
	abi.filter((e) => e.type === 'function').map((e) => e.name);

describe('protocol.abi', () => {
	it('exports a non-empty ABI array of well-formed entries', () => {
		expect(Array.isArray(protocolABI)).toBe(true);
		expect(protocolABI.length).toBeGreaterThan(0);
		expect(protocolABI.every((e) => typeof e === 'object' && 'type' in e)).toBe(true);
	});

	it('contains the expected protocol functions', () => {
		const names = fnNames(protocolABI);
		for (const name of [
			'createPublication',
			'getPublicationByEns',
			'getEnsNameByPublication',
			'setConfig',
			'initialize',
			'upgradeTo',
			'upgradeToAndCall',
			'transferOwnership',
			'proxiableUUID',
		]) {
			expect(names).toContain(name);
		}
	});

	it('has correct selectors for key protocol functions', () => {
		expect(functionSelector(protocolABI, 'createPublication')).toBe('0x789d73a9');
		expect(functionSelector(protocolABI, 'getPublicationByEns')).toBe('0x557658d3');
		expect(functionSelector(protocolABI, 'setConfig')).toBe('0xd11db010');
		expect(functionSelector(protocolABI, 'initialize')).toBe('0x485cc955');
	});
});

describe('publication/abi (publicationAbi + safeAbi)', () => {
	it('exports non-empty ABI arrays', () => {
		expect(Array.isArray(publicationAbi)).toBe(true);
		expect(publicationAbi.length).toBeGreaterThan(0);
		expect(Array.isArray(safeAbi)).toBe(true);
		expect(safeAbi.length).toBeGreaterThan(0);
	});

	it('publicationAbi contains the deal-lifecycle + admin functions', () => {
		const names = fnNames(publicationAbi);
		for (const name of [
			'offerDeal',
			'acceptDeal',
			'revokeDeal',
			'hasDeal',
			'hasDealBatch',
			'updateConfig',
			'updateHtmlRoot',
			'updatePkp',
			'whitelistAuthor',
			'upgradeTo',
			'upgradeToAndCall',
		]) {
			expect(names).toContain(name);
		}
	});

	it('publicationAbi selectors match the deal-lifecycle functions', () => {
		expect(functionSelector(publicationAbi, 'offerDeal')).toBe('0xd5acd639');
		expect(functionSelector(publicationAbi, 'acceptDeal')).toBe('0x7b0fad69');
		expect(functionSelector(publicationAbi, 'revokeDeal')).toBe('0x5de9537a');
		expect(functionSelector(publicationAbi, 'hasDeal')).toBe('0x2244ad2b');
		expect(functionSelector(publicationAbi, 'updateConfig')).toBe('0x8a76984d');
		expect(functionSelector(publicationAbi, 'updateHtmlRoot')).toBe('0x12e93177');
	});

	it('safeAbi exposes isOwner(address) with the expected selector', () => {
		expect(fnNames(safeAbi)).toContain('isOwner');
		expect(functionSelector(safeAbi, 'isOwner')).toBe('0x2f54bf6e');
	});
});

describe('contracts/abi_proxy_admin', () => {
	it('currently exports NO ABI array — the file is fully commented out', () => {
		// Finding: src/contracts/abi_proxy_admin.ts contains only a commented-out
		// `ABI_PROXY_ADMIN` and no live `export`. There is no admin-proxy ABI to
		// sanity-check today. Encoded here so the intent (an ABI should exist)
		// is visible; when the file is restored this test should be updated to
		// assert the real entries instead.
		const exported = Object.keys(proxyAdminModule);
		expect(exported).not.toContain('ABI_PROXY_ADMIN');
		expect(exported.filter((k) => k !== 'default')).toHaveLength(0);
	});
});
