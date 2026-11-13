import { describe, expect, it, vi } from 'vitest';
import {
  DRAFTS_MODULE_INTERFACE_ID,
  OWNER_HISTORY_MODULE_INTERFACE_ID,
} from '@s2s/soul2soul-shared/gates';
import { keccak256 } from 'viem';
import { decryptAuthorDraft, type AuthorDraftInput, type AuthorDraftDeps } from './author-draft';

// ============================================================================
// decryptAuthorDraft — GATES-1 for one draft, plus the PIN.
//
// The gate itself is shared and tested there (`ownsVerdict`); what is tested
// here is what this file does with its answer: read the entry at the block the
// gate reported, refuse unless the blob is that author's and hashes to the
// signed plaintextHash, and keep every refusal's wording.
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

const INPUT: AuthorDraftInput = {
  pkpId: '0x1',
  genesis: GENESIS,
  authorSafe: SAFE,
  signature: '0xsigned',
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
 * The runtime, faked at the injection boundary: a chain read that answers the
 * module lookup and `fetch`, a gateway that answers the item, a decryptor, and a
 * signature recovery. Everything asserted below goes through these.
 */
const runtime = (overrides: Partial<AuthorDraftDeps> = {}, options: { entry?: unknown } = {}) => {
  const reads: ReadCall[] = [];
  const deps: AuthorDraftDeps = {
    owns: vi.fn(async () => ({ ok: true, block: 880 })),
    read: vi.fn(async (target, _abi, fn, args, block) => {
      reads.push({ target, fn, args, block });
      if (fn === 'getModulesPaginated') return [[DRAFTS_MODULE, HISTORY_MODULE], END_SENTINEL];
      if (fn === 'supportsInterface') {
        const drafts = args[0] === DRAFTS_MODULE_INTERFACE_ID && target === DRAFTS_MODULE;
        const history = args[0] === OWNER_HISTORY_MODULE_INTERFACE_ID && target === HISTORY_MODULE;
        return drafts || history;
      }
      if (fn === 'fetch') return options.entry ?? ENTRY;
      throw new Error('unexpected read: ' + fn);
    }),
    cat: vi.fn(async () => JSON.stringify(ITEM)),
    decrypt: vi.fn(async () => ({ decrypted: PLAINTEXT })),
    recoverSigner: vi.fn(() => SIGNER),
    ...overrides,
  };
  return { deps, reads, entry: () => reads.filter((r) => r.fn === 'fetch') };
};

describe('decryptAuthorDraft — the version that is opened is the version judged', () => {
  it('reads the entry at the block the gate reported, and cats that entry s cid', async () => {
    const { deps, entry } = runtime();
    const outcome = await decryptAuthorDraft(INPUT, deps);

    expect(outcome.ok).toBe(true);
    expect(entry()).toHaveLength(1);
    expect(entry()[0].block).toBe(880);
    expect(entry()[0].target).toBe(DRAFTS_MODULE);
    expect(entry()[0].args).toEqual([GENESIS]);
    expect(deps.cat).toHaveBeenCalledWith(CID);
    if (outcome.ok) expect(outcome.data).toEqual({ plaintext: PLAINTEXT, author: SAFE, cid: CID });
  });

  it('reports the judged block in the trace', async () => {
    const { deps } = runtime();
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.trace).toContainEqual({ step: 'appendBlock', block: 880 });
  });

  it('passes block 0 through unpinned-worthy: the pre-upgrade fallback has no height', async () => {
    // Block 0 is "no block was recorded", so there is nothing to pin to; the
    // gate's own fallback is the live isOwner. evmRead drops a 0 tag.
    const { deps, entry } = runtime({ owns: vi.fn(async () => ({ ok: true, block: 0 })) });
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.ok).toBe(true);
    expect(entry()[0].block).toBe(0);
  });

  it('recovers the signer from the signature and judges that address', async () => {
    const { deps } = runtime();
    await decryptAuthorDraft(INPUT, deps);
    expect(deps.recoverSigner).toHaveBeenCalledWith(INPUT.signature);
    expect(deps.owns).toHaveBeenCalledWith(GENESIS, SAFE, SIGNER);
  });

  it('normalises a bytes32 genesis to lowercase before any read', async () => {
    const { deps, entry } = runtime();
    await decryptAuthorDraft({ ...INPUT, genesis: GENESIS.toUpperCase().replace('0X', '0x') }, deps);
    expect(entry()[0].args).toEqual([GENESIS]);
  });

  it('normalises a raw objectId through toBytes32Id', async () => {
    const { deps } = runtime();
    vi.stubGlobal('ethers', {
      utils: { toUtf8Bytes: (s: string) => s, keccak256: () => GENESIS },
    });
    try {
      await decryptAuthorDraft({ ...INPUT, genesis: '65f0c0ffee' }, deps);
      expect(deps.owns).toHaveBeenCalledWith(GENESIS, SAFE, SIGNER);
    } finally {
      vi.unstubAllGlobals();
    }
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
    expect(deps.owns).not.toHaveBeenCalled();
    expect(deps.recoverSigner).not.toHaveBeenCalled();
  });

  it('refuses a signer the gate rejected, and names the block it was refused at', async () => {
    // A signer added to the Safe after the version was appended: the gate judges
    // at the append block and answers no.
    const { deps, entry } = runtime({
      owns: vi.fn(async () => ({ ok: false, block: 900 })),
    });
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('signer does not own the author Safe');
    expect(outcome.trace).toContainEqual({ step: 'appendBlock', block: 900 });
    expect(entry()).toHaveLength(0);
    expect(deps.cat).not.toHaveBeenCalled();
  });

  it('refuses an unknown draft', async () => {
    const { deps } = runtime({}, {
      entry: { ...ENTRY, versionCount: 0, author: END_SENTINEL, cid: '' },
    });
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('unknown draft');
    expect(deps.cat).not.toHaveBeenCalled();
  });

  it('refuses a draft the Safe s log attributes to another Safe', async () => {
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

  it('refuses when the author Safe s modules cannot be resolved', async () => {
    const { deps } = runtime();
    deps.read = vi.fn(async () => [[], END_SENTINEL]);
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe('cannot resolve the author Safe modules: no-enabled-modules');
    }
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
