import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  canAuthor,
  canAuthorVerdict,
  canPublish,
  canRead,
  canReset,
  canReview,
  isOutOfForce,
  isOwnerAt,
  lastVersionBlock,
  type GateRead,
  type GateValueRead,
} from './index';
import { DRAFTS_MODULE_INTERFACE_ID, OWNER_HISTORY_MODULE_INTERFACE_ID } from './modules';

// The gates are pure decision logic over an injected read, so they can be
// tested without a chain: record every question asked, answer from a table.
const makeRead = (answers: Record<string, boolean>) => {
  const asked: { target: string; fn: string; args: unknown[] }[] = [];
  const read: GateRead = async (target, _abi, fn, args) => {
    asked.push({ target, fn, args });
    const key = `${fn}:${target}`;
    if (!(key in answers)) throw new Error(`unexpected read ${key}`);
    return answers[key];
  };
  return { read, asked };
};

const AUTHOR_SAFE = '0xaaaa';
const PUBLICATION = '0xbbbb';
const SIGNER = '0xcccc';
const HEX32 = `0x${'11'.repeat(32)}`;

const SAFE = '0x' + 'aa'.repeat(20);
const OTHER_SAFE = '0x' + 'bb'.repeat(20);
const DRAFTS = '0x' + '11'.repeat(20);
const HISTORY = '0x' + '22'.repeat(20);
/** A second enabled module, for the two-modules-answer-one-role refusal. */
const EXTRA = '0x' + '33'.repeat(20);
const ZERO = '0x' + '0'.repeat(40);
/** The append block of the genesis's last version. */
const APPEND_BLOCK = 4321;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

interface ChainOptions {
  /** Whether the Safe answers a module list naming the drafts log and history. */
  modules?: boolean;
  /** Whether the Safe runs an owner-history module (off: drafts log only). */
  history?: boolean;
  /** An extra enabled module that also answers the drafts role id. */
  ambiguousDrafts?: boolean;
  /** `authorOf(genesis)` on the drafts module. */
  author?: string;
  /** `blocksOf(genesis)` on the drafts module. */
  blocks?: unknown;
  isOwnerAt?: boolean;
  isOwner?: boolean;
  canRead?: boolean;
}

/**
 * One chain: the Safe's enabled modules answer the two role ids, the drafts
 * module answers `blocksOf`, and the history module answers `isOwnerAt`. The
 * Safe's own `isOwner` is answered too, so a test can prove whether the gate
 * asked it. Every read is recorded with its target and arguments.
 */
const makeChain = (options: ChainOptions = {}) => {
  const asked: { target: string; fn: string; args: unknown[] }[] = [];
  const modules = options.modules ?? true;
  const history = options.history ?? true;

  const enabled = modules
    ? [DRAFTS, ...(history ? [HISTORY] : []), ...(options.ambiguousDrafts ? [EXTRA] : [])]
    : [];

  const read: GateRead = async (target, _abi, fn, args) => {
    asked.push({ target, fn, args });
    if (fn === 'supportsInterface') {
      if (!modules) return false;
      if (args[0] === DRAFTS_MODULE_INTERFACE_ID) {
        return same(target, DRAFTS) || (options.ambiguousDrafts === true && same(target, EXTRA));
      }
      if (args[0] === OWNER_HISTORY_MODULE_INTERFACE_ID) return history && same(target, HISTORY);
      return false;
    }
    if (fn === 'isOwner') return options.isOwner ?? true;
    if (fn === 'isOwnerAt') return options.isOwnerAt ?? true;
    if (fn === 'canRead') return options.canRead ?? true;
    throw new Error(`unexpected boolean read ${fn}:${target}`);
  };

  const readValue: GateValueRead = async (target, _abi, fn, args) => {
    asked.push({ target, fn, args });
    if (fn === 'getModulesPaginated') return [enabled, ZERO];
    if (fn === 'authorOf') return options.author ?? SAFE;
    if (fn === 'blocksOf') return options.blocks ?? [1, APPEND_BLOCK];
    throw new Error(`unexpected value read ${fn}:${target}`);
  };

  return { read, readValue, asked };
};

