import { describe, it, expect, beforeAll, vi } from 'vitest';
import { canPublish, canRead, canReset, canReview, owns, type GateRead } from './index';

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
  it('reads canPublish on the publication, isOwner on the author Safe, hasDeal on the publication', async () => {
    const { read, asked } = makeRead({
      [`canPublish:${PUBLICATION}`]: true,
      [`isOwner:${AUTHOR_SAFE}`]: true,
      [`hasDeal:${PUBLICATION}`]: true,
    });
    expect(await canRead(read, HEX32, AUTHOR_SAFE, PUBLICATION, SIGNER)).toBe(true);
    expect(asked.map((a) => `${a.fn}:${a.target}`).sort()).toEqual(
      [`canPublish:${PUBLICATION}`, `hasDeal:${PUBLICATION}`, `isOwner:${AUTHOR_SAFE}`].sort(),
    );
  });

  it('refuses when no deal exists for the genesis, even for a whitelisted owner', async () => {
    const { read } = makeRead({
      [`canPublish:${PUBLICATION}`]: true,
      [`isOwner:${AUTHOR_SAFE}`]: true,
      [`hasDeal:${PUBLICATION}`]: false,
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

    it('hashes a raw CID reference into bytes32 before the hasDeal read', async () => {
      let seen: unknown[] | undefined;
      const read: GateRead = async (target, _abi, fn, args) => {
        if (fn === 'hasDeal') seen = args;
        return true;
      };
      await canRead(read, 'bafyrawwcid', AUTHOR_SAFE, PUBLICATION, SIGNER);
      expect(seen).toEqual([HEX32]);
    });

    it('passes an already-hashed 0x+64hex reference through unchanged', async () => {
      let seen: unknown[] | undefined;
      const read: GateRead = async (target, _abi, fn, args) => {
        if (fn === 'hasDeal') seen = args;
        return true;
      };
      await canRead(read, HEX32, AUTHOR_SAFE, PUBLICATION, SIGNER);
      expect(seen).toEqual([HEX32]);
    });
  });
});

describe('canRead without an ethers runtime', () => {
  it('uses the normaliser the host supplies, never the global', async () => {
    vi.unstubAllGlobals();
    expect(typeof (globalThis as any).ethers).toBe('undefined');

    let seen: unknown[] | undefined;
    const read: GateRead = async (_target, _abi, fn, args) => {
      if (fn === 'hasDeal') seen = args;
      return true;
    };
    const toId = (ref: string) => `hashed:${ref}`;

    expect(await canRead(read, 'bafyrawwcid', AUTHOR_SAFE, PUBLICATION, SIGNER, toId)).toBe(true);
    expect(seen).toEqual(['hashed:bafyrawwcid']);
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
  const AUTHOR_MODULE = '0xdddd';

  // An address-shaped chain read, recorded in its own list so a test can see
  // the order across both reads: authorOf first, isOwner second.
  const makeValueRead = (answers: Record<string, string>) => {
    const valueAsked: { target: string; fn: string; args: unknown[] }[] = [];
    const readValue = async (
      target: string,
      _abi: string[],
      fn: string,
      args: unknown[],
    ): Promise<string> => {
      valueAsked.push({ target, fn, args });
      const key = `${fn}:${target}`;
      if (!(key in answers)) throw new Error(`unexpected read ${key}`);
      return answers[key];
    };
    return { readValue, valueAsked };
  };

  it('resolves the author from the drafts module, then asks that Safe who owns it', async () => {
    const { readValue, valueAsked } = makeValueRead({ [`authorOf:${AUTHOR_MODULE}`]: AUTHOR_SAFE });
    const { read, asked } = makeRead({ [`isOwner:${AUTHOR_SAFE}`]: true });

    expect(await owns(read, readValue, HEX32, AUTHOR_MODULE, SIGNER)).toBe(true);
    expect(valueAsked.map((a) => `${a.fn}:${a.target}`)).toEqual([`authorOf:${AUTHOR_MODULE}`]);
    expect(valueAsked[0].args).toEqual([HEX32]);
    expect(asked.map((a) => `${a.fn}:${a.target}`)).toEqual([`isOwner:${AUTHOR_SAFE}`]);
    expect(asked[0].args).toEqual([SIGNER]);
  });

  it('asks isOwner once, on the Safe the module named, and refuses its non-owner', async () => {
    const { readValue } = makeValueRead({ [`authorOf:${AUTHOR_MODULE}`]: AUTHOR_SAFE });
    const { read, asked } = makeRead({ [`isOwner:${AUTHOR_SAFE}`]: false });

    expect(await owns(read, readValue, HEX32, AUTHOR_MODULE, SIGNER)).toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0].target).toBe(AUTHOR_SAFE);
  });

  it('never reads isOwner on any Safe the module did not name', async () => {
    const OTHER_SAFE = '0xeeee';
    const { readValue } = makeValueRead({ [`authorOf:${AUTHOR_MODULE}`]: AUTHOR_SAFE });
    // makeRead throws on an unexpected isOwner target, so a read of the wrong
    // Safe fails the test rather than answering.
    const { read } = makeRead({ [`isOwner:${OTHER_SAFE}`]: true });

    await expect(owns(read, readValue, HEX32, AUTHOR_MODULE, SIGNER)).rejects.toThrow(
      `unexpected read isOwner:${AUTHOR_SAFE}`,
    );
  });

  it('refuses an unknown genesis — DraftsModuleV1 answers zero rather than reverting', async () => {
    const { readValue, valueAsked } = makeValueRead({
      [`authorOf:${AUTHOR_MODULE}`]: `0x${'0'.repeat(40)}`,
    });
    const { read, asked } = makeRead({});

    expect(await owns(read, readValue, HEX32, AUTHOR_MODULE, SIGNER)).toBe(false);
    expect(valueAsked).toHaveLength(1);
    expect(asked).toHaveLength(0);
  });

  it('holds for a draft no publication knows — the case canPublish cannot answer', async () => {
    const { readValue } = makeValueRead({ [`authorOf:${AUTHOR_MODULE}`]: AUTHOR_SAFE });
    const { read } = makeRead({
      [`canPublish:${PUBLICATION}`]: false,
      [`isOwner:${AUTHOR_SAFE}`]: true,
    });

    expect(await canPublish(read, AUTHOR_SAFE, PUBLICATION, SIGNER)).toBe(false);
    expect(await owns(read, readValue, HEX32, AUTHOR_MODULE, SIGNER)).toBe(true);
  });

  it('normalises a raw reference before the authorOf read', async () => {
    const { readValue, valueAsked } = makeValueRead({ [`authorOf:${AUTHOR_MODULE}`]: AUTHOR_SAFE });
    const { read } = makeRead({ [`isOwner:${AUTHOR_SAFE}`]: true });

    await owns(read, readValue, 'bafyrawwcid', AUTHOR_MODULE, SIGNER, (r) => `hashed:${r}`);
    expect(valueAsked[0].args).toEqual(['hashed:bafyrawwcid']);
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
