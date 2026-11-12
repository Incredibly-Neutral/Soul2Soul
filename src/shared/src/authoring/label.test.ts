/**
 * `label` in the note frontmatter.
 *
 * It is a protocol key, not template data: it lands in ParsedNote as a trimmed
 * string, stays out of the custom bag, and a blank or non-string value is no
 * label at all.
 */
import { describe, it, expect } from 'vitest';

import { KNOWN_FRONTMATTER_KEYS, parseMarkdownNote } from './note';

function note(extra: string): string {
  return `---
title: My First Post
custom_field: hello
${extra}
---

# A Real Title

Body.
`;
}

describe('authoring/note — label', () => {
  it('parses a label and keeps it out of the custom bag', async () => {
    const parsed = await parseMarkdownNote(note('label: Field notes'), 'n.md');

    expect(parsed.label).toBe('Field notes');
    expect(parsed.custom).toEqual({ custom_field: 'hello' });
    expect(KNOWN_FRONTMATTER_KEYS.has('label')).toBe(true);
  });

  it('trims the value', async () => {
    const parsed = await parseMarkdownNote(note('label: "  Field notes  "'), 'n.md');

    expect(parsed.label).toBe('Field notes');
    expect(parsed.custom).toEqual({ custom_field: 'hello' });
  });

  it('reads a blank or non-string value as no label', async () => {
    expect((await parseMarkdownNote(note('label: ""'), 'n.md')).label).toBeNull();
    expect((await parseMarkdownNote(note('label: "   "'), 'n.md')).label).toBeNull();
    expect((await parseMarkdownNote(note('label: 42'), 'n.md')).label).toBeNull();
    expect((await parseMarkdownNote(note('label: [a, b]'), 'n.md')).label).toBeNull();
  });

  it('is null when the note has no label', async () => {
    const parsed = await parseMarkdownNote(note(''), 'n.md');

    expect(parsed.label).toBeNull();
  });
});
