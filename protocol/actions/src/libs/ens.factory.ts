import { evmRead } from './evm';

declare const ethers: any;

const ENS_REGISTRY_ADDRESS = '0x9aB0B1629fc094B1142F9fe9456cdc34A130c4e5';

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

  const moduleNames = await Promise.allSettled(
    modules.map((addr: string) =>
      evmRead('L2', addr, ['function NAME() view returns (string)'], 'NAME', [], rpcs?.L2),
    ),
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