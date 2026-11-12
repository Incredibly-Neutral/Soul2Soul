import { describe, it, expect } from 'vitest';
import { decryptAction } from '../actions/decrypt.js';
import { LEGACY_AUTHOR_PREFIX } from '../../manuscript/identity/author-address.js';
import { DRAFTS_MODULE_INTERFACE_ID, OWNER_HISTORY_MODULE_INTERFACE_ID } from '../../gates/modules.js';

/**
 * The decrypt action is a string, so it is evaluated here with stubs rather than
 * imported as a function. Nothing leaves the process: ethers is a stub with the
 * four utils the action uses plus a Contract that answers out of a table, and
 * `fetch` is a function.
 *
 * The table is a whole author Safe: an enabled-module list, the two role ids
 * those modules answer, the drafts log's fetch/blocksOf and the history module's
 * isOwnerAt. Every call is recorded, because resolution is most of what the
 * action now does.
 */

const SIGNER = '0x1111111111111111111111111111111111111111';
const AUTHOR = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const DRAFTS = '0x4444444444444444444444444444444444444444';
const HISTORY = '0x5555555555555555555555555555555555555555';
const PUBLICATION_MODULE = '0x6666666666666666666666666666666666666666';
const ZERO = '0x0000000000000000000000000000000000000000';
const GENESIS = '0x' + 'ab'.repeat(32);
const CID = 'bafybeigdyrzt';
const PLAINTEXT = '{"title":"hello"}';
const GATEWAY = 'https://gw.example';
const APPEND_BLOCK = 4321;

/** Deterministic stand-in for keccak: the bytes' hex, left-aligned to 32 bytes. */
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const keccak = (bytes: Uint8Array) => '0x' + (hex(bytes) + '0'.repeat(64)).slice(0, 64);
const utf8 = (s: string) => new TextEncoder().encode(s);
const hashOf = (s: string) => keccak(utf8(s));

interface Read {
  target: string;
  fn: string;
  args: unknown[];
}

const item = (over: Record<string, unknown> = {}) => ({
  encryption: true,
  body: 'cipher-blob',
  public: { author: AUTHOR, plaintextHash: hashOf(PLAINTEXT) },
  ...over,
});

function load(
  opts: {
    entry?: unknown;
    blocks?: unknown;
    isOwner?: boolean;
    isOwnerAt?: boolean;
    enabled?: string[];
    answers?: Record<string, string[]>;
    reverts?: string[];
    itemJson?: unknown;
    decryptResult?: unknown;
    signer?: string;
    pages?: [string[], string][];
  } = {},
) {
  const reads: Read[] = [];
  const cats: string[] = [];

  const entry = opts.entry ?? {
    genesis: GENESIS,
    author: AUTHOR,
    cid: CID,
    timestamp: 0,
    versionCount: 1,
  };

  const enabled = opts.enabled ?? [PUBLICATION_MODULE, DRAFTS, HISTORY];
  const answers = opts.answers ?? {
    [DRAFTS]: [DRAFTS_MODULE_INTERFACE_ID],
    [HISTORY]: [OWNER_HISTORY_MODULE_INTERFACE_ID],
  };
  const reverts = opts.reverts ?? [];
  let pageIndex = 0;

  const ethersStub = {
    utils: {
      keccak256: keccak,
      toUtf8Bytes: utf8,
      hashMessage: (m: string) => hashOf(m),
      recoverAddress: () => opts.signer ?? SIGNER,
    },
    providers: {
      StaticJsonRpcProvider: class {
        constructor(public connection: unknown) {}
      },
    },
    Contract: class {
      constructor(public target: string) {}
      private record(fn: string, args: unknown[]) {
        reads.push({ target: this.target, fn, args });
        if (reverts.includes(this.target)) throw new Error('execution reverted');
      }
      async getModulesPaginated(start: string, pageSize: number) {
        reads.push({ target: this.target, fn: 'getModulesPaginated', args: [start, pageSize] });
        if (opts.pages) {
          const page = opts.pages[Math.min(pageIndex, opts.pages.length - 1)];
          pageIndex += 1;
          return page;
        }
        return [enabled, ZERO];
      }
      async supportsInterface(interfaceId: string) {
        this.record('supportsInterface', [interfaceId]);
        return (answers[this.target] ?? []).includes(interfaceId);
      }
      async fetch(genesis: string) {
        this.record('fetch', [genesis]);
        return entry;
      }
      async blocksOf(genesis: string) {
        this.record('blocksOf', [genesis]);
        return opts.blocks ?? [1, APPEND_BLOCK];
      }
      async isOwner(owner: string) {
        this.record('isOwner', [owner]);
        return opts.isOwner ?? true;
      }
      async isOwnerAt(who: string, blockNumber: number) {
        this.record('isOwnerAt', [who, blockNumber]);
        return opts.isOwnerAt ?? true;
      }
    },
  };

  const fetchStub = async (url: string) => {
    cats.push(url);
    return { text: async () => JSON.stringify(opts.itemJson ?? item()) };
  };

  const litStub = { Actions: { Decrypt: async () => opts.decryptResult ?? PLAINTEXT } };
  const silentConsole = { log: () => {}, error: () => {}, warn: () => {} };

  const main = new Function(
    'Lit',
    'ethers',
    'fetch',
    'console',
    decryptAction + '\nreturn main;',
  )(litStub, ethersStub, fetchStub, silentConsole) as (params: unknown) => Promise<any>;

  return { main, reads, cats };
}

