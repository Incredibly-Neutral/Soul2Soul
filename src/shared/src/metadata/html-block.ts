// ============================================================================
// HTML block extraction / JSON-LD injection — the single definition of
// "the bytes that get hashed".
//
// The renderer hashes the page BEFORE injecting its JSON-LD block; the update
// gate re-derives the digest from the page AFTER injection. Both therefore need
// the same answer to "which substring of this page is the hashed region", and
// that answer has to be stable across the injection:
//
//   extractHashableHtml(insertJsonLdScript(page, tag)) === extractHashableHtml(page)
//
// When the page carries an <html> wrapper the injected block is placed BEFORE
// `<html`, i.e. outside the region, so the invariant is free. When it does not,
// the only available region is the whole document, so the block(s) are stripped
// before hashing — otherwise signer and verifier would hash different strings
// and every page without an <html> tag would be permanently un-updatable.
//
// Keeping this in shared/ is deliberate: it lived twice (render + verify) and
// the two copies silently disagreed on exactly that case.
// ============================================================================

const HTML_BLOCK_RE = /<html[^>]*>([\s\S]*)<\/html>/i;

/**
 * A JSON-LD block plus one optional trailing newline.
 *
 * The trailing newline belongs to the injection, not to the page, so it is
 * consumed as well — otherwise stripping `tag + "\n" + page` would leave one
 * stray "\n" and break the round-trip invariant.
 */
const JSON_LD_BLOCK_RE = /<script\s+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>\r?\n?/gi;

/** True when the page carries an `<html>…</html>` wrapper (i.e. a real region). */
export function hasHtmlBlock(html: string): boolean {
  return HTML_BLOCK_RE.test(html);
}

/**
 * The hashed region of a page.
 *
 * - `<html>…</html>` present  → that block, exactly as before (backwards
 *   compatible with every already-published page, whose digest was taken over
 *   the same substring).
 * - no `<html>` tag           → the whole document minus any JSON-LD blocks.
 *
 * `\r\n` → `\n` because IPFS gateways may rewrite line endings; that
 * normalisation is part of the definition, so it lives here too.
 */
export function extractHashableHtml(html: string): string {
  const block = HTML_BLOCK_RE.exec(html);
  const region = block ? block[0] : html.replace(JSON_LD_BLOCK_RE, '');
  return region.replace(/\r\n/g, '\n');
}

const DOCTYPE = '<!DOCTYPE html>';

/**
 * Insert the page's JSON-LD block, in the position that keeps it outside the
 * hashed region whenever a region boundary exists.
 */
export function insertJsonLdScript(html: string, scriptTag: string): string {
  const doctypeAt = html.indexOf(DOCTYPE);
  if (doctypeAt >= 0) {
    const head = html.slice(0, doctypeAt);
    const rest = html.slice(doctypeAt + DOCTYPE.length);
    if (/<html/i.test(rest)) {
      // Same bytes as the original renderer: the block lands just before <html>.
      return head + DOCTYPE + rest.replace(/(\s*<html)/i, `\n${scriptTag}\n$1`);
    }
    // DOCTYPE but no <html>: leave the document otherwise untouched, so
    // stripping the block restores exactly the pre-injection bytes.
    return head + DOCTYPE + `${scriptTag}\n` + rest;
  }
  if (/<html/i.test(html)) {
    return html.replace(/(<html)/i, `${scriptTag}\n$1`);
  }
  return `${scriptTag}\n${html}`;
}
