import { namehash as viemNamehash } from 'viem/ens';
import { PublicClient, getContract, decodeFunctionResult, type Address } from 'viem';
import type { z } from 'zod';
import type { S2SManifest } from './types';
import { ENS_NAMEWRAPPER, MANIFEST_MODULE_ADDRESS } from './constants';
import { predictPublicationModule } from './factories';
import { isPublicationModuleName } from './module-name';
import { manifestSchema } from './schemas';

export * from './module-name';
export * from './factories';
export {
  S2S_MODULE_KIND_PUBLICATION,
  S2S_MODULE_KIND_RECORDS,
  MANIFEST_MODULE_ADDRESS,
  MANIFEST_VERSION_KEY,
} from './constants';

export type { S2SManifest };
export type {
  Metered,
  S2SSignerSecrets,
  S2SPublishSecrets,
  StorageCredential,
  FilecoinSessionKeyData,
} from './types';
export { useMetered } from './types';

// Viem public client type (equivalent to ethers Provider)
export type ViemProvider = PublicClient;

/**
 * The manifest module's read surface: one document per version, and the version
 * that is current.
 *
 * `getManifest()` answers the current document as a pair, `(version, json)`;
 * `getManifest(version)` answers the snapshot published under that version,
 * which is history and never moves. There is no `VERSION()` on this module: the
 * document names its own version, and the module's address is its identity.
 */
// Two abi constants, not one with two `getManifest` entries: the overloads are
// told apart by their arguments, and a single abi makes the no-argument call
// answer the versioned overload's type.
const MANIFEST_CURRENT_ABI = [
  // The module's own refusals, so a read on an empty module says "no manifest
  // published yet" instead of a bare 0x6a166a2d.
  { type: 'error', name: 'NoManifest', inputs: [] },
  { type: 'error', name: 'VersionNotFound', inputs: [{ name: 'version', type: 'string' }] },
  {
    inputs: [],
    name: 'getManifest',
    outputs: [
      { internalType: 'string', name: 'version', type: 'string' },
      { internalType: 'string', name: 'json', type: 'string' },
    ],
    stateMutability: 'view' as const,
    type: 'function',
  },
] as const;

const MANIFEST_VERSIONED_ABI = [
  { type: 'error', name: 'NoManifest', inputs: [] },
  { type: 'error', name: 'VersionNotFound', inputs: [{ name: 'version', type: 'string' }] },
  {
    inputs: [{ internalType: 'string', name: 'version', type: 'string' }],
    name: 'getManifest',
    outputs: [{ internalType: 'string', name: 'json', type: 'string' }],
    stateMutability: 'view' as const,
    type: 'function',
  },
] as const;

/**
 * The manifest: the addresses and action CIDs of this deployment, as one JSON
 * document on the manifest module, `0x0CbCB9…`, held above as a constant.
 *
 * Read with one call, and with no input from any publication: this is the
 * bootstrap read, what a client needs before a publication exists, so it cannot
 * depend on a publication's version, its records module or its ENS name. A
 * publication that pins a document is a different read, resolved from that
 * publication's own `manifest_version` record.
 *
 * The document is JSON, camelCase:
 *
 *   version, gateway, ensRegistry, ensRecords, publicationFactory,
 *   recordsFactory, pkp, litActions{prep, render, update,
 *   maintainCache?, repointArchive?, encrypt?, decrypt?}
 *
 * Optional action CIDs are omitted when the action was never written, never
 * present as an empty string. There is no fallback: an empty module, unparsable
 * JSON, a missing field or an unrecognised shape is an error naming the module
 * and the version asked for.
 *
 * `version` names which document to read. Absent, this reads the current one.
 * Present as `x.y.z`, it reads the snapshot published under that version, and a
 * document whose own `version` disagrees with the one named is a bad record, not
 * a fallback. The current read also checks the pair the module answers, so a
 * document and its index cannot disagree.
 */
export const getManifest = async (
  // Unused by the bootstrap read; the pinned read needs it, to resolve a
  // publication's Safe from its ENS name.
  _l1Provider: ViemProvider,
  l2Provider: ViemProvider,
  version?: string,
): Promise<S2SManifest> => {
  let document: string;
  let currentVersion: string | undefined;
  try {
    if (version) {
      document = await l2Provider.readContract({
        address: MANIFEST_MODULE_ADDRESS as Address,
        abi: MANIFEST_VERSIONED_ABI,
        functionName: 'getManifest',
        args: [version],
      });
    } else {
      const [answeredVersion, answeredDocument] = await l2Provider.readContract({
        address: MANIFEST_MODULE_ADDRESS as Address,
        abi: MANIFEST_CURRENT_ABI,
        functionName: 'getManifest',
        args: [],
      });
      currentVersion = answeredVersion;
      document = answeredDocument;
    }
  } catch (error) {
    throw new Error(
      `manifest: cannot read ${version ? `version ${version}` : 'the current version'} on ` +
        `${MANIFEST_MODULE_ADDRESS}: ${(error as Error).message}`,
    );
  }

  const key = version ?? currentVersion;

  let raw: unknown;
  try {
    raw = JSON.parse(document);
  } catch (error) {
    throw new Error(`manifest: version ${key} is not valid JSON: ${(error as Error).message}`);
  }

  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = manifestSchema.parse(raw);
  } catch (error) {
    throw new Error(
      `manifest: version ${key} does not have the document's shape: ${(error as Error).message}`,
    );
  }

  // The index and the document are written together, so they cannot disagree.
  // Either one answering a different version is a bad write, not a fallback.
  if (key && manifest.version !== key) {
    throw new Error(
      `manifest: version ${key} carries document version ${manifest.version}, not ${key}`,
    );
  }

  // There is no publication in this read: one is resolved by name, from a
  // publication's own records, and a client that has not created one yet has
  // nothing to resolve. The factory is in the document, so it is still known.
  return {
    version: manifest.version,
    gateway: manifest.gateway,
    ensRegistry: manifest.ensRegistry,
    ensRecords: manifest.ensRecords,
    publicationFactory: manifest.publicationFactory,
    recordsFactory: manifest.recordsFactory,
    moduleFactory: manifest.publicationFactory,
    pkp: manifest.pkp,
    litActions: {
      prep: manifest.litActions.prep,
      render: manifest.litActions.render,
      update: manifest.litActions.update,
      maintainCache: manifest.litActions.maintainCache,
      repointArchive: manifest.litActions.repointArchive,
      encrypt: manifest.litActions.encrypt,
      decrypt: manifest.litActions.decrypt,
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
  ethersProvider: ViemProvider,
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

/**
 * The controller's modules, resolved by the Safe's own `NAME()` scan.
 *
 * Scan-only on purpose: the factory address a prediction needs is itself a
 * record, and this runs before the records are read. `getManifest` is where
 * the prediction happens, once it holds that record.
 */
export const getProtocolControllerAndModules = async (
  dev: boolean,
  l1Provider: ViemProvider,
  l2Provider: ViemProvider,
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

  const customRegistryContract = (await nameWrapper.read.ownerOf([subdomainNode])) as `0x${string}`;

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
      } else if (isPublicationModuleName(name)) {
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
    /** The Safe's enabled-module list, as read; reused by the prediction. */
    modules,
  };
};