describe('isOwnerAt', () => {
  it('asks the Safe itself, live, when no block is given', async () => {
    const { read, asked } = makeRead({ [`isOwner:${SAFE}`]: true });

    expect(await isOwnerAt(read, SAFE, SIGNER)).toBe(true);
    expect(asked).toEqual([{ target: SAFE, fn: 'isOwner', args: [SIGNER] }]);
  });

  it('reads block 0 as the present tense, never as a height', async () => {
    // Block 0 is what a version older than the field, or an imported log, reads
    // back as. With a history module standing by, the gate still asks the Safe.
    const { read, asked } = makeRead({ [`isOwner:${SAFE}`]: true });

    expect(await isOwnerAt(read, SAFE, SIGNER, 0, HISTORY)).toBe(true);
    expect(asked).toEqual([{ target: SAFE, fn: 'isOwner', args: [SIGNER] }]);
  });

  it('asks the history module at the block, and nothing else', async () => {
    const { read, asked } = makeRead({ [`isOwnerAt:${HISTORY}`]: true });

    expect(await isOwnerAt(read, SAFE, SIGNER, APPEND_BLOCK, HISTORY)).toBe(true);
    expect(asked).toEqual([
      { target: HISTORY, fn: 'isOwnerAt', args: [SIGNER, APPEND_BLOCK] },
    ]);
  });

  it('refuses a signer the history does not place as an owner at that block', async () => {
    const { read } = makeRead({ [`isOwnerAt:${HISTORY}`]: false });

    expect(await isOwnerAt(read, SAFE, SIGNER, APPEND_BLOCK, HISTORY)).toBe(false);
  });

  it('refuses a block with no history module, without reading anything', async () => {
    const { read, asked } = makeRead({});

    expect(await isOwnerAt(read, SAFE, SIGNER, APPEND_BLOCK)).toBe(false);
    // The refusal is silent: no read, no throw, and no live fallback answering
    // a question the gate was not asked.
    expect(asked).toEqual([]);
  });
});

describe('lastVersionBlock', () => {
  it('takes the last entry of the list, whatever the decoder returned', () => {
    expect(lastVersionBlock([1, 2, 3])).toBe(3);
    expect(lastVersionBlock(['1', '2', '3'])).toBe(3);
    expect(lastVersionBlock([{ toNumber: () => 9 }])).toBe(9);
  });

  it('answers undefined when there is no block list to read', () => {
    expect(lastVersionBlock(undefined)).toBeUndefined();
    expect(lastVersionBlock([])).toBeUndefined();
    expect(lastVersionBlock('not-a-list')).toBeUndefined();
    expect(lastVersionBlock([{ nope: true }])).toBeUndefined();
  });
});

describe('canPublish', () => {
  it('admits an author Safe that is whitelisted and whose signer owns it', async () => {
    const { read } = makeRead({
      [`canPublish:${PUBLICATION}`]: true,
      [`isOwner:${AUTHOR_SAFE}`]: true,
    });
    expect(await canPublish(read, AUTHOR_SAFE, PUBLICATION, SIGNER)).toBe(true);
  });

  it('is an obligation on both callers, not either: whitelisted author + non-owner signer is refused', async () => {
    const { read } = makeRead({
      [`canPublish:${PUBLICATION}`]: true,
      [`isOwner:${AUTHOR_SAFE}`]: false,
    });
    expect(await canPublish(read, AUTHOR_SAFE, PUBLICATION, SIGNER)).toBe(false);
  });

  it('refuses an owner of a Safe the publication does not whitelist', async () => {
    const { read } = makeRead({
      [`canPublish:${PUBLICATION}`]: false,
      [`isOwner:${AUTHOR_SAFE}`]: true,
    });
    expect(await canPublish(read, AUTHOR_SAFE, PUBLICATION, SIGNER)).toBe(false);
  });

  it('asks ownership in the present tense: a write is being admitted now', async () => {
    const { read, asked } = makeRead({
      [`canPublish:${PUBLICATION}`]: true,
      [`isOwner:${AUTHOR_SAFE}`]: true,
    });

    await canPublish(read, AUTHOR_SAFE, PUBLICATION, SIGNER);

    expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
    expect(asked.find((a) => a.fn === 'isOwner')!.args).toEqual([SIGNER]);
  });
});

