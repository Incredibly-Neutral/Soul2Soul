// ============================================================================
// `s2s author info` — one identity report under two names.
//
// The chain read and the store write-back are faked (`AuthorIdentityDeps`), so
// what is under test is the text and the JSON both actions emit: `info` leads
// with the pet name, `address` keeps the block it printed before the rename,
// and both carry the same keys with their own action.
// ============================================================================

import type { Address } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import {
  authorAddress,
  authorIdentityLines,
  authorInfo,
  runAuthorIdentity,
  type AuthorIdentityDeps,
} from '../src/commands/address';
import { authorHelpEntries, findAuthorCommand } from '../src/commands/index';
import type { AuthorSafeState } from '../src/core/author-safe';
import type { CliContext } from '../src/core/context';
import type { CliOut } from '../src/lib/out';

const SAFE = '0x934E20411C9E8E92946BD8786D7c3E5bC4DB1387' as Address;
const EOA = '0x2222222222222222222222222222222222222222' as Address;

const STATE: AuthorSafeState = {
  address: SAFE,
  eoa: EOA,
  salt: `s2s_${EOA}`,
  chain: 'base',
  safeSource: 'derived',
  deployed: false,
};

interface Captured {
  out: CliOut;
  results: Record<string, unknown>[];
  human: string[];
  warnings: string[];
}

function capture(): Captured {
  const results: Record<string, unknown>[] = [];
  const human: string[] = [];
  const warnings: string[] = [];
  const out: CliOut = {
    json: false,
    log: () => undefined,
    warn: (message: string) => warnings.push(message),
    result: (data: unknown, text?: string) => {
      results.push(data as Record<string, unknown>);
      if (text !== undefined) human.push(text);
    },
  };
  return { out, results, human, warnings };
}

/** Only what the command reads: the active author row, and output. */
function context(out: CliOut, author: { name: string; source: string } | undefined): CliContext {
  return { out, config: { author } } as unknown as CliContext;
}

function deps(state: AuthorSafeState = STATE): AuthorIdentityDeps {
  return { safeState: () => Promise.resolve(state), remember: vi.fn() };
}

describe('s2s author info', () => {
  it('prints the pet name first, then the address block unchanged', async () => {
    const cap = capture();

    await runAuthorIdentity(
      context(cap.out, { name: 'zomi', source: 'store' }),
      'author.info',
      deps(),
    );

    expect(cap.human[0]).toBe(
      [
        'author      : zomi',
        `author safe : ${SAFE}`,
        `eoa (owner) : ${EOA}`,
        `salt        : s2s_${EOA}`,
        'chain       : base',
        'deployed    : no — run: s2s author init',
      ].join('\n'),
    );
    expect(cap.results[0]).toEqual({
      action: 'author.info',
      address: SAFE,
      eoa: EOA,
      salt: `s2s_${EOA}`,
      chain: 'base',
      safeSource: 'derived',
      deployed: false,
      author: 'zomi',
    });
  });

  it('says the key is not in the store when no author row resolved', async () => {
    const cap = capture();

    // A key from env / a project file has no pet name (`resolvePrivateKey` leaves
    // `name` undefined), so `config.author` is absent or nameless.
    await runAuthorIdentity(context(cap.out, undefined), 'author.info', deps());

    expect(cap.human[0]?.split('\n')[0]).toBe('author      : (none — key not in the author store)');
    expect(cap.results[0]?.author).toBeNull();
  });

  it('keeps the suffixes the address block already had', () => {
    const given: AuthorSafeState = { ...STATE, salt: null, safeSource: 'given', signerIsOwner: false };

    expect(authorIdentityLines(given, 'zomi', 'author.info').split('\n').slice(1)).toEqual([
      `author safe : ${SAFE}`,
      `eoa (owner) : ${EOA}  — not an owner of this Safe (s2s signer queue)`,
      'salt        : (none, the Safe was given, not derived)',
      'chain       : base',
      'deployed    : no — this CLI never deploys a given Safe; its owners have to',
    ]);
  });
});

describe('s2s author address (alias)', () => {
  it('prints the block it printed before info existed, and reports its own action', async () => {
    const cap = capture();

    await runAuthorIdentity(
      context(cap.out, { name: 'zomi', source: 'store' }),
      'author.address',
      deps(),
    );

    expect(cap.human[0]).toBe(
      [
        `author safe : ${SAFE}`,
        `eoa (owner) : ${EOA}`,
        `salt        : s2s_${EOA}`,
        'chain       : base',
        'deployed    : no — run: s2s author init',
      ].join('\n'),
    );
    expect(cap.results[0]?.action).toBe('author.address');
    // The plugins read `author` from this result, so the key stays on both.
    expect(cap.results[0]?.author).toBe('zomi');
  });

  it('names no deprecation on the alias path', async () => {
    const cap = capture();

    await runAuthorIdentity(context(cap.out, { name: 'zomi', source: 'store' }), 'author.address', deps());

    expect(cap.warnings).toEqual([]);
    expect(cap.human[0]).not.toMatch(/deprecat/i);
  });
});

describe('registration', () => {
  it('dispatches both names to a spec', () => {
    expect(findAuthorCommand('info')).toBe(authorInfo);
    expect(findAuthorCommand('address')).toBe(authorAddress);
  });

  it('lists the alias next to info in `s2s author --help`', () => {
    const names = authorHelpEntries.map((entry) => entry.name);
    const at = names.indexOf('info');

    expect(at).toBeGreaterThanOrEqual(0);
    expect(names[at + 1]).toBe('address');
    expect(authorHelpEntries[at + 1]?.summary).toMatch(/^Alias of info/);
    expect(authorHelpEntries[at]?.summary).toMatch(/author identity/);
  });
});
