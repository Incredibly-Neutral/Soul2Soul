import { describe, it, expect } from 'vitest';
import { prevNextRing, prevNextData } from './handlebars-helpers.js';
import { renderHTMLFromSource } from './html.ctrlr.js';

// ============================================================================
// prevNext built-in helper — CIRCULAR RING prev/next navigation.
//
// Ported from the s2s-s3ntiment helpers.source reference impl. The Track-2
// runtime publication-helper injection path is DEAD (see
// brain/specs/RFC-content-transforms.md), so `prevNext` is now a BUILT-IN so
// `{{prevNext collections.why position}}` works in production via the
// statically-compiled bundle.
//
// Verified reference behavior (3 fixtures, positions 1/2/3):
//   pos1 → prev=last, next=#2
//   pos2 → prev=#1,   next=#3
//   pos3 → prev=#2,   next=#1
// ============================================================================

const ring = [
  { id: 'a', position: 1 },
  { id: 'b', position: 2 },
  { id: 'c', position: 3 },
];

const ids = (r: { prev: any; next: any }) => ({
  prev: r.prev?.id,
  next: r.next?.id,
});

describe('prevNextRing — 3-position circular ring (identity + wrap)', () => {
  it('position 1: prev wraps to last (c), next is #2 (b)', () => {
    expect(ids(prevNextRing(ring, 1)!)).toEqual({ prev: 'c', next: 'b' });
  });

  it('position 2: prev is #1 (a), next is #3 (c)', () => {
    expect(ids(prevNextRing(ring, 2)!)).toEqual({ prev: 'a', next: 'c' });
  });

  it('position 3: prev is #2 (b), next wraps to first (a)', () => {
    expect(ids(prevNextRing(ring, 3)!)).toEqual({ prev: 'b', next: 'a' });
  });

  it('accepts string positions ({{prevNext collections.why position}} resolves strings)', () => {
    expect(ids(prevNextRing(ring, '2')!)).toEqual({ prev: 'a', next: 'c' });
  });

  it('orders by ascending position regardless of input order', () => {
    const shuffled = [ring[2], ring[0], ring[1]];
    expect(ids(prevNextRing(shuffled, 2)!)).toEqual({ prev: 'a', next: 'c' });
  });
});

describe('prevNextRing — degenerate cases', () => {
  it('1-item ring: prev and next are the same single item (emitted once)', () => {
    const single = [{ id: 'only', position: 1 }];
    const r = prevNextRing(single, 1)!;
    expect(r.prev).toBe(r.next);
    expect(r.prev.id).toBe('only');
    expect(r.ordered).toHaveLength(1);
  });

  it('empty ring: returns null (helper emits "")', () => {
    expect(prevNextRing([], 1)).toBeNull();
  });

  it('non-array collection: returns null', () => {
    expect(prevNextRing(undefined, 1)).toBeNull();
    expect(prevNextRing('nope', 1)).toBeNull();
    expect(prevNextRing(null, 1)).toBeNull();
  });

  it('non-numeric position: returns null', () => {
    expect(prevNextRing(ring, 'abc')).toBeNull();
    expect(prevNextRing(ring, undefined)).toBeNull();
  });

  it('items without a numeric position are filtered out of the ring', () => {
    const mixed = [
      { id: 'x', position: 'nope' },
      { id: 'a', position: 1 },
      { id: 'b', position: 2 },
    ];
    expect(ids(prevNextRing(mixed, 1)!)).toEqual({ prev: 'b', next: 'b' }); // 2-ring: prev==next==other
  });
});

// ============================================================================
// Built-in registration — {{prevNext collections.why position}} in a template
// ============================================================================

describe('prevNext built-in helper (rendered through the renderer)', () => {
  it('is registered as a built-in and renders the wrapped prev/next blocks', () => {
    const html = renderHTMLFromSource(
      '<!DOCTYPE html><html><body>{{prevNext collections.why position}}</body></html>',
      {},
      {
        position: '1',
        collections: {
          why: ring,
        },
      },
    );
    // pos1 → prev wraps to last (c), next is #2 (b)
    expect(html).toContain('id="c"');
    expect(html).toContain('id="b"');
    expect(html).not.toContain('id="a"');
    // both blocks emitted (prev + next)
    expect((html.match(/class="block"/g) || []).length).toBe(2);
  });

  it('emits the single item once for a 1-item ring', () => {
    const html = renderHTMLFromSource(
      '<!DOCTYPE html><html><body>{{prevNext collections.why position}}</body></html>',
      {},
      {
        position: '1',
        collections: { why: [{ id: 'only', position: 1 }] },
      },
    );
    expect(html).toContain('id="only"');
    expect((html.match(/class="block"/g) || []).length).toBe(1);
  });

  it('emits "" (no block) for an empty ring', () => {
    const html = renderHTMLFromSource(
      '<!DOCTYPE html><html><body>{{prevNext collections.why position}}</body></html>',
      {},
      { position: '1', collections: { why: [] } },
    );
    expect(html).toBe('<!DOCTYPE html><html><body></body></html>');
  });
});

// ============================================================================
// prevNextData built-in helper — DATA-RETURNING sibling of {{prevNext}}.
//
// Returns an ARRAY (not an HTML string) of the prev/next ring items so the
// engine's {{#each (prevNextData collections.why position)}} iterates them and
// dev-authored HTML inside the loop works via {{this.<field>}} /
// {{{this.custom.summary}}}. Semantics mirror prevNextRing/prevNext exactly:
//   n == 1  → [the single item]
//   n >  1  → [prev, next] (greatest position < current, least > current, wrap)
//   empty / non-array / non-numeric position → []
// Each element exposes the same field surface prevNext's block() uses:
// id, author, slug, path, and custom.summary.
// ============================================================================

