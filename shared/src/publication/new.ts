import type { S2SPublication } from './types';
import type { TxRunner } from './tx-runner';
import type { S2SProtocolInfo } from '../protocol';
import type { S2SIPFSMethods } from '../ipfs';
import { safeAbi, ensSubdomainRegistryAbi } from '../contracts';
import { AssetsBuilder } from './assets-builder';
import { ConfigBuilder, parseGitHubUrl } from './config-builder';

// =============================================================================
// Protocol-generated ABIs injected because they live outside shared's rootDir.
// Neutralpress imports them from protocol/contracts/generated/abis;
// safe-app will provide them from its own build path.
// =============================================================================
export interface NewPublicationDeps {
  l1: TxRunner;
  l2: TxRunner;
  privateKey: string;
  protocolInfo: S2SProtocolInfo; // sources ensRegistry, recordsFactory, publicationFactory
  recordsModuleFactoryAbi: any; // protocol-generated
  publicationModuleFactoryAbi: any; // protocol-generated
  recordsModuleAbi: any; // protocol-generated

  // Configuration building
  ipfs: S2SIPFSMethods; // app-constructed with its kubo+pinata gateways
  githubToken: string; // was import.meta.env.VITE_GITHUB_TOKEN
  ensRecordsAddress: string; // protocolInfo.ensRecords for AssetsBuilder

  createFeed: (name: string, desc: string, safeAddr: string) => Promise<string>;
}

// =============================================================================
// Deps assembly
//
// Single entry point for building NewPublicationDeps from injected pieces — so
// each host (neutralpress with its obsidian plugin settings, safe-app with its
// own gateway config) supplies the pieces and shared wires them together,
// centralizing the ensRecordsAddress fallback.
// =============================================================================

export interface BuildNewPublicationDepsInput {
  runners: { l1: TxRunner; l2: TxRunner };
  privateKey: string;
  protocolInfo: S2SProtocolInfo; // sources ensRegistry, recordsFactory, publicationFactory
  recordsModuleFactoryAbi: any; // protocol-generated
  publicationModuleFactoryAbi: any; // protocol-generated
  recordsModuleAbi: any; // protocol-generated
  ipfs: S2SIPFSMethods; // app-constructed with its kubo+pinata gateways
  githubToken: string;
  createFeed: (name: string, desc: string, safeAddr: string) => Promise<string>;
}

export function buildNewPublicationDeps(input: BuildNewPublicationDepsInput): NewPublicationDeps {
  const {
    runners,
    privateKey,
    protocolInfo,
    recordsModuleFactoryAbi,
    publicationModuleFactoryAbi,
    recordsModuleAbi,
    ipfs,
    githubToken,
    createFeed,
  } = input;
  return {
    l1: runners.l1,
    l2: runners.l2,
    privateKey,
    protocolInfo,
    recordsModuleFactoryAbi,
    publicationModuleFactoryAbi,
    recordsModuleAbi,
    ipfs,
    githubToken,
    ensRecordsAddress: protocolInfo?.ensRecords ?? '',
    createFeed,
  };
}

// =============================================================================
// Main orchestration
// =============================================================================

