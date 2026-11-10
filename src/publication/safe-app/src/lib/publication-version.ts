// safe-app/src/lib/publication-version.ts
//
// One decision: which contract surface a publication module actually has.
//
// The module's `NAME()` is the only signal. Reads cannot separate the versions
// (V3 aliases the V2 read selectors and structs), and the writes differ
// outright:
//
//   V3  "S2S Publication Module V3"   accept = admit,  takedown = reject
//   V2  "S2S Publication Module V2"   accept = acceptOffer, takedown = retract
//   V1  "S2S Publication Module"      no agreements surface at all
//
// Binding the V3 ABI to every version is what broke V1/V2 publications: their
// proxies do not implement `admit`/`reject`, so every Accept/Refuse/Revoke
// reverted, and V1 has no `getDeals`/`hasDeal` so the deals tab failed to load.
// Callers ask this module instead of comparing names or versions themselves.

import type { InterfaceAbi } from 'ethers';
import { Abi_S2SPublicationModuleV2 } from '@s2s/publication-contracts/abis/S2SPublicationModuleV2';
import { Abi_S2SPublicationModuleV3 } from '@s2s/publication-contracts/abis/S2SPublicationModuleV3';
import { publicationModuleVersion } from '@s2s/soul2soul-shared/protocol';

export type PublicationBinding = {
  /** The version the module reported, not the version whose ABI was used. */
  version: number;
  /** ABI to construct the wrapper with, so encodes match the implementation. */
  abi: InterfaceAbi;
  /** Verb that admits an offer into an agreement. */
  accept: 'admit' | 'acceptOffer';
  /** Verb that ends an agreement or declines an offer, reversibly. */
  reject: 'reject' | 'retract';
};

/** V3's surface. */
const V3_SURFACE = { abi: Abi_S2SPublicationModuleV3, accept: 'admit', reject: 'reject' } as const;

/** V2's surface: the same reads, different writes. */
const V2_SURFACE = {
  abi: Abi_S2SPublicationModuleV2,
  accept: 'acceptOffer',
  reject: 'retract',
} as const;

/**
 * The surface for a module named `name`, or `undefined` when there is nothing
 * to bind: not a publication module, or V1 — the bare name has no
 * `getDeals`/`getOffers`/`hasDeal` at all, so the app leaves it unbound and the
 * deals tab degrades to "no publication module", which is what it did before
 * agreements existed.
 *
 * A later version than this build knows binds the current surface: the verbs
 * have been additive since V3, and refusing to bind would hide a publication.
 * Either way the reported version is the module's own.
 *
 * There is deliberately no fallback binding. A version that could not be read
 * is not a guessable version — a wrong guess here encodes a selector the proxy
 * does not implement, and the first Accept or Refuse fails client-side.
 */
export const publicationBindingFor = (
  name: string | undefined | null,
): PublicationBinding | undefined => {
  const version = publicationModuleVersion(name);
  if (version === undefined) return undefined;
  if (version >= 3) return { ...V3_SURFACE, version };
  if (version === 2) return { ...V2_SURFACE, version };
  return undefined;
};
