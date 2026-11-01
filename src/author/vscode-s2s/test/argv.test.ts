import { describe, expect, it } from 'vitest';

import {
  UsageError,
  authorArgs,
  authorIdentityArgs,
  configArgs,
  isAuthorAction,
  publicationNewArgs,
  requireAbsoluteNote,
  versionArgs,
} from '../src/argv';
import { NOTE } from './fixtures';

const ACTIONS = ['upload', 'offer', 'preview', 'publish', 'revoke'] as const;

describe('authorArgs — shape', () => {
  it.each(ACTIONS)('%s: group, action, absolute note, --json last', (action) => {
    const args = authorArgs(action, NOTE);
    expect(args.slice(0, 3)).toEqual(['author', action, NOTE]);
    expect(args[args.length - 1]).toBe('--json');
    expect(args.filter((arg) => arg === '--json')).toHaveLength(1);
  });

  it.each(ACTIONS)('%s: never invents a flag', (action) => {
    expect(authorArgs(action, NOTE)).toEqual(['author', action, NOTE, '--json']);
  });

  it('passes --publication before --json', () => {
    const args = authorArgs('upload', NOTE, { publication: 'polyphony.soul2soul.eth' });
    expect(args).toEqual([
      'author',
      'upload',
      NOTE,
      '--publication',
      'polyphony.soul2soul.eth',
      '--json',
    ]);
  });

  it('uses offer, never propose', () => {
    const args = authorArgs('offer', NOTE, { cid: 'bafy-cid' });
    expect(args).toContain('offer');
    expect(args).not.toContain('propose');
    expect(args).toContain('--cid');
    expect(args[args.length - 1]).toBe('--json');
  });

  it('passes --allow-plaintext as a boolean', () => {
    const args = authorArgs('publish', NOTE, { allowPlaintext: true });
    expect(args).toContain('--allow-plaintext');
    expect(args[args.indexOf('--allow-plaintext') + 1]).toBe('--json');
  });
});

describe('authorArgs — refusals', () => {
  it('rejects a relative note path', () => {
    expect(() => authorArgs('upload', 'notes/a.md')).toThrow(UsageError);
  });

  it('rejects an empty note path', () => {
    expect(() => authorArgs('upload', '')).toThrow(/no note path/);
  });

  it('rejects --cid on anything but offer', () => {
    expect(() => authorArgs('publish', NOTE, { cid: 'bafy' })).toThrow(/--cid is not valid/);
  });

  it('rejects --allow-plaintext on revoke', () => {
    expect(() => authorArgs('revoke', NOTE, { allowPlaintext: true })).toThrow(
      /--allow-plaintext is not valid/,
    );
  });
});

describe('requireAbsoluteNote', () => {
  it('returns the path when absolute', () => {
    expect(requireAbsoluteNote(NOTE)).toBe(NOTE);
  });
});

describe('isAuthorAction', () => {
  it('accepts the five actions and rejects propose', () => {
    for (const action of ACTIONS) expect(isAuthorAction(action)).toBe(true);
    expect(isAuthorAction('propose')).toBe(false);
  });
});

describe('publicationNewArgs', () => {
  it('builds the required shape', () => {
    expect(publicationNewArgs('polyphony', { repo: 'joera/polyphony' })).toEqual([
      'publication',
      'new',
      'polyphony',
      '--repo',
      'joera/polyphony',
      '--json',
    ]);
  });

  it('joins author and owner lists with commas', () => {
    const args = publicationNewArgs('polyphony', {
      repo: 'joera/polyphony',
      branch: 'main',
      authors: ['0xa', '0xb'],
      owners: ['0xc'],
    });
    expect(args).toEqual([
      'publication',
      'new',
      'polyphony',
      '--repo',
      'joera/polyphony',
      '--branch',
      'main',
      '--author',
      '0xa,0xb',
      '--owner',
      '0xc',
      '--json',
    ]);
  });

  it('requires a name and a repo', () => {
    expect(() => publicationNewArgs('', { repo: 'o/r' })).toThrow(UsageError);
    expect(() => publicationNewArgs('polyphony', { repo: '' })).toThrow(UsageError);
  });
});

describe('configArgs', () => {
  it('passes values through verbatim', () => {
    expect(configArgs('set', ['rpcL2', 'https://example.invalid'])).toEqual([
      'config',
      'set',
      'rpcL2',
      'https://example.invalid',
      '--json',
    ]);
  });

  it('appends --local before --json', () => {
    expect(configArgs('list', [], { local: true })).toEqual([
      'config',
      'list',
      '--local',
      '--json',
    ]);
  });
});

describe('identity helpers', () => {
  it('address/init take no positional', () => {
    expect(authorIdentityArgs('address')).toEqual(['author', 'address', '--json']);
    expect(authorIdentityArgs('init')).toEqual(['author', 'init', '--json']);
  });

  it('version document', () => {
    expect(versionArgs()).toEqual(['--version', '--json']);
  });
});
