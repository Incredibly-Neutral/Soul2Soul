/**
 * Shared test helpers for neutralpress unit tests.
 *
 * `makeMain` builds a fake `IMainController` with controllable, vi.fn()-spied
 * surfaces mirroring the shapes the neutralpress source reads off `main`:
 *   - main.plugin.app.vault.read / metadataCache / fileManager
 *   - main.plugin.app.settings + saveSettings
 *   - main.oxo.ctrlr.account[chain] signers, safeInstance, viem, storage, user
 *   - main.oxo.settings (litUsageKey, kubo_token, pin_provider, ...)
 *   - main.protocolInfo.gateway
 *   - main.notice, main.content.parseNote, main.isValidForPublishing, ...
 *
 * Override individual pieces after construction (e.g. stub vault.read for a
 * fixture) or pass `{ main: { ... } }` to replace defaults wholesale.
 */

import { vi } from 'vitest';

export function makeVaultFile(name: string, raw: string, extra: Record<string, any> = {}) {
	return {
		name,
		path: `/vault/${name}`,
		extension: name.split('.').pop() || 'md',
		stat: { mtime: 1_700_000_000_000 },
		...extra,
	};
}

export function makeMain(overrides: { main?: Record<string, any> } = {}) {
	const vaultRead = vi.fn(async () => '');
	const vaultModify = vi.fn(async () => {});
	const getFileByPath = vi.fn((path: string) => makeVaultFile(path.split('/').pop() || '', ''));
	const getFileCache = vi.fn(() => ({ frontmatter: {} }));
	const processFrontMatter = vi.fn(async (_file: any, fn: (fm: Record<string, any>) => void) => {
		fn({});
	});

	const main = {
		basePath: '/vault',
		plugin: {
			app: {
				vault: {
					read: vaultRead,
					modify: vaultModify,
					getFileByPath,
					adapter: {},
				},
				metadataCache: { getFileCache },
				fileManager: { processFrontMatter },
			},
			settings: {
				dev: false,
				data_gateway: 'https://ipfs.transport-union.dev',
				publications: [],
				contract_factory: '0x0',
				ens_registry: '0x0',
				ens_resolver: '0x0',
				ens_records: '0x0',
				safe_records_factory: '0x0',
				safe_publication_factory: '0x0',
				proxy_admin: '0x0',
				chain_id: '8453',
			},
			saveSettings: vi.fn(async () => {}),
		},
		oxo: {
			ctrlr: {
				plugin: { settings: { rpc_key: 'drpc_test', pin_provider: 'filebase' } },
				account: {
					ETH_MAINNET: {
						provider: {},
						address: '0xL1',
						signMessage: vi.fn(async () => '0xsignature'),
						signTypedData: vi.fn(),
						genericTx: vi.fn(async () => '0xtx'),
					},
					BASE: {
						provider: {},
						address: '0xL2',
						signMessage: vi.fn(async () => '0xsignature'),
						signTypedData: vi.fn(),
						genericTx: vi.fn(async () => '0xtx'),
					},
				},
				safeInstance: vi.fn(() => ({})),
				lit: {},
				viem: { read: vi.fn(async () => null) },
				user: { safe: '0xSafe', eoa: '0xEoa' },
				storage: { uploadTree: vi.fn(async () => '0xcid') },
				pinata: { uploadFileFromPath: vi.fn(async () => 'QmStub') },
			},
			settings: {
				litUsageKey: 'test-lit-usage-key',
				kubo_token: '',
				pin_provider: 'filebase',
				pinata_jwt: '',
				filebase_token: '',
			},
		},
		protocolInfo: { gateway: 'https://ipfs.transport-union.dev' },
		notice: { setMessage: vi.fn(), hide: vi.fn() },
		content: { parseNote: vi.fn(async () => ({ tags: [] })) },
		isValidForPublishing: vi.fn(() => true),
		getInitializedService: vi.fn(async () => ({ getMultiSig: vi.fn(async () => '0xpub') })),
		renderCalls: vi.fn(async () => {}),
		newPublication: vi.fn(async () => {}),
		proposeContent: vi.fn(async () => {}),
		revokeContent: vi.fn(async () => {}),
		publishContent: vi.fn(async () => {}),
		...overrides.main,
	};

	return main;
}
