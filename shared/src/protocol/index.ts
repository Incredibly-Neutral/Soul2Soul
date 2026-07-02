import { namehash as viemNamehash } from 'viem/ens';
import { PublicClient, getContract, decodeFunctionResult } from 'viem';
import type { S2SProtocolInfo } from './types';
import { ENS_NAMEWRAPPER } from './constants';

export type { S2SProtocolInfo };
export type { DidEthr, S2SPublicContent, S2SProof, S2SContentItem, S2SContentBody, S2SBody, S2SBodyBase, S2SBodyPlain, S2SBodyEncrypted, S2STemplateData, S2SCollection, S2SRipple, S2STemplateConfig, IMapping, S2SJob } from './types';
export { S2S_DOMAIN, S2S_TYPES, toDidEthr, eoaOf } from './types';
export type { Metered, S2SSignerSecrets, S2SPublishSecrets, StorageCredential, FilecoinSessionKeyData } from './types';
export { useMetered } from './types';

// Viem public client type (equivalent to ethers Provider)
export type ViemProvider = PublicClient;

/**
 * NOTE (INV-2): This reader expects the following on-chain record keys to exist
 * on the controller's records module. Before this can produce correct results,
 * the on-chain records must be written (see protocol/scripts/lit/update-protocol.ts):
 *
 *   data_gateway, ens_records, ens_registry, publication_factory, records_factory,
 *   pkp_ethAddress, lit_action_prep, lit_action_render, lit_action_update
 *
 * The following keys were DROPPED (stop reading): assets_gateway, lens_app,
 * pkp_tokenId, pkp_publicKey, lit_action_cbor, lit_action_single, lit_action_root_update.
 * The following were RENAMED: lit_action_single → lit_action_render,
 * lit_action_root_update → lit_action_update.
 */
export const getProtocolInfo = async (
  dev = false,
  l1Provider: ViemProvider,
  l2Provider: ViemProvider
): Promise<S2SProtocolInfo> => {
  const { multisig, configModule } = await getProtocolControllerAndModules(
    dev,
    l1Provider,
    l2Provider
  );

  const [
    data_gateway,
    ens_records,
    ens_registry,
    publication_factory,
    records_factory,
    lit_action_prep,
    lit_action_render,
    lit_action_update,
    pkp_ethAddress,
  ] = await getRecords(
    configModule!,
    [
      'data_gateway',
      'ens_records',
      'ens_registry',
      'publication_factory',
      'records_factory',
      'lit_action_prep',
      'lit_action_render',
      'lit_action_update',
      'pkp_ethAddress',
    ],
    l2Provider
  );

  return {
    gateway: data_gateway,
    ensRegistry: ens_registry,
    ensRecords: ens_records,
    publicationFactory: publication_factory,
    recordsFactory: records_factory,
    pkp: pkp_ethAddress,
    litActions: {
      prep: lit_action_prep,
      render: lit_action_render,
      update: lit_action_update,
    },
  };
};

export const tokenIDFromBytes = (bytes: string): string => {
  return '';
};

export const publicKeyFromBytes = (bytes: string): string => {
  return bytes;
};

export const getRecords = async (
  moduleAddress: string,
  keys: string[],
  ethersProvider: ViemProvider
) => {
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
    '0x0000000000000000000000000000000000000001' as `0x${string}`,
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

      if (name === 'S2S Records Module') {
        configModule = moduleAddress;
      } else if (name === 'S2S Publication Module') {
        publicationModule = moduleAddress;
      }
    } catch (error) {
      // Module doesn't have NAME function, skip
    }
  }

  return {
    multisig: controller,
    configModule,
    publicationModule,
  };
};
