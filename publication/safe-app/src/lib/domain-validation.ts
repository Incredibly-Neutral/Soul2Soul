// safe-app/src/lib/domain-validation.ts
//
// ENS write-target ownership validation for the Records tab 'Add domain' flow.
//
// PR #83 added an optional `domain` to S2SPublicationConfig so the EVM update
// action can write the publication's contenthash to `namehash(domain)` instead
// of the default `namehash(name)` subdomain (press/actions/src/update/main.ts
// picks `writeDomain = config.domain || publication` and writes contenthash at
// `namehash(writeDomain)`). Without a guard that is an arbitrary-node write: any
// domain could be targeted. This module closes that hole on the safe-app side —
// before saving a domain, the safe-app must prove the entered domain resolves to
// the SAME publication Safe that owns the current publication name, so the write
// target is always a node controlled by the publication's own Safe.
//
// ENFORCEMENT TOGGLE: the ownership gate is OFF by default right now (product
// decision — it should not block the Add-domain flow). The gate code, tests and
// `verifyDomainOwnership` all stay intact for when it is re-enabled — flip
// `DOMAIN_VALIDATION_CONFIG.enforceOwnership` to `true` to turn it back on. See
// `maybeVerifyDomainOwnership` for the enforcement-aware entry point used by the
// Records tab.
//
// `namehash`, `evmRead` and `rpcs` are injected so the check is a pure function
// and unit-testable in node (see safe-app/tests/domain-validation.test.ts).

export const ENS_REGISTRY_ADDRESS = '0x9aB0B1629fc094B1142F9fe9456cdc34A130c4e5';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** ENS Registry + NameWrapper live on L1 (Ethereum mainnet). */
export const ENS_L1_CHAIN_ID = 1;

const NAMEWRAPPER_ABI = ['function nameWrapper() view returns (address)'];
const OWNEROF_ABI = ['function ownerOf(uint256 id) view returns (address)'];

/** Shape of safe-app/src/lib/evm.ts evmRead — chainId is a number here. The
 *  optional trailing `rpcs` (a per-network RPC URL list) is accepted for parity
 *  with the protocol's evmRead; the safe-app implementation ignores it. */
export type EvmReadFn = (
  chainId: number,
  contractAddress: string,
  abi: any,
  method: string,
  args: any[],
  rpcs?: string[],
) => Promise<unknown>;

export interface DomainOwnershipDeps {
  namehash: (name: string) => string;
  evmRead: EvmReadFn;
  rpcs?: { L1: string[]; L2: string[] };
}

export interface DomainOwnershipCheck {
  ok: boolean;
  reason?: string;
  domainOwner?: string;
  publicationOwner?: string;
}

/**
 * Resolve the Safe that owns `name` (the NameWrapper owner of namehash(name)).
 * Returns the lowercase owner address, or null when the name is unregistered /
 * unwrapped / unreadable (ownerOf reverts or returns the zero address).
 * Never throws — a resolution failure is reported as null so the caller can
 * fail the ownership check with a clear message.
 */
export async function getEnsOwner(
  name: string,
  deps: DomainOwnershipDeps,
): Promise<string | null> {
  const { namehash, evmRead, rpcs } = deps;
  try {
    const nameWrapper = await evmRead(
      ENS_L1_CHAIN_ID,
      ENS_REGISTRY_ADDRESS,
      NAMEWRAPPER_ABI,
      'nameWrapper',
      [],
      rpcs?.L1,
    );
    if (!nameWrapper) return null;
    const owner = await evmRead(
      ENS_L1_CHAIN_ID,
      String(nameWrapper),
      OWNEROF_ABI,
      'ownerOf',
      [namehash(name)],
      rpcs?.L1,
    );
    if (!owner) return null;
    const normalized = String(owner).toLowerCase();
    return normalized === ZERO_ADDRESS ? null : normalized;
  } catch {
    return null;
  }
}

/**
 * Ownership check for the 'Add domain' flow. The entered `domain` is only
 * acceptable when it resolves to the same publication Safe as the current
 * `publication` name. Returns { ok: false, reason } (never throws) when the
 * check fails, so the caller can surface the message and refuse to save.
 */
export async function verifyDomainOwnership(
  domain: string,
  publication: string,
  deps: DomainOwnershipDeps,
): Promise<DomainOwnershipCheck> {
  const trimmed = domain.trim();
  if (!trimmed) {
    return { ok: false, reason: 'Enter an ENS domain before adding it.' };
  }
  const publicationName = publication.trim();
  if (!publicationName) {
    return {
      ok: false,
      reason: 'No publication name record found — cannot verify domain ownership.',
    };
  }

  const [publicationOwner, domainOwner] = await Promise.all([
    getEnsOwner(publicationName, deps),
    getEnsOwner(trimmed, deps),
  ]);

  if (!publicationOwner) {
    return {
      ok: false,
      reason: `Could not resolve the current publication "${publicationName}" to an ENS owner.`,
    };
  }
  if (!domainOwner) {
    return {
      ok: false,
      reason: `"${trimmed}" is not a wrapped ENS domain — it has no owner, so the contenthash could not be safely written there.`,
    };
  }
  if (domainOwner === publicationOwner) {
    return { ok: true, domainOwner, publicationOwner };
  }
  return {
    ok: false,
    domainOwner,
    publicationOwner,
    reason: `"${trimmed}" is owned by ${domainOwner}, not this publication Safe (${publicationOwner}). Only the publication Safe may set the ENS write-target domain.`,
  };
}

// =============================================================================
// Enforcement toggle
// =============================================================================

/** Whether the Records tab enforces the same-Safe ownership check when a domain
 *  is added. OFF by default (the gate should not block the Add-domain flow);
 *  flip `enforceOwnership` to `true` to re-enable the blocking gate. */
export interface DomainValidationConfig {
  enforceOwnership: boolean;
}

/** Single source of truth for the Add-domain ownership gate. Default OFF — the
 *  Add-domain flow saves the domain without requiring ownership. Toggle here:
 *
 *      DOMAIN_VALIDATION_CONFIG.enforceOwnership = true;  // re-enable the gate
 */
export const DOMAIN_VALIDATION_CONFIG: DomainValidationConfig = {
  enforceOwnership: false,
};

/** Enforcement-aware entry point for addAlias() (the Records tab's per-alias
 *  ownership gate). When the gate is OFF (the
 *  default) the ownership check is skipped entirely and the domain is accepted;
 *  when ON, this delegates to the full `verifyDomainOwnership` gate and the
 *  existing reject behaviour (different-Safe / unwrapped / unresolvable)
 *  applies. Never throws — fails closed with a clear reason when enforced. */
export async function maybeVerifyDomainOwnership(
  domain: string,
  publication: string,
  deps: DomainOwnershipDeps,
  config: DomainValidationConfig = DOMAIN_VALIDATION_CONFIG,
): Promise<DomainOwnershipCheck> {
  if (!config.enforceOwnership) {
    // Gate OFF: skip the check — accept the domain as-is.
    return { ok: true };
  }
  return verifyDomainOwnership(domain, publication, deps);
}
