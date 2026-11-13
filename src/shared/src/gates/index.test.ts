import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  canPublish,
  canRead,
  canReset,
  canReview,
  owns,
  ownsVerdict,
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
});

describe('canRead', () => {
  it('reads canRead on the publication and isOwner on the author Safe', async () => {
    const { read, asked } = makeRead({
      [`canRead:${PUBLICATION}`]: true,
      [`isOwner:${AUTHOR_SAFE}`]: true,
    });
    expect(await canRead(read, HEX32, AUTHOR_SAFE, PUBLICATION, SIGNER)).toBe(true);
    expect(asked.map((a) => `${a.fn}:${a.target}`).sort()).toEqual(
      [`canRead:${PUBLICATION}`, `isOwner:${AUTHOR_SAFE}`].sort(),
    );
    const canReadArgs = asked.find((a) => a.fn === 'canRead')!.args;
    expect(canReadArgs).toEqual([HEX32, AUTHOR_SAFE]);
  });

  it('refuses when the publication answers no for this reader, even for its owner', async () => {
    const { read } = makeRead({
      [`canRead:${PUBLICATION}`]: false,
      [`isOwner:${AUTHOR_SAFE}`]: true,
    });
    expect(await canRead(read, HEX32, AUTHOR_SAFE, PUBLICATION, SIGNER)).toBe(false);
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
      let seen: unknown[] | undefined;
      const read: GateRead = async (target, _abi, fn, args) => {
        if (fn === 'canRead') seen = args;
        return true;
      };
      await canRead(read, 'bafyrawwcid', AUTHOR_SAFE, PUBLICATION, SIGNER);
      expect(seen).toEqual([HEX32, AUTHOR_SAFE]);
    });

    it('passes an already-hashed 0x+64hex reference through unchanged', async () => {
      let seen: unknown[] | undefined;
      const read: GateRead = async (target, _abi, fn, args) => {
        if (fn === 'canRead') seen = args;
        return true;
      };
      await canRead(read, HEX32, AUTHOR_SAFE, PUBLICATION, SIGNER);
      expect(seen).toEqual([HEX32, AUTHOR_SAFE]);
    });
  });
});

