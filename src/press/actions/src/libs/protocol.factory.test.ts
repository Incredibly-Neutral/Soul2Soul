/**
 * `getManifest` — the manifest document, from the manifest module.
 *
 * `getManifest` makes one call, `getManifest()` on `0x0CbCB9…`, and nothing
 * else: no records module, no ENS walk, no `VERSION()` beside the document.
 * What it pins: the single read, the current document versus a named version's
 * snapshot, the document mapped onto `S2SManifest`, optional action CIDs omitted
 * rather than present as the empty string, and a failure that names the version
 * read for each of the ways a document can be unreadable — absent, unparsable,
 * wrong shape, wrong version for the index.
 *
 * It is the only read an action makes before discovery: the document carries the
 * factory, so there is no separate `publication_factory` call left to pin.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  /** The document, JSON: `''` for an empty answer, or `'revert'`. */
  manifest: '' as string,
  /** What the module's index answers as the current version, or `'revert'`. */
  index: '0.1.0' as string,
  /** A stray `getRecord`/`getRecords` read shows up here. */
  answer: '' as string,
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
    async (
      _chain: string,
      _address: string,
      _abi: unknown,
      method: string,
      args: any[],
    ): Promise<any> => {
      if (method === 'getManifest') {
        if (mocks.manifest === 'revert' || mocks.index === 'revert') {
          throw new Error('execution reverted: NoManifest()');
        }
        // The versioned overload answers the JSON alone; the no-argument one
        // answers a named pair, as ethers decodes a two-value return.
        if (args.length) return mocks.manifest;
        return { version: mocks.index, json: mocks.manifest };
      }
      if (method === 'getRecord') return mocks.answer;
      if (method === 'getRecords') return mocks.records;
      return '';
    },
  ),
}));

import { evmRead } from './evm';
import { getManifest } from './protocol.factory';

const MANIFEST_MODULE = '0x0CbCB9FbbEA0A8DE0547fDb5389b24edB447873F';
const FACTORY = '0x' + '77'.repeat(20);
const PUB_RECORD = '0x' + '55'.repeat(20);
const PKP = '0x' + '44'.repeat(20);

const manifestReads = () =>
  vi.mocked(evmRead).mock.calls.filter(([, , , method]) => method === 'getManifest');

/** The document as the writer publishes it: camelCase, every required field. */
const document = (overrides: Record<string, unknown> = {}) => ({
  version: '0.1.0',
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
  mocks.index = '0.1.0';
  mocks.records = [];
});

describe('getManifest', () => {
  it('maps the document onto S2SManifest', async () => {
    const info = await getManifest();

    expect(info.version).toBe('0.1.0');
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

  it('reads the current document with one call on the module, and nothing else', async () => {
    await getManifest();

    expect(vi.mocked(evmRead).mock.calls).toHaveLength(1);

    const [read] = manifestReads();
    expect(read[0]).toBe('L2');
    expect(read[1]).toBe(MANIFEST_MODULE);
    expect(read[4]).toEqual([]);
  });

  it('reads a named version from the versioned overload, not the current document', async () => {
    mocks.manifest = JSON.stringify(document({ version: '0.1.4' }));

    const info = await getManifest(undefined, '0.1.4');

    expect(info.version).toBe('0.1.4');
    const [read] = manifestReads();
    expect(read[4]).toEqual(['0.1.4']);
  });

  it('passes the caller’s L2 RPC URLs to the read', async () => {
    const rpcs = { L1: ['http://l1'], L2: ['http://l2'] };

    await getManifest(rpcs);

    for (const call of vi.mocked(evmRead).mock.calls) {
      expect(call[5]).toEqual(rpcs.L2);
    }
  });

  it('omits an optional action CID the document does not carry, rather than returning it as empty', async () => {
    const info = await getManifest();

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

    const info = await getManifest();

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

    await expect(getManifest()).rejects.toThrow(/manifest: .*litActions\.encrypt/);
  });

  it('throws naming the version when the module answers nothing', async () => {
    mocks.manifest = '';

    await expect(getManifest()).rejects.toThrow(/manifest: version 0\.1\.0 is empty/);
    expect(manifestReads()).toHaveLength(1);
  });

  it('throws naming the module when the read reverts', async () => {
    mocks.index = 'revert';

    await expect(getManifest()).rejects.toThrow(
      new RegExp(`manifest: cannot read the current version on ${MANIFEST_MODULE}`),
    );
    await expect(getManifest(undefined, '0.1.4')).rejects.toThrow(
      /manifest: cannot read version 0\.1\.4/,
    );
  });

  it('throws on invalid JSON', async () => {
    mocks.manifest = '{"version":"2.1.0",';

    await expect(getManifest()).rejects.toThrow(/manifest: version 0\.1\.0 is not valid JSON/);
  });

  it('throws when the JSON is not an object', async () => {
    mocks.manifest = '"2.1.0"';

    await expect(getManifest()).rejects.toThrow(/manifest: .*not a JSON object/);
  });

  it('throws when version is absent or not x.y.z', async () => {
    mocks.manifest = JSON.stringify(document({ version: '2.1' }));
    await expect(getManifest()).rejects.toThrow(/manifest: 'version'/);

    mocks.manifest = JSON.stringify(document({ version: undefined }));
    await expect(getManifest()).rejects.toThrow(/manifest: 'version'/);
  });

  it('throws when a required address is missing or empty', async () => {
    for (const field of [
      'gateway',
      'ensRegistry',
      'ensRecords',
      'publicationFactory',
      'recordsFactory',
      'pkp',
    ]) {
      mocks.manifest = JSON.stringify(document({ [field]: '' }));
      await expect(getManifest()).rejects.toThrow(new RegExp(`manifest: '${field}'`));

      mocks.manifest = JSON.stringify(document({ [field]: undefined }));
      await expect(getManifest()).rejects.toThrow(new RegExp(`manifest: '${field}'`));
    }
  });

  it('throws when litActions or one of the three CIDs is missing', async () => {
    const { litActions, ...withoutActions } = document();
    mocks.manifest = JSON.stringify(withoutActions);
    await expect(getManifest()).rejects.toThrow(/manifest: 'litActions'/);

    mocks.manifest = JSON.stringify(
      document({ litActions: { prep: 'bafyprep', render: 'bafyrender' } }),
    );
    await expect(getManifest()).rejects.toThrow(/manifest: 'litActions\.update'/);
  });

  it('refuses a document whose own version disagrees with the index', async () => {
    mocks.manifest = JSON.stringify(document({ version: '0.1.3' }));
    mocks.index = '0.1.0';

    await expect(getManifest()).rejects.toThrow(/version 0\.1\.0 carries document version 0\.1\.3/);
  });

  it('refuses a named version answered with another document', async () => {
    mocks.manifest = JSON.stringify(document({ version: '0.1.0' }));

    await expect(getManifest(undefined, '0.1.4')).rejects.toThrow(
      /version 0\.1\.4 carries document version 0\.1\.0/,
    );
  });

  it('takes the factory discovery asks from the document, not from a second read', async () => {
    const info = await getManifest();

    expect(info.moduleFactory).toBe(PUB_RECORD);
    expect(info.publicationFactory).toBe(PUB_RECORD);
    // Nothing else was read: no record, no VERSION(), no ENS walk.
    expect(manifestReads()).toHaveLength(1);
    expect(
      vi.mocked(evmRead).mock.calls.filter(([, , , method]) => method !== 'getManifest'),
    ).toHaveLength(0);
  });
});
