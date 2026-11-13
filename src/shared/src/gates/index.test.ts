import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  canPublish,
  canRead,
  canReset,
  canReview,
  isOutOfForce,
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
  // module answers authorOf and blocksOf, and the history module answers
  // isOwnerAt. The Safe's own isOwner is answered too, so a test can prove the
  // gate never asks it. Every read is recorded with its target and arguments.
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

  it('refuses a version whose block is 0, without reading the Safe', async () => {
    // Block 0 is "no block was recorded": pre-upgrade, or carried in by an
    // import. There is no owner set to judge the entry against, so the live
    // answer does not rescue it.
    const { read, readValue, asked } = ownsChain({ blocks: [0], isOwner: true });

    expect(await owns(read, readValue, HEX32, SAFE, SIGNER)).toBe(false);

    expect(asked.some((a) => a.fn === 'isOwner')).toBe(false);
  });

  it('reads no owner at all for block 0: the append block is the only yardstick', async () => {
    // A signer the history would place as an owner at the block the gate was
    // asked in is still not judged at that block; block 0 has no yardstick.
    const { read, readValue, asked } = ownsChain({ blocks: [0], isOwnerAt: true });

    expect(await owns(read, readValue, HEX32, SAFE, SIGNER)).toBe(false);

    expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
    expect(asked.some((a) => a.fn === 'isOwner')).toBe(false);
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

  it('refuses when the drafts log answers no usable block list', async () => {
    const { read, readValue } = ownsChain({ blocks: 'not-a-list' });

    expect(await owns(read, readValue, HEX32, SAFE, SIGNER)).toBe(false);
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
        modules: { drafts: DRAFTS, ownerHistory: HISTORY },
        author: SAFE,
      });
    });

    it('reports block 0 as a refusal, and the answers it had already read', async () => {
      const { read, readValue, asked } = ownsChain({ blocks: [0], isOwner: true });

      const verdict = await ownsVerdict(read, readValue, HEX32, SAFE, SIGNER);

      expect(verdict.block).toBe(0);
      expect(verdict.ok).toBe(false);
      expect(verdict.modules).toEqual({ drafts: DRAFTS, ownerHistory: HISTORY });
      expect(verdict.author).toBe(SAFE);
      expect(asked.some((a) => a.fn === 'isOwner')).toBe(false);
    });

    it('reports the block on a refusal too', async () => {
      const { read, readValue } = ownsChain({ isOwnerAt: false });

      const verdict = await ownsVerdict(read, readValue, HEX32, SAFE, SIGNER);

      expect(verdict.ok).toBe(false);
      expect(verdict.block).toBe(APPEND_BLOCK);
    });

    it('reports no block when the drafts log answers no usable block list', async () => {
      const { read, readValue } = ownsChain({ blocks: 'not-a-list' });

      const verdict = await ownsVerdict(read, readValue, HEX32, SAFE, SIGNER);

      expect(verdict.ok).toBe(false);
      expect(verdict.block).toBeUndefined();
      // The two answers before it did land, so a caller may still use them.
      expect(verdict.modules).toEqual({ drafts: DRAFTS, ownerHistory: HISTORY });
      expect(verdict.author).toBe(SAFE);
    });

    it('reports the module reason, and no modules, when the lookup answers nothing', async () => {
      const { read, readValue } = ownsChain({ ambiguousDrafts: true });

      const verdict = await ownsVerdict(read, readValue, HEX32, SAFE, SIGNER);

      expect(verdict.ok).toBe(false);
      expect(verdict.modules).toBeUndefined();
      expect(verdict.modulesError).toBe('ambiguous-drafts-module');
      expect(verdict.block).toBeUndefined();
      expect(verdict.author).toBeUndefined();
    });

    it('reports the modules but no author when the log names no genesis', async () => {
      const { read, readValue } = ownsChain({ author: ZERO });

      const verdict = await ownsVerdict(read, readValue, HEX32, SAFE, SIGNER);

      expect(verdict.ok).toBe(false);
      expect(verdict.modules).toEqual({ drafts: DRAFTS, ownerHistory: HISTORY });
      expect(verdict.author).toBeUndefined();
      expect(verdict.block).toBeUndefined();
    });

    it('reports the other Safe s name, and no block, when the log is not this Safe s', async () => {
      const { read, readValue } = ownsChain({ author: OTHER_SAFE });

      const verdict = await ownsVerdict(read, readValue, HEX32, SAFE, SIGNER);

      expect(verdict.ok).toBe(false);
      expect(verdict.author).toBe(OTHER_SAFE);
      expect(verdict.block).toBeUndefined();
    });
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