const dataRing = [
  {
    id: 'a',
    position: 1,
    author: 'Author A',
    slug: 'a-slug',
    path: '/posts/a',
    custom: { summary: 'sum-a' },
  },
  {
    id: 'b',
    position: 2,
    author: 'Author B',
    slug: 'b-slug',
    path: '/posts/b',
    custom: { summary: 'sum-b' },
  },
  {
    id: 'c',
    position: 3,
    author: 'Author C',
    slug: 'c-slug',
    path: '/posts/c',
    custom: { summary: 'sum-c' },
  },
];

const dataIds = (arr: any[]) => arr.map((it) => it?.id);

describe('prevNextData — 3-position circular ring (identity + wrap)', () => {
  it('position 1: [prev wraps to last (c), next is #2 (b)]', () => {
    expect(dataIds(prevNextData(dataRing, 1))).toEqual(['c', 'b']);
  });

  it('position 2: [prev is #1 (a), next is #3 (c)]', () => {
    expect(dataIds(prevNextData(dataRing, 2))).toEqual(['a', 'c']);
  });

  it('position 3: [prev is #2 (b), next wraps to first (a)]', () => {
    expect(dataIds(prevNextData(dataRing, 3))).toEqual(['b', 'a']);
  });

  it('accepts string positions (resolves like {{prevNextData ... position}})', () => {
    expect(dataIds(prevNextData(dataRing, '2'))).toEqual(['a', 'c']);
  });

  it('orders by ascending position regardless of input order', () => {
    const shuffled = [dataRing[2], dataRing[0], dataRing[1]];
    expect(dataIds(prevNextData(shuffled, 2))).toEqual(['a', 'c']);
  });
});

describe('prevNextData — degenerate cases', () => {
  it('1-item ring: returns an array of that one item', () => {
    const single = [{ id: 'only', position: 1 }];
    const out = prevNextData(single, 1);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ id: 'only', position: 1 });
  });

  it('empty ring: returns []', () => {
    expect(prevNextData([], 1)).toEqual([]);
  });

  it('non-array collection: returns []', () => {
    expect(prevNextData(undefined, 1)).toEqual([]);
    expect(prevNextData('nope', 1)).toEqual([]);
    expect(prevNextData(null, 1)).toEqual([]);
  });

  it('non-numeric position: returns []', () => {
    expect(prevNextData(dataRing, 'abc')).toEqual([]);
    expect(prevNextData(dataRing, undefined)).toEqual([]);
  });

  it('items without a numeric position are filtered out of the ring', () => {
    const mixed = [
      { id: 'x', position: 'nope' },
      { id: 'a', position: 1 },
      { id: 'b', position: 2 },
    ];
    expect(dataIds(prevNextData(mixed, 1))).toEqual(['b', 'b']); // 2-ring: prev==next==other
  });
});

describe('prevNextData built-in helper (rendered through the renderer)', () => {
  it('is registered and {{#each (prevNextData ...)}} iterates the two ring items', () => {
    const html = renderHTMLFromSource(
      '<!DOCTYPE html><html><body>{{#each (prevNextData collections.why position)}}<article>{{this.slug}}</article>{{/each}}</body></html>',
      {},
      { position: '1', collections: { why: dataRing } },
    );
    // pos1 → [c, b]
    expect(html).toContain('<article>c-slug</article>');
    expect(html).toContain('<article>b-slug</article>');
    expect(html).not.toContain('<article>a-slug</article>');
    expect((html.match(/<article>/g) || []).length).toBe(2);
  });

  it('exposes the full field surface (id, author, slug, path, custom.summary) per item', () => {
    const html = renderHTMLFromSource(
      '<!DOCTYPE html><html><body>{{#each (prevNextData collections.why position)}}<article data-id="{{this.id}}" author="{{this.author}}" slug="{{this.slug}}" path="{{this.path}}">{{{this.custom.summary}}}</article>{{/each}}</body></html>',
      {},
      { position: '1', collections: { why: dataRing } },
    );
    expect((html.match(/<article/g) || []).length).toBe(2);
    expect(html).toContain('data-id="c"');
    expect(html).toContain('author="Author C"');
    expect(html).toContain('slug="c-slug"');
    expect(html).toContain('path="/posts/c"');
    expect(html).toContain('sum-c');
    expect(html).toContain('data-id="b"');
    expect(html).toContain('author="Author B"');
    expect(html).toContain('slug="b-slug"');
    expect(html).toContain('path="/posts/b"');
    expect(html).toContain('sum-b');
  });

  it('emits a single article for a 1-item ring', () => {
    const html = renderHTMLFromSource(
      '<!DOCTYPE html><html><body>{{#each (prevNextData collections.why position)}}<article>{{this.slug}}</article>{{/each}}</body></html>',
      {},
      {
        position: '1',
        collections: { why: [{ id: 'only', position: 1, slug: 'only-slug' }] },
      },
    );
    expect(html).toContain('<article>only-slug</article>');
    expect((html.match(/<article>/g) || []).length).toBe(1);
  });

  it('emits nothing (no articles) for an empty ring', () => {
    const html = renderHTMLFromSource(
      '<!DOCTYPE html><html><body>{{#each (prevNextData collections.why position)}}<article>{{this.slug}}</article>{{/each}}</body></html>',
      {},
      { position: '1', collections: { why: [] } },
    );
    expect(html).toBe('<!DOCTYPE html><html><body></body></html>');
  });
});
