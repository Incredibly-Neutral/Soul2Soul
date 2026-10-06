/**
 * Availability classification tests for render/main.ts.
 *
 * Asserts the contract: data-fetch failures are classified as kind "data"
 * (NON-FATAL, genesis + cid recorded), config/template failures are FATAL
 * (ok:false + classified availability entry in trace).
 *
 * All chain/IPFS interactions are mocked — no live RPC required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { main } from './main';
import type { SingleInput, S2STemplateConfig } from '@s2s/soul2soul-shared/lit-actions';

// Inline fixtures (avoids cross-package test-helper imports)
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
  getProtocolInfo: vi.fn(),
}));
vi.mock('../libs/evm', () => ({
  evmRead: vi.fn(),
  evmWrite: vi.fn(),
  toHexString: vi.fn(),
}));
vi.mock('../libs/module.factory', () => ({
  fetchById: vi.fn(),
  fetchByPublication: vi.fn(),
  fetchByPublicationWithSkips: vi.fn(),
  fetchByPublicationDetailed: vi.fn(),
  getDeals: vi.fn(),
  getLatestEntry: vi.fn(),
  getVersion: vi.fn(),
  toBody: vi.fn(),
}));
vi.mock('../libs/gates', () => ({
  extractSignerAddress: vi.fn(),
  canRead: vi.fn(),
  canPublish: vi.fn(),
}));
vi.mock('../libs/helpers', () => ({
  requireFields: vi.fn(),
  fetchWithTimeout: vi.fn(),
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
import { fetchById } from '../libs/module.factory';
import { getProtocolInfo } from '../libs/protocol.factory';
import { getDomainOwnerAndModules } from '../libs/ens.factory';
import { extractSignerAddress } from '../libs/gates';
import { uploadFile, decodeArchiveCid } from '../libs/ipfs.factory';
import { renderHTML } from '../renderer/html.ctrlr';
import { addAndSignMetadata } from './metadata';
import { evmRead } from '../libs/evm';

// ── Helpers ──────────────────────────────────────────────────────────────

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
  vi.mocked(getProtocolInfo).mockResolvedValue({
    gateway: 'https://ipfs.example.com',
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
    author: 'did:ethr:0xaaaa',
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
  vi.mocked(renderHTML).mockResolvedValue('<html>rendered</html>');
  vi.mocked(addAndSignMetadata).mockResolvedValue('<html>signed</html>');
  vi.mocked(uploadFile).mockResolvedValue('QmUploaded');
  vi.mocked(shouldWriteBackCache).mockReturnValue(false);
}

beforeEach(() => {
  vi.clearAllMocks();
  setupHappyDeps();
  // Mock ethers global required by the action
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

describe('render action — availability classification', () => {
  it('records a "data" availability entry with genesis+cid when a collection fetch skip occurs', async () => {
    vi.mocked(fetchCollections).mockResolvedValue({
      collections: {},
      drift: null,
      skips: [
        {
          genesis: '0xdaebfb9a123456789012345678901234567890123456789012345678901234',
          cid: 'QmSkippedCid',
          reason: 'IPFS retrieval failed: 504 Gateway Time-out',
        },
      ],
    });

    const result = await main(baseInput);

    expect(result.ok).toBe(true);
    const data = (result as any).data;
    expect(data.availability).toBeDefined();
    expect(data.availability).toHaveLength(1);
    const entry = data.availability[0];
    expect(entry.kind).toBe('data');
    expect(entry.genesis).toBe(
      '0xdaebfb9a123456789012345678901234567890123456789012345678901234',
    );
    expect(entry.cid).toBe('QmSkippedCid');
    expect(entry.reason).toContain('504 Gateway Time-out');
    expect(entry.fatal).toBe(false);
  });

  it('config fetch failure is FATAL with kind "config" and classified error in trace', async () => {
    vi.mocked(getConfig).mockRejectedValue(new Error('config: failed to cat/parse config CID QmConfig: 504 Gateway Time-out'));

    const result = await main(baseInput);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toBe('');
    expect(result.error).toContain('config');

    // The availability entry should be in trace for ok:false results.
    const availabilityTrace = result.trace.find((t: any) => t?.availability);
    expect(availabilityTrace).toBeDefined();
    expect(availabilityTrace.availability).toHaveLength(1);
    expect(availabilityTrace.availability[0].kind).toBe('config');
    expect(availabilityTrace.availability[0].fatal).toBe(true);
  });

  it('template render failure is FATAL with kind "template" and classified error in trace', async () => {
    vi.mocked(renderHTML).mockRejectedValue(new Error('Handlebars compile error: missing partial'));

    const result = await main(baseInput);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('template render failed');

    const availabilityTrace = result.trace.find((t: any) => t?.availability);
    expect(availabilityTrace).toBeDefined();
    expect(availabilityTrace.availability).toHaveLength(1);
    expect(availabilityTrace.availability[0].kind).toBe('template');
    expect(availabilityTrace.availability[0].fatal).toBe(true);
    expect(availabilityTrace.availability[0].genesis).toBe(baseInput.job.id);
  });

  it('returns ok:true with empty availability when no failures occur', async () => {
    const result = await main(baseInput);

    expect(result.ok).toBe(true);
    const data = (result as any).data;
    // availability is undefined (omitted) when empty
    expect(data.availability).toBeUndefined();
  });

  it('records decrypt failures as non-fatal data entries', async () => {
    // Simulate a collection with an encrypted item that fails to decrypt.
    // The decrypt mock is imported at the top level.
    vi.mocked(fetchCollections).mockResolvedValue({
      collections: {
        posts: [
          {
            id: '0xgenesis1',
            cid: 'QmEncryptedCid',
            encryption: true,
            content: 'ciphertext',
            author: 'did:ethr:0xaaaa',
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
    const { decrypt } = await import('../libs/decrypt');
    (decrypt as any).mockRejectedValue(new Error('Decryption failed: wrong key'));

    const result = await main(baseInput);

    // Data failures are NON-FATAL — render still ok:true.
    expect(result.ok).toBe(true);
    const data = (result as any).data;
    expect(data.availability).toBeDefined();
    const dataEntries = data.availability.filter((a: any) => a.kind === 'data');
    expect(dataEntries.length).toBeGreaterThanOrEqual(1);
    const decryptEntry = dataEntries.find((a: any) => a.reason.includes('Decryption error'));
    expect(decryptEntry).toBeDefined();
    expect(decryptEntry.fatal).toBe(false);
    expect(decryptEntry.genesis).toBe('0xgenesis1');
    expect(decryptEntry.cid).toBe('QmEncryptedCid');
  });
});
