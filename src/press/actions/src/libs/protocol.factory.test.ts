/**
 * `getManifest` — the manifest document, plus the module version beside it.
 *
 * `getManifest` reads `getRecord('manifest')` and `VERSION()` on the records
 * module, and nothing else. What it pins: the two-read sequence, the document
 * mapped onto `S2SManifest`, optional action CIDs omitted rather than present as
 * the empty string, and a failure that names `manifest` for each of the four
 * ways a document can be unreadable — missing, unparsable, wrong shape, wrong
 * major. It is the only read an action makes before discovery: the document
 * carries the factory, so there is no separate `publication_factory` call left
 * to pin.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  /** Still answered for any other `getRecord` key, so a stray read shows up. */
  answer: '' as string,
  /** The `manifest` record: JSON, `''` for absent, or `'revert'`. */
  manifest: '' as string,
  /** What `VERSION()` on the module answers, or `'revert'`. */
  version: '1' as string,
  /** Still answered for `getRecords`, so a stray key-list read shows up. */
  records: [] as any[],
}));

// ens.factory (imported through protocol.factory) computes the two module kinds
// from the bundle's runtime `ethers` global at module load.
vi.hoisted(() => {
  (globalThis as any).ethers = {
    utils: {
      id: (text: string) =>
        text === 's2s.module.publication' ? '0x' + '93'.repeat(32) : '0x' + '32'.repeat(32),
      namehash: () => '0x' + 'ab'.repeat(32),
    },
  };
});

vi.mock('./evm', () => ({
  evmRead: vi.fn(
    async (chain: string, address: string, abi: unknown, method: string, args: any[]) => {
      if (method === 'getRecord') {
        if (args[0] === 'manifest') {
          if (mocks.manifest === 'revert') throw new Error('execution reverted');
          return mocks.manifest;
        }
        if (mocks.answer === 'revert') throw new Error('execution reverted');
        return mocks.answer;
      }
      if (method === 'VERSION') {
        if (mocks.version === 'revert') throw new Error('execution reverted');
        return mocks.version;
      }
      if (method === 'getRecords') return mocks.records;
      return '';
    },
  ),
}));

import { evmRead } from './evm';
import { getManifest } from './protocol.factory';

const RECORDS_MODULE = '0xBB0BBd828c19502a8fCFbF07f5ACEcd8E8641D29';
const FACTORY = '0x' + '77'.repeat(20);
const PUB_RECORD = '0x' + '55'.repeat(20);
const PKP = '0x' + '44'.repeat(20);

const recordReads = () =>
  vi.mocked(evmRead).mock.calls.filter(([, , , method]) => method === 'getRecord');
const versionReads = () =>
  vi.mocked(evmRead).mock.calls.filter(([, , , method]) => method === 'VERSION');
const recordsReads = () =>
  vi.mocked(evmRead).mock.calls.filter(([, , , method]) => method === 'getRecords');

/** The document as the writer publishes it: camelCase, every required field. */
const document = (overrides: Record<string, unknown> = {}) => ({
  version: '1.0.0',
  gateway: 'https://gw.example',
  ensRegistry: '0x' + '02'.repeat(20),
  ensRecords: '0x' + '03'.repeat(20),
  publicationFactory: PUB_RECORD,
  recordsFactory: '0x' + '04'.repeat(20),
  pkp: PKP,
  litActions: {
    prep: 'bafyprep',
    render: 'bafyrender',
    update: 'bafyupdate',
  },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.answer = '';
  mocks.manifest = JSON.stringify(document());
  mocks.version = '1';
  mocks.records = [];
});

