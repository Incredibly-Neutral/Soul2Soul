import { describe, it, expect, afterAll } from 'vitest';
import { renderHTML, renderHTMLFromSource } from './html.ctrlr';

// ============================================================================
// Production byte-identity regression guard.
//
// The production `renderHTML` was split into `fetchTemplateBundle` (fetching)
// + `renderHTMLFromSource` (pure) + the gateway partial resolver. This test
// asserts that a FIXED production input produces EXACTLY the same output it
// did BEFORE the refactor (captured from the pre-refactor renderHTML on the
// same inputs, via a mocked gateway), proving the refactor is byte-identical.
// ============================================================================

const GW = 'https://gw.test';
const TPL_CID = 'bafyTEMPLATE';
const FOO_CID = 'bafyFOOTER';

const templateArray = [
  { path: 'templates/post.handlebars', cid: TPL_CID },
  { path: 'templates/partials/footer.handlebars', cid: FOO_CID },
];

const templateSource = `<!DOCTYPE html>
<html>
<body>
<h1>{{title}}</h1>
<p>{{content}}</p>
{{> footer}}
</body>
</html>`;

const footerSource = `<footer>&copy; {{year}} \u2014 {{lowercase title}}</footer>`;

// ---- Mock the IPFS gateway (dag/get + cat) ------------------------------
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  if (url.includes('/api/v0/dag/get?arg=')) {
    return new Response(JSON.stringify(templateArray), { status: 200 });
  }
  if (url.includes(`/api/v0/cat?arg=${TPL_CID}`)) {
    return new Response(templateSource, { status: 200 });
  }
  if (url.includes(`/api/v0/cat?arg=${FOO_CID}`)) {
    return new Response(footerSource, { status: 200 });
  }
  return new Response('not found', { status: 404 });
}) as any;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// EXACT output captured from the PRE-REFACTOR production renderHTML on the
// same (config, templateConfig, templateData, gateway) inputs below.
const EXPECTED_BEFORE_REFACTOR = `<!DOCTYPE html>
<html>
<body>
<h1>Hello &amp; World</h1>
<p>Line &lt;b&gt;bold&lt;/b&gt;
NEXT</p>
<footer>© 2026 — hello & world</footer>
</body>
</html>`;

describe('renderHTML byte-identity (additive refactor guard)', () => {
  it('produces byte-identical output to the pre-refactor renderHTML', async () => {
    const html = await renderHTML(
      { templateCid: 'bafyTEST' },
      { file: 'post' },
      { title: 'Hello & World', content: 'Line <b>bold</b>\nNEXT', year: '2026', collections: {} },
      GW,
    );
    expect(html).toBe(EXPECTED_BEFORE_REFACTOR);
  });

  it('renderHTMLFromSource (pure) matches the production fetch path byte-for-byte', () => {
    // The pure core, fed the same injected sources the gateway would return,
    // must equal the production renderHTML output exactly — the zero-drift
    // guarantee that the dev action and production share one renderer.
    const html = renderHTMLFromSource(
      templateSource,
      { footer: footerSource },
      { title: 'Hello & World', content: 'Line <b>bold</b>\nNEXT', year: '2026', collections: {} },
    );
    expect(html).toBe(EXPECTED_BEFORE_REFACTOR);
  });
});
