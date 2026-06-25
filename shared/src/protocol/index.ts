import { namehash as viemNamehash } from 'viem/ens';
import { PublicClient, getContract, decodeFunctionResult } from 'viem';
import type { S2SProtocolInfo, PKP } from './types';
import { ENS_NAMEWRAPPER } from './constants';

export type { S2SProtocolInfo, PKP };
export type { DidEthr, S2SPublicContent, S2SProof, S2SContentItem, S2SContentBody, S2SBody, S2SBodyBase, S2SBodyPlain, S2SBodyEncrypted, S2STemplateData, S2SCollection, S2SRipple, S2STemplateConfig, IMapping, S2SJob } from './types';
export { S2S_DOMAIN, S2S_TYPES, toDidEthr, eoaOf } from './types';

// Viem public client type (equivalent to ethers Provider)
export type ViemProvider = PublicClient;

export const getProtocolInfo = async (
  dev = false,
  l1Provider: ViemProvider,
  l2Provider: ViemProvider
): Promise<S2SProtocolInfo> => {
  // try {


    const { multisig, configModule } = await getProtocolControllerAndModules(
      dev,
      l1Provider,
      l2Provider
    );

    const [
      assets_gateway,
      data_gateway,
      ens_records,
      lens_app,
      lit_action_prep,
      lit_action_single,
      lit_action_cbor,
      lit_action_root_update,
      pkp_tokenId,
      pkp_publicKey,
      pkp_ethAddress,
    ] = await getRecords(
      configModule!,
      [
        'assets_gateway',
        'data_gateway',
        'ens_records',
        'lens_app',
        'lit_action_prep',
        'lit_action_single',
        'lit_action_cbor',
        'lit_action_root_update',
        'pkp_tokenId',
        'pkp_publicKey',
        'pkp_ethAddress',
      ],
      l2Provider
    );


    return {
      addr: multisig || '',
      recordsModule: configModule!,
      dataGateway: data_gateway,
      assetsGateway: assets_gateway,
      lensApp: lens_app,
      ensRecords: ens_records,
      pkp: {
        ethAddress: pkp_ethAddress,
        publicKey: pkp_publicKey,
        tokenId: pkp_tokenId,
      },
      litActionPrep: lit_action_prep,
      litActionCbor: lit_action_cbor,
      litActionSingle: lit_action_single,
      litActionRootUpdate: lit_action_root_update,
    };
  // } catch (error) {
  //   const errorMsg = error instanceof Error ? error.message : String(error);
  //   console.log('Protocol info error:', errorMsg);
  //   throw error;
  // }
};

export const tokenIDFromBytes = (bytes: string): string => {
  // I Doubt this can actualy be done .. and probably we wont need it anyway
  return '';
};

export const publicKeyFromBytes = (bytes: string): string => {
  return bytes;
};

// export const addressFromBytes = (publicKeyBytes: Uint8Array | string): string => {
//   // viem equivalent: getChecksummedAddress from keccak256 hash
//   const pubKeyHex = typeof publicKeyBytes === 'string'
//     ? publicKeyBytes
//     : `0x${Buffer.from(publicKeyBytes).toString('hex')}`;

//   const uncompressedKey = pubKeyHex.startsWith('0x04')
//     ? pubKeyHex.slice(4)
//     : pubKeyHex.replace(/^0x/, '');

//   const hash = `0x${Buffer.from(uncompressedKey, 'hex').toString('hex')}`;
//   const rawAddress = '0x' + hash.slice(-40);
//   return rawAddress;
// };

export const getRecords = async (
  moduleAddress: string,
  keys: string[],
  ethersProvider: ViemProvider
) => {
  // Get the contract via viem
  const contract = getContract({
    address: moduleAddress as `0x${string}`,
    abi: [
      {
        inputs: [
          {
            internalType: 'string[]',
            name: 'keys',
            type: 'string[]',
          },
        ],
        name: 'getRecords',
        outputs: [
          {
            internalType: 'string[]',
            name: 'values',
            type: 'string[]',
          },
        ],
        stateMutability: 'view' as const,
        type: 'function',
      },
    ],
    client: ethersProvider,
  });

  return await contract.read.getRecords([keys]);
};

export const getProtocolControllerAndModules = async (
  dev: boolean,
  l1Provider: ViemProvider,
  l2Provider: ViemProvider
) => {
  // try {
    const ensName = dev ? 'dev.soul2soul.eth' : 'soul2soul.eth';

    const nameWrapper = getContract({
      address: ENS_NAMEWRAPPER as `0x${string}`,
      abi: [
        {
          inputs: [
            {
              internalType: 'uint256',
              name: 'id',
              type: 'uint256',
            },
          ],
          name: 'ownerOf',
          outputs: [
            {
              internalType: 'address',
              name: '',
              type: 'address',
            },
          ],
          stateMutability: 'view' as const,
          type: 'function',
        },
      ],
      client: l1Provider,
    });

    const subdomainNode = BigInt(viemNamehash(ensName));

    const customRegistryContract = (await nameWrapper.read.ownerOf([
      subdomainNode,
    ])) as `0x${string}`;

    const registry = getContract({
      address: customRegistryContract,
      abi: [
        {
          inputs: [],
          name: 'parentDomainController',
          outputs: [
            {
              internalType: 'address',
              name: '',
              type: 'address',
            },
          ],
          stateMutability: 'view' as const,
          type: 'function',
        },
      ],
      client: l1Provider,
    });

    const controller = (await registry.read.parentDomainController()) as `0x${string}`;

    const safe = getContract({
      address: controller,
      abi: [
        {
          inputs: [
            {
              internalType: 'address',
              name: 'start',
              type: 'address',
            },
            {
              internalType: 'uint256',
              name: 'pageSize',
              type: 'uint256',
            },
          ],
          name: 'getModulesPaginated',
          outputs: [
            {
              internalType: 'address[]',
              name: 'array',
              type: 'address[]',
            },
            {
              internalType: 'address',
              name: 'next',
              type: 'address',
            },
          ],
          stateMutability: 'view' as const,
          type: 'function',
        },
      ],
      client: l2Provider,
    });

    const [modules] = await safe.read.getModulesPaginated([
      '0x0000000000000000000000000000000000000001' as `0x${string}`, // sentinel
      10n,
    ]);

    let configModule = null;
    let publicationModule = null;

    for (const moduleAddress of modules) {
      try {
        const module = getContract({
          address: moduleAddress as `0x${string}`,
          abi: [
            {
              inputs: [],
              name: 'NAME',
              outputs: [
                {
                  internalType: 'string',
                  name: '',
                  type: 'string',
                },
              ],
              stateMutability: 'view' as const,
              type: 'function',
            },
          ],
          client: l2Provider,
        });

        const name = (await module.read.NAME()) as string;
        // console.log(`Module ${moduleAddress} NAME:`, name);

        if (name === 'S2S Records Module') {
          configModule = moduleAddress;
        } else if (name === 'S2S Publication Module') {
          publicationModule = moduleAddress;
        }
      } catch (error) {
        // Module doesn't have NAME function, skip
        // console.log(`Module ${moduleAddress} has no NAME function`);
      }
    }

    return {
      multisig: controller,
      configModule,
      publicationModule,
    };
  // } catch (error) {
  //   console.error('Error getting publication addresses:', error);
  //   return {
  //     multisig: null,
  //     configModule: null,
  //     publicationModule: null,
  //   };
  // }
};
