// ============================================================================
// Publication address resolution — pure viem reads that resolve a publication
// subdomain to its Safe (L1 ENS NameWrapper) and then to its Records +
// Publication module addresses (L2 Safe `getModulesPaginated` + NAME() sniff).
//
// Ported from neutralpress' publication/ens.ts + publication.service.ts so the
// headless author-cli resolves addresses exactly the way the Obsidian plugin
// does (SPEC-author-hosts). Host-agnostic: callers pass viem public clients.
// ============================================================================

import { keccak256, toBytes, type Address, type PublicClient } from 'viem';

import { ensSubdomainRegistryAbi, safeAbi } from '../contracts';
import { isPublicationModuleName } from '../protocol/module-name';

/** Minimal NameWrapper `ownerOf` ABI — the ENS registry points at it. */
const NAME_WRAPPER_ABI = [
  {
    inputs: [{ internalType: 'uint256', name: 'id', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/** Minimal `NAME()` ABI used to sniff Safe modules during discovery. */
const MODULE_NAME_ABI = [
  {
    inputs: [],
    name: 'NAME',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export interface ResolvedPublicationSafe {
  /** The publication Safe address (NameWrapper token owner). */
  address: Address;
  chainId: number;
}

/**
 * Resolve a publication subdomain to its Safe address via the L1 ENS
 * OpenSubdomainRegistry (mirrors neutralpress `getPublicationMultiSig`):
 *
 *   nameWrapper = registry.nameWrapper()
 *   parentNode  = registry.parentNode()
 *   labelHash   = keccak256(subdomain)
 *   node        = keccak256(parentNode ++ labelHash)
 *   safe        = nameWrapper.ownerOf(uint256(node))
 */
export async function resolvePublicationSafe(
  l1: PublicClient,
  ensRegistry: Address,
  subdomain: string,
): Promise<ResolvedPublicationSafe> {
  const nameWrapper = (await l1.readContract({
    address: ensRegistry,
    abi: ensSubdomainRegistryAbi,
    functionName: 'nameWrapper',
  })) as Address;

  const parentNode = (await l1.readContract({
    address: ensRegistry,
    abi: ensSubdomainRegistryAbi,
    functionName: 'parentNode',
  })) as `0x${string}`;

  const subdomainLabel = keccak256(toBytes(subdomain));
  const subdomainNode = keccak256(`0x${parentNode.slice(2)}${subdomainLabel.slice(2)}`);

  const owner = (await l1.readContract({
    address: nameWrapper,
    abi: NAME_WRAPPER_ABI,
    functionName: 'ownerOf',
    args: [BigInt(subdomainNode)],
  }));

  return { address: owner, chainId: 1 };
}

export interface ResolvedPublicationModules {
  configModule: Address | undefined;
  publicationModule: Address | undefined;
}

/**
 * Discover a publication Safe's Records (`S2S Records Module`) and Publication
 * module addresses by reading the Safe's enabled modules and sniffing each one's
 * `NAME()`. The publication test accepts every version (V1, V2, V3, …) through
 * `isPublicationModuleName`, because a publication on an older implementation
 * still serves reads and author writes. Mirrors neutralpress'
 * `PublicationService.getModuleAdresses`.
 */
export async function resolvePublicationModules(
  l2: PublicClient,
  safeAddress: Address,
): Promise<ResolvedPublicationModules> {
  let configModule: Address | undefined;
  let publicationModule: Address | undefined;

  const [modules] = (await l2.readContract({
    address: safeAddress,
    abi: safeAbi,
    functionName: 'getModulesPaginated',
    args: ['0x0000000000000000000000000000000000000001', 10],
  })) as [Address[], Address];

  for (const moduleAddress of modules) {
    try {
      const moduleName = (await l2.readContract({
        address: moduleAddress,
        abi: MODULE_NAME_ABI,
        functionName: 'NAME',
      }));

      if (moduleName === 'S2S Records Module') {
        configModule = moduleAddress;
      } else if (isPublicationModuleName(moduleName)) {
        publicationModule = moduleAddress;
      }
    } catch {
      // Module doesn't expose NAME() — not a module we care about.
    }
  }

  return { configModule, publicationModule };
}