describe('canRead', () => {
  it('asks the publication, and judges ownership at the append block', async () => {
    const { read, readValue, asked } = makeChain();

    expect(await canRead(read, readValue, HEX32, SAFE, PUBLICATION, SIGNER)).toBe(true);

    expect(asked.find((a) => a.fn === 'canRead')!.args).toEqual([HEX32, SAFE]);
    const ownership = asked.find((a) => a.fn === 'isOwnerAt')!;
    expect(ownership.target).toBe(HISTORY);
    expect(ownership.args).toEqual([SIGNER, APPEND_BLOCK]);
    expect(asked.find((a) => a.fn === 'blocksOf')!.target).toBe(DRAFTS);
    // Ownership is historical here, so the live owner set is never asked.
    expect(asked.some((a) => a.fn === 'isOwner')).toBe(false);
  });

  it('reads the block of the last version, not the first', async () => {
    const { read, readValue, asked } = makeChain({ blocks: [11, 12, APPEND_BLOCK] });

    await canRead(read, readValue, HEX32, SAFE, PUBLICATION, SIGNER);

    expect(asked.find((a) => a.fn === 'isOwnerAt')!.args).toEqual([SIGNER, APPEND_BLOCK]);
  });

  it('refuses a signer who only became an owner after the version was appended', async () => {
    const { read, readValue } = makeChain({ isOwnerAt: false, isOwner: true });

    expect(await canRead(read, readValue, HEX32, SAFE, PUBLICATION, SIGNER)).toBe(false);
  });

  it('refuses when the publication answers no for this reader, even for its owner', async () => {
    const { read, readValue } = makeChain({ canRead: false, isOwnerAt: true });

    expect(await canRead(read, readValue, HEX32, SAFE, PUBLICATION, SIGNER)).toBe(false);
  });

  it('refuses when the Safe s modules cannot be resolved, rather than asking the live owner set', async () => {
    // No drafts log means no `authorOf` and no height: the ownership half has
    // nothing to answer, and a live `isOwner` would answer a different question.
    const { read, readValue, asked } = makeChain({ modules: false, isOwner: true });

    expect(await canRead(read, readValue, HEX32, SAFE, PUBLICATION, SIGNER)).toBe(false);

    expect(asked.some((a) => a.fn === 'isOwner')).toBe(false);
    expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
    expect(asked.some((a) => a.fn === 'blocksOf')).toBe(false);
  });

  it('admits a version with no height on a Safe that runs no owner-history module', async () => {
    const { read, readValue, asked } = makeChain({
      history: false,
      blocks: [0],
      isOwner: true,
      canRead: true,
    });

    expect(await canRead(read, readValue, HEX32, SAFE, PUBLICATION, SIGNER)).toBe(true);
    expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
  });

  it('asks the drafts log whose the genesis is: the ownership half is canAuthor', async () => {
    const { read, readValue, asked } = makeChain();

    await canRead(read, readValue, HEX32, SAFE, PUBLICATION, SIGNER);

    expect(asked.find((a) => a.fn === 'authorOf')!.target).toBe(DRAFTS);
  });

  describe('genesis normalisation', () => {
    beforeAll(() => {
      // toBytes32Id hashes non-hex32 references through the ethers v5 global
      // that the Lit Action runtime injects; stand one in for the test.
      vi.stubGlobal('ethers', {
        utils: {
          toUtf8Bytes: (s: string) => new TextEncoder().encode(s),
          keccak256: () => HEX32,
        },
      });
    });

    it('hashes a raw CID reference into bytes32 before the canRead read', async () => {
      const { read, readValue, asked } = makeChain();

      await canRead(read, readValue, 'bafyrawwcid', SAFE, PUBLICATION, SIGNER);

      expect(asked.find((a) => a.fn === 'canRead')!.args).toEqual([HEX32, SAFE]);
      expect(asked.find((a) => a.fn === 'blocksOf')!.args).toEqual([HEX32]);
    });

    it('passes an already-hashed 0x+64hex reference through unchanged', async () => {
      const { read, readValue, asked } = makeChain();

      await canRead(read, readValue, HEX32, SAFE, PUBLICATION, SIGNER);

      expect(asked.find((a) => a.fn === 'canRead')!.args).toEqual([HEX32, SAFE]);
    });
  });
});

