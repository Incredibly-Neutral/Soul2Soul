import { describe, it, expect } from 'vitest';
import { decryptAction } from '../actions/decrypt.js';

/**
 * The decrypt action is a string, so it is evaluated here with stubs rather than
 * imported as a function. Nothing leaves the process: ethers is a stub with the
 * four utils the action uses plus a Contract that answers out of a table, and
 * `fetch` is a function.
 */

const SIGNER = '0x1111111111111111111111111111111111111111';
const AUTHOR = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const MODULE = '0x4444444444444444444444444444444444444444';
const GENESIS = '0x' + 'ab'.repeat(32);
const CID = 'bafybeigdyrzt';
const PLAINTEXT = '{"title":"hello"}';
const GATEWAY = 'https://gw.example';

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
  public: { author: 'did:ethr:' + AUTHOR, plaintextHash: hashOf(PLAINTEXT) },
  ...over,
});

function load(opts: {
  entry?: unknown;
  isOwner?: boolean;
  itemJson?: unknown;
  decryptResult?: unknown;
  signer?: string;
} = {}) {
  const reads: Read[] = [];
  const cats: string[] = [];

  const entry = opts.entry ?? {
    genesis: GENESIS,
    author: AUTHOR,
    cid: CID,
    timestamp: 0,
    versionCount: 1,
  };

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
      async fetch(genesis: string) {
        reads.push({ target: this.target, fn: 'fetch', args: [genesis] });
        return entry;
      }
      async isOwner(owner: string) {
        reads.push({ target: this.target, fn: 'isOwner', args: [owner] });
        return opts.isOwner ?? true;
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
  authorModule: MODULE,
  signature: '0xsig',
  rpcs: { L2: ['https://rpc-one', 'https://rpc-two'] },
  gateway: GATEWAY,
  ...over,
});

describe('decryptAction', () => {
  it('refuses an unknown draft before reading isOwner', async () => {
    const { main, reads, cats } = load({
      entry: { genesis: GENESIS, author: '0x' + '0'.repeat(40), cid: '', timestamp: 0, versionCount: 0 },
    });

    const result = await main(params());

    expect(result.ok).toBe(false);
    expect(result.action).toBe('decrypt');
    expect(result.error).toBe('unknown draft');
    expect(reads.map((r) => r.fn)).toEqual(['fetch']);
    expect(cats).toEqual([]);
  });

  it('refuses a signer who does not own the author Safe, before any fetch', async () => {
    const { main, reads, cats } = load({ isOwner: false });

    const result = await main(params());

    expect(result.error).toBe('signer does not own the author Safe');
    expect(reads.map((r) => r.fn)).toEqual(['fetch', 'isOwner']);
    expect(cats).toEqual([]);
  });

  it('refuses when the blob author is not the draft author', async () => {
    const { main } = load({ itemJson: item({ public: { author: 'did:ethr:' + OTHER, plaintextHash: hashOf(PLAINTEXT) } }) });

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
      itemJson: item({ public: { author: 'did:ethr:' + AUTHOR, plaintextHash: hashOf('some other body') } }),
    });

    const result = await main(params());

    expect(result.error).toBe('plaintext does not match the signed hash');
    expect(result.data).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
  });

  it('returns the plaintext with the entry author and cid on the happy path', async () => {
    const { main, cats } = load();

    const result = await main(params());

    expect(result.ok).toBe(true);
    expect(result.action).toBe('decrypt');
    expect(result.data).toEqual({ plaintext: PLAINTEXT, author: AUTHOR, cid: CID });
    expect(cats).toEqual([GATEWAY + '/api/v0/cat?arg=' + CID]);
  });

  it('reads isOwner on the entry author, whichever addresses the caller passes', async () => {
    const { main, reads } = load({ entry: { genesis: GENESIS, author: OTHER, cid: CID, timestamp: 0, versionCount: 1 } });

    await main(params({ authorSafe: AUTHOR, safe: AUTHOR }));

    const isOwner = reads.find((r) => r.fn === 'isOwner')!;
    expect(isOwner.target).toBe(OTHER);
    expect(isOwner.args).toEqual([SIGNER]);
  });
});