describe('canRead without an ethers runtime', () => {
  it('uses the normaliser the host supplies, never the global', async () => {
    vi.unstubAllGlobals();
    expect(typeof (globalThis as any).ethers).toBe('undefined');

    let seen: unknown[] | undefined;
    const read: GateRead = async (_target, _abi, fn, args) => {
      if (fn === 'canRead') seen = args;
      return true;
    };
    const toId = (ref: string) => `hashed:${ref}`;

    expect(await canRead(read, 'bafyrawwcid', AUTHOR_SAFE, PUBLICATION, SIGNER, toId)).toBe(true);
    expect(seen).toEqual(['hashed:bafyrawwcid', AUTHOR_SAFE]);
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

describe('owns', () => {
  const SAFE = '0x' + 'aa'.repeat(20);
  const OTHER_SAFE = '0x' + 'bb'.repeat(20);
  const DRAFTS = '0x' + '11'.repeat(20);
  const HISTORY = '0x' + '22'.repeat(20);
  const PUBLICATION_MODULE = '0x' + '33'.repeat(20);
  const ZERO = '0x' + '0'.repeat(40);
  /** The append block of the genesis's last version. */
  const APPEND_BLOCK = 4321;

  // One chain: the Safe's enabled modules answer the two role ids, the drafts
  // module answers authorOf and blocksOf, the history module answers isOwnerAt,
  // and the Safe itself answers isOwner. Every read is recorded with its target
  // and arguments, so a test can prove which owner set answered.
  const ownsChain = (
    options: {
      author?: string;
      blocks?: unknown;
      isOwnerAt?: boolean;
      isOwner?: boolean;
      enabled?: string[];
      answers?: Record<string, string[]>;
      ambiguousDrafts?: boolean;
    } = {},
  ) => {
    const asked: { target: string; fn: string; args: unknown[] }[] = [];
    const enabled = options.enabled ?? [PUBLICATION_MODULE, DRAFTS, HISTORY];
    const answers = options.answers ?? {
      [DRAFTS]: [DRAFTS_MODULE_INTERFACE_ID],
      [HISTORY]: [OWNER_HISTORY_MODULE_INTERFACE_ID],
    };
    const withExtraDrafts = options.ambiguousDrafts
      ? { ...answers, [PUBLICATION_MODULE]: [DRAFTS_MODULE_INTERFACE_ID] }
      : answers;

    const read: GateRead = async (target, _abi, fn, args) => {
      asked.push({ target, fn, args });
      if (fn === 'supportsInterface') return (withExtraDrafts[target] ?? []).includes(String(args[0]));
      if (fn === 'isOwner') return options.isOwner ?? true;
      throw new Error(`unexpected boolean read ${fn}:${target}`);
    };

    const readValue: GateValueRead = async (target, _abi, fn, args) => {
      asked.push({ target, fn, args });
      if (fn === 'getModulesPaginated') return [enabled, ZERO];
      if (fn === 'authorOf') return options.author ?? SAFE;
      if (fn === 'blocksOf') return options.blocks ?? [1, APPEND_BLOCK];
      if (fn === 'isOwnerAt') return options.isOwnerAt ?? true;
      throw new Error(`unexpected value read ${fn}:${target}`);
    };

    return { read, readValue, asked };
  };

  it('accepts an owner at the append block, read from the owner-history module', async () => {
    const { read, readValue, asked } = ownsChain({ isOwnerAt: true });

    expect(await owns(read, readValue, HEX32, SAFE, SIGNER)).toBe(true);

    const ownership = asked.find((a) => a.fn === 'isOwnerAt')!;
    expect(ownership.target).toBe(HISTORY);
    expect(ownership.args).toEqual([SIGNER, APPEND_BLOCK]);
    // The live isOwner is never the answer, at any block; a recorded block reads
    // the history module and nothing else.
    expect(asked.some((a) => a.fn === 'isOwner')).toBe(false);
    expect(asked.find((a) => a.fn === 'authorOf')!.target).toBe(DRAFTS);
  });

  it('rejects an address that only became an owner later', async () => {
    // It owns the Safe now, but not in the block the genesis was appended in.
    const { read, readValue, asked } = ownsChain({ isOwnerAt: false, isOwner: true });

    expect(await owns(read, readValue, HEX32, SAFE, SIGNER)).toBe(false);

    const ownership = asked.find((a) => a.fn === 'isOwnerAt')!;
    expect(ownership.args).toEqual([SIGNER, APPEND_BLOCK]);
    expect(asked.some((a) => a.fn === 'isOwner')).toBe(false);
  });

  it('refuses a version whose block is 0 when the live set does not hold the signer', async () => {
    // Block 0 is "no block was recorded": pre-upgrade, or carried in by an import.
    // The question is still asked, against the Safe's live owners.
    const { read, readValue, asked } = ownsChain({ blocks: [0], isOwner: false, isOwnerAt: true });

    expect(await owns(read, readValue, HEX32, SAFE, SIGNER)).toBe(false);

    expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
  });

  it('answers a version whose block is 0 from the Safe live isOwner, with no history read', async () => {
    const { read, readValue, asked } = ownsChain({ blocks: [0], isOwner: true, isOwnerAt: false });

    expect(await owns(read, readValue, HEX32, SAFE, SIGNER)).toBe(true);

    const live = asked.find((a) => a.fn === 'isOwner')!;
    expect(live.target).toBe(SAFE);
    expect(live.args).toEqual([SIGNER]);
    expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
  });

  it('answers a log with no usable block list the same way: live isOwner, no history read', async () => {
    const { read, readValue, asked } = ownsChain({ blocks: [], isOwner: true, isOwnerAt: false });

    expect(await owns(read, readValue, HEX32, SAFE, SIGNER)).toBe(true);

    expect(asked.some((a) => a.fn === 'isOwner')).toBe(true);
    expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
  });

  it('reads the block of the last version, not the first', async () => {
    const { read, readValue, asked } = ownsChain({ blocks: [11, 12, APPEND_BLOCK] });

    await owns(read, readValue, HEX32, SAFE, SIGNER);

    expect(asked.find((a) => a.fn === 'isOwnerAt')!.args).toEqual([SIGNER, APPEND_BLOCK]);
  });

  it('refuses a genesis the Safe drafts log does not name, before any ownership read', async () => {
    const { read, readValue, asked } = ownsChain({ author: OTHER_SAFE });

    expect(await owns(read, readValue, HEX32, SAFE, SIGNER)).toBe(false);
    expect(asked.some((a) => a.fn === 'authorOf')).toBe(true);
    expect(asked.some((a) => a.fn === 'blocksOf')).toBe(false);
    expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
  });

  it('compares the named Safe case-insensitively', async () => {
    const { read, readValue } = ownsChain({ author: '0x' + 'AA'.repeat(20) });

    expect(await owns(read, readValue, HEX32, SAFE.toLowerCase(), SIGNER)).toBe(true);
  });

  it('refuses an unknown genesis — DraftsModuleV1 answers zero rather than reverting', async () => {
    const { read, readValue, asked } = ownsChain({ author: ZERO });

    expect(await owns(read, readValue, HEX32, SAFE, SIGNER)).toBe(false);
    expect(asked.some((a) => a.fn === 'blocksOf')).toBe(false);
    expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
  });

  it('refuses without reading the log when the Safe runs two drafts modules', async () => {
    const { read, readValue, asked } = ownsChain({ ambiguousDrafts: true });

    expect(await owns(read, readValue, HEX32, SAFE, SIGNER)).toBe(false);
    expect(asked.some((a) => a.fn === 'authorOf')).toBe(false);
  });

  it('refuses when the drafts log answers no usable block list and the live set does not hold it', async () => {
    const { read, readValue, asked } = ownsChain({ blocks: 'not-a-list', isOwner: false });

    expect(await owns(read, readValue, HEX32, SAFE, SIGNER)).toBe(false);
    expect(asked.some((a) => a.fn === 'isOwner')).toBe(true);
    expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
  });

  it('holds for a draft no publication knows — the case canPublish cannot answer', async () => {
    const { read, readValue } = ownsChain({ isOwnerAt: true });
    const { read: publicationRead } = makeRead({
      [`canPublish:${PUBLICATION}`]: false,
      [`isOwner:${SAFE}`]: true,
    });

    expect(await canPublish(publicationRead, SAFE, PUBLICATION, SIGNER)).toBe(false);
    expect(await owns(read, readValue, HEX32, SAFE, SIGNER)).toBe(true);
  });

  it('normalises a raw reference before the authorOf read', async () => {
    const { read, readValue, asked } = ownsChain();

    await owns(read, readValue, 'bafyrawwcid', SAFE, SIGNER, { toId: (r) => `hashed:${r}` });
    expect(asked.find((a) => a.fn === 'authorOf')!.args).toEqual(['hashed:bafyrawwcid']);
  });

  // `owns` is `ownsVerdict(...).ok`, so every decision above is also the
  // verdict's decision. What is tested here is what the verdict REPORTS: which
  // paths carry the judged block, and which carry the module answers and the
  // entry author, so a caller does not resolve the Safe's modules a second time.
  describe('ownsVerdict — what it reports', () => {
    it('reports the append block and the answers it judged from', async () => {
      const { read, readValue } = ownsChain();

      const verdict = await ownsVerdict(read, readValue, HEX32, SAFE, SIGNER);

      expect(verdict).toEqual({
        ok: true,
        block: APPEND_BLOCK,
        ownerSet: 'append-block',
        modules: { drafts: DRAFTS, ownerHistory: HISTORY },
        author: SAFE,
      });
    });

    it('reports block 0 with the live owner set that answered it', async () => {
      const { read, readValue, asked } = ownsChain({ blocks: [0], isOwner: true });

      const verdict = await ownsVerdict(read, readValue, HEX32, SAFE, SIGNER);

      expect(verdict.block).toBe(0);
      expect(verdict.ok).toBe(true);
      expect(verdict.ownerSet).toBe('live');
      expect(verdict.modules).toEqual({ drafts: DRAFTS, ownerHistory: HISTORY });
      expect(verdict.author).toBe(SAFE);
      expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
    });

    it('reports the block on a refusal too', async () => {
      const { read, readValue } = ownsChain({ isOwnerAt: false });

      const verdict = await ownsVerdict(read, readValue, HEX32, SAFE, SIGNER);

      expect(verdict.ok).toBe(false);
      expect(verdict.block).toBe(APPEND_BLOCK);
      expect(verdict.ownerSet).toBe('append-block');
    });

    it('reports no block but the live set when the drafts log answers no usable block list', async () => {
      const { read, readValue } = ownsChain({ blocks: 'not-a-list' });

      const verdict = await ownsVerdict(read, readValue, HEX32, SAFE, SIGNER);

      expect(verdict.ok).toBe(true);
      expect(verdict.block).toBeUndefined();
      expect(verdict.ownerSet).toBe('live');
      // The two answers before it did land, so a caller may still use them.
      expect(verdict.modules).toEqual({ drafts: DRAFTS, ownerHistory: HISTORY });
      expect(verdict.author).toBe(SAFE);
    });

    it('names the set that answered, so the two paths are told apart without the block-0 rule', async () => {
      const pinned = ownsChain();
      const live = ownsChain({ blocks: [0] });

      expect((await ownsVerdict(pinned.read, pinned.readValue, HEX32, SAFE, SIGNER)).ownerSet).toBe(
        'append-block',
      );
      expect((await ownsVerdict(live.read, live.readValue, HEX32, SAFE, SIGNER)).ownerSet).toBe(
        'live',
      );
    });

    it('reports the module reason, and no modules, when the lookup answers nothing', async () => {
      const { read, readValue } = ownsChain({ ambiguousDrafts: true });

      const verdict = await ownsVerdict(read, readValue, HEX32, SAFE, SIGNER);

      expect(verdict.ok).toBe(false);
      expect(verdict.modules).toBeUndefined();
      expect(verdict.modulesError).toBe('ambiguous-drafts-module');
      expect(verdict.block).toBeUndefined();
      expect(verdict.ownerSet).toBeUndefined();
      expect(verdict.author).toBeUndefined();
    });

    it('reports the modules but no author when the log names no genesis', async () => {
      const { read, readValue } = ownsChain({ author: ZERO });

      const verdict = await ownsVerdict(read, readValue, HEX32, SAFE, SIGNER);

      expect(verdict.ok).toBe(false);
      expect(verdict.modules).toEqual({ drafts: DRAFTS, ownerHistory: HISTORY });
      expect(verdict.author).toBeUndefined();
      expect(verdict.block).toBeUndefined();
      expect(verdict.ownerSet).toBeUndefined();
    });

    it('reports the other Safe s name, and no block, when the log is not this Safe s', async () => {
      const { read, readValue } = ownsChain({ author: OTHER_SAFE });

      const verdict = await ownsVerdict(read, readValue, HEX32, SAFE, SIGNER);

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

  it('refuses an owner of some other Safe', async () => {
    const { read } = makeRead({ [`isOwner:${PUBLICATION}`]: false });
    expect(await canReset(read, PUBLICATION, SIGNER)).toBe(false);
  });
});
