/**
 * Unit tests — oxo-core → TxRunner bridge (src/publication/tx-runner.ts).
 *
 * Pure module: `createTxRunner` delegates to oxo.ctrlr.safeInstance(chain) and
 * casts the returned PermissionlessSafeService to TxRunner. `createL1Runner` /
 * `createL2Runner` are convenience wrappers pinning the chain constants.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	createTxRunner,
	createL1Runner,
	createL2Runner,
} from './tx-runner';

describe('tx-runner adapter', () => {
	const safeService = { getMultiSig: vi.fn(async () => '0xsafe') };

	it('createTxRunner returns the exact safeInstance object for the given chain', () => {
		const oxo = { ctrlr: { safeInstance: vi.fn(() => safeService) } };
		const runner = createTxRunner(oxo, 'BASE');
		expect(runner).toBe(safeService);
		expect(oxo.ctrlr.safeInstance).toHaveBeenCalledWith('BASE');
	});

	it('createL1Runner delegates to safeInstance(ETH_MAINNET)', () => {
		const oxo = { ctrlr: { safeInstance: vi.fn(() => safeService) } };
		const runner = createL1Runner(oxo);
		expect(runner).toBe(safeService);
		expect(oxo.ctrlr.safeInstance).toHaveBeenCalledWith('ETH_MAINNET');
	});

	it('createL2Runner delegates to safeInstance(BASE)', () => {
		const oxo = { ctrlr: { safeInstance: vi.fn(() => safeService) } };
		const runner = createL2Runner(oxo);
		expect(runner).toBe(safeService);
		expect(oxo.ctrlr.safeInstance).toHaveBeenCalledWith('BASE');
	});

	it('surfaces the safeInstance TxRunner surface (no re-wrapping)', () => {
		const oxo = { ctrlr: { safeInstance: vi.fn(() => safeService) } };
		const runner = createTxRunner(oxo, 'BASE') as any;
		expect(typeof runner.getMultiSig).toBe('function');
		// A PermissionlessSafeService-shaped object passes through untouched.
		expect(runner.getMultiSig).toBe(safeService.getMultiSig);
	});
});
