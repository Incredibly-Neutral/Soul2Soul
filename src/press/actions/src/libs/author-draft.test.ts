import { describe, expect, it, vi } from 'vitest';
import { keccak256 } from 'viem';
import {
  decryptAuthorDraft,
  type AuthorDraftInput,
  type AuthorDraftDeps,
} from './author-draft';

// ============================================================================
// decryptAuthorDraft — GATES-1 for one draft, plus the PIN.
//
// The pieces are shared and tested there (`resolveAuthorModules`, `isOwnerAt`);
// what is tested here is the composition and what this file does with it:
// resolve the Safe's modules once, require the drafts log to name that Safe,
// take the block from `blocksOf`, judge ownership at that block, and read the
// entry there and nowhere else. Every refusal's wording is pinned, and so is the
// direction of the historical judgement in both directions.
// ============================================================================

const SAFE = '0x' + '11'.repeat(20);
const OTHER_SAFE = '0x' + '22'.repeat(20);
const SIGNER = '0x' + '33'.repeat(20);
const DRAFTS_MODULE = '0x' + '44'.repeat(20);
const HISTORY_MODULE = '0x' + '55'.repeat(20);
const END_SENTINEL = '0x' + '00'.repeat(20);
const GENESIS = '0x' + 'ab'.repeat(32);
const CID = 'bafyDraftCid';
const PLAINTEXT = '{"title":"A draft","body":"secret"}';
const PLAINTEXT_HASH = keccak256(new TextEncoder().encode(PLAINTEXT));
const CIPHERTEXT = { ciphertext: 'wrapped', dataToEncryptHash: '0x' + 'cd'.repeat(32) };

/** The append block of the draft's last version, and an earlier one before it. */
const APPEND_BLOCK = 880;
const BLOCKS = [640, APPEND_BLOCK];

const INPUT: AuthorDraftInput = {
  pkpId: '0x1',
  genesis: GENESIS,
  authorSafe: SAFE,
  signature: '0xsigned',
};

const MODULES = {
  ok: true as const,
  drafts: DRAFTS_MODULE,
  ownerHistory: HISTORY_MODULE,
  reads: 7,
};

const ENTRY = {
  genesis: GENESIS,
  author: SAFE,
  cid: CID,
  timestamp: 1,
  versionCount: 3,
};

const ITEM = {
  encryption: true,
  body: CIPHERTEXT,
  public: { author: SAFE, plaintextHash: PLAINTEXT_HASH },
};

type ReadCall = { target: string; fn: string; args: unknown[]; block?: number };

/**
 * The runtime, faked at the injection boundary: module resolution, the two
 * value reads the composition makes, ownership at a block, a pinned chain read
 * that answers the entry, a gateway, a decryptor, and a signature recovery.
 * Everything asserted below goes through these.
 */
const runtime = (overrides: Partial<AuthorDraftDeps> = {}, options: { entry?: unknown } = {}) => {
  const reads: ReadCall[] = [];
  const deps: AuthorDraftDeps = {
    resolveModules: vi.fn(async () => ({ ...MODULES })),
    readValue: vi.fn(async (target, _abi, fn, args) => {
      reads.push({ target, fn, args });
      if (fn === 'authorOf') return SAFE;
      if (fn === 'blocksOf') return BLOCKS;
      throw new Error('unexpected value read: ' + fn);
    }),
    isOwnerAt: vi.fn(async () => true),
    read: vi.fn(async (target, _abi, fn, args, block) => {
      reads.push({ target, fn, args, block });
      if (fn === 'fetch') return options.entry ?? ENTRY;
      throw new Error('unexpected read: ' + fn);
    }),
    cat: vi.fn(async () => JSON.stringify(ITEM)),
    decrypt: vi.fn(async () => ({ decrypted: PLAINTEXT })),
    recoverSigner: vi.fn(() => SIGNER),
    ...overrides,
  };
  const entry = () => reads.filter((r) => r.fn === 'fetch');
  const calls = (fn: string) => reads.filter((r) => r.fn === fn);
  return { deps, reads, entry, calls };
};

