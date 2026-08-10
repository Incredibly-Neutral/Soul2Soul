// ============================================================================
// Local render fixtures (RFC B — templating-only dev kit).
//
// Synthesized S2SBody / templateData used to drive the renderer layer locally
// with NO chain, NO gateway, NO decrypt, NO signature. Every body is a plaintext
// S2SBodyPlain (encryption: false).
//
// Content bodies are stored RAW (markdown) — mirroring the render action's
// contract that stored content stays clean/raw and the markdown->HTML + content
// transform stage happen at render time (see local-render.ts contentPipeline()).
//
// 'hello-world' deliberately contains a `<!-- section class="aside">...` section
// directive so the `sections` content transform (RFC A) is exercised end-to-end.
// ============================================================================

import type { S2SBodyPlain } from '@s2s/soul2soul-shared';

/** Posts rendered by post.handlebars and collected by home.handlebars. */
export const postFixtures: S2SBodyPlain[] = [
  {
    id: 'fixture-post-1',
    author: '0x1111111111111111111111111111111111111111',
    locale: 'en',
    parent: '',
    position: '0',
    postType: 'post',
    creationDate: '2026-01-15T10:00:00Z',
    modifiedDate: '2026-01-15T10:00:00Z',
    tags: ['s2s', 'fixture'],
    encryption: false,
    title: 'Hello World',
    slug: 'hello-world',
    content: `# Hello World

Welcome to the local-render fixture. This body is stored as **raw markdown** and
is converted to HTML and passed through the content-transform stage at render time.

<!-- section class="aside">This aside callout is produced by the sections content transform.<!-- /section -->

The section directive above becomes a real \`<section class="aside">\` element.
`,
  },
  {
    id: 'fixture-post-2',
    author: '0x2222222222222222222222222222222222222222',
    locale: 'en',
    parent: '',
    position: '1',
    postType: 'post',
    creationDate: '2026-02-01T09:30:00Z',
    modifiedDate: '2026-02-01T09:30:00Z',
    tags: ['s2s', 'fixture'],
    encryption: false,
    title: 'Second Post',
    slug: 'second-post',
    content: `# Second Post

A second fixture post with **markdown** and a plain paragraph.
`,
  },
];

/** Pages rendered by page.handlebars. */
export const pageFixtures: S2SBodyPlain[] = [
  {
    id: 'fixture-page-1',
    author: '0x3333333333333333333333333333333333333333',
    locale: 'en',
    parent: '',
    position: '0',
    postType: 'page',
    creationDate: '2026-01-01T08:00:00Z',
    modifiedDate: '2026-01-01T08:00:00Z',
    tags: ['s2s', 'fixture'],
    encryption: false,
    title: 'About',
    slug: 'about',
    content: `# About

This is a **page** fixture rendered by page.handlebars.
`,
  },
];

/**
 * Every fixture body referenced by the local-render script, keyed by postType.
 * Used to keep the "which bodies exist" source of truth in one place.
 */
export const allFixtures: Record<string, S2SBodyPlain[]> = {
  post: postFixtures,
  page: pageFixtures,
};
