import { evmRead } from './evm';

declare const ethers: any;

const ENS_REGISTRY_ADDRESS = '0x9aB0B1629fc094B1142F9fe9456cdc34A130c4e5';

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

export const getDomainOwnerAndModules = async (publication: string, rpcs?: { L1: string[]; L2: string[] }) => {
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

  // Cap NAME() probe concurrency to avoid bursting ~10-20 simultaneous RPC
  // connections (a root cause of intermittent ECONNRESET / 'missing response'
  // transport failures). Preserves allSettled semantics: a module lacking
  // NAME() (genuine revert) is still skipped silently below.
  const moduleNames = await mapWithLimit(
    modules,
    MAX_CONCURRENT_NAME_PROBES,
    (addr: string) =>
      evmRead('L2', addr, ['function NAME() view returns (string)'], 'NAME', [], rpcs?.L2),
  );

  for (let i = 0; i < modules.length; i++) {
    const result = moduleNames[i];
    if (result.status === 'fulfilled') {
      if (result.value === 'S2S Records Module') {
        configModule = modules[i];
      } else if (
        result.value === 'S2S Publication Module V2' ||
        result.value === 'S2S Publication Module' // backwards compat
      ) {
        publicationModule = modules[i];
      }
    }
  }

  return {
    multisig,
    configModule,
    publicationModule,
  };
};