/**
 * Render-time content transforms.
 *
 * A content transform is a pure string-in/string-out function applied to the
 * decrypted plaintext body content at render time — before any template logic
 * runs and independent of template call sites. Stored/decrypted content stays
 * clean and raw; transforms only affect the rendered `templateData.content`.
 *
 * The stage is a small ordered registry (a typed seam) so a future
 * publication-supplied helper (a `helper_action` CID fetched and run in-process
 * inside the verified render action) can slot in as an additional transform
 * without reworking the hook in data.ctrlr.ts.
 */

/** A pure string-in/string-out content transform. */
export type ContentTransform = (content: string) => string;

/**
 * Built-in `sections` transform.
 *
 * Turns markdown section directives into HTML `<section>` elements:
 *
 *   `<!-- section class="aside"> ... <!-- /section>` -> `<section class="aside">...</section>`
 *
 * - Accepts both `<!-- section` and `<!--section` (the space is optional).
 * - Attributes pass through raw as a string.
 * - Attribute-less `<!-- section>` -> `<section>`.
 * - Tolerates a `-->` or `>` closer on both opener and closer
 *   (`<!-- /section>` / `<!-- /section -->`).
 * - Only the `section` tag is handled; the marker is case-insensitive. All
 *   other content passes through unchanged.
 * - Non-string input is returned unchanged.
 */
export const sectionsTransform: ContentTransform = (content: string): string => {
  // Defensive: non-string input passes through unchanged.
  if (typeof content !== 'string') return content;

  return content.replace(
    /<!--\s*section\b([\s\S]*?)(?:-->|>)([\s\S]*?)<!--\s*\/section\s*(?:-->|>)/gi,
    (_match: string, attrs: string, inner: string): string => {
      const attrStr = attrs.trim();
      return '<section' + (attrStr ? ' ' + attrStr : '') + '>' + inner + '</section>';
    },
  );
};

/**
 * Default ordered content-transform stage. The built-in `sections` transform
 * is the seed; future publication-supplied helpers append to this list.
 */
export const DEFAULT_CONTENT_TRANSFORMS: readonly ContentTransform[] = [sectionsTransform];

/**
 * Run the default content-transform stage over `content`.
 *
 * Pure string-in/string-out. Non-string input is returned unchanged.
 */
export const transformContent: ContentTransform = (content: string): string => {
  // Defensive: non-string input passes through unchanged.
  if (typeof content !== 'string') return content;

  return DEFAULT_CONTENT_TRANSFORMS.reduce(
    (acc: string, transform: ContentTransform) => transform(acc),
    content,
  );
};
