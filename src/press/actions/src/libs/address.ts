// ============================================================================
// Addresses — the one normaliser.
//
// An author (and a publisher, and a deal's `Entry.author`) is an address. The
// prefix tolerance for the form an item or a page was pinned in before the
// author became bare lives in shared's `authorAddress()`; what is left here is
// the residual shared does not do: deciding whether what remains is an address
// at all.
//
// This module is deliberately dependency-free (no zod, no schema import). It is
// reached from three bundles — the render action, the update action and the
// archive path — and the update action is small on purpose: importing
// `libs/item-integrity` for this function would pull the content-item schema
// (zod) into it and roughly double the action's bytes.
// ============================================================================

// Deep-imported like the other dependency-free identity helpers: the package
// root drags in zod and viem, which no Lit Action needs.
import { authorAddress } from '../../../../shared/dist/manuscript/identity/author-address';

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Normalise an address-shaped string to a lowercase 0x address. Accepts both a
 * plain address (what getDeals() returns for a deal, and what an item minted
 * since the author became bare carries) and the pre-change form shared's
 * `authorAddress()` strips.
 *
 * Null means "cannot bind": callers fail closed for the item side, since the
 * item is attacker-controlled.
 */
export const addressOf = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const raw = authorAddress(value);
  return ADDRESS_RE.test(raw) ? raw : null;
};
