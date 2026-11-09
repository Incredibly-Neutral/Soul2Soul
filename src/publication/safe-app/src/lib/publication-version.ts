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
  /** Version the module reports: 2 or 3. */
  version: number;
  /** ABI to construct the wrapper with, so encodes match the implementation. */
  abi: InterfaceAbi;
  /** Verb that admits an offer into an agreement. */
  accept: 'admit' | 'acceptOffer';
  /** Verb that ends an agreement or declines an offer, reversibly. */
  reject: 'reject' | 'retract';
  /** False when the version has no agreements surface (V1). */
  hasAgreements: boolean;
};

/** The live deployment's surface. */
const V3_BINDING: PublicationBinding = {
  version: 3,
  abi: Abi_S2SPublicationModuleV3,
  accept: 'admit',
  reject: 'reject',
  hasAgreements: true,
};

/** The previous deployment: same reads, different writes. */
const V2_BINDING: PublicationBinding = {
  version: 2,
  abi: Abi_S2SPublicationModuleV2,
  accept: 'acceptOffer',
  reject: 'retract',
  hasAgreements: true,
};

/** The live binding, for a module whose NAME() could not be read. */
export const CURRENT_PUBLICATION_BINDING = V3_BINDING;

/**
 * The surface for a module named `name`, or `undefined` when there is nothing
 * to bind: not a publication module, or V1 (no agreements surface, so the app
 * shows "no publication module" — its behaviour before agreements existed).
 *
 * Later versions than this build knows bind the current ABI: the verbs have
 * been additive since V3, and refusing to bind would hide a publication.
 */
export const publicationBindingFor = (
  name: string | undefined | null,
): PublicationBinding | undefined => {
  const version = publicationModuleVersion(name);
  if (version === undefined) return undefined;
  if (version >= 3) return V3_BINDING;
  if (version === 2) return V2_BINDING;
  return undefined;
};
