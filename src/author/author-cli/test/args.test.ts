import { describe, expect, it } from 'vitest';

import {
  commandHelp,
  flagBool,
  flagList,
  flagRows,
  flagString,
  GLOBAL_FLAGS,
  parseArgs,
  parseCommandArgs,
  type FlagSpecs,
} from '../src/lib/args';

const PUBLISH_FLAGS: FlagSpecs = {
  publication: { type: 'string', value: '<ens>', summary: 'target publication ENS' },
  'allow-plaintext': { type: 'boolean', summary: 'allow plaintext' },
  author: { type: 'string', value: '<addr>', repeatable: true, summary: 'author address' },
};

describe('parseCommandArgs', () => {
  it('treats a declared boolean as boolean and does not consume the next token', () => {
    const { flags, positionals } = parseCommandArgs(
      ['--allow-plaintext', 'note.md'],
      PUBLISH_FLAGS,
    );
    expect(flags['allow-plaintext']).toBe(true);
    expect(positionals).toEqual(['note.md']);
  });

  it('consumes a value for a declared string flag', () => {
    const { flags, positionals } = parseCommandArgs(
      ['--publication', 'about.soul2soul.eth', 'note.md'],
      PUBLISH_FLAGS,
    );
    expect(flags.publication).toBe('about.soul2soul.eth');
    expect(positionals).toEqual(['note.md']);
  });

  it('supports --flag=value', () => {
    const { flags } = parseCommandArgs(['--publication=a.eth'], PUBLISH_FLAGS);
    expect(flags.publication).toBe('a.eth');
  });

  it('rejects an unknown flag instead of ignoring it', () => {
    expect(() => parseCommandArgs(['--publcation', 'a.eth'], PUBLISH_FLAGS)).toThrow(
      /unknown flag --publcation \(did you mean --publication\?\)/,
    );
  });

  it('rejects a string flag with no value', () => {
    expect(() => parseCommandArgs(['--publication'], PUBLISH_FLAGS)).toThrow(
      /--publication requires a value \(<ens>\)/,
    );
  });

  it('accumulates a repeatable flag as a comma list', () => {
    const { flags } = parseCommandArgs(
      ['--author', '0xaa', '--author', '0xbb'],
      PUBLISH_FLAGS,
    );
    expect(flags.author).toBe('0xaa,0xbb');
  });

  it('negates a boolean with --no-<flag>', () => {
    expect(parseCommandArgs(['--no-json'], PUBLISH_FLAGS).flags.json).toBe(false);
    expect(parseCommandArgs(['--json'], PUBLISH_FLAGS).flags.json).toBe(true);
  });

  it('reads --json=false as false, not as "present"', () => {
    const { flags } = parseCommandArgs(['--json=false'], PUBLISH_FLAGS);
    expect(flagBool(flags, 'json')).toBe(false);
  });

  it('accepts the -h alias for --help', () => {
    expect(parseCommandArgs(['-h'], PUBLISH_FLAGS).flags.help).toBe(true);
  });

  it('treats everything after -- as positional', () => {
    const { positionals } = parseCommandArgs(
      ['--json', '--', '--not-a-flag', 'x'],
      PUBLISH_FLAGS,
    );
    expect(positionals).toEqual(['--not-a-flag', 'x']);
  });
});

describe('parseArgs (discovery)', () => {
  it('keeps unknown flags verbatim and leaves the group/action positional', () => {
    const { flags, positionals } = parseArgs(['--json', 'author', 'bogus']);
    expect(flags.json).toBe(true);
    expect(positionals).toEqual(['author', 'bogus']);
  });

  it('offers --flag=value', () => {
    expect(parseArgs(['--repo=a/b']).flags.repo).toBe('a/b');
  });
});

describe('flag helpers', () => {
  it('reads string flags and returns undefined for boolean flags', () => {
    expect(flagString({ repo: 'a/b' }, 'repo')).toBe('a/b');
    expect(flagString({ json: true }, 'json')).toBeUndefined();
  });

  it('reads booleans', () => {
    expect(flagBool({ 'allow-plaintext': true }, 'allow-plaintext')).toBe(true);
    expect(flagBool({ 'allow-plaintext': false }, 'allow-plaintext')).toBe(false);
    expect(flagBool({}, 'allow-plaintext')).toBe(false);
  });

  it('splits comma-separated lists, trimming and dropping empties', () => {
    const flags = { authors: '0xaa, 0xbb ,, 0xcc' };
    expect(flagList(flags, 'authors')).toEqual(['0xaa', '0xbb', '0xcc']);
    expect(flagList({}, 'missing')).toEqual([]);
  });
});

describe('help rendered from the spec', () => {
  it('lists every declared flag with its placeholder', () => {
    const rows = flagRows(PUBLISH_FLAGS);
    expect(rows).toContain('--publication <ens>');
    expect(rows).toContain('--allow-plaintext');
    expect(rows).toContain('--author <addr>');
  });

  it('builds a usage line from group, name and params', () => {
    const help = commandHelp(
      'author',
      'publish',
      'Upload, offer, render.',
      PUBLISH_FLAGS,
      '<note>',
    );
    expect(help.startsWith('s2s author publish <note> [flags]')).toBe(true);
    expect(help).toContain('--json');
    expect(help).toContain('-h, --help');
  });

  it('renders the help alias once, as -h, --help', () => {
    const rows = flagRows({}, GLOBAL_FLAGS);
    expect(rows.match(/show help for this command/g)).toHaveLength(1);
    expect(rows).toContain('-h, --help');
  });
});
