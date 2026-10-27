/**
 * prep/main.ts — integrity containment (C4).
 *
 * Contract under test:
 *   - one contentId whose stored body fails the plaintextHash check must NOT
 *     abort the prep invocation: it is skipped with a contained trace record,
 *     and every other contentId in the batch still gets its jobs;
 *   - a non-integrity failure (e.g. content genuinely absent) keeps its
 *     pre-existing abort behaviour.
 *
 * Only the chain/IPFS/config edge is mocked — the real
 * fetchById → fetchItemById → readItemByEntry path runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as ethers from 'ethers5';

(globalThis as unknown as { ethers: unknown }).ethers = ethers;

vi.mock('../libs/evm', () => ({ evmRead: vi.fn() }));
vi.mock('../libs/ipfs.factory', () => ({ catFile: vi.fn() }));
vi.mock('../libs/ens.factory', () => ({ getDomainOwnerAndModules: vi.fn() }));
vi.mock('../libs/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../libs/helpers')>();
  return { ...actual, setRpcAuth: vi.fn() };
});
vi.mock('../render/config.ctrl', () => ({ getConfig: vi.fn(), getTaskConfig: vi.fn() }));

import { main } from './main';
import { evmRead } from '../libs/evm';
import { catFile } from '../libs/ipfs.factory';
import { getDomainOwnerAndModules } from '../libs/ens.factory';
import { getConfig, getTaskConfig } from '../render/config.ctrl';
import type { PrepInput } from '@s2s/soul2soul-shared/lit-actions';

const FORGED_GENESIS = '0x' + '11'.repeat(32);
const GOOD_GENESIS = '0x' + '22'.repeat(32);
const FORGED_CID = 'bafyforged';
const GOOD_CID = 'bafygood';
const PUBLICATION = 'test.soul2soul.eth';
const AUTHOR = 'did:ethr:0x' + 'a'.repeat(40);

const PLAINTEXT = JSON.stringify({ content: 'Hello', slug: 'hello', title: 'Hello' });
const PLAINTEXT_HASH = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(PLAINTEXT));
const FORGED_PLAINTEXT = JSON.stringify({ content: 'FORGED', slug: 'hello', title: 'Hello' });

const item = (body: string) => ({
  public: {
    specVersion: '1',
    author: AUTHOR,
    postType: 'post',
    mediaType: 'text/markdown',
    parent: '',
    position: '0',
    publication: PUBLICATION,
    locale: 'en',
    createdAt: 1700000000,
    tags: [],
    plaintextHash: PLAINTEXT_HASH,
  },
  objectId: '0x' + 'de'.repeat(32),
  proof: { type: 'eip712', signer: '0x' + 'b'.repeat(40), signature: '0x' + 'cc'.repeat(65) },
  encryption: false,
  body,
});

const input = (contentIds: string[]): PrepInput => ({
  publication: PUBLICATION,
  contentIds,
  endpoints: {
    ipfsGateway: 'https://ipfs.example',
    rpcs: { L1: ['https://rpc.l1'], L2: ['https://rpc.l2'] },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDomainOwnerAndModules).mockResolvedValue({
    multisig: '0xms',
    configModule: '0xcfg',
    publicationModule: '0xpub',
  });
  vi.mocked(getConfig).mockResolvedValue({ mapping: {} });
  vi.mocked(getTaskConfig).mockResolvedValue({
    templateConfig: { reference: 'post', file: 'post.hbs', path: '/{slug}' },
    rippleConfigs: [],
  } as never);

  vi.mocked(evmRead).mockImplementation(((
    _chain: string,
    _address: string,
    _abi: unknown,
    fn: string,
    args?: unknown[],
  ): Promise<unknown> => {
    if (fn === 'getLatest') {
      const genesis = String((args ?? [])[0]);
      const cid = genesis === FORGED_GENESIS ? FORGED_CID : GOOD_CID;
      return Promise.resolve({ genesis, author: '0xauthor', cid, timestamp: 1700000000 });
    }
    if (fn === 'getVersionCount') return Promise.resolve(1);
    if (fn === 'getText') return Promise.resolve('');
    return Promise.reject(new Error(`unexpected evmRead: ${fn}`));
  }) as never);

  vi.mocked(catFile).mockImplementation(((gateway: string, cid: string) => {
    if (cid === FORGED_CID) return Promise.resolve(JSON.stringify(item(FORGED_PLAINTEXT)));
    if (cid === GOOD_CID) return Promise.resolve(JSON.stringify(item(PLAINTEXT)));
    return Promise.reject(new Error(`unexpected cat: ${cid}`));
  }) as never);
});

describe('prep — one forged item does not abort the batch', () => {
  it('skips the forged contentId, keeps the good one, and records the skip in trace', async () => {
    const result = await main(input([FORGED_GENESIS, GOOD_GENESIS]));

    if (!result.ok) throw new Error(`prep failed: ${result.error}`);
    const jobs = (result.data as { jobs: { id: string }[] }).jobs;
    expect(jobs.map((j) => j.id)).toEqual([GOOD_GENESIS]);

    const skipped = (result.trace as { skipped?: unknown[] }[]).find((t) => t.skipped)?.skipped as
      | { genesis: string; cid: string; reason: string }[]
      | undefined;
    expect(skipped).toHaveLength(1);
    expect(skipped?.[0].genesis).toBe(FORGED_GENESIS);
    expect(skipped?.[0].cid).toBe(FORGED_CID);
    expect(skipped?.[0].reason).toContain('plaintext hash mismatch');
  });

  it('still fails the invocation when the content is genuinely absent', async () => {
    vi.mocked(evmRead).mockResolvedValue({
      genesis: GOOD_GENESIS,
      author: '0xauthor',
      cid: '',
      timestamp: 1700000000,
    } as never);

    const result = await main(input([GOOD_GENESIS]));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(String(result.error)).toContain('not found');
  });
});
