import { describe, expect, it } from 'vitest';

import { flagList, flagString, parseArgs } from '../src/lib/args';

describe('parseArgs', () => {
  it('treats boolean flags as boolean and does not consume the next token', () => {
    const { flags, positionals } = parseArgs(['--json', 'author', 'bogus'], {
      booleanFlags: ['json', 'help'],
    });
    expect(flags.json).toBe(true);
    expect(positionals).toEqual(['author', 'bogus']);
  });

  it('consumes a value when the next token is not a flag', () => {
    const { flags, positionals } = parseArgs(['--repo', 'a/b', 'upload', 'x.md']);
    expect(flags.repo).toBe('a/b');
    expect(positionals).toEqual(['upload', 'x.md']);
  });

  it('does not consume a flag-looking token as a value', () => {
    const { flags } = parseArgs(['--repo', '--json']);
    expect(flags.repo).toBe(true);
    expect(flags.json).toBe(true);
  });

  it('supports --flag=value', () => {
    const { flags } = parseArgs(['--repo=a/b', '--branch=main']);
    expect(flags.repo).toBe('a/b');
    expect(flags.branch).toBe('main');
  });

  it('parses single-letter flags as boolean', () => {
    const { flags } = parseArgs(['-h']);
    expect(flags.h).toBe(true);
  });

  it('treats everything after -- as positional', () => {
    const { flags, positionals } = parseArgs(['--json', '--', '--not-a-flag', 'x']);
    expect(flags.json).toBe(true);
    expect(positionals).toEqual(['--not-a-flag', 'x']);
  });

  it('keeps unknown flags verbatim in flags', () => {
    const { flags } = parseArgs(['--whatever', 'value']);
    expect(flags.whatever).toBe('value');
  });
});

describe('flagString / flagList', () => {
  it('reads string flags and returns undefined for boolean flags', () => {
    expect(flagString({ repo: 'a/b' }, 'repo')).toBe('a/b');
    expect(flagString({ json: true }, 'json')).toBeUndefined();
  });

  it('splits comma-separated lists, trimming and dropping empties', () => {
    const flags = { authors: '0xaa, 0xbb ,, 0xcc' };
    expect(flagList(flags, 'authors')).toEqual(['0xaa', '0xbb', '0xcc']);
    expect(flagList({}, 'missing')).toEqual([]);
  });
});
