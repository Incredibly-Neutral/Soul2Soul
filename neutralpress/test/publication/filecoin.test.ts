/**
 * Unit tests for src/publication/filecoin.ts — Kubo base URL normalisation and
 * the S2SIPFSMethods client built from plugin/oxo settings (ipfsFromSettings).
 *
 * The old filecoinUploadBackground tests moved into the shared component
 * (S2SIPFSMethods.backupToProviders) — they live in shared/src/ipfs.
 */

import { describe, it, expect } from 'vitest';
import { kuboBaseUrl, ipfsFromSettings } from '../../src/publication/filecoin';
import { S2SIPFSMethods } from '@s2s/soul2soul-shared';
import { makeMain } from '../helpers/main';

describe('kuboBaseUrl', () => {
	it('falls back to the transport-union default when kubo_url is unset', () => {
		const main = makeMain(); // oxo.settings.kubo_url is undefined
		expect(kuboBaseUrl(main)).toBe('https://ipfs.transport-union.dev');
	});

	it('keeps an already-schemed URL as-is', () => {
		const main = makeMain();
		main.oxo.settings.kubo_url = 'https://custom.ipfs.example';
		expect(kuboBaseUrl(main)).toBe('https://custom.ipfs.example');
	});

	it('prepends https:// to a bare host', () => {
		const main = makeMain();
		main.oxo.settings.kubo_url = 'custom.ipfs.example';
		expect(kuboBaseUrl(main)).toBe('https://custom.ipfs.example');
	});
});

describe('ipfsFromSettings', () => {
	it('builds an S2SIPFSMethods with the plugin data_gateway', () => {
		const main = makeMain();
		const ipfs = ipfsFromSettings(main);
		expect(ipfs).toBeInstanceOf(S2SIPFSMethods);
		expect(ipfs.gateway).toBe('https://ipfs.transport-union.dev');
	});

	it('prefers plugin pinata_jwt/filebase_token over oxo settings', () => {
		const main = makeMain();
		(main.plugin.settings as any).pinata_jwt = 'plugin-jwt';
		(main.plugin.settings as any).filebase_token = 'plugin-fb';
		main.oxo.settings.pinata_jwt = 'oxo-jwt';
		main.oxo.settings.filebase_token = 'oxo-fb';
		const ipfs = ipfsFromSettings(main) as any;
		expect(ipfs.pinataJWT).toBe('plugin-jwt');
		expect(ipfs.filebaseToken).toBe('plugin-fb');
	});

	it('falls back to oxo settings tokens when plugin values are unset', () => {
		const main = makeMain();
		main.oxo.settings.pinata_jwt = 'oxo-jwt';
		main.oxo.settings.filebase_token = 'oxo-fb';
		const ipfs = ipfsFromSettings(main) as any;
		expect(ipfs.pinataJWT).toBe('oxo-jwt');
		expect(ipfs.filebaseToken).toBe('oxo-fb');
	});
});
