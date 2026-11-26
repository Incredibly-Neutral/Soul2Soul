import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHTML } from './html.ctrlr';

// ============================================================================
// Fatal-failure guards for the production render path.
//
// A failed template or partial fetch, or a render that produces no page, must
// reject. It must never resolve to an empty or partial page that then gets
// uploaded and published in place of the real one.
// ============================================================================

const GW = 'https://gw.test';
const TPL_CID = 'bafyTEMPLATE';
const FOOTER_CID = 'bafyFOOTER';
const OUTER_CID = 'bafyOUTER';
const INNER_CID = 'bafyINNER';
const UNUSED_CID = 'bafyUNUSED';

const config = { templateCid: 'bafyTEST' };
const templateConfig = { file: 'post' };

const listing = [
  { path: 'templates/post.handlebars', cid: TPL_CID },
  { path: 'templates/partials/footer.handlebars', cid: FOOTER_CID },
  { path: 'templates/partials/outer.handlebars', cid: OUTER_CID },
  { path: 'templates/partials/inner.handlebars', cid: INNER_CID },
  { path: 'templates/partials/unused.handlebars', cid: UNUSED_CID },
];

const simpleTemplate = '<html><body><h1>{{title}}</h1>{{> footer}}</body></html>';
const footerSource = '<footer>foot</footer>';
const nestedTemplate = '<html><body>{{> outer}}</body></html>';
const outerSource = '<section>{{> inner}}</section>';
const innerSource = '<i>deep</i>';

type CatSpec = { status: number; body?: string };

interface FetchOptions {
  template?: CatSpec;
  cats?: Record<string, CatSpec>;
  array?: any[];
}

let fetchedUrls: string[] = [];
const originalFetch = globalThis.fetch;

const installFetch = (opts: FetchOptions = {}) => {
  fetchedUrls = [];
  const template = opts.template ?? { status: 200, body: simpleTemplate };
  const cats: Record<string, CatSpec> = {
    [TPL_CID]: template,
    [FOOTER_CID]: { status: 200, body: footerSource },
    [OUTER_CID]: { status: 200, body: outerSource },
    [INNER_CID]: { status: 200, body: innerSource },
    ...(opts.cats ?? {}),
  };

  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    fetchedUrls.push(url);

    if (url.includes('/api/v0/dag/get?arg=')) {
      return new Response(JSON.stringify(opts.array ?? listing), { status: 200 });
    }

    const match = url.match(/cat\?arg=([^&]+)/);
    const spec = match ? cats[match[1]] : undefined;
    if (!spec) return new Response('not found', { status: 404 });

    return new Response(spec.status === 200 ? (spec.body ?? '') : 'error', {
      status: spec.status,
    });
  }) as any;
};

const data = { title: 'Hi' };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('renderHTML fatal failures', () => {
  it('rejects when the template cat returns 404', async () => {
    installFetch({ template: { status: 404 } });
    await expect(renderHTML(config, templateConfig, data, GW)).rejects.toThrow(
      'template bundle unavailable',
    );
  });

  it('rejects when the template body is empty', async () => {
    installFetch({ template: { status: 200, body: '   \n  ' } });
    await expect(renderHTML(config, templateConfig, data, GW)).rejects.toThrow(
      'template render produced an empty page',
    );
  });

  it('rejects when a referenced partial cat returns 404', async () => {
    installFetch({ cats: { [FOOTER_CID]: { status: 404 } } });
    await expect(renderHTML(config, templateConfig, data, GW)).rejects.toThrow(
      /partial fetch failed: footer \(404\)/,
    );
  });

  it('does not fetch an unreferenced partial and renders successfully', async () => {
    installFetch({ cats: { [UNUSED_CID]: { status: 404 } } });
    const html = await renderHTML(config, templateConfig, data, GW);
    expect(html).toContain('<h1>Hi</h1>');
    expect(html).toContain('<footer>foot</footer>');
    expect(fetchedUrls.some((url) => url.includes(UNUSED_CID))).toBe(false);
  });

  it('resolves a nested partial reference transitively', async () => {
    installFetch({
      template: { status: 200, body: nestedTemplate },
    });
    const html = await renderHTML(config, templateConfig, data, GW);
    expect(html).toContain('<section>');
    expect(html).toContain('<i>deep</i>');
    expect(fetchedUrls.some((url) => url.includes(OUTER_CID))).toBe(true);
    expect(fetchedUrls.some((url) => url.includes(INNER_CID))).toBe(true);
  });

  it('leaves a Handlebars built-in tag literal instead of treating it as a partial', async () => {
    installFetch({
      template: { status: 200, body: '<html><body>{{> @partial-block}}</body></html>' },
    });
    const html = await renderHTML(config, templateConfig, data, GW);
    expect(html).toContain('{{> @partial-block}}');
  });

  it('leaves a parameterised partial tag literal instead of treating it as a partial', async () => {
    installFetch({
      template: { status: 200, body: '<html><body>{{> footer title="x"}}</body></html>' },
    });
    const html = await renderHTML(config, templateConfig, data, GW);
    expect(html).toContain('{{> footer title="x"}}');
    expect(fetchedUrls.some((url) => url.includes(FOOTER_CID))).toBe(false);
  });

  it('returns HTML on the plain happy path', async () => {
    installFetch();
    const html = await renderHTML(config, templateConfig, data, GW);
    expect(html).toContain('<h1>Hi</h1>');
    expect(html).toContain('<footer>foot</footer>');
  });
});
