/**
 * Unit tests for src/settings.ts.
 *
 * Covers:
 *   - DEFAULT_SETTINGS: every field present with the expected default
 *     (contract addresses, chain_id as the string "8453", etc.).
 *   - DSGSettingsTab: constructor wiring (app/plugin/name) against the mocked
 *     App/PluginSettingTab, plus a headless exercise of `display()`'s dev
 *     toggle handler (persist + protocolInfo refresh) with a recording
 *     Setting mock and a stubbed shared `getProtocolInfo`.
 *
 * DOM-heavy rendering is intentionally kept minimal — the value here is the
 * defaults contract and the settings wiring, not Obsidian's container markup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `display()`'s dev-toggle handler calls getProtocolInfo (live chain RPC).
// Stub it so the wiring is testable headlessly; the callback args are still
// evaluated, so the plugin shape below mirrors what the handler reads.
const { mockGetProtocolInfo, mockToggleCallbacks } = vi.hoisted(() => ({
	mockGetProtocolInfo: vi.fn(async () => ({ mocked: true, gateway: 'mock-gateway' })),
	mockToggleCallbacks: [] as Array<(v: boolean) => void>,
}));

vi.mock('@s2s/soul2soul-shared', () => ({ getProtocolInfo: mockGetProtocolInfo }));

// Replace only `Setting` with a recording variant so `display()`'s
// addToggle(cb) callback is captured (the stock obsidian stub ignores it).
vi.mock('obsidian', async () => {
	const actual = await vi.importActual<typeof import('obsidian')>('obsidian');
	class MockSetting extends (actual.Setting as any) {
		addToggle(cb: (v: boolean) => void) {
			mockToggleCallbacks.push(cb);
			return this;
		}
	}
	return { ...actual, Setting: MockSetting };
});

import { App, PluginSettingTab } from 'obsidian';
import { DEFAULT_SETTINGS, DSGSettingsTab } from '../../src/settings';

describe('DEFAULT_SETTINGS', () => {
	it('defines every settings field with its expected default', () => {
		expect(DEFAULT_SETTINGS.dev).toBe(false);
		expect(DEFAULT_SETTINGS.data_gateway).toBe('https://ipfs.transport-union.dev');
		expect(DEFAULT_SETTINGS.arbiscan_key).toBe('');
		expect(DEFAULT_SETTINGS.basescan_key).toBe('');
		expect(DEFAULT_SETTINGS.publications).toEqual([]);
		expect(DEFAULT_SETTINGS.chain_id).toBe('8453');
	});

	it('pins the deployed contract addresses', () => {
		expect(DEFAULT_SETTINGS.contract_factory).toBe('0x5a9F61C144862b46A29A434d5C17036Ff5fA40C0');
		expect(DEFAULT_SETTINGS.ens_registry).toBe('0x9aB0B1629fc094B1142F9fe9456cdc34A130c4e5');
		expect(DEFAULT_SETTINGS.ens_resolver).toBe('0x5ED9023eaDbE9757E347E92D1Da97F2e0b010b61');
		expect(DEFAULT_SETTINGS.ens_records).toBe('0x5D42f9b016B4251FC6407d5e8154DA887F394900');
		expect(DEFAULT_SETTINGS.safe_records_factory).toBe(
			'0xed933AB957aa3440133cdf1236662635d4eb2Ccf',
		);
		expect(DEFAULT_SETTINGS.proxy_admin).toBe('0x66d5549fdfaCc3606EB5bcD702D989A846A936c0');
	});

	it('keeps every address a well-formed 0x 20-byte hex string', () => {
		const addrs = [
			DEFAULT_SETTINGS.contract_factory,
			DEFAULT_SETTINGS.ens_registry,
			DEFAULT_SETTINGS.ens_resolver,
			DEFAULT_SETTINGS.ens_records,
			DEFAULT_SETTINGS.safe_records_factory,
			DEFAULT_SETTINGS.proxy_admin,
		];
		for (const addr of addrs) {
			expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
		}
	});
});

describe('DSGSettingsTab', () => {
	beforeEach(() => {
		mockToggleCallbacks.length = 0;
		mockGetProtocolInfo.mockClear();
	});

	it('wires the constructor to the app/plugin and sets a display name', () => {
		const app = new App();
		const plugin = { settings: { dev: false } };
		const tab = new DSGSettingsTab(app, plugin as any);

		expect(tab).toBeInstanceOf(PluginSettingTab);
		expect(tab.app).toBe(app);
		expect((tab as any).plugin).toBe(plugin);
		expect((tab as any).name).toBe('NP settings');
	});

	it('display() renders the settings heading without touching the DOM', () => {
		const app = new App();
		const plugin = { settings: { dev: false }, saveSettings: vi.fn(async () => {}) };
		const tab = new DSGSettingsTab(app, plugin as any);

		const containerEl = {
			empty: vi.fn(),
			createEl: vi.fn(() => ({})),
		};
		(tab as any).containerEl = containerEl;

		expect(() => tab.display()).not.toThrow();
		expect(containerEl.empty).toHaveBeenCalledTimes(1);
		expect(containerEl.createEl).toHaveBeenCalledWith('h3', { text: 'NeutralPress settings' });
		// The dev toggle is wired — its handler is captured by the mock Setting.
		expect(mockToggleCallbacks).toHaveLength(1);
	});

	it('dev-toggle handler persists the new value and refreshes protocolInfo', async () => {
		const app = new App();
		const plugin = {
			settings: { dev: false },
			saveSettings: vi.fn(async () => {}),
			ctrlr: {},
			oxo: {
				ctrlr: {
					account: {
						ETH_MAINNET: { provider: {} },
						BASE: { provider: {} },
					},
				},
			},
		};
		const tab = new DSGSettingsTab(app, plugin as any);
		(tab as any).containerEl = { empty: vi.fn(), createEl: vi.fn(() => ({})) };

		tab.display();
		expect(mockToggleCallbacks).toHaveLength(1);

		// The addToggle callback receives a `toggle` object (setValue + onChange).
		const registeredHandlers: Array<(v: boolean) => void> = [];
		const toggle = {
			setValue: vi.fn(),
			onChange: (cb: (v: boolean) => void) => {
				registeredHandlers.push(cb);
			},
		};
		mockToggleCallbacks[0](toggle);

		// Seeds the toggle with the current plugin dev flag, then registers the handler.
		expect(toggle.setValue).toHaveBeenCalledWith(false);
		expect(registeredHandlers).toHaveLength(1);
		const onChange = registeredHandlers[0];

		await onChange(true);

		expect(plugin.settings.dev).toBe(true);
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
		expect(mockGetProtocolInfo).toHaveBeenCalledWith(
			plugin.ctrlr,
			plugin.oxo.ctrlr.account.ETH_MAINNET.provider,
			plugin.oxo.ctrlr.account.BASE.provider,
		);
		expect((plugin.ctrlr as any).protocolInfo).toEqual({ mocked: true, gateway: 'mock-gateway' });
	});
});
