import { evmRead } from './evm';

declare const ethers: any;

const ENS_REGISTRY_ADDRESS = '0x9aB0B1629fc094B1142F9fe9456cdc34A130c4e5';

// Known enabled modules on the publication Safe that can NEVER be an S2S module,
// so probing them with NAME() is pure waste (each probe is an eth_call that
// counts against Lit's 50-requests-per-session cap, and every one reverts —
// logging the evmRead failover twice per action, once per RPC URL). We still
// treat these as present in the Safe's module list; we just never issue a
// NAME() eth_call for them.
//
// Provenance: the canonical Safe Account Abstraction (4337) Module at
// 0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226 — SAFE_4337_MODULE_ADDRESS per
// @safe-global/safe-modules-deployments safe-4337-module/v0.3.0 (and mirrored
// in permissionless's toSafeSmartAccount.ts). Safe 1.4.1 + EntryPoint 0.7 on
// Base 8453. It never implements NAME().
const KNOWN_NON_S2S_MODULES: string[] = ['0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226'];

// Compare addresses in canonical lowercase form so a lower/checksum-case
// mismatch can't defeat the KNOWN_NON_S2S_MODULES filter.
const isKnownNonS2SModule = (address: string): boolean =>
  KNOWN_NON_S2S_MODULES.some((known) => known.toLowerCase() === address.toLowerCase());

// Max simultaneous NAME() eth_call probes (pageSize is 10 — keep the fan-out
// well under it so a single prep/render/update can't burst ~10-20 connections).
const MAX_CONCURRENT_NAME_PROBES = 3;

// Small worker pool that maps `fn` over `items` with at most `limit` promises in
// flight at once. Returns a PromiseSettledResult-per-item array (same shape and
// ordering as Promise.allSettled) so callers can inspect fulfilled/rejected
// results per index. Used to cap the parallel eth_call fan-out below so we can't
// burst ~10-20 simultaneous RPC connections (which are a root cause of
// intermittent ECONNRESET / 'missing response' transport failures).
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(0, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export const getProtocolControllerAndModules = async (rpcs?: { L1: string[]; L2: string[] }) => {
  try {
    const subdomainNode = ethers.utils.namehash('soul2soul.eth');
    const nameWrapperAddress = await evmRead(
      'L1',
      ENS_REGISTRY_ADDRESS,
      ['function nameWrapper() view returns (address)'],
      'nameWrapper',
      [],
      rpcs?.L1,
    );
    const customRegistry = await evmRead(
      'L1',
      nameWrapperAddress,
      ['function ownerOf(uint256 id) view returns (address)'],
      'ownerOf',
      [subdomainNode],
      rpcs?.L1,
    );
    const controller = await evmRead(
      'L1',
      customRegistry,
      ['function parentDomainController() view returns (address)'],
      'parentDomainController',
      [],
      rpcs?.L1,
    );
    const modules = await evmRead(
      'L2',
      controller,
      [
        'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] memory array, address next)',
      ],
      'getModulesPaginated',
      ['0x0000000000000000000000000000000000000001', 10],
      rpcs?.L2,
    );

    let configModule = null;

    for (const moduleAddress of modules[0]) {
      // Skip known non-S2S modules (e.g. the canonical Safe 4337 Module): they
      // can never be an S2S module and probing them just burns RPC requests.
      if (isKnownNonS2SModule(moduleAddress)) continue;
      try {
        const name = await evmRead(
          'L2',
          moduleAddress,
          ['function NAME() view returns (string)'],
          'NAME',
          [],
          rpcs?.L2,
        );

        if (name === 'S2S Records Module') {
          configModule = moduleAddress;
        }
      } catch (error) {
        // Module doesn't have NAME function, skip
        console.log(`Module ${moduleAddress} has no NAME function`);
      }
    }

    return {
      multisig: controller,
      configModule,
    };
  } catch (error) {
    console.error('Error getting publication addresses:', error);
    return {
      multisig: null,
      configModule: null,
    };
  }
};

export const getDomainOwnerAndModules = async (
  publication: string,
  rpcs?: { L1: string[]; L2: string[] },
) => {
  const nameWrapperAddress = await evmRead(
    'L1',
    ENS_REGISTRY_ADDRESS,
    ['function nameWrapper() view returns (address)'],
    'nameWrapper',
    [],
    rpcs?.L1,
  );
  const subdomainNode = ethers.utils.namehash(publication);
  const multisig = await evmRead(
    'L1',
    nameWrapperAddress,
    ['function ownerOf(uint256 id) view returns (address)'],
    'ownerOf',
    [subdomainNode],
    rpcs?.L1,
  );
  const [modules] = await evmRead(
    'L2',
    multisig,
    [
      'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] memory array, address next)',
    ],
    'getModulesPaginated',
    ['0x0000000000000000000000000000000000000001', 10],
    rpcs?.L2,
  );

  let configModule = null;
  let publicationModule = null;

  // Drop known non-S2S modules (e.g. the canonical Safe 4337 Module) from
  // NAME() probing entirely — they can never be an S2S module, and each probe
  // is an eth_call that reverts and counts against Lit's 50-request-session
  // cap. They remain conceptually present in the Safe's module list; we just
  // never issue a NAME() evmRead for them.
  const probeableModules = modules.filter((addr: string) => !isKnownNonS2SModule(addr));

  // Cap NAME() probe concurrency to avoid bursting ~10-20 simultaneous RPC
  // connections (a root cause of intermittent ECONNRESET / 'missing response'
  // transport failures). Preserves allSettled semantics: a module lacking
  // NAME() (genuine revert) is still skipped silently below.
  const moduleNames = await mapWithLimit(
    probeableModules,
    MAX_CONCURRENT_NAME_PROBES,
    (addr: string) =>
      evmRead('L2', addr, ['function NAME() view returns (string)'], 'NAME', [], rpcs?.L2),
  );

  for (let i = 0; i < probeableModules.length; i++) {
    const result = moduleNames[i];
    if (result.status === 'fulfilled') {
      if (result.value === 'S2S Records Module') {
        configModule = probeableModules[i];
      } else if (
        result.value === 'S2S Publication Module V2' ||
        result.value === 'S2S Publication Module' // backwards compat
      ) {
        publicationModule = probeableModules[i];
      }
    }
  }

  return {
    multisig,
    configModule,
    publicationModule,
  };
};
