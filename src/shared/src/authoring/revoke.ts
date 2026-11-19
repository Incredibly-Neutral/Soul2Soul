// ============================================================================
// Revocation path derivation — the single source of truth for computing the
// `remove[]` entry that makes a revoked item disappear from the rendered site.
//
// Ported from neutralpress' publication/revoke.ts so the headless author-cli
// derives the exact same remove path the Obsidian plugin does. See the B1/B1b
// comments there (and in SPEC-author-hosts) for the full reasoning: the path must
// reproduce the render pipeline's `createPath` prefix logic.
// ============================================================================

/** A path to remove from the published tree during an EVM update. */
export interface RemoveEntry {
  path: string;
  replacedBy?: string;
}

/**
 * Derive the item's rendered path for a remove entry, matching the render
 * pipeline's `createPath` for the standard `/{slug}` template. When the
 * publication's on-chain `localePaths` are supplied (see
 * `localePathsOf`), the locale prefix is reproduced EXACTLY as the renderer
 * computes it:
 *
 *     prefix = localePaths[body.locale] ?? localePaths.default ?? ''
 *
 * so a declared non-default locale mapped to an EMPTY prefix (e.g.
 * `localePaths.en === ''`) correctly yields `/<slug>` — NOT `/en/<slug>`.
 * Without a localePaths map, fall back to the legacy default scheme: a
 * `/<locale>` prefix for any non-default locale, `''` for the default locale.
 * Leading slash is fine — the update action's `sanitizeRemovePath` strips it.
 *
 * `templatePath` is the publication's own template path for the note's post
 * type (`config.mapping.templateConfig[reference].path`), read from the same
 * config the renderer reads. Given it, the derivation is `createPath` itself:
 * locale prefix plus template path with `{slug}` substituted, so a post
 * template at `/posts/{slug}/` removes `/posts/{slug}`, not `/{slug}`, which
 * matched no page and left the revoked item live. A template path without
 * `{slug}` is one page shared by every item of its type, not this item's
 * page, so it falls back to the standard scheme.
 */
export function revokedPathFor(
  slug: string,
  locale?: string,
  localePaths?: Record<string, string>,
  templatePath?: string | null,
): string {
  const prefix = localePaths
    ? localePaths[locale ?? 'default'] || localePaths.default || ''
    : '';
  const legacyPrefix = !localePaths && locale && locale !== 'default' ? `/${locale}` : '';

  if (templatePath?.includes('{slug}')) {
    return `${prefix}${templatePath.replace('{slug}', slug)}`;
  }

  return `${prefix || legacyPrefix}/${slug}`;
}
