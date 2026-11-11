// ============================================================================
// Author identity — one legacy tolerance, in one place.
//
// An item's author is the author Safe's bare address. Items pinned before that
// was true carry the old `did`-prefixed form in `public.author`, and they must
// still verify and render. Nothing writes that form any more, so this module is
// the only code that still knows about it: delete the prefix once no readable
// item carries it.
//
// A rendered page names the same identity as a CAIP-10 account id — the address
// with the chain in front of it — so `accountAddress()` is the reader for both
// shapes. The chain prefix, like the legacy one, is decoration around the
// address; the address is the identity.
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

/** The `eip155:<chainId>:` prefix of a CAIP-10 account id. */
const CAIP10_EIP155_PREFIX = /^eip155:\d+:/;

/**
 * The address `value` names. A CAIP-10 account id (`eip155:<chainId>:0x…`) names
 * the address after the chain prefix; a bare address names itself; the
 * pre-change prefixed form goes through `authorAddress()`.
 *
 * The case of a CAIP-10 value is NOT folded: the address is returned exactly as
 * the value carried it, because a rendered page must emit what the item says and
 * a checksummed address is still the same address. Only the retired prefix form
 * goes through `authorAddress()`, which lowercases what it returns.
 */
export function accountAddress(value: string): string {
  const text = String(value ?? '').trim();
  if (CAIP10_EIP155_PREFIX.test(text)) return text.replace(CAIP10_EIP155_PREFIX, '');
  if (text.toLowerCase().startsWith(LEGACY_AUTHOR_PREFIX)) return authorAddress(text);
  return text;
}