describe('canRead without an ethers runtime', () => {
  it('uses the normaliser the host supplies, never the global', async () => {
    vi.unstubAllGlobals();
    expect(typeof (globalThis as any).ethers).toBe('undefined');

    const { read, readValue, asked } = makeChain();
    const toId = (ref: string) => `hashed:${ref}`;

    expect(
      await canRead(read, readValue, 'bafyrawwcid', SAFE, PUBLICATION, SIGNER, toId),
    ).toBe(true);
    expect(asked.find((a) => a.fn === 'canRead')!.args).toEqual(['hashed:bafyrawwcid', SAFE]);
  });
});

describe('canReview', () => {
  it('asks the publication only, with the normalised genesis and the signer', async () => {
    const { read, asked } = makeRead({ [`canReview:${PUBLICATION}`]: true });
    expect(await canReview(read, HEX32, PUBLICATION, SIGNER)).toBe(true);
    expect(asked).toEqual([{ target: PUBLICATION, fn: 'canReview', args: [HEX32, SIGNER] }]);
  });

  it('refuses an address the publication does not list as a reviewer', async () => {
    const { read } = makeRead({ [`canReview:${PUBLICATION}`]: false });
    expect(await canReview(read, HEX32, PUBLICATION, SIGNER)).toBe(false);
  });

  it('hashes a raw reference through the host normaliser', async () => {
    let seen: unknown[] | undefined;
    const read: GateRead = async (_target, _abi, fn, args) => {
      if (fn === 'canReview') seen = args;
      return true;
    };
    await canReview(read, 'bafyrawwcid', PUBLICATION, SIGNER, (ref) => `hashed:${ref}`);
    expect(seen).toEqual(['hashed:bafyrawwcid', SIGNER]);
  });
});

describe('isOutOfForce', () => {
  it('is not out of force while the publication holds a deal on the genesis', async () => {
    const { read, asked } = makeRead({ [`hasDeal:${PUBLICATION}`]: true });
    expect(await isOutOfForce(read, HEX32, PUBLICATION)).toBe(false);
    expect(asked).toEqual([{ target: PUBLICATION, fn: 'hasDeal', args: [HEX32] }]);
  });

  it('is out of force when hasDeal answers false, so the page can be removed as a repair', async () => {
    const { read } = makeRead({ [`hasDeal:${PUBLICATION}`]: false });
    expect(await isOutOfForce(read, HEX32, PUBLICATION)).toBe(true);
  });

  it('answers false when the read throws — a transport error never makes a page removable', async () => {
    const read: GateRead = async () => {
      throw new Error('rpc timeout');
    };
    expect(await isOutOfForce(read, HEX32, PUBLICATION)).toBe(false);
  });
});

