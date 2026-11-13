import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
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
const DRAFTS = '0x' + '11'.repeat(20);
const HISTORY = '0x' + '22'.repeat(20);
const ZERO = '0x' + '0'.repeat(40);
/** The append block of the genesis's last version. */
const APPEND_BLOCK = 4321;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

interface ChainOptions {
  /** Whether the Safe answers a module list naming the drafts log and history. */
  modules?: boolean;
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

  const read: GateRead = async (target, _abi, fn, args) => {
    asked.push({ target, fn, args });
    if (fn === 'supportsInterface') {
      if (!modules) return false;
      if (args[0] === DRAFTS_MODULE_INTERFACE_ID) return same(target, DRAFTS);
      if (args[0] === OWNER_HISTORY_MODULE_INTERFACE_ID) return same(target, HISTORY);
      return false;
    }
    if (fn === 'isOwner') return options.isOwner ?? true;
    if (fn === 'isOwnerAt') return options.isOwnerAt ?? true;
    if (fn === 'canRead') return options.canRead ?? true;
    throw new Error(`unexpected boolean read ${fn}:${target}`);
  };

  const readValue: GateValueRead = async (target, _abi, fn, args) => {
    asked.push({ target, fn, args });
    if (fn === 'getModulesPaginated') return [modules ? [DRAFTS, HISTORY] : [], ZERO];
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

  it('lets the live isOwner decide when the Safe has no resolvable modules', async () => {
    const { read, readValue, asked } = makeChain({ modules: false, isOwner: true });

    expect(await canRead(read, readValue, HEX32, SAFE, PUBLICATION, SIGNER)).toBe(true);

    // No block is named, so no historical read is possible and none is tried.
    expect(asked.some((a) => a.fn === 'blocksOf')).toBe(false);
    expect(asked.some((a) => a.fn === 'isOwnerAt')).toBe(false);
    expect(asked.find((a) => a.fn === 'isOwner')!.target).toBe(SAFE);
  });

  it('refuses that same read when the live isOwner answers no', async () => {
    const { read, readValue } = makeChain({ modules: false, isOwner: false });

    expect(await canRead(read, readValue, HEX32, SAFE, PUBLICATION, SIGNER)).toBe(false);
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
