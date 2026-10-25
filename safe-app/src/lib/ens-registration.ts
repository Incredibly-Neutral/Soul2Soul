// safe-app/src/lib/ens-registration.ts
//
// ENS subdomain registration for a publication (init-flow step 1).
//
// A publication created by the safe-app gets modules + a config record on
// Base, but `src` never called `registerSubdomain` — so `polyphony` had no
// `polyphony.soul2soul.eth` subnode at all: `resolvePublicationSafe` resolved
// the name to the zero address and handed 0x0 to every module read, leaving the
// publication unreachable by name.
//
// Why this is its OWN step and not part of a module batch: the ENS registry is
// deployed on Ethereum L1 only (Base has 0 bytes of code at that address), while
// the modules live on Base. A Safe transaction is single-chain, so the
// registration must be proposed from the L1 Safe — the *twin* Safe that shares
// the same address on both chains — never batched with the Base module txs.
//
// The registry is permissionless for wrapped parents:
// `registeredSubdomains(label)` is the registry's own bool, the subnode owner is
// the NameWrapper's `ownerOf(namehash(label.parent))`, and `registerSubdomain`
// can be called by anyone while the parent is wrapped (the wrapper/holder mints
// the subnode to the requested owner).
//
// Pure + injected reads (same shape as domain-validation.ts): every chain read
// goes through `deps.evmRead(ENS_L1_CHAIN_ID, …)` so unit tests inject a fake and
// nothing here touches a real RPC, `window`, or lit.

import { ethers } from 'ethers';
import {
  ENS_L1_CHAIN_ID,
  ENS_REGISTRY_ADDRESS,
  ZERO_ADDRESS,
  type EvmReadFn,
} from './domain-validation';

/** The parent every publication name hangs off. Defined locally on purpose —
 *  the library must not import this from a component. */
export const SOUL2SOUL_SUFFIX = 'soul2soul.eth';

const REGISTRY_ABI = [
  'function parentNode() view returns (bytes32)',
  'function nameWrapper() view returns (address)',
  'function registeredSubdomains(string label) view returns (bool)',
];
const NAMEWRAPPER_ABI = ['function ownerOf(uint256 id) view returns (address)'];

/** The write the flow proposes: registry.registerSubdomain(label, owner). */
const REGISTER_SUBDOMAIN_ABI = ['function registerSubdomain(string label, address owner)'];
const REGISTRY_INTERFACE = new ethers.Interface(REGISTER_SUBDOMAIN_ABI);

export interface EnsRegistrationDeps {
  evmRead: EvmReadFn;
  rpcs?: { L1: string[]; L2: string[] };
}

export interface EnsRegistrationState {
  label: string;
  /** `${label}.soul2soul.eth` */
  name: string;
  /** The registry address actually used for the reads. */
  registry: string;
  nameWrapper: string;
  /** 0x + 64 hex — namehash(`${label}.soul2soul.eth`). */
  node: string;
  /** Lowercase; the zero address when the subnode has no owner. */
  owner: string;
  /** registry.registeredSubdomains(label) */
  registered: boolean;
  /** owner === safeAddress (case-insensitive). */
  ownedBySafe: boolean;
  /** !registered && owner === ZERO → the flow must propose registration. */
  needsRegistration: boolean;
  /** registered === true but owner === ZERO (registry flag set, no subnode) —
   *  a half-written state that needs a human; never auto-retried. */
  desynced: boolean;
}

/**
 * namehash-style subnode: keccak256(parentNode ++ keccak256(utf8(label))).
 * For `parentNode === namehash('soul2soul.eth')` this is exactly
 * `namehash('label.soul2soul.eth')`.
 */
export function computeSubnode(parentNode: string, label: string): string {
  const labelHash = ethers.keccak256(ethers.toUtf8Bytes(label));
  return ethers.keccak256(ethers.concat([parentNode, labelHash]));
}

/**
 * Read the publication's ENS registration state from L1.
 *
 * Throws only when the registry itself cannot be read (`parentNode` /
 * `registeredSubdomains`) — the caller treats that as "unknown, try again".
 * A failed/reverting `ownerOf` (unwrapped or absent subnode) is NOT an error:
 * it maps to the zero address, the same convention as `getEnsOwner`.
 */
export async function readEnsRegistration(
  deps: EnsRegistrationDeps,
  opts: { registry?: string; label: string; safeAddress: string },
): Promise<EnsRegistrationState> {
  const { evmRead, rpcs } = deps;
  const registry = opts.registry ?? ENS_REGISTRY_ADDRESS;
  const { label } = opts;
  const read = (contract: string, abi: any, method: string, args: any[]): Promise<unknown> =>
    evmRead(ENS_L1_CHAIN_ID, contract, abi, method, args, rpcs?.L1);

  const parentNode = String(await read(registry, REGISTRY_ABI, 'parentNode', []));
  const node = computeSubnode(parentNode, label);

  // No wrapper → no wrapped subnodes → owner stays zero (registration still
  // readable from the registry itself, so don't fail the whole call).
  let nameWrapper = ZERO_ADDRESS;
  try {
    const wrapped = await read(registry, REGISTRY_ABI, 'nameWrapper', []);
    if (wrapped) nameWrapper = String(wrapped).toLowerCase();
  } catch {
    nameWrapper = ZERO_ADDRESS;
  }

  const registered = Boolean(await read(registry, REGISTRY_ABI, 'registeredSubdomains', [label]));

  let owner = ZERO_ADDRESS;
  if (nameWrapper !== ZERO_ADDRESS) {
    try {
      const raw = await read(nameWrapper, NAMEWRAPPER_ABI, 'ownerOf', [node]);
      const candidate = raw ? String(raw).toLowerCase() : ZERO_ADDRESS;
      owner = candidate === ZERO_ADDRESS ? ZERO_ADDRESS : candidate;
    } catch {
      // Unwrapped / absent subnode: ownerOf reverts. Treat as "no owner".
      owner = ZERO_ADDRESS;
    }
  }

  const safe = opts.safeAddress.toLowerCase();
  const ownedBySafe = owner !== ZERO_ADDRESS && owner === safe;
  const hasNoOwner = owner === ZERO_ADDRESS;

  return {
    label,
    name: `${label}.${SOUL2SOUL_SUFFIX}`,
    registry,
    nameWrapper,
    node,
    owner,
    registered,
    ownedBySafe,
    needsRegistration: !registered && hasNoOwner,
    desynced: registered && hasNoOwner,
  };
}

/** A ready-to-propose Safe transaction (single call). */
export interface RegisterSubdomainCall {
  to: string;
  data: string;
  value: '0';
}

/**
 * Encode `registry.registerSubdomain(label, owner)` for the L1 Safe queue.
 * The selector is derived by ethers from the signature — never hardcoded.
 */
export function buildRegisterSubdomainCall(
  registry: string,
  label: string,
  owner: string,
): RegisterSubdomainCall {
  return {
    to: registry,
    data: REGISTRY_INTERFACE.encodeFunctionData('registerSubdomain', [label, owner]),
    value: '0',
  };
}