export async function newPublicationSafe(
  deps: NewPublicationDeps,
  publication: S2SPublication,
): Promise<void> {
  const salt = 'publication_safe_' + publication.name;
  const subdomain: string = publication.name.split('.')[0] || '';

  const signer = await deps.l1.updateSigner(deps.privateKey);
  await deps.l2.updateSigner(deps.privateKey);

  const publicationAddress1 = (await deps.l1.connectToFreshSafe(salt)) as `0x${string}`;
  const publicationAddress2 = (await deps.l2.connectToFreshSafe(salt)) as `0x${string}`;

  publication.contract = publicationAddress1;

  // FIX: recordsModule was incorrectly destructured as [recordsModule] in the
  // original code, slicing the first character off the returned address string.
  const [registration, recordsModule] = await Promise.all([
    // L1: ENS registration
    deps.l1.genericTx(
      deps.protocolInfo.ensRegistry as `0x${string}`,
      JSON.stringify(ensSubdomainRegistryAbi),
      'registerSubdomain',
      [subdomain, publicationAddress1],
      false,
    ),

    // L2: Create records module
    deps.l2.genericTx(
      deps.protocolInfo.recordsFactory as `0x${string}`,
      JSON.stringify(deps.recordsModuleFactoryAbi),
      'createModule',
      [publicationAddress2],
      true,
    ),
  ]);

  console.log('ENS registered:', registration);

  // Safe on L2 is now deployed — reconnect before sending FROM it
  await deps.l1.connectToExistingSafe(publicationAddress1);
  await deps.l2.connectToExistingSafe(publicationAddress2);

  const publicationModule = await deps.l2.genericTx(
    deps.protocolInfo.publicationFactory as `0x${string}`,
    JSON.stringify(deps.publicationModuleFactoryAbi),
    'createModule',
    [publicationAddress2, publication.authors, []],
    true,
  );

  console.log('Created modules:', recordsModule, publicationModule);

  await deps.l2.batchGenericTx([
    {
      address: publicationAddress2,
      abi: JSON.stringify(safeAbi),
      method: 'enableModule',
      args: [recordsModule],
      deploy: false,
    },
    {
      address: publicationAddress2,
      abi: JSON.stringify(safeAbi),
      method: 'enableModule',
      args: [publicationModule],
      deploy: false,
    },
  ]);

  // Verify modules enabled
  await verifyModulesEnabled(
    deps.l2,
    publication.name,
    publicationAddress2,
    recordsModule,
    publicationModule,
  );

  // =========================================================================
  // Build assets + config (two-step compose — assets first, then config)
  // =========================================================================
  const { owner, repo: repoName, branch: ghBranch } = parseGitHubUrl(publication.devRepository);
  const effectiveBranch = publication.branch || ghBranch;
  const existingConfigCid = publication.configCid; // may be undefined on first create

  const assetsBuilder = new AssetsBuilder(deps.ipfs, deps.githubToken);
  const { cid: assetsCid } = await assetsBuilder.buildAssets(
    owner,
    repoName,
    effectiveBranch,
    publication.name,
    publicationAddress2,
    existingConfigCid,
  );

  const configBuilder = new ConfigBuilder(deps.ipfs, deps.githubToken);
  const { cid: configCid } = await configBuilder.buildConfig(
    owner,
    repoName,
    effectiveBranch,
    publication.name,
    publicationAddress2,
    assetsCid,
    existingConfigCid,
  );

  publication.configCid = configCid;

  // =========================================================================
  // Feed creation + records
  // =========================================================================
  const feedAddress = await deps.createFeed(
    publication.name,
    'Publication Feed for Soul2Soul Protocol',
    publicationAddress2,
  );

  publication.feed = feedAddress;

  await setRecordsWithRetry(deps.l2, recordsModule, deps.recordsModuleAbi, publication);

  if (publication.owners.length > 0) {
    const addOwnerCalls = publication.owners.map((owner: string) => ({
      address: publicationAddress2,
      abi: JSON.stringify(safeAbi),
      method: 'addOwnerWithThreshold',
      args: [owner, 1],
    }));

    await deps.l1.batchGenericTx(addOwnerCalls);
    await deps.l2.batchGenericTx(addOwnerCalls);
    await verifyOwnersAdded(deps.l1, publicationAddress2, publication.owners || []);
    await verifyOwnersAdded(deps.l2, publicationAddress2, publication.owners || []);
    await removeInitialSigner(deps.l1, publicationAddress2, signer, publication.owners || []);
    await removeInitialSigner(deps.l2, publicationAddress2, signer, publication.owners || []);
  }

  console.log('FINISHED: ', publicationAddress1);
}

// =============================================================================
// Helpers (genuinely generic — only use genericRead/genericTx on TxRunner)
// =============================================================================

