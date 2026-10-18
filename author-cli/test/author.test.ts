import { describe, expect, it } from 'vitest';

import { upsertFrontmatter } from '../src/lib/frontmatter';

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
