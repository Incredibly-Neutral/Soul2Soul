// ============================================================================
// Author identity — one legacy tolerance, in one place.
//
// An item's author is the author Safe's bare address. Items pinned before that
// was true carry the old `did`-prefixed form in `public.author`, and they must
// still verify and render. Nothing writes that form any more, so this module is
// the only code that still knows about it: delete the prefix once no readable
// item carries it.
// ============================================================================

/**
 * The prefix pre-change items carry. Exported only so a test can build an item
 * of that shape; no production path may use it.
 */
export const LEGACY_AUTHOR_PREFIX = 'did:ethr:';

/**
 * The bare, lowercase address `value` names, with the pre-change prefix removed
 * if it is there. Every comparison of two authors goes through this: the form an
 * old item was pinned in is not part of the identity, the address is.
 */
export function authorAddress(value: string): string {
  const text = String(value ?? '').trim();
  const lower = text.toLowerCase();
  return lower.startsWith(LEGACY_AUTHOR_PREFIX) ? lower.slice(LEGACY_AUTHOR_PREFIX.length) : lower;
}
