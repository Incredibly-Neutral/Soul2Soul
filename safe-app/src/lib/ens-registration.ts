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
// `registeredSubdomains(label)` is the registry's own bool, and
// `registerSubdomain` mints the subnode to the requested owner — through the
// NameWrapper when `isParentWrapped` (nameWrapper.setSubnodeOwner), through the
// ENS registry itself otherwise (ens.setSubnodeOwner). The owner read has to
// follow the same branch, or a SUCCESSFUL registration on an unwrapped parent
// reads back as "registered, no owner" and looks like the fatal desync.
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
 *  the library must not import this from a component. Also the default
 *  display suffix: callers that know the publication's full name pass the real
 *  suffix (see `suffix` in ReadEnsOptions), so a registry with a different
 *  parent is not mislabelled. */
export const SOUL2SOUL_SUFFIX = 'soul2soul.eth';

const REGISTRY_ABI = [
  'function parentNode() view returns (bytes32)',
  'function isParentWrapped() view returns (bool)',
  'function nameWrapper() view returns (address)',
  'function ens() view returns (address)',
  'function registeredSubdomains(string label) view returns (bool)',
];
const NAMEWRAPPER_ABI = ['function ownerOf(uint256 id) view returns (address)'];
const ENS_REGISTRY_ABI = ['function owner(bytes32 node) view returns (address)'];

/** The write the flow proposes: registry.registerSubdomain(label, owner). */
const REGISTER_SUBDOMAIN_ABI = ['function registerSubdomain(string label, address owner)'];
const REGISTRY_INTERFACE = new ethers.Interface(REGISTER_SUBDOMAIN_ABI);

export interface EnsRegistrationDeps {
  evmRead: EvmReadFn;
}

export interface EnsRegistrationState {
  label: string;
  /** `${label}.${suffix}` (suffix defaults to soul2soul.eth). */
  name: string;
  /** The registry address actually used for the reads. */
  registry: string;
  /** The NameWrapper, or the zero address when the parent is not wrapped. */
  nameWrapper: string;
  /** `isParentWrapped()` — which contract holds the subnode. */
  parentWrapped: boolean;
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
 * Mirror of `ENSOpenSubdomainRegistry.validSubdomain` + `_isValidLabel`:
 * 1..63 bytes of lowercase `a-z`/`0-9`, hyphen allowed but not at either end.
 *
 * Checked BEFORE the write: `registerSubdomain` reverts outside this alphabet,
 * and a reverting L1 Safe transaction costs real gas (the twin-Safe paste on
 * Base reverts too, and the timeout message would then tell the human to run
 * the same invalid call again).
 */
export function isValidSubdomainLabel(label: string): boolean {
  if (label.length < 1 || label.length > 63) return false;
  if (!/^[a-z0-9-]+$/.test(label)) return false;
  return !label.startsWith('-') && !label.endsWith('-');
}

/** Why `label` cannot be registered, as a user-facing sentence; '' when it can. */
export function subdomainLabelError(label: string): string {
  if (!label) return 'Publication name is required.';
  if (label.length > 63) {
    return `“${label}” is too long — the ENS registry allows at most 63 characters.`;
  }
  if (!/^[a-z0-9-]+$/.test(label)) {
    return `“${label}” may only contain lowercase letters a–z, the digits 0–9 and hyphens.`;
  }
  if (!isValidSubdomainLabel(label)) {
    return `“${label}” must start and end with a letter or a digit, not a hyphen.`;
  }
  return '';
}

/**
 * A failed subnode-owner read: is it "there is no owner" (the call reverted /
 * returned nothing — the absent-subnode case the flow treats as zero), or "we
 * do not know" (a transport/RPC failure)? Only the first may map to the zero
 * address. Turning a transient RPC error into "no owner" reports a retryable
 * condition as an unrecoverable on-chain state.
 */
function isAbsentOwnerError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && /^(CALL_EXCEPTION|BAD_DATA|INVALID_ARGUMENT)$/.test(code)) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /revert|invalid token|call exception|could not decode/i.test(message);
}

/** `ownerOf` (wrapped) / `owner` (unwrapped) for the subnode: an absent owner
 *  reads as zero, an unreadable one throws ("unknown, try again"). */
async function readSubnodeOwner(
  read: (contract: string, abi: any, method: string, args: any[]) => Promise<unknown>,
  contract: string,
  abi: any,
  method: string,
  node: string,
): Promise<string> {
  try {
    const raw = await read(contract, abi, method, [node]);
    const owner = raw ? String(raw).toLowerCase() : ZERO_ADDRESS;
    return owner === ZERO_ADDRESS ? ZERO_ADDRESS : owner;
  } catch (err) {
    if (isAbsentOwnerError(err)) return ZERO_ADDRESS;
    throw err;
  }
}

