import { describe, it, expect } from 'vitest';
import { prevNextRing } from './handlebars-helpers.js';
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