export async function verifyModulesEnabled(
  runner: TxRunner,
  ensName: string,
  publicationAddress: string,
  recordsModule: string,
  publicationModule: string,
) {
  // Add initial delay for state propagation
  await new Promise((resolve) => setTimeout(resolve, 5000));

  for (const module of [recordsModule, publicationModule]) {
    let isEnabled = false;
    let retries = 0;

    while (!isEnabled && retries < 20) {
      console.log('checking for module:', module);
      retries++;
      try {
        isEnabled = await runner.genericRead(
          publicationAddress as `0x${string}`,
          JSON.stringify(safeAbi),
          'isModuleEnabled',
          [module],
        );

        if (isEnabled) {
          // console.log(`✅ Module ${module} verified after ${retries} attempts`);
        } else {
          // console.log(`Module not enabled yet, waiting...`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      } catch (error: any) {
        console.log(`❌ Retry ${retries}/20 - Error:`, error.message || error);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    if (!isEnabled) {
      console.error(`❌ Module ${module} still not verified after ${retries} retries`);
      console.log('Continuing anyway - modules are enabled but state not readable yet');
    }
  }

  // Extra safety buffer
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

export async function setRecordsWithRetry(
  runner: TxRunner,
  recordsModule: string,
  recordsModuleAbi: any,
  publication: any,
) {
  let success = false;
  let attempts = 0;

  console.log('recordsmodule', recordsModule);

  while (!success && attempts < 3) {
    attempts++;
    try {
      console.log(`Setting records (attempt ${attempts}/3)...`);

      const setRecords = await runner.genericTx(
        recordsModule as `0x${string}`,
        JSON.stringify(recordsModuleAbi),
        'setRecords',
        [
          ['name', 'config', 'repo', 'branch', 'feed'],
          [
            publication.name,
            publication.configCid,
            publication.devRepository,
            publication.branch,
            publication.feed,
          ],
        ],
        false,
      );

      console.log('✅ setRecords succeeded:', setRecords);
      success = true;
    } catch (error: any) {
      console.log(`❌ Attempt ${attempts} failed:`, error.message);
      if (attempts < 3) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      } else {
        throw error;
      }
    }
  }
}

export async function verifyOwnersAdded(
  runner: TxRunner,
  publicationAddress: string,
  owners: string[],
) {
  if (owners.length === 0) return;

  console.log('Verifying owners added...');
  let isOwner = false;
  let retries = 0;

  while (!isOwner && retries < 10) {
    retries++;
    try {
      isOwner = await runner.genericRead(
        publicationAddress as `0x${string}`,
        JSON.stringify(safeAbi),
        'isOwner',
        [owners[0]],
      );

      if (isOwner) {
        console.log(`✅ Owner ${owners[0]} verified after ${retries} attempts`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  if (!isOwner) throw new Error(`Owner ${owners[0]} not added`);

  // Extra buffer
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

export async function removeInitialSigner(
  runner: TxRunner,
  publicationAddress: string,
  signer: string,
  owners: string[],
) {
  const currentOwners = await runner.genericRead(
    publicationAddress as `0x${string}`,
    JSON.stringify(safeAbi),
    'getOwners',
    [],
  );

  console.log('Current owners:', currentOwners);

  const ownerToRemove = signer;
  const ownerIndex = currentOwners.findIndex(
    (addr: string) => addr.toLowerCase() === ownerToRemove.toLowerCase(),
  );

  if (ownerIndex === -1) {
    console.log('Owner already removed or not found');
  } else {
    const prevOwner =
      ownerIndex === 0
        ? '0x0000000000000000000000000000000000000001'
        : currentOwners[ownerIndex - 1];

    console.log('Removing owner:', ownerToRemove);
    console.log('prevOwner:', prevOwner);
    console.log('New threshold:', owners.length);

    let removeOwnerSuccess = false;
    let attempts = 0;

    while (!removeOwnerSuccess && attempts < 3) {
      attempts++;
      try {
        console.log(`Removing original owner (attempt ${attempts}/3)...`);

        const rmOwner = await runner.genericTx(
          publicationAddress as `0x${string}`,
          JSON.stringify(safeAbi),
          'removeOwner',
          [prevOwner, ownerToRemove, owners.length.toString()],
          false,
        );

        console.log('✅ removeOwner succeeded:', rmOwner);
        removeOwnerSuccess = true;
      } catch (error: any) {
        console.log(`❌ Attempt ${attempts} failed:`, error.message);
        if (attempts < 3) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
        } else {
          throw error;
        }
      }
    }
  }
}
