/**
 * The hashed-region definition, and the invariant that makes it safe:
 *
 *   extractHashableHtml(insertJsonLdScript(page, tag)) === extractHashableHtml(page)
 *
 * The renderer hashes before injection; the verifier hashes after. If those two
 * disagree the page's own digest can never match, and the update gate rejects
 * forever. They disagreed for exactly one page shape (no <html> tag), which is
 * what this file pins.
 */
import { describe, it, expect } from 'vitest';
import { extractHashableHtml, insertJsonLdScript } from './html-block';

const TAG = `<script type="application/ld+json">
{ "identifier": "0xabc" }
</script>`;

const PAGES = {
  'doctype + html': `<!DOCTYPE html>\n<html lang="en"><body>hi</body></html>`,
  'html only': `<html lang="en"><body>hi</body></html>`,
  'doctype, no html': `<!DOCTYPE html><body>hi</body>`,
  'bare fragment': `<div>hi</div>`,
  'doctype + html with page-owned json-ld': `<!DOCTYPE html>\n<html lang="en"><head><script type="application/ld+json">{"a":1}</script></head><body>hi</body></html>`,
  'bare fragment with page-owned json-ld': `<script type="application/ld+json">{"a":1}</script>\n<div>hi</div>`,
};

describe('extractHashableHtml', () => {
  it('returns the <html>…</html> block, excluding the doctype and the injected block', () => {
    expect(extractHashableHtml(PAGES['doctype + html'])).toBe(
      `<html lang="en"><body>hi</body></html>`,
    );
  });

  it('normalises CRLF so gateway rewriting does not break the digest', () => {
    expect(extractHashableHtml(`<html>\r\n<body>x</body>\r\n</html>`)).toBe(
      `<html>\n<body>x</body>\n</html>`,
    );
  });

  it('falls back to the whole document when there is no <html> tag', () => {
    expect(extractHashableHtml(`<div>hi</div>`)).toBe(`<div>hi</div>`);
  });

  it('strips JSON-LD blocks when the whole document is the region', () => {
    // Otherwise the injected block would be part of the verifier's region but
    // not of the signer's.
    expect(extractHashableHtml(`${TAG}\n<div>hi</div>`)).toBe(`<div>hi</div>`);
  });
});

describe('insertJsonLdScript', () => {
  it('puts the block before <html>, outside the hashed region', () => {
    const out = insertJsonLdScript(PAGES['doctype + html'], TAG);
    expect(out.indexOf(TAG)).toBeLessThan(out.indexOf('<html'));
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('never drops the block for a doctype without an <html> tag', () => {
    // Pre-existing bug: the doctype branch only injected when it later found
    // `<html`, so these pages shipped with no provenance block at all.
    const out = insertJsonLdScript(PAGES['doctype, no html'], TAG);
    expect(out).toContain(TAG);
  });
});

describe('insert/extract invariant — signer and verifier hash the same bytes', () => {
  for (const [name, page] of Object.entries(PAGES)) {
    it(`holds for: ${name}`, () => {
      const injected = insertJsonLdScript(page, TAG);
      expect(injected).toContain(TAG);
      expect(extractHashableHtml(injected)).toBe(extractHashableHtml(page));
      // The signed region never contains the injected block itself.
      expect(extractHashableHtml(injected)).not.toContain(TAG);
    });
  }

  it('is stable for a page that already carries its own JSON-LD block', () => {
    const page = PAGES['bare fragment with page-owned json-ld'];
    const injected = insertJsonLdScript(page, TAG);
    expect(extractHashableHtml(injected)).toBe(extractHashableHtml(page));
  });
});