describe('decryptAuthorDraft — the version that is opened is the version judged', () => {
  it('reads the entry at the append block, from the drafts module it resolved', async () => {
    const { deps, entry } = runtime();
    const outcome = await decryptAuthorDraft(INPUT, deps);

    expect(outcome.ok).toBe(true);
    expect(entry()).toHaveLength(1);
    expect(entry()[0].block).toBe(APPEND_BLOCK);
    expect(entry()[0].target).toBe(DRAFTS_MODULE);
    expect(entry()[0].args).toEqual([GENESIS]);
    expect(deps.cat).toHaveBeenCalledWith(CID);
    if (outcome.ok) expect(outcome.data).toEqual({ plaintext: PLAINTEXT, author: SAFE, cid: CID });
  });

  it('resolves the Safe s modules once, and every read goes to the drafts log it named', async () => {
    const { deps, reads } = runtime();
    await decryptAuthorDraft(INPUT, deps);

    // A second lookup would spend the chain budget twice and could judge the
    // entry against a module set that rotated in between.
    expect(deps.resolveModules).toHaveBeenCalledTimes(1);
    expect(deps.resolveModules).toHaveBeenCalledWith(SAFE);
    expect(reads.map((r) => r.fn)).toEqual(['authorOf', 'blocksOf', 'fetch']);
    expect(reads.every((r) => r.target === DRAFTS_MODULE)).toBe(true);
  });

  it('takes the last entry of blocksOf, not the first', async () => {
    const { deps, calls } = runtime();
    await decryptAuthorDraft(INPUT, deps);
    expect(calls('blocksOf')[0].args).toEqual([GENESIS]);
    expect(calls('blocksOf')[0].target).toBe(DRAFTS_MODULE);
  });

  it('reports the judged block in the trace', async () => {
    const { deps } = runtime();
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.trace).toContainEqual({ step: 'appendBlock', block: APPEND_BLOCK });
  });

  it('refuses block 0: no height to read the entry at and no owner set to judge it', async () => {
    // Block 0 is "no block was recorded" (pre-upgrade, or an imported log). There
    // is no pinned read to make and no unpinned one to fall back to.
    const { deps, entry } = runtime({
      readValue: vi.fn(async (_target: string, _abi: string[], fn: string) =>
        fn === 'authorOf' ? SAFE : [640, 0],
      ),
    });
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('no append block was recorded for this draft');
    expect(entry()).toHaveLength(0);
    expect(deps.isOwnerAt).not.toHaveBeenCalled();
    expect(deps.cat).not.toHaveBeenCalled();
  });

  it('recovers the signer from the signature and judges that address', async () => {
    const { deps } = runtime();
    await decryptAuthorDraft(INPUT, deps);
    expect(deps.recoverSigner).toHaveBeenCalledWith(INPUT.signature);
    expect(deps.isOwnerAt).toHaveBeenCalledWith(SAFE, SIGNER, APPEND_BLOCK, HISTORY_MODULE);
  });

  it('normalises a bytes32 genesis to lowercase before any read', async () => {
    const { deps, calls } = runtime();
    await decryptAuthorDraft({ ...INPUT, genesis: GENESIS.toUpperCase().replace('0X', '0x') }, deps);
    expect(calls('authorOf')[0].args).toEqual([GENESIS]);
    expect(calls('fetch')[0].args).toEqual([GENESIS]);
  });

  it('normalises a raw objectId through toBytes32Id', async () => {
    const { deps, calls } = runtime();
    vi.stubGlobal('ethers', {
      utils: { toUtf8Bytes: (s: string) => s, keccak256: () => GENESIS },
    });
    try {
      await decryptAuthorDraft({ ...INPUT, genesis: '65f0c0ffee' }, deps);
      expect(calls('authorOf')[0].args).toEqual([GENESIS]);
      expect(deps.isOwnerAt).toHaveBeenCalledWith(SAFE, SIGNER, APPEND_BLOCK, HISTORY_MODULE);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('decryptAuthorDraft — ownership is judged at the append block', () => {
  it('admits an owner at the append block who is not an owner now', async () => {
    // A key rotated out of the Safe after the version was appended keeps what it
    // wrote: the question is historical, and the present tense is not asked.
    const { deps, entry } = runtime({ isOwnerAt: vi.fn(async () => true) });
    const outcome = await decryptAuthorDraft(INPUT, deps);

    expect(outcome.ok).toBe(true);
    expect(deps.isOwnerAt).toHaveBeenCalledWith(SAFE, SIGNER, APPEND_BLOCK, HISTORY_MODULE);
    expect(entry()[0].block).toBe(APPEND_BLOCK);
  });

  it('refuses an owner now who was not an owner at the append block', async () => {
    // A key added afterwards does not inherit what the Safe wrote before it.
    const { deps, entry } = runtime({ isOwnerAt: vi.fn(async () => false) });
    const outcome = await decryptAuthorDraft(INPUT, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('signer does not own the author Safe');
    expect(deps.isOwnerAt).toHaveBeenCalledWith(SAFE, SIGNER, APPEND_BLOCK, HISTORY_MODULE);
    expect(entry()).toHaveLength(0);
    expect(deps.cat).not.toHaveBeenCalled();
    expect(outcome.trace).toContainEqual({ step: 'appendBlock', block: APPEND_BLOCK });
  });
});

describe('decryptAuthorDraft — refusals', () => {
  it('refuses a Safe that is not an address, before any gate call', async () => {
    const { deps } = runtime();
    const outcome = await decryptAuthorDraft({ ...INPUT, authorSafe: '0x0' }, deps);
    expect(outcome).toEqual({
      ok: false,
      error: 'author Safe is not an address',
      trace: [{ step: 'genesis', address: GENESIS }],
    });
    expect(deps.resolveModules).not.toHaveBeenCalled();
    expect(deps.recoverSigner).not.toHaveBeenCalled();
  });

  it('says why the module lookup refused, in the string action s words', async () => {
    const expected: [string, string][] = [
      ['unreadable-module-list', 'cannot read the author Safe module list'],
      ['no-enabled-modules', 'author Safe has no enabled modules'],
      ['no-drafts-module', 'no drafts module on the author Safe'],
      ['ambiguous-drafts-module', 'two drafts modules answer on the author Safe'],
      ['no-owner-history-module', 'no owner history module on the author Safe'],
      ['ambiguous-owner-history-module', 'two owner history modules answer on the author Safe'],
    ];

    for (const [modulesError, message] of expected) {
      const { deps, entry } = runtime({
        resolveModules: vi.fn(async () => ({ ok: false as const, error: modulesError as never, reads: 1 })),
      });
      const outcome = await decryptAuthorDraft(INPUT, deps);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toBe(message);
      expect(entry()).toHaveLength(0);
    }
  });

  it('refuses a genesis the drafts log does not name', async () => {
    const { deps, entry } = runtime({
      readValue: vi.fn(async (_target: string, _abi: string[], fn: string) =>
        fn === 'authorOf' ? END_SENTINEL : BLOCKS,
      ),
    });
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('unknown draft');
    expect(entry()).toHaveLength(0);
    expect(deps.isOwnerAt).not.toHaveBeenCalled();
    expect(deps.cat).not.toHaveBeenCalled();
  });

  it('refuses a draft the Safe s log attributes to another Safe', async () => {
    const { deps, entry } = runtime({
      readValue: vi.fn(async (_target: string, _abi: string[], fn: string) =>
        fn === 'authorOf' ? OTHER_SAFE : BLOCKS,
      ),
    });
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('draft belongs to another Safe');
    expect(entry()).toHaveLength(0);
    expect(deps.isOwnerAt).not.toHaveBeenCalled();
  });

  it('refuses when the log answers no usable block list', async () => {
    const { deps, entry } = runtime({
      readValue: vi.fn(async (_target: string, _abi: string[], fn: string) =>
        fn === 'authorOf' ? SAFE : [],
      ),
    });
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('cannot read the append block');
    expect(entry()).toHaveLength(0);
    expect(deps.isOwnerAt).not.toHaveBeenCalled();
  });

  it('refuses an entry with no versions left, even if the log named an author', async () => {
    const { deps } = runtime({}, {
      entry: { ...ENTRY, versionCount: 0, author: END_SENTINEL, cid: '' },
    });
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('unknown draft');
    expect(deps.cat).not.toHaveBeenCalled();
  });

  it('refuses an entry the pinned read attributes to another Safe', async () => {
    const { deps } = runtime({}, { entry: { ...ENTRY, author: OTHER_SAFE } });
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('draft belongs to another Safe');
  });

  it('refuses an item that is not encrypted', async () => {
    const { deps } = runtime();
    deps.cat = vi.fn(async () => JSON.stringify({ ...ITEM, encryption: false }));
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('not an encrypted item');
    expect(deps.decrypt).not.toHaveBeenCalled();
  });

  it('refuses a blob signed by another author', async () => {
    const { deps } = runtime();
    deps.cat = vi.fn(async () =>
      JSON.stringify({ ...ITEM, public: { ...ITEM.public, author: OTHER_SAFE } }),
    );
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('item author is not the draft author');
    expect(deps.decrypt).not.toHaveBeenCalled();
  });

  it('accepts a scheme-prefixed author, which older items carry', async () => {
    const { deps } = runtime();
    deps.cat = vi.fn(async () =>
      JSON.stringify({ ...ITEM, public: { ...ITEM.public, author: 'safe-eoa:' + SAFE } }),
    );
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.ok).toBe(true);
  });

  it('refuses plaintext that does not hash to the signed plaintextHash', async () => {
    const { deps } = runtime();
    deps.decrypt = vi.fn(async () => ({ decrypted: PLAINTEXT + ' ' }));
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('plaintext does not match the signed hash');
  });

  it('refuses when the decryptor hands back no plaintext', async () => {
    const { deps } = runtime();
    deps.decrypt = vi.fn(async () => ({ decrypted: 42 }));
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('decrypt returned no plaintext');
  });

  it('turns a thrown failure into a refusal rather than an exception', async () => {
    const { deps } = runtime();
    deps.cat = vi.fn(async () => {
      throw new Error('IPFS retrieval failed: 504 Gateway Timeout');
    });
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe('decrypt failed: IPFS retrieval failed: 504 Gateway Timeout');
    }
  });
});

describe('decryptAuthorDraft — the trace carries no secret', () => {
  it('names steps and public addresses only', async () => {
    const { deps } = runtime();
    const outcome = await decryptAuthorDraft(INPUT, deps);
    const serialised = JSON.stringify(outcome.trace);

    expect(serialised).not.toContain(PLAINTEXT);
    expect(serialised).not.toContain('secret');
    expect(serialised).not.toContain(CIPHERTEXT.dataToEncryptHash);
    expect(serialised).not.toContain(INPUT.signature);
    expect(outcome.trace.map((s) => s.step)).toEqual([
      'genesis',
      'signer',
      'appendBlock',
      'draft',
      'item',
      'blobAuthor',
      'decrypt',
      'plaintextHash',
    ]);
  });
});