describe('getManifest', () => {
  it('maps the document onto S2SManifest', async () => {
    const info = await getManifest(false);

    expect(info.version).toBe('1.0.0');
    expect(info.gateway).toBe('https://gw.example');
    expect(info.ensRegistry).toBe('0x' + '02'.repeat(20));
    expect(info.ensRecords).toBe('0x' + '03'.repeat(20));
    expect(info.publicationFactory).toBe(PUB_RECORD);
    expect(info.moduleFactory).toBe(PUB_RECORD);
    expect(info.recordsFactory).toBe('0x' + '04'.repeat(20));
    expect(info.pkp).toBe(PKP);
    expect(info.litActions).toEqual({
      prep: 'bafyprep',
      render: 'bafyrender',
      update: 'bafyupdate',
    });
  });

  it('reads the manifest record then VERSION() on the records module, and nothing else', async () => {
    await getManifest(false);

    expect(vi.mocked(evmRead).mock.calls).toHaveLength(2);

    const [record] = recordReads();
    expect(record[0]).toBe('L2');
    expect(record[1]).toBe(RECORDS_MODULE);
    expect(record[4]).toEqual(['manifest']);

    const [version] = versionReads();
    expect(version[0]).toBe('L2');
    expect(version[1]).toBe(RECORDS_MODULE);

    expect(recordsReads()).toHaveLength(0);
  });

  it('reads the record before the version, so an unreadable document fails first', async () => {
    await getManifest(false);

    const order = vi.mocked(evmRead).mock.calls.map(([, , , method]) => method);
    expect(order).toEqual(['getRecord', 'VERSION']);
  });

  it('passes the caller’s L2 RPC URLs to both reads', async () => {
    const rpcs = { L1: ['http://l1'], L2: ['http://l2'] };

    await getManifest(false, rpcs);

    for (const call of vi.mocked(evmRead).mock.calls) {
      expect(call[5]).toEqual(rpcs.L2);
    }
  });

  it('accepts a document whose minor segment differs from VERSION(), 1.2.0 beside 1', async () => {
    mocks.manifest = JSON.stringify(document({ version: '1.2.0' }));
    mocks.version = '1';

    const info = await getManifest(false);

    expect(info.version).toBe('1.2.0');
  });

  it('omits an optional action CID the document does not carry, rather than returning it as empty', async () => {
    const info = await getManifest(false);

    expect('maintainCache' in info.litActions).toBe(false);
    expect('repointArchive' in info.litActions).toBe(false);
    expect('encrypt' in info.litActions).toBe(false);
    expect('decrypt' in info.litActions).toBe(false);
  });

  it('carries every optional action CID the document does have', async () => {
    mocks.manifest = JSON.stringify(
      document({
        litActions: {
          prep: 'bafyprep',
          render: 'bafyrender',
          update: 'bafyupdate',
          maintainCache: 'bafycache',
          repointArchive: 'bafyrepoint',
          encrypt: 'bafyenc',
          decrypt: 'bafydec',
        },
      }),
    );

    const info = await getManifest(false);

    expect(info.litActions.maintainCache).toBe('bafycache');
    expect(info.litActions.repointArchive).toBe('bafyrepoint');
    expect(info.litActions.encrypt).toBe('bafyenc');
    expect(info.litActions.decrypt).toBe('bafydec');
  });

  it('refuses a document with no optional CIDs only when one is malformed', async () => {
    // Absent is fine (previous test); present as the empty string is not.
    mocks.manifest = JSON.stringify(
      document({
        litActions: {
          prep: 'bafyprep',
          render: 'bafyrender',
          update: 'bafyupdate',
          encrypt: '',
        },
      }),
    );

    await expect(getManifest(false)).rejects.toThrow(/manifest: .*litActions\.encrypt/);
  });

  it('throws naming manifest when the record is missing, without reading VERSION()', async () => {
    mocks.manifest = '';

    await expect(getManifest(false)).rejects.toThrow(/manifest: no 'manifest' record/);
    expect(versionReads()).toHaveLength(0);
  });

  it('throws naming manifest when the read reverts', async () => {
    mocks.manifest = 'revert';

    await expect(getManifest(false)).rejects.toThrow(
      /manifest: the 'manifest' record is unreadable/,
    );
    expect(versionReads()).toHaveLength(0);
  });

  it('throws naming manifest on invalid JSON', async () => {
    mocks.manifest = '{"version":"2.1.0",';

    await expect(getManifest(false)).rejects.toThrow(
      /manifest: the 'manifest' record is not valid JSON/,
    );
    expect(versionReads()).toHaveLength(0);
  });

  it('throws naming manifest when the JSON is not an object', async () => {
    mocks.manifest = '"2.1.0"';

    await expect(getManifest(false)).rejects.toThrow(/manifest: .*not a JSON object/);
  });

  it('throws naming manifest when version is absent or not x.y.z', async () => {
    mocks.manifest = JSON.stringify(document({ version: '2.1' }));
    await expect(getManifest(false)).rejects.toThrow(/manifest: 'version'/);

    mocks.manifest = JSON.stringify(document({ version: undefined }));
    await expect(getManifest(false)).rejects.toThrow(/manifest: 'version'/);
  });

  it('throws naming manifest when a required address is missing or empty', async () => {
    for (const field of [
      'gateway',
      'ensRegistry',
      'ensRecords',
      'publicationFactory',
      'recordsFactory',
      'pkp',
    ]) {
      mocks.manifest = JSON.stringify(document({ [field]: '' }));
      await expect(getManifest(false)).rejects.toThrow(new RegExp(`manifest: '${field}'`));

      mocks.manifest = JSON.stringify(document({ [field]: undefined }));
      await expect(getManifest(false)).rejects.toThrow(new RegExp(`manifest: '${field}'`));
    }
  });

  it('throws naming manifest when litActions or one of the three CIDs is missing', async () => {
    const { litActions, ...withoutActions } = document();
    mocks.manifest = JSON.stringify(withoutActions);
    await expect(getManifest(false)).rejects.toThrow(/manifest: 'litActions'/);

    mocks.manifest = JSON.stringify(document({ litActions: { prep: 'bafyprep', render: 'bafyrender' } }));
    await expect(getManifest(false)).rejects.toThrow(/manifest: 'litActions\.update'/);
  });

  it('throws naming manifest on a major mismatch with VERSION()', async () => {
    mocks.manifest = JSON.stringify(document({ version: '3.0.0' }));
    mocks.version = '1';

    await expect(getManifest(false)).rejects.toThrow(
      /manifest: document version 3\.0\.0 is not compatible with VERSION\(\) 1/,
    );
  });

  it('throws naming manifest when VERSION() is unreadable', async () => {
    mocks.version = 'revert';

    await expect(getManifest(false)).rejects.toThrow(/manifest: VERSION\(\) is unreadable/);
  });

  it('takes the factory discovery asks from the document, not from a second read', async () => {
    const info = await getManifest(false);

    expect(info.moduleFactory).toBe(PUB_RECORD);
    expect(info.publicationFactory).toBe(PUB_RECORD);
    expect(recordReads()).toHaveLength(1);
    expect(recordReads()[0][4]).toEqual(['manifest']);
  });

  it('compares the document major against VERSION() as a whole string', async () => {
    mocks.version = '1.0.0';

    await expect(getManifest(false)).rejects.toThrow(/VERSION\(\) 1\.0\.0/);
  });
});