const params = (over: Record<string, unknown> = {}) => ({
  pkpId: 'pkp-1',
  genesis: GENESIS,
  authorSafe: AUTHOR,
  signature: '0xsig',
  rpcs: { L2: ['https://rpc-one', 'https://rpc-two'] },
  gateway: GATEWAY,
  ...over,
});

describe('decryptAction', () => {
  it('resolves the drafts module from the Safe before it reads the genesis', async () => {
    const { main, reads } = load();

    const result = await main(params());

    expect(result.ok).toBe(true);
    const page = reads.find((r) => r.fn === 'getModulesPaginated')!;
    expect(page.target).toBe(AUTHOR);
    const fetch = reads.find((r) => r.fn === 'fetch')!;
    expect(fetch.target).toBe(DRAFTS);
    expect(fetch.args).toEqual([GENESIS]);
  });

  it('refuses two enabled modules answering the drafts role instead of picking one', async () => {
    const { main, reads, cats } = load({
      answers: {
        [DRAFTS]: [DRAFTS_MODULE_INTERFACE_ID],
        [HISTORY]: [OWNER_HISTORY_MODULE_INTERFACE_ID],
        [PUBLICATION_MODULE]: [DRAFTS_MODULE_INTERFACE_ID],
      },
    });

    const result = await main(params());

    expect(result.error).toBe('two drafts modules answer on the author Safe');
    expect(reads.some((r) => r.fn === 'fetch')).toBe(false);
    expect(cats).toEqual([]);
  });

  it('refuses when the Safe has no drafts module, and survives a reverting module', async () => {
    const { main } = load({
      enabled: [PUBLICATION_MODULE, HISTORY],
      answers: { [HISTORY]: [OWNER_HISTORY_MODULE_INTERFACE_ID] },
      reverts: [PUBLICATION_MODULE],
    });

    const result = await main(params());

    expect(result.error).toBe('no drafts module on the author Safe');
  });

  it('refuses an unknown draft before reading any ownership', async () => {
    const { main, reads, cats } = load({
      entry: { genesis: GENESIS, author: ZERO, cid: '', timestamp: 0, versionCount: 0 },
    });

    const result = await main(params());

    expect(result.ok).toBe(false);
    expect(result.action).toBe('decrypt');
    expect(result.error).toBe('unknown draft');
    expect(reads.some((r) => r.fn === 'isOwnerAt' || r.fn === 'isOwner')).toBe(false);
    expect(cats).toEqual([]);
  });

  it('refuses a draft that sits in another Safe drafts log', async () => {
    const { main, reads, cats } = load({
      entry: { genesis: GENESIS, author: OTHER, cid: CID, timestamp: 0, versionCount: 1 },
    });

    const result = await main(params());

    expect(result.error).toBe('draft belongs to another Safe');
    expect(reads.some((r) => r.fn === 'isOwnerAt')).toBe(false);
    expect(cats).toEqual([]);
  });

  it('accepts a signer who was an owner at the append block', async () => {
    const { main, reads } = load({ isOwnerAt: true });

    const result = await main(params());

    expect(result.ok).toBe(true);
    const ownership = reads.find((r) => r.fn === 'isOwnerAt')!;
    expect(ownership.target).toBe(HISTORY);
    expect(ownership.args).toEqual([SIGNER, APPEND_BLOCK]);
  });

  it('refuses a signer who only became an owner later', async () => {
    const { main, reads, cats } = load({ isOwnerAt: false, isOwner: true });

    const result = await main(params());

    expect(result.error).toBe('signer does not own the author Safe');
    expect(reads.find((r) => r.fn === 'isOwnerAt')!.args).toEqual([SIGNER, APPEND_BLOCK]);
    expect(cats).toEqual([]);
  });

  it('falls back to the Safe live isOwner for a version whose recorded block is 0', async () => {
    const { main, reads } = load({ blocks: [0], isOwner: true, isOwnerAt: false });

    const result = await main(params());

    expect(result.ok).toBe(true);
    expect(reads.some((r) => r.fn === 'isOwnerAt')).toBe(false);
    const live = reads.find((r) => r.fn === 'isOwner')!;
    expect(live.target).toBe(AUTHOR);
    expect(live.args).toEqual([SIGNER]);
  });

  it('refuses when the blob author is not the author Safe', async () => {
    const { main } = load({
      itemJson: item({ public: { author: OTHER, plaintextHash: hashOf(PLAINTEXT) } }),
    });

    const result = await main(params());

    expect(result.error).toBe('item author is not the draft author');
    expect(result.data).toBeUndefined();
  });

  it('refuses an item that is not encrypted', async () => {
    const { main } = load({ itemJson: item({ encryption: false }) });

    const result = await main(params());

    expect(result.error).toBe('not an encrypted item');
    expect(result.data).toBeUndefined();
  });

  it('refuses a plaintext that does not match the signed hash, returning no plaintext', async () => {
    const { main } = load({
      itemJson: item({ public: { author: AUTHOR, plaintextHash: hashOf('some other body') } }),
    });

    const result = await main(params());

    expect(result.error).toBe('plaintext does not match the signed hash');
    expect(result.data).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
  });

  it('returns the plaintext with the author Safe and cid on the happy path', async () => {
    const { main, cats } = load();

    const result = await main(params());

    expect(result.ok).toBe(true);
    expect(result.action).toBe('decrypt');
    expect(result.data).toEqual({ plaintext: PLAINTEXT, author: AUTHOR, cid: CID });
    expect(cats).toEqual([GATEWAY + '/api/v0/cat?arg=' + CID]);
  });

  it('still accepts a pre-change prefixed author', async () => {
    const { main } = load({
      itemJson: item({
        public: { author: LEGACY_AUTHOR_PREFIX + AUTHOR, plaintextHash: hashOf(PLAINTEXT) },
      }),
    });

    const result = await main(params());

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ plaintext: PLAINTEXT, author: AUTHOR, cid: CID });
  });

  it('walks a module list that comes back in pages', async () => {
    const { main, reads } = load({
      pages: [
        [[PUBLICATION_MODULE], DRAFTS],
        [[DRAFTS, HISTORY], ZERO],
      ],
    });

    const result = await main(params());

    expect(result.ok).toBe(true);
    expect(reads.filter((r) => r.fn === 'getModulesPaginated')).toHaveLength(2);
  });

  it('refuses a caller who names no author Safe', async () => {
    const { main, cats } = load();

    const result = await main(params({ authorSafe: '0xnot-an-address' }));

    expect(result.error).toBe('author Safe is not an address');
    expect(cats).toEqual([]);
  });
});