describe('canAuthor', () => {
  it('accepts an owner at the append block, read from the owner-history module', async () => {
    const { read, readValue, asked } = makeChain({ isOwnerAt: true });

    expect(await canAuthor(read, readValue, HEX32, SAFE, SIGNER)).toBe(true);

    const ownership = asked.find((a) => a.fn === 'isOwnerAt')!;
    expect(ownership.target).toBe(HISTORY);
    expect(ownership.args).toEqual([SIGNER, APPEND_BLOCK]);
    // The live owner set is never the answer when a positive block was recorded.
    expect(asked.some((a) => a.fn === 'isOwner')).toBe(false);
    expect(asked.find((a) => a.fn === 'authorOf')!.target).toBe(DRAFTS);
  });

  it('rejects an address that only became an owner later', async () => {
    // It owns the Safe now, but not in the block the genesis was appended in.
    const { read, readValue, asked } = makeChain({ isOwnerAt: false, isOwner: true });

    expect(await canAuthor(read, readValue, HEX32, SAFE, SIGNER)).toBe(false);

    expect(asked.find((a) => a.fn === 'isOwnerAt')!.args).toEqual([SIGNER, APPEND_BLOCK]);
    expect(asked.some((a) => a.fn === 'isOwner')).toBe(false);
  });

  it('answers a version whose block is 0 from the Safe live isOwner, with no history read', async () => {
    // Block 0 is "no block was recorded": pre-upgrade, or carried in by an
    // import. A missing height must not deny access.
    const { read, readValue, asked } = makeChain({ blocks: [0], isOwner: true, isOwnerAt: false });

    expect(await canAuthor(read, readValue, HEX32, SAFE, SIGNER)).toBe(true);

    const live = asked.find((a) => a.fn === 'isOwner')!;
    expect(live.target).toBe(SAFE);
    expect(live.args).toEqual([SIGNER]);
    expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
  });

  it('refuses that same version when the live set no longer holds the signer', async () => {
    const { read, readValue } = makeChain({ blocks: [0], isOwner: false, isOwnerAt: true });

    expect(await canAuthor(read, readValue, HEX32, SAFE, SIGNER)).toBe(false);
  });

  it('answers a log with no usable block list the same way: live isOwner, no history read', async () => {
    const { read, readValue, asked } = makeChain({ blocks: [], isOwner: true, isOwnerAt: false });

    expect(await canAuthor(read, readValue, HEX32, SAFE, SIGNER)).toBe(true);

    expect(asked.some((a) => a.fn === 'isOwner')).toBe(true);
    expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
  });

  it('judges at the block of the last version, not the first', async () => {
    const { read, readValue, asked } = makeChain({ blocks: [11, 12, APPEND_BLOCK] });

    await canAuthor(read, readValue, HEX32, SAFE, SIGNER);

    expect(asked.find((a) => a.fn === 'isOwnerAt')!.args).toEqual([SIGNER, APPEND_BLOCK]);
  });

  it('refuses a genesis the Safe drafts log does not name, before any ownership read', async () => {
    const { read, readValue, asked } = makeChain({ author: OTHER_SAFE });

    expect(await canAuthor(read, readValue, HEX32, SAFE, SIGNER)).toBe(false);
    expect(asked.some((a) => a.fn === 'authorOf')).toBe(true);
    expect(asked.some((a) => a.fn === 'blocksOf')).toBe(false);
    expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
  });

  it('compares the named Safe case-insensitively', async () => {
    const { read, readValue } = makeChain({ author: SAFE.toUpperCase().replace('0X', '0x') });

    expect(await canAuthor(read, readValue, HEX32, SAFE.toLowerCase(), SIGNER)).toBe(true);
  });

  it('refuses an unknown genesis — DraftsModuleV1 answers zero rather than reverting', async () => {
    const { read, readValue, asked } = makeChain({ author: ZERO });

    expect(await canAuthor(read, readValue, HEX32, SAFE, SIGNER)).toBe(false);
    expect(asked.some((a) => a.fn === 'blocksOf')).toBe(false);
    expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
  });

  it('refuses without reading the log when the Safe runs two drafts modules', async () => {
    const { read, readValue, asked } = makeChain({ ambiguousDrafts: true });

    expect(await canAuthor(read, readValue, HEX32, SAFE, SIGNER)).toBe(false);
    expect(asked.some((a) => a.fn === 'authorOf')).toBe(false);
  });

  it('answers a block-0 version live when the Safe runs no owner-history module', async () => {
    // The missing height needs no history module, so its absence is no reason to
    // deny the draft: the Safe's live owner set answers.
    const { read, readValue, asked } = makeChain({ history: false, blocks: [0], isOwner: true });

    expect(await canAuthor(read, readValue, HEX32, SAFE, SIGNER)).toBe(true);

    expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
    expect(asked.find((a) => a.fn === 'isOwner')!.target).toBe(SAFE);
  });

  it('answers a log with no usable block list live when the Safe runs no owner-history module', async () => {
    const { read, readValue, asked } = makeChain({ history: false, blocks: [], isOwner: true });

    expect(await canAuthor(read, readValue, HEX32, SAFE, SIGNER)).toBe(true);
    expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
    expect(asked.find((a) => a.fn === 'isOwner')!.target).toBe(SAFE);
  });

  it('refuses a positive append block when the Safe runs no owner-history module', async () => {
    // Nothing can say who owned the Safe at that block, and the live set is not
    // that question: the refusal names the module that did not answer.
    const { read, readValue, asked } = makeChain({ history: false, isOwner: true });

    const verdict = await canAuthorVerdict(read, readValue, HEX32, SAFE, SIGNER);

    expect(verdict.ok).toBe(false);
    expect(verdict.modulesError).toBe('no-owner-history-module');
    expect(verdict.block).toBe(APPEND_BLOCK);
    expect(verdict.ownerSet).toBeUndefined();
    expect(verdict.modules).toEqual({ drafts: DRAFTS });
    expect('ownerHistory' in verdict.modules!).toBe(false);
    expect(verdict.author).toBe(SAFE);
    expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
    expect(asked.some((a) => a.fn === 'isOwner')).toBe(false);
  });

  it('refuses a Safe whose module list cannot be read, never answering live', async () => {
    const { read, readValue, asked } = makeChain({ modules: false, isOwner: true });

    expect(await canAuthor(read, readValue, HEX32, SAFE, SIGNER)).toBe(false);
    expect(asked.some((a) => a.fn === 'isOwner')).toBe(false);
  });

  it('holds for a draft no publication knows — the case canPublish cannot answer', async () => {
    const { read, readValue } = makeChain({ isOwnerAt: true });
    const { read: publicationRead } = makeRead({
      [`canPublish:${PUBLICATION}`]: false,
      [`isOwner:${SAFE}`]: true,
    });

    expect(await canPublish(publicationRead, SAFE, PUBLICATION, SIGNER)).toBe(false);
    expect(await canAuthor(read, readValue, HEX32, SAFE, SIGNER)).toBe(true);
  });

  it('normalises a raw reference before the authorOf read', async () => {
    const { read, readValue, asked } = makeChain();

    await canAuthor(read, readValue, 'bafyrawwcid', SAFE, SIGNER, { toId: (r) => `hashed:${r}` });

    expect(asked.find((a) => a.fn === 'authorOf')!.args).toEqual(['hashed:bafyrawwcid']);
  });

  // `canAuthor` is `canAuthorVerdict(...).ok`, so every decision above is also
  // the verdict's. These test what the verdict REPORTS: which paths carry the
  // judged block, which carry the module answers and the entry author, and which
  // owner set answered.
  describe('canAuthorVerdict — what it reports', () => {
    it('reports the append block and the answers it judged from', async () => {
      const { read, readValue } = makeChain();

      const verdict = await canAuthorVerdict(read, readValue, HEX32, SAFE, SIGNER);

      expect(verdict).toEqual({
        ok: true,
        block: APPEND_BLOCK,
        ownerSet: 'append-block',
        modules: { drafts: DRAFTS, ownerHistory: HISTORY },
        author: SAFE,
      });
    });

    it('reports block 0 with the live owner set that answered it', async () => {
      const { read, readValue, asked } = makeChain({ blocks: [0], isOwner: true });

      const verdict = await canAuthorVerdict(read, readValue, HEX32, SAFE, SIGNER);

      expect(verdict.block).toBe(0);
      expect(verdict.ok).toBe(true);
      expect(verdict.ownerSet).toBe('live');
      expect(verdict.modules).toEqual({ drafts: DRAFTS, ownerHistory: HISTORY });
      expect(verdict.author).toBe(SAFE);
      expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
    });

    it('reports the block on a refusal too', async () => {
      const { read, readValue } = makeChain({ isOwnerAt: false });

      const verdict = await canAuthorVerdict(read, readValue, HEX32, SAFE, SIGNER);

      expect(verdict.ok).toBe(false);
      expect(verdict.block).toBe(APPEND_BLOCK);
      expect(verdict.ownerSet).toBe('append-block');
    });

    it('reports no block but the live set when the drafts log answers no usable block list', async () => {
      const { read, readValue } = makeChain({ blocks: 'not-a-list' });

      const verdict = await canAuthorVerdict(read, readValue, HEX32, SAFE, SIGNER);

      expect(verdict.ok).toBe(true);
      expect(verdict.block).toBeUndefined();
      expect(verdict.ownerSet).toBe('live');
      // The two answers before it did land, so a caller may still use them.
      expect(verdict.modules).toEqual({ drafts: DRAFTS, ownerHistory: HISTORY });
      expect(verdict.author).toBe(SAFE);
    });

    it('names the set that answered, so the two paths are told apart without the block-0 rule', async () => {
      const pinned = makeChain();
      const live = makeChain({ blocks: [0] });

      expect(
        (await canAuthorVerdict(pinned.read, pinned.readValue, HEX32, SAFE, SIGNER)).ownerSet,
      ).toBe('append-block');
      expect((await canAuthorVerdict(live.read, live.readValue, HEX32, SAFE, SIGNER)).ownerSet).toBe(
        'live',
      );
    });

    it('reports the module reason, and no modules, when the lookup answers nothing', async () => {
      const { read, readValue } = makeChain({ ambiguousDrafts: true });

      const verdict = await canAuthorVerdict(read, readValue, HEX32, SAFE, SIGNER);

      expect(verdict.ok).toBe(false);
      expect(verdict.modules).toBeUndefined();
      expect(verdict.modulesError).toBe('ambiguous-drafts-module');
      expect(verdict.block).toBeUndefined();
      expect(verdict.ownerSet).toBeUndefined();
      expect(verdict.author).toBeUndefined();
    });

    it('reports the modules but no author when the log names no genesis', async () => {
      const { read, readValue } = makeChain({ author: ZERO });

      const verdict = await canAuthorVerdict(read, readValue, HEX32, SAFE, SIGNER);

      expect(verdict.ok).toBe(false);
      expect(verdict.modules).toEqual({ drafts: DRAFTS, ownerHistory: HISTORY });
      expect(verdict.author).toBeUndefined();
      expect(verdict.block).toBeUndefined();
      expect(verdict.ownerSet).toBeUndefined();
    });

    it('reports the other Safe s name, and no block, when the log is not this Safe s', async () => {
      const { read, readValue } = makeChain({ author: OTHER_SAFE });

      const verdict = await canAuthorVerdict(read, readValue, HEX32, SAFE, SIGNER);

      expect(verdict.ok).toBe(false);
      expect(verdict.author).toBe(OTHER_SAFE);
      expect(verdict.block).toBeUndefined();
      expect(verdict.ownerSet).toBeUndefined();
    });
  });
});

describe('canReset', () => {
  it('asks one question, of the publication Safe, not of the author Safe', async () => {
    const { read, asked } = makeRead({ [`isOwner:${PUBLICATION}`]: true });
    expect(await canReset(read, PUBLICATION, SIGNER)).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0].target).toBe(PUBLICATION);
  });

  it('does not resolve modules or name a block: a reset is asked for now', async () => {
    const { read, asked } = makeRead({ [`isOwner:${PUBLICATION}`]: true });

    await canReset(read, PUBLICATION, SIGNER);

    expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
  });

  it('refuses an owner of some other Safe', async () => {
    const { read } = makeRead({ [`isOwner:${PUBLICATION}`]: false });
    expect(await canReset(read, PUBLICATION, SIGNER)).toBe(false);
  });
});
