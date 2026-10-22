import { describe, expect, it } from 'vitest';

import { resolveKuboCid, upsertFrontmatter } from '../src/lib/frontmatter';

describe('upsertFrontmatter', () => {
  it('updates an existing key and preserves the rest of the block and the body', () => {
    const raw = ['---', 'title: Hello', 'slug: old', '---', '', '# Hello', 'Body text.'].join(
      '\n',
    );
    const next = upsertFrontmatter(raw, { slug: 'new-slug' });
    expect(next.startsWith('---\n')).toBe(true);
    expect(next).toContain('title: Hello');
    expect(next).toContain('slug: new-slug');
    expect(next).not.toContain('slug: old');
    expect(next.endsWith('---\n\n# Hello\nBody text.')).toBe(true);
  });

  it('adds a new key without dropping existing ones', () => {
    const raw = '---\ntitle: Hello\n---\n\nBody.';
    const next = upsertFrontmatter(raw, { genesis: '0xabcd' });
    expect(next).toContain('title: Hello');
    expect(next).toContain('genesis: "0xabcd"');
    expect(next.endsWith('---\n\nBody.')).toBe(true);
  });

  it('adds a frontmatter block to a file that has none', () => {
    const next = upsertFrontmatter('Just a body.', { title: 'T' });
    expect(next.startsWith('---\n')).toBe(true);
    expect(next).toContain('title: T');
    expect(next.endsWith('---\nJust a body.')).toBe(true);
  });

  it('quotes hex-like values so they round-trip as strings (0x would otherwise re-parse as a number)', () => {
    const raw = ['---', 'title: Hi', '---', '', '# Hi'].join('\n');
    const next = upsertFrontmatter(raw, { genesis: '0x' + 'ab'.repeat(32) });
    expect(next).toContain('genesis: "0x' + 'ab'.repeat(32) + '"');
  });
});

describe('resolveKuboCid', () => {
  it('prefers an explicit --cid over the stored one', () => {
    expect(resolveKuboCid('bafyexplicit', { kubo_cid: 'bafystored' })).toBe('bafyexplicit');
  });

  it('falls back to the CID written back by the last upload', () => {
    expect(resolveKuboCid(undefined, { kubo_cid: 'bafystored' })).toBe('bafystored');
  });

  it('returns undefined when neither is present', () => {
    expect(resolveKuboCid(undefined, {})).toBeUndefined();
    expect(resolveKuboCid(undefined, { kubo_cid: '' })).toBeUndefined();
    expect(resolveKuboCid(undefined, { kubo_cid: '   ' })).toBeUndefined();
    expect(resolveKuboCid(undefined, { kubo_cid: 42 })).toBeUndefined();
  });
});

describe('kubo_cid write-back', () => {
  it('round-trips the CID through the frontmatter upsert', () => {
    const raw = '---\ntitle: Hi\ngenesis: "0xabc"\n---\n\nBody.';
    const next = upsertFrontmatter(raw, { kubo_cid: 'bafkreigh2akiscaildc6gq4q2f4c4r2o2b3qw6m7f5h4j6k7l8m9n0p' });
    expect(next).toContain('kubo_cid: bafkreigh2akiscaildc6gq4q2f4c4r2o2b3qw6m7f5h4j6k7l8m9n0p');
    expect(next).toContain('genesis: "0xabc"');
    expect(next.endsWith('---\n\nBody.')).toBe(true);
  });

  it('overwrites a previous CID in place rather than appending a duplicate key', () => {
    const raw = '---\ntitle: Hi\nkubo_cid: bafyold\n---\n\nBody.';
    const next = upsertFrontmatter(raw, { kubo_cid: 'bafynew' });
    expect(next).toContain('kubo_cid: bafynew');
    expect(next).not.toContain('bafyold');
    expect(next.match(/kubo_cid/g)).toHaveLength(1);
  });
});
