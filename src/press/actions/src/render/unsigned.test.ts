/**
 * `unsigned` input tests for render/main.ts.
 *
 * Contract: a run with `unsigned: true` skips the signature and nothing else.
 * `addAndSignMetadata` still runs, so the JSON-LD colophon is built and
 * inserted; the action passes `{ unsigned: true }` and the function skips only
 * the PKP key read, emitting the same proof-without-proofValue the signing
 * catch emits. Every other step still runs: decryptRaw for encrypted
 * collection items, the plaintext integrity check, the template render and the
 * upload. Absent or false keeps today's behavior: the signing attempt is made.
 *
 * All chain/IPFS interactions are mocked — no live RPC required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { main } from './main';
import type { SingleInput, S2STemplateConfig } from '@s2s/soul2soul-shared/lit-actions';

const sampleTemplateConfig: S2STemplateConfig = {
  reference: 'post',
  file: 'post.hbs',
  path: '/{slug}',
};
const sampleJob = {
  id: '0x9a1600a648241726b0470d0b0b85df1d166e0aa74b88789b5f569294baa5a063',
  templateConfig: sampleTemplateConfig,
  html: '',
  path: '/hello-world',
};
const sampleEndpoints = {
  ipfsGateway: 'https://ipfs.transport-union.dev',
  rpcs: {
    L1: ['https://lb.drpc.live/ethereum/key'],
    L2: ['https://lb.drpc.live/base/key'],
  },
};

// ── Mock the entire dependency tree ──────────────────────────────────────

vi.mock('../libs/decrypt', () => ({
  decryptRaw: vi.fn(),
  decrypt: vi.fn(),
}));
vi.mock('../libs/ens.factory', () => ({
  getDomainOwnerAndModules: vi.fn(),
}));
vi.mock('../libs/ipfs.factory', () => ({
  uploadFile: vi.fn(),
  decodeArchiveCid: vi.fn((v: string) => v),
  catFile: vi.fn(),
}));
vi.mock('../libs/protocol.factory', () => ({
  getManifest: vi.fn(),
}));
vi.mock('../libs/evm', () => ({
  enableReadCache: vi.fn(),
  evmRead: vi.fn(),
  evmWrite: vi.fn(),
  toHexString: vi.fn(),
}));
vi.mock('../libs/module.factory', () => ({
  fetchById: vi.fn(),
  fetchByPublication: vi.fn(),
  fetchByPublicationWithSkips: vi.fn(),
  fetchByPublicationDetailed: vi.fn(),
  getAgreements: vi.fn(),
  getLatestEntry: vi.fn(),
  getVersion: vi.fn(),
  toBody: vi.fn(),
  verifyDecryptedBody: vi.fn(),
}));
vi.mock('../libs/gates', () => ({
  extractSignerAddress: vi.fn(),
  canRead: vi.fn(),
  canPublish: vi.fn(),
}));
vi.mock('../libs/helpers', () => ({
  requireFields: vi.fn(),
  fetchWithTimeout: vi.fn(),
  setRpcAuth: vi.fn(),
  addressToUserId: vi.fn(),
}));
vi.mock('./config.ctrl', () => ({
  getConfig: vi.fn(),
  getTaskConfig: vi.fn(),
}));
vi.mock('./data.ctrlr', () => ({
  initTemplateData: vi.fn(),
  fetchCollections: vi.fn(),
  mergeDecrypted: vi.fn(),
  pathsForCollections: vi.fn(),
  shouldWriteBackCache: vi.fn(),
}));
vi.mock('./metadata', () => ({
  addAndSignMetadata: vi.fn(),
}));
vi.mock('../renderer/html.ctrlr', () => ({
  renderHTML: vi.fn(),
}));

// ── Import mocked deps for test configuration ────────────────────────────

import { getConfig } from './config.ctrl';
import { initTemplateData, fetchCollections, shouldWriteBackCache } from './data.ctrlr';
import { fetchById, verifyDecryptedBody } from '../libs/module.factory';
import { getManifest } from '../libs/protocol.factory';
import { getDomainOwnerAndModules } from '../libs/ens.factory';
import { extractSignerAddress } from '../libs/gates';
import { uploadFile, decodeArchiveCid } from '../libs/ipfs.factory';
import { renderHTML } from '../renderer/html.ctrlr';
import { addAndSignMetadata } from './metadata';
import { decryptRaw } from '../libs/decrypt';

// ── Helpers ──────────────────────────────────────────────────────────────

const RENDERED = '<html>rendered</html>';
const SIGNED = '<html>signed</html>';

const baseInput: SingleInput = {
  job: { ...sampleJob, templateConfig: { ...sampleJob.templateConfig, collections: [] } },
  signature: '0xsig',
  authorSafeAddress: '0xAuthorSafe',
  publication: 'test.soul2soul.eth',
  preview: true,
  endpoints: sampleEndpoints,
};

function setupHappyDeps() {
  vi.mocked(extractSignerAddress).mockReturnValue('0xSigner');
  vi.mocked(getManifest).mockResolvedValue({
    gateway: 'https://ipfs.example.com',
    publicationFactory: '0x' + '88'.repeat(20),
    moduleFactory: '0x' + '77'.repeat(20),
    pkp: { ethAddress: '0xPKP', publicKey: 'pk', tokenId: '1' },
    ensRecords: '0xENS',
    litActions: { prep: 'cid1', render: 'cid2', update: 'cid3' },
  } as any);
  vi.mocked(getDomainOwnerAndModules).mockResolvedValue({
    multisig: '0xMulti',
    configModule: '0xConfigModule',
    publicationModule: '0xPubModule',
  });
  vi.mocked(decodeArchiveCid).mockReturnValue('');
  vi.mocked(fetchById).mockResolvedValue({
    id: sampleJob.id,
    author: '0xaaaa',
    locale: 'en',
    postType: 'post',
    creationDate: '2026-01-01',
    encryption: false,
    content: 'Hello',
    title: 'Test',
    slug: 'test',
    tags: [],
    publication: 'test.soul2soul.eth',
  });
  vi.mocked(getConfig).mockResolvedValue({
    mapping: { templateConfig: [], ripples: [] },
    localePaths: {},
  });
  vi.mocked(initTemplateData).mockResolvedValue({
    id: sampleJob.id,
    path: '/test',
    revoked: false,
    content: 'Hello',
    title: 'Test',
    slug: 'test',
  });
  vi.mocked(fetchCollections).mockResolvedValue({
    collections: {},
    drift: null,
    skips: [],
  });
  vi.mocked(renderHTML).mockResolvedValue(RENDERED);
  vi.mocked(addAndSignMetadata).mockResolvedValue(SIGNED);
  vi.mocked(uploadFile).mockResolvedValue('QmUploaded');
  vi.mocked(shouldWriteBackCache).mockReturnValue(false);
  vi.mocked(verifyDecryptedBody).mockReturnValue('verified');
}

beforeEach(() => {
  vi.clearAllMocks();
  setupHappyDeps();
  (global as any).ethers = {
    utils: {
      hashMessage: vi.fn().mockReturnValue('0xhash'),
      namehash: vi.fn().mockReturnValue('0xnode'),
      toUtf8Bytes: vi.fn(),
    },
  };
});

// ============================================================================
// Tests
// ============================================================================

describe('render action — the `unsigned` input', () => {
  it('asks for an unsigned colophon and uploads the rendered page when unsigned is true', async () => {
    const result = await main({ ...baseInput, unsigned: true });

    expect(result.ok).toBe(true);
    // The colophon is still built; only the signature is skipped.
    expect(addAndSignMetadata).toHaveBeenCalledTimes(1);
    expect(addAndSignMetadata).toHaveBeenCalledWith(
      sampleJob.id,
      RENDERED,
      expect.anything(),
      expect.anything(),
      { unsigned: true },
    );
    expect(uploadFile).toHaveBeenCalledWith(sampleEndpoints.ipfsGateway, SIGNED);
    expect((result as any).data.job.html).toBe('QmUploaded');
    expect(
      result.trace.some(
        (line: any) =>
          typeof line === 'string' &&
          line.includes('provenance unsigned: colophon kept, no signature'),
      ),
    ).toBe(true);
  });

  it('asks for a signed colophon when unsigned is false', async () => {
    const result = await main({ ...baseInput, unsigned: false });

    expect(result.ok).toBe(true);
    expect(addAndSignMetadata).toHaveBeenCalledTimes(1);
    expect(addAndSignMetadata).toHaveBeenCalledWith(
      sampleJob.id,
      RENDERED,
      expect.anything(),
      expect.anything(),
      { unsigned: false },
    );
    expect(uploadFile).toHaveBeenCalledWith(sampleEndpoints.ipfsGateway, SIGNED);
  });

  it('attempts signing when unsigned is absent (deployed callers)', async () => {
    const input = { ...baseInput };
    delete (input as { unsigned?: boolean }).unsigned;

    const result = await main(input);

    expect(result.ok).toBe(true);
    expect(addAndSignMetadata).toHaveBeenCalledTimes(1);
    expect(uploadFile).toHaveBeenCalledWith(sampleEndpoints.ipfsGateway, SIGNED);
  });

  it('still decrypts and verifies encrypted collection items, renders and uploads when unsigned is true', async () => {
    vi.mocked(fetchCollections).mockResolvedValue({
      collections: {
        posts: [
          {
            id: '0xgenesis1',
            cid: 'QmEncryptedCid',
            encryption: true,
            content: 'ciphertext',
            plaintextHash: '0x' + 'ab'.repeat(32),
            author: '0xaaaa',
            locale: 'en',
            postType: 'post',
            creationDate: '2026-01-01',
            publication: 'test.soul2soul.eth',
            tags: [],
          },
        ],
      },
      drift: null,
      skips: [],
    });
    vi.mocked(decryptRaw).mockResolvedValue({
      raw: '{"content":"hello"}',
      parsed: { content: 'hello' },
      rawFromDecryptor: true,
    });

    const result = await main({ ...baseInput, unsigned: true });

    expect(result.ok).toBe(true);
    // The unsigned run is a full render: decrypt, integrity verdict, template,
    // colophon, upload. Only the signature is skipped.
    expect(decryptRaw).toHaveBeenCalledTimes(1);
    expect(verifyDecryptedBody).toHaveBeenCalledTimes(1);
    expect(renderHTML).toHaveBeenCalledTimes(1);
    expect(addAndSignMetadata).toHaveBeenCalledTimes(1);
    expect(addAndSignMetadata).toHaveBeenCalledWith(
      sampleJob.id,
      RENDERED,
      expect.anything(),
      expect.anything(),
      { unsigned: true },
    );
    expect(uploadFile).toHaveBeenCalledWith(sampleEndpoints.ipfsGateway, SIGNED);
  });
});
