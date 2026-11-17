import { namehash as viemNamehash } from 'viem/ens';
import { PublicClient, getContract, decodeFunctionResult, type Address } from 'viem';
import type { S2SManifest } from './types';
import { ENS_NAMEWRAPPER } from './constants';
import { predictPublicationModule } from './factories';
import { isPublicationModuleName } from './module-name';
import { manifestSchema } from './schemas';

/** The record key the manifest document is published under. */
const MANIFEST_KEY = 'manifest';

export * from './module-name';
export * from './factories';
export { S2S_MODULE_KIND_PUBLICATION, S2S_MODULE_KIND_RECORDS } from './constants';

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
 * INV-2: the controller's records module carries the manifest as ONE document,
 * under the key `manifest`. The same document is mirrored at `manifest@x.y.z`
 * for every version ever published, so a reader pinned to an older release
 * still finds it and history is retained without a second read here.
 *
 * The document is JSON, camelCase:
 *
 *   version, gateway, ensRegistry, ensRecords, publicationFactory,
 *   recordsFactory, pkp, litActions{prep, render, update,
 *   maintainCache?, repointArchive?, encrypt?, decrypt?}
 *
 * Optional action CIDs are omitted when the action was never written, never
 * present as an empty string. There is no fallback to the flat keys that
 * preceded this document and none to a partially valid one: a missing key or
 * unparsable JSON is an error naming `manifest`.
 *
 * `VERSION()` on the same module answers the manifest's major.minor as one
 * string, `0.1`, so the check is the document's first two segments against that
 * whole string. There is no redeploy when the document moves within a minor:
 * `VERSION()` stays `0.1` while the document carries `0.1.3`. A different major
 * or minor is a document this module cannot be read alongside.
 *
 * One deployment's manifest: the addresses and action CIDs a client needs to
 * talk to it, read from the controller's records module. This is not protocol
 * text and not code, it is references to code, published per release.
 *
 * `version` names which document to read. Absent, this reads the live record,
 * `manifest`. Present as `x.y.z`, it reads the mirror written for that version,
 * `manifest@x.y.z`, which is history: a snapshot of the fields as they were
 * published then, including action CIDs the Lit group may since have replaced.
 * A named version that answers a document claiming another version is a bad
 * record, not a fallback.
 */
export const getManifest = async (
  l1Provider: ViemProvider,
  l2Provider: ViemProvider,
  version?: string,
): Promise<S2SManifest> => {
  const {
    multisig,
    configModule,
    publicationModule: scannedPublicationModule,
    modules,
  } = await getProtocolControllerAndModules(false, l1Provider, l2Provider);

  const key = version ? `${MANIFEST_KEY}@${version}` : MANIFEST_KEY;
  const [document] = await getRecords(configModule!, [key], l2Provider);

  if (!document) {
    throw new Error(`manifest: no '${key}' record on ${configModule}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(document);
  } catch (error) {
    throw new Error(
      `manifest: the '${key}' record is not valid JSON: ${(error as Error).message}`,
    );
  }

  // The schema's output is the document: everything but the factory discovery
  // was handed and the module it predicts.
  let manifest: Omit<S2SManifest, 'moduleFactory' | 'publicationModule'>;
  try {
    manifest = manifestSchema.parse(raw);
  } catch (error) {
    throw new Error(
      `manifest: the '${key}' record does not have the document's shape: ${(error as Error).message}`,
    );
  }

  // Asked for one version, answered with another: the record was overwritten
  // with a different document, or the caller named a key that holds the wrong
  // thing. Either way it is not the snapshot that was asked for.
  if (version && manifest.version !== version) {
    throw new Error(
      `manifest: the '${key}' record carries version ${manifest.version}, not ${version}`,
    );
  }

  const onChainVersion = (await getContract({
    address: configModule! as Address,
    abi: [
      {
        inputs: [],
        name: 'VERSION',
        outputs: [{ internalType: 'string', name: '', type: 'string' }],
        stateMutability: 'view' as const,
        type: 'function',
      },
    ],
    client: l2Provider,
  }).read.VERSION()) as string;

  // `VERSION()` is the manifest's major.minor, so this is the document's first
  // two segments against the whole of it: `0.1` reads a `0.1.3` document.
  const documentPrefix = manifest.version.split('.').slice(0, 2).join('.');
  if (documentPrefix !== onChainVersion) {
    throw new Error(
      `manifest: document version ${manifest.version} is not compatible with VERSION() ${onChainVersion}`,
    );
  }

  // The factory that answers a module address is in the document, so the
  // prediction can only run after the read. It is given the module list read
  // above: one `getModulesPaginated`, one records read, either way.
  const predictedPublicationModule = manifest.publicationFactory
    ? await predictPublicationModule(
        l2Provider,
        manifest.publicationFactory as Address,
        multisig as Address,
        modules,
      )
    : undefined;

  return {
    version: manifest.version,
    gateway: manifest.gateway,
    ensRegistry: manifest.ensRegistry,
    ensRecords: manifest.ensRecords,
    publicationFactory: manifest.publicationFactory,
    recordsFactory: manifest.recordsFactory,
    // One factory for every kind, named by the same field in the document.
    moduleFactory: manifest.publicationFactory,
    publicationModule: predictedPublicationModule ?? scannedPublicationModule ?? undefined,
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
