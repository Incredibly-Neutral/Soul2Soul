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
// The gate itself is shared and tested there (`canAuthorVerdict`); what is tested
// here is what this file does with its answer: read the entry at the block the
// gate reported and from the module it reported, refuse unless the blob is that
// author's and hashes to the signed plaintextHash, and keep every refusal's
// wording. No module is resolved here, so the chain reads below are the entry
// read and nothing else.
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

/** What the gate says it resolved and judged at, at block 880. */
const VERDICT = {
  ok: true,
  block: 880,
  ownerSet: 'append-block' as const,
  modules: { drafts: DRAFTS_MODULE, ownerHistory: HISTORY_MODULE },
  author: SAFE,
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
 * The runtime, faked at the injection boundary: the gate's verdict, a chain
 * read that answers the entry, a gateway that answers the item, a decryptor, and
 * a signature recovery. Everything asserted below goes through these.
 */
const runtime = (overrides: Partial<AuthorDraftDeps> = {}, options: { entry?: unknown } = {}) => {
  const reads: ReadCall[] = [];
  const deps: AuthorDraftDeps = {
    canAuthorVerdict: vi.fn(async () => ({ ...VERDICT })),
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
  return { deps, reads, entry: () => reads.filter((r) => r.fn === 'fetch') };
};

describe('decryptAuthorDraft — the version that is opened is the version judged', () => {
  it('reads the entry at the block the gate reported, from the module it reported', async () => {
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

  it('resolves no module and reads nothing else: the verdict carries what the gate read', async () => {
    const { deps, reads } = runtime();
    await decryptAuthorDraft(INPUT, deps);

    // The whole module lookup is one round trip of chain calls; repeating it
    // here would spend the gate's budget twice and could judge the entry against
    // a module set that rotated in between.
    expect(reads.map((r) => r.fn)).toEqual(['fetch']);
  });

  it('reports the judged block in the trace', async () => {
    const { deps } = runtime();
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.trace).toContainEqual({ step: 'appendBlock', block: 880, ownerSet: 'append-block' });
  });

  it('reads the entry unpinned at head when the log records block 0, and still opens the draft', async () => {
    // Block 0 is "no block was recorded" (pre-upgrade, or an imported log). The
    // gate answered from the Safe's live owners, so there is no height to pin to
    // and the entry is read at the head — the version that answer was given at.
    const { deps, entry: fetch, reads } = runtime({
      canAuthorVerdict: vi.fn(async () => ({ ...VERDICT, block: 0, ownerSet: 'live' as const })),
    });
    const outcome = await decryptAuthorDraft(INPUT, deps);

    expect(outcome.ok).toBe(true);
    expect(fetch()).toHaveLength(1);
    expect(fetch()[0].block).toBeUndefined();
    expect(reads.map((r) => r.fn)).toEqual(['fetch']);
    expect(deps.cat).toHaveBeenCalledWith(CID);
    expect(outcome.trace).toContainEqual({ step: 'appendBlock', block: 0, ownerSet: 'live' });
  });

  it('reads the entry unpinned at head when the log answers no block list, and still opens the draft', async () => {
    const { deps, entry: fetch, reads } = runtime({
      canAuthorVerdict: vi.fn(async () => ({
        ok: true,
        ownerSet: 'live' as const,
        modules: VERDICT.modules,
        author: SAFE,
      })),
    });
    const outcome = await decryptAuthorDraft(INPUT, deps);

    expect(outcome.ok).toBe(true);
    expect(fetch()[0].block).toBeUndefined();
    expect(reads.map((r) => r.fn)).toEqual(['fetch']);
    expect(deps.cat).toHaveBeenCalledWith(CID);
    expect(outcome.trace).toContainEqual({ step: 'appendBlock', ownerSet: 'live' });
  });

  it('reports the live set on the trace even when it refused', async () => {
    const { deps, entry: fetch } = runtime({
      canAuthorVerdict: vi.fn(async () => ({
        ok: false,
        block: 0,
        ownerSet: 'live' as const,
        modules: VERDICT.modules,
        author: SAFE,
      })),
    });
    const outcome = await decryptAuthorDraft(INPUT, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('signer does not own the author Safe');
    expect(outcome.trace).toContainEqual({ step: 'appendBlock', block: 0, ownerSet: 'live' });
    expect(fetch()).toHaveLength(0);
  });

  it('still refuses an entry from another Safe on the unpinned path', async () => {
    const { deps } = runtime(
      { canAuthorVerdict: vi.fn(async () => ({ ...VERDICT, block: 0, ownerSet: 'live' as const })) },
      { entry: { ...ENTRY, author: OTHER_SAFE } },
    );
    const outcome = await decryptAuthorDraft(INPUT, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('draft belongs to another Safe');
    expect(deps.cat).not.toHaveBeenCalled();
  });

  it('still refuses an entry with no versions left on the unpinned path', async () => {
    const { deps } = runtime(
      { canAuthorVerdict: vi.fn(async () => ({ ...VERDICT, block: 0, ownerSet: 'live' as const })) },
      { entry: { ...ENTRY, versionCount: 0 } },
    );
    const outcome = await decryptAuthorDraft(INPUT, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('unknown draft');
    expect(deps.cat).not.toHaveBeenCalled();
  });

  it('recovers the signer from the signature and judges that address', async () => {
    const { deps } = runtime();
    await decryptAuthorDraft(INPUT, deps);
    expect(deps.recoverSigner).toHaveBeenCalledWith(INPUT.signature);
    expect(deps.canAuthorVerdict).toHaveBeenCalledWith(GENESIS, SAFE, SIGNER);
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
      expect(deps.canAuthorVerdict).toHaveBeenCalledWith(GENESIS, SAFE, SIGNER);
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
    expect(deps.canAuthorVerdict).not.toHaveBeenCalled();
    expect(deps.recoverSigner).not.toHaveBeenCalled();
  });

  it('refuses a signer the gate rejected at a positive block, and names that block', async () => {
    // A signer added to the Safe after the version was appended: the gate judges
    // at the append block and answers no.
    const { deps, entry } = runtime({
      canAuthorVerdict: vi.fn(async () => ({ ...VERDICT, ok: false, block: 900 })),
    });
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('signer does not own the author Safe');
    expect(outcome.trace).toContainEqual({ step: 'appendBlock', block: 900, ownerSet: 'append-block' });
    expect(entry()).toHaveLength(0);
    expect(deps.cat).not.toHaveBeenCalled();
  });

  it('names the block it refused at when the Safe runs no owner-history module', async () => {
    // The refusal carries a block and no owner set: nothing answered at that
    // block, so the trace names the block without claiming a set.
    const { deps, entry } = runtime({
      canAuthorVerdict: vi.fn(async () => ({
        ok: false,
        block: 880,
        modules: { drafts: DRAFTS_MODULE },
        modulesError: 'no-owner-history-module' as const,
        author: SAFE,
      })),
    });

    const outcome = await decryptAuthorDraft(INPUT, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok)
      expect(outcome.error).toBe(
        'no owner history module on the author Safe: the append block cannot be judged',
      );
    expect(outcome.trace).toContainEqual({ step: 'appendBlock', block: 880 });
    expect(entry()).toHaveLength(0);
  });

  it('says why the module lookup refused, in the string action s words', async () => {
    const expected: [string, string][] = [
      ['unreadable-module-list', 'cannot read the author Safe module list'],
      ['no-enabled-modules', 'author Safe has no enabled modules'],
      ['no-drafts-module', 'no drafts module on the author Safe'],
      ['ambiguous-drafts-module', 'two drafts modules answer on the author Safe'],
      [
        'no-owner-history-module',
        'no owner history module on the author Safe: the append block cannot be judged',
      ],
      ['ambiguous-owner-history-module', 'two owner history modules answer on the author Safe'],
    ];

    for (const [modulesError, message] of expected) {
      const { deps, entry } = runtime({
        canAuthorVerdict: vi.fn(async () => ({ ok: false, modulesError: modulesError as never })),
      });
      const outcome = await decryptAuthorDraft(INPUT, deps);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toBe(message);
      expect(entry()).toHaveLength(0);
    }
  });

  it('refuses a genesis the drafts log does not name', async () => {
    const { deps, entry } = runtime({
      canAuthorVerdict: vi.fn(async () => ({ ok: false, modules: VERDICT.modules })),
    });
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('unknown draft');
    expect(entry()).toHaveLength(0);
    expect(deps.cat).not.toHaveBeenCalled();
  });

  it('refuses a draft the Safe s log attributes to another Safe', async () => {
    const { deps } = runtime({
      canAuthorVerdict: vi.fn(async () => ({ ...VERDICT, ok: false, author: OTHER_SAFE })),
    });
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('draft belongs to another Safe');
  });

  it('refuses on a verdict with no block and no owner set when the gate said no', async () => {
    // The residual shape: no block reported and no set named, so no answer was
    // reached and there is nothing to read the entry under.
    const { deps, entry } = runtime({
      canAuthorVerdict: vi.fn(async () => ({ ok: false, modules: VERDICT.modules, author: SAFE })),
    });
    const outcome = await decryptAuthorDraft(INPUT, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('signer does not own the author Safe');
    expect(entry()).toHaveLength(0);
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
    expect(outcome.trace.find((s) => s.step === 'appendBlock')?.ownerSet).toBe('append-block');
  });
});
