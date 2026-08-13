import { describe, it, expect, beforeAll } from 'vitest';
import { main } from './main';

// ============================================================================
// render-dev action tests — RFC B Option C.
//
// The dev action must render correctly from INJECTED inputs alone: no chain,
// no decrypt, no sign, no upload, no Lit.Actions.* call. These tests feed it
// plaintext bodies + local template/partial/helper sources and assert the
// output HTML.
// ============================================================================

const sectionTransform = `<!-- section class="aside">This is an aside<!-- /section -->`;
const sectionExpected = `<section class="aside">This is an aside</section>`;

const baseInput = {
  config: { templateCid: 'dev-only' },
  templateConfig: {
    reference: 'post',
    file: 'post',
    path: '/posts',
  },
  templateSource: `<!DOCTYPE html>
<html>
<body>
<article>
<h1>{{title}}</h1>
<div class="content">{{{content}}}</div>
<footer>{{> postfooter}}</footer>
</article>
</body>
</html>`,
  partialsSource: {
    postfooter: `<span>By {{author}}</span>`,
  },
  body: {
    id: 'dev-1',
    author: '0xAlice',
    locale: 'nl',
    parent: '',
    position: '',
    postType: 'post',
    creationDate: '2026-08-10',
    modifiedDate: '2026-08-10',
    tags: [],
    publication: 'test.s2s',
    encryption: false,
    title: 'Hello world',
    slug: 'hello-world',
    content: 'plain',
    custom: {},
  },
};

describe('render-dev: sections content transform', () => {
  it('transforms <!-- section class="aside">... into an HTML <section class="aside">', async () => {
    const res = await main({
      ...baseInput,
      body: { ...baseInput.body, content: sectionTransform },
    });
    expect(res.ok).toBe(true);
    expect(res.action).toBe('render-dev');
    const html = (res as any).html as string;
    expect(html).toContain(sectionExpected);
    expect(html).not.toContain('<!-- section');
  });
});

describe('render-dev: plaintext body (encryption:false) through unescape', () => {
  it('unescapes \\n and \\" in the raw content before the content transform', async () => {
    // The body content carries escaped newlines / quotes (as stored plaintext
    // would); the shared buildTemplateData unescapes them like production.
    const raw = 'line one \\nline two with \"quotes\"';
    const res = await main({
      ...baseInput,
      body: {
        ...baseInput.body,
        content: raw,
      },
      templateSource: `<!DOCTYPE html><html><body><pre>{{{content}}}</pre></body></html>`,
    });
    expect(res.ok).toBe(true);
    const html = (res as any).html as string;
    expect(html).toContain('line one \nline two with "quotes"');
  });

  it('rejects an encrypted body (dev render has no decrypt path)', async () => {
    const res = await main({
      ...baseInput,
      body: { ...baseInput.body, encryption: true as any },
    });
    expect(res.ok).toBe(false);
    expect((res as any).error).toMatch(/plaintext|encryption/i);
  });
});

describe('render-dev: collections', () => {
  it('runs the shared pure collection filter over injected allDeals[]', async () => {
    const res = await main({
      ...baseInput,
      templateConfig: {
        ...baseInput.templateConfig,
        collections: [{ slug: 'featured', filters: [{ featured: true }] }],
      },
      allDeals: [
        { id: 'a', title: 'Featured One', featured: true },
        { id: 'b', title: 'Plain', featured: false },
        { id: 'c', title: 'Featured Two', featured: true },
      ],
      templateSource: `<!DOCTYPE html><html><body>
{{#each collections.featured}}<li>{{title}}</li>{{/each}}
</body></html>`,
    });
    expect(res.ok).toBe(true);
    const html = (res as any).html as string;
    expect(html).toContain('<li>Featured One</li>');
    expect(html).toContain('<li>Featured Two</li>');
    expect(html).not.toContain('<li>Plain</li>');
  });

  it('uses pre-built injected collections directly', async () => {
    const res = await main({
      ...baseInput,
      templateConfig: {
        ...baseInput.templateConfig,
        collections: [{ slug: 'latest', filters: [] }],
      },
      collections: { latest: [{ id: 'x', title: 'Prebuilt' }] },
      templateSource: `<!DOCTYPE html><html><body>{{#each collections.latest}}{{title}}{{/each}}</body></html>`,
    });
    expect(res.ok).toBe(true);
    expect((res as any).html).toContain('Prebuilt');
  });
});

describe('render-dev: output shape', () => {
  it('returns ActionResult-shaped { ok, action, html, trace } with no CIDs/signature', async () => {
    const res = await main(baseInput);
    expect(res.ok).toBe(true);
    const r = res as any;
    expect(r.action).toBe('render-dev');
    expect(typeof r.html).toBe('string');
    expect(Array.isArray(r.trace)).toBe(true);
    expect(r.html).toContain('<h1>Hello world</h1>');
    expect(r.html).toContain('<span>By 0xAlice</span>'); // partial from injected partialsSource
    // no CIDs / signature / upload fields
    expect(r.data).toBeUndefined();
    expect(r.cid).toBeUndefined();
    expect(r.signature).toBeUndefined();
  });
});