/**
 * The parent part of a full publication name: 'polyphony.soul2soul.eth' →
 * 'soul2soul.eth'. '' when the name does not start with `${label}.`, so callers
 * fall back to the default suffix instead of mislabelling a foreign parent.
 */
export function suffixOfPublicationName(publicationName: string, label: string): string {
  const prefix = `${label}.`;
  return publicationName.startsWith(prefix) && publicationName.length > prefix.length
    ? publicationName.slice(prefix.length)
    : '';
}

export interface ReadEnsOptions {
  registry?: string;
  label: string;
  safeAddress: string;
  /** Display suffix for `state.name`; defaults to soul2soul.eth. */
  suffix?: string;
}

/**
 * Read the publication's ENS registration state from L1.
 *
 * Throws when the answer would be a guess: the registry itself cannot be read
 * (`parentNode` / `isParentWrapped` / `registeredSubdomains`), the registry
 * reports a wrapped parent but no NameWrapper, or the subnode owner read fails
 * for a reason that is not "absent" (a transport/429 failure). The caller
 * treats a throw as "unknown, try again" — never as an on-chain corruption.
 *
 * A reverting `ownerOf`/`owner` (unwrapped or absent subnode) is NOT an error:
 * it maps to the zero address, the same convention as `getEnsOwner`.
 */
export async function readEnsRegistration(
  deps: EnsRegistrationDeps,
  opts: ReadEnsOptions,
): Promise<EnsRegistrationState> {
  const { evmRead } = deps;
  const registry = opts.registry ?? ENS_REGISTRY_ADDRESS;
  const { label } = opts;
  const suffix = opts.suffix || SOUL2SOUL_SUFFIX;
  const read = (contract: string, abi: any, method: string, args: any[]): Promise<unknown> =>
    evmRead(ENS_L1_CHAIN_ID, contract, abi, method, args);

  // One round trip: none of these reads depends on another's answer (only the
  // owner read below needs `parentNode`), and this runs in a 5 s poll loop.
  const [parentNodeRaw, wrappedRaw, registeredRaw] = await Promise.all([
    read(registry, REGISTRY_ABI, 'parentNode', []),
    read(registry, REGISTRY_ABI, 'isParentWrapped', []),
    read(registry, REGISTRY_ABI, 'registeredSubdomains', [label]),
  ]);

  const parentNode = String(parentNodeRaw);
  const parentWrapped = Boolean(wrappedRaw);
  const registered = Boolean(registeredRaw);
  const node = computeSubnode(parentNode, label);

  // Follow the registry's own branch. Both reads can revert for an unregistered
  // subnode (a legitimate "no owner"), but a failed *nameWrapper/ens* read is
  // required information: guessing zero there is what turned a transient RPC
  // error into the fatal desync verdict.
  let nameWrapper = ZERO_ADDRESS;
  let owner: string;
  if (parentWrapped) {
    const wrapperRaw = await read(registry, REGISTRY_ABI, 'nameWrapper', []);
    nameWrapper = wrapperRaw ? String(wrapperRaw).toLowerCase() : ZERO_ADDRESS;
    if (nameWrapper === ZERO_ADDRESS) {
      throw new Error(
        `ENS registry ${registry} reports a wrapped parent but no NameWrapper address.`,
      );
    }
    owner = await readSubnodeOwner(read, nameWrapper, NAMEWRAPPER_ABI, 'ownerOf', node);
  } else {
    // Unwrapped parent: registerSubdomain mints through the ENS registry
    // (`ens.setSubnodeOwner`), so the subnode's owner lives there. The registry
    // exposes the ENS address it was configured with.
    const ensRaw = await read(registry, REGISTRY_ABI, 'ens', []);
    const ens = ensRaw ? String(ensRaw).toLowerCase() : ZERO_ADDRESS;
    if (ens === ZERO_ADDRESS) {
      throw new Error(`ENS registry ${registry} reports an unwrapped parent but no ENS address.`);
    }
    owner = await readSubnodeOwner(read, ens, ENS_REGISTRY_ABI, 'owner', node);
  }

  const safe = opts.safeAddress.toLowerCase();
  const ownedBySafe = owner !== ZERO_ADDRESS && owner === safe;
  const hasNoOwner = owner === ZERO_ADDRESS;

  return {
    label,
    name: `${label}.${suffix}`,
    registry,
    nameWrapper,
    parentWrapped,
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
 *
 * Refuses an invalid label: this is the last gate before a real L1 Safe
 * transaction, and the registry would revert (real gas) on one.
 */
export function buildRegisterSubdomainCall(
  registry: string,
  label: string,
  owner: string,
): RegisterSubdomainCall {
  if (!isValidSubdomainLabel(label)) {
    throw new Error(subdomainLabelError(label) || `“${label}” is not a valid ENS subdomain label.`);
  }
  return {
    to: registry,
    data: REGISTRY_INTERFACE.encodeFunctionData('registerSubdomain', [label, owner]),
    value: '0',
  };
}
