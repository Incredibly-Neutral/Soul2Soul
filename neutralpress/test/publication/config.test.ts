/**
 * Unit tests for src/publication/config.ts — publication config upload +
 * shaping.
 *
 * `uploadConfig` orchestrates: read existing config (optional) → pull
 * templates from the dev repo → IPFS-add each → dagPut the template list →
 * fetch mapping.json → build the S2SPublicationConfig → IPFS-add it. The
 * github helpers are mocked so we control the template/mapping payloads; the
 * ipfs surface (getJsonLike/add/dagPut) is stubbed on the makeMain fixture.
 *
 * `createConfig` is the pure shaping step and is asserted for exact shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/publication/github', () => ({
	getAllFilesRecursive: vi.fn(),
	getLatestCommitSHA: vi.fn(),
	fetchFileFromGithub: vi.fn(),
}));

import {
	getAllFilesRecursive,
	getLatestCommitSHA,
	fetchFileFromGithub,
} from '../../src/publication/github';
import { uploadConfig, createConfig } from '../../src/publication/config';
import { makeMain } from '../helpers/main';

const mockGetAllFiles = vi.mocked(getAllFilesRecursive);
const mockGetLatestCommitSHA = vi.mocked(getLatestCommitSHA);
const mockFetchFileFromGithub = vi.mocked(fetchFileFromGithub);

const GATEWAY = 'https://ipfs.transport-union.dev';
const MAPPING_JSON = JSON.stringify({ localePaths: { default: '', en: '/en' } });

function mainWithIpfs(overrides: Record<string, any> = {}) {
	const main = makeMain();
	main.oxo.ctrlr.ipfs = {
		getJsonLike: vi.fn(async () => ({})),
		add: vi.fn(async (data: any) => (typeof data === 'object' ? 'final-config-cid' : `cid-${data}`)),
		dagPut: vi.fn(async () => 'templates-cid'),
		...overrides,
	};
	return main;
}

const publication = {
	name: 'Acme',
	contract: '0xContract',
	configCid: undefined,
	devRepository: 'https://github.com/acme/publisher',
	branch: 'main',
};

beforeEach(() => {
	vi.restoreAllMocks();
	mockGetAllFiles.mockReset();
	mockGetLatestCommitSHA.mockReset();
	mockFetchFileFromGithub.mockReset();
});

describe('createConfig (pure shaping)', () => {
	it('returns the exact S2SPublicationConfig shape', () => {
		const protocolInfo = { gateway: GATEWAY } as any;
		const pub = { name: 'Acme', contract: '0xContract' } as any;

		const config = createConfig(protocolInfo, pub, { stylesheets: [], templates: [] }, 'templates-cid', MAPPING_JSON);

		expect(config).toEqual({
			assetsCid: '',
			contract: '0xContract',
			dataGateway: GATEWAY,
			mapping: { localePaths: { default: '', en: '/en' } },
			name: 'Acme',
			templateCid: 'templates-cid',
			localePaths: { default: '', en: '/en' },
		});
	});

	it('defaults contract to "" when unset', () => {
		const config = createConfig(
			{ gateway: GATEWAY } as any,
			{ name: 'X' } as any,
			{},
			'tc',
			'{"localePaths":{"default":""}}',
		);
		expect(config.contract).toBe('');
	});
});

describe('uploadConfig — fresh publication (no configCid)', () => {
	beforeEach(() => {
		mockGetAllFiles.mockResolvedValue([
			{ path: 'templates/index.html', url: 'https://raw/.../index.html', download_url: 'https://raw/.../index.html' },
		]);
		// template content first, then mapping.json. The template body is
		// newline-stripped and single-backslash-stripped by uploadConfig.
		mockFetchFileFromGithub
			.mockResolvedValueOnce('  <h1>Hello\\world</h1>  \n')
			.mockResolvedValue(MAPPING_JSON);
		mockGetLatestCommitSHA.mockResolvedValue('sha456');
	});

	it('pulls templates, dagPuts the list, builds config and returns the final CID', async () => {
		const main = mainWithIpfs();
		const result = await uploadConfig(main, publication as any);

		// github orchestration
		expect(mockGetAllFiles).toHaveBeenCalledWith('acme', 'publisher', 'main', 'templates');
		expect(mockFetchFileFromGithub).toHaveBeenNthCalledWith(
			1,
			'https://raw/.../index.html',
		);
		expect(mockFetchFileFromGithub).toHaveBeenLastCalledWith(
			'https://raw.githubusercontent.com/acme/publisher/sha456/mapping.json',
		);
		expect(mockGetLatestCommitSHA).toHaveBeenCalledWith(publication);

		// template was newline/backslash-stripped before add + stored as body
		const ipfs = main.oxo.ctrlr.ipfs;
		const templateAddCalls = (ipfs.add as any).mock.calls.filter(
			(c: any[]) => typeof c[0] === 'string',
		);
		// input '  <h1>Hello\\world</h1>  \n' → strip newline → strip '\w' → 'w'
		expect(templateAddCalls[0][0]).toBe('  <h1>Helloworld</h1>  ');
		expect(templateAddCalls).toHaveLength(2); // add(…, true) + add(…, false)

		// dagPut of the template list with the gateway
		expect(ipfs.dagPut).toHaveBeenCalledWith(
			[{ path: 'templates/index.html', cid: 'cid-  <h1>Helloworld</h1>  ', body: '  <h1>Helloworld</h1>  ' }],
			GATEWAY,
		);

		// final add receives the shaped config object → its CID is returned
		const configAddCall = (ipfs.add as any).mock.calls.find(
			(c: any[]) => typeof c[0] === 'object',
		);
		expect(configAddCall[0]).toEqual({
			assetsCid: '',
			contract: '0xContract',
			dataGateway: GATEWAY,
			mapping: { localePaths: { default: '', en: '/en' } },
			name: 'Acme',
			templateCid: 'templates-cid',
			localePaths: { default: '', en: '/en' },
		});
		expect(configAddCall[1]).toBe(GATEWAY);
		expect(result).toBe('final-config-cid');
	});

	it('starts from an empty config when there is no existing configCid', async () => {
		const main = mainWithIpfs();
		await uploadConfig(main, publication as any);
		expect(main.oxo.ctrlr.ipfs.getJsonLike).not.toHaveBeenCalled();
	});
});

describe('uploadConfig — existing configCid', () => {
	it('merges new templates into the existing template list', async () => {
		const main = mainWithIpfs({
			getJsonLike: vi.fn(async () => ({
				stylesheets: [],
				templates: [{ path: 'templates/old.html', cid: 'cid-old' }],
			})),
		});
		mockGetAllFiles.mockResolvedValue([
			{ path: 'templates/new.html', url: 'https://raw/.../new.html' },
		]);
		mockFetchFileFromGithub
			.mockResolvedValueOnce('new-body')
			.mockResolvedValue(MAPPING_JSON);
		mockGetLatestCommitSHA.mockResolvedValue('sha1');

		await uploadConfig(main, { ...publication, configCid: 'QmExisting' } as any);

		expect(main.oxo.ctrlr.ipfs.getJsonLike).toHaveBeenCalledWith('QmExisting', GATEWAY);
		expect(main.oxo.ctrlr.ipfs.dagPut).toHaveBeenCalledWith(
			[
				{ path: 'templates/old.html', cid: 'cid-old' },
				{ path: 'templates/new.html', cid: 'cid-new-body', body: 'new-body' },
			],
			GATEWAY,
		);
	});

	it('treats a Type:error config read as an empty config', async () => {
		const main = mainWithIpfs({
			getJsonLike: vi.fn(async () => ({ Type: 'error' })),
		});
		mockGetAllFiles.mockResolvedValue([]);
		mockFetchFileFromGithub.mockResolvedValue(MAPPING_JSON);
		mockGetLatestCommitSHA.mockResolvedValue('sha1');

		const result = await uploadConfig(main, { ...publication, configCid: 'QmBad' } as any);

		// empty templates → dagPut([]) then final add still runs
		expect(main.oxo.ctrlr.ipfs.dagPut).toHaveBeenCalledWith([], GATEWAY);
		expect(result).toBe('final-config-cid');
	});

	it('skips re-upload when the template cid is already present', async () => {
		const main = mainWithIpfs({
			getJsonLike: vi.fn(async () => ({
				templates: [{ path: 'templates/x.html', cid: 'cid-x' }],
			})),
		});
		mockGetAllFiles.mockResolvedValue([
			{ path: 'templates/x.html', url: 'https://raw/.../x.html' },
		]);
		mockFetchFileFromGithub.mockResolvedValueOnce('x').mockResolvedValue(MAPPING_JSON);
		mockGetLatestCommitSHA.mockResolvedValue('sha1');
		main.oxo.ctrlr.ipfs.add = vi.fn(async () => 'cid-x');

		await uploadConfig(main, { ...publication, configCid: 'QmX' } as any);

		const templateAddCalls = (main.oxo.ctrlr.ipfs.add as any).mock.calls.filter(
			(c: any[]) => typeof c[0] === 'string',
		);
		// only the pre-check add(…, true) — no duplicate add(…, false), no push
		expect(templateAddCalls).toHaveLength(1);
		expect(main.oxo.ctrlr.ipfs.dagPut).toHaveBeenCalledWith(
			[{ path: 'templates/x.html', cid: 'cid-x' }],
			GATEWAY,
		);
	});
});

describe('uploadConfig — failure behavior', () => {
	it('swallows errors and returns undefined', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const main = mainWithIpfs();
		mockGetAllFiles.mockRejectedValue(new Error('repo gone'));

		await expect(uploadConfig(main, publication as any)).resolves.toBeUndefined();
		expect(logSpy).toHaveBeenCalledWith(new Error('repo gone'));
	});
});
