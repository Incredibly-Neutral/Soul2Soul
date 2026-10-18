import { describe, expect, it } from 'vitest';

import {
  deriveSummary,
  extractFrontmatter,
  extractTitleAndBase,
  parseMarkdownNote,
  slugifyTitle,
} from './note';

const NOTE = `---
title: My First Post
language: fr
tags:
  - acme--s2s
  - personal
post_type: article
parent: 3
custom_field: hello
genesis: 0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c
---

# A Real Title

Intro paragraph.

<!--more-->

Rest of the body.
`;

describe('authoring/note', () => {
  it('parses frontmatter, tags, custom bag and publications', async () => {
    const parsed = await parseMarkdownNote(NOTE, 'ignored-name.md');

    expect(parsed.title).toBe('A Real Title'); // `# ` heading wins over frontmatter/filename
    expect(parsed.postType).toBe('article');
    expect(parsed.locale).toBe('fr');
    expect(parsed.parent).toBe(3);
    expect(parsed.tags).toEqual(['acme--s2s', 'personal']);
    expect(parsed.publications).toEqual(['acme.soul2soul.eth']);
    expect(parsed.custom).toEqual({ custom_field: 'hello' });
    expect(parsed.genesis).toBe('0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c');
    expect(parsed.slug).toBe('a-real-title');
  });

  it('splits summary from content on the more marker', async () => {
    const parsed = await parseMarkdownNote(NOTE, 'x.md');
    expect(parsed.summary).toContain('Intro paragraph');
    expect(parsed.summary).not.toContain('Rest of the body');
    expect(parsed.content).toContain('Rest of the body');
  });

  it('derives a slug from the filename when there is no heading or frontmatter', async () => {
    const parsed = await parseMarkdownNote('# H1 Title', 'Some File!.md');
    expect(parsed.title).toBe('H1 Title');
    expect(parsed.slug).toBe('h1-title');
  });

  it('handles a file with no frontmatter', async () => {
    const parsed = await parseMarkdownNote('# Only A Heading', 'note.md');
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.tags).toEqual([]);
    expect(parsed.publications).toEqual([]);
    expect(parsed.contentId).toBeNull();
    expect(parsed.genesis).toBeNull();
  });

  it('extractFrontmatter isolates the yaml block', () => {
    const { frontmatter, body } = extractFrontmatter('---\ntags: [a]\n---\n# Body');
    expect(frontmatter).toEqual({ tags: ['a'] });
    expect(body.trim()).toBe('# Body');
  });

  it('slugifyTitle mirrors the neutralpress options', () => {
    expect(slugifyTitle("Hello, World! (v2)")).toBe('hello-world-v2');
    expect(slugifyTitle('  Spaces   and... Punct?.')).toBe('spaces-and-punct');
  });

  it('extractTitleAndBase strips .base embeds and promotes a heading', () => {
    const { body, title } = extractTitleAndBase('![[template.base]]\n\n# The Title\n\nBody');
    expect(title).toBe('The Title');
    expect(body).toContain('Body');
    expect(body).not.toContain('template.base');
  });

  it('deriveSummary handles split markers', () => {
    const { summary, content } = deriveSummary('before<!--split-->after');
    expect(summary).toBe('before');
    expect(content).toBe('after');
  });
});
