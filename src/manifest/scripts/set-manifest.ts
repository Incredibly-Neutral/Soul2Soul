/**
 * Publish one manifest document on the manifest module.
 *
 * The module holds the document the whole system reads: every address a client
 * needs, and every action CID. It is write-once per version, so this checks the
 * version is not already published before it proposes anything, and refuses a
 * document whose own `version` field disagrees with the version it is filed
 * under.
 *
 * Run: pnpm set:manifest --version 0.1.0 --from-records 0xBB0B…
 *      pnpm set:manifest --version 0.1.0 --document '<json>'
 *      pnpm set:manifest … --json     a Transaction Builder batch, not a proposal
 *      pnpm set:manifest … --data     the calldata only
 *
 * `--from-records` assembles the first document from the flat record keys the
 * records module already carries. That is a migration, not a supported path: the
 * document is the record now, and the flat keys are not read by anything.
 */

import { encodeFunctionData, getAddress, isAddress, parseAbi } from 'viem';

import {
  MODULE_ABI,
  addressEnv,
  deliver,
  publicClient,
  refuse,
  say,
} from './lib';

const MANIFEST_ABI = [
  {
    type: 'function',
    name: 'setManifest',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'version', type: 'string' },
      { name: 'json', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'versionExists',
    stateMutability: 'view',
    inputs: [{ name: 'version', type: 'string' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

const RECORDS_ABI = parseAbi([
  'function getAllKeys() view returns (string[])',
  'function getRecords(string[] keys) view returns (string[])',
]);

/** The flat record key each document field came from, while they still exist. */
const LEGACY_KEY: Record<string, string> = {
  gateway: 'data_gateway',
  ensRegistry: 'ens_registry',
  ensRecords: 'ens_records',
  publicationFactory: 'publication_factory',
  recordsFactory: 'records_factory',
  pkp: 'pkp_ethAddress',
};

const LEGACY_ACTION_KEY: Record<string, string> = {
  prep: 'lit_action_prep',
  render: 'lit_action_render',
  update: 'lit_action_update',
  maintainCache: 'lit_action_maintainCache',
  repointArchive: 'lit_action_repointArchive',
  encrypt: 'lit_action_encrypt',
  decrypt: 'lit_action_decrypt',
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** The address the document is filed on: the constant, unless `.env` says otherwise. */
function moduleAddress(): `0x${string}` {
  const fromEnv = process.env.MANIFEST_MODULE_ADDRESS;
  if (fromEnv) {
    if (!isAddress(fromEnv)) refuse(`MANIFEST_MODULE_ADDRESS is not an address: ${fromEnv}`);
    return getAddress(fromEnv);
  }
  return '0x0CbCB9FbbEA0A8DE0547fDb5389b24edB447873F';
}

/**
 * The document, assembled from the flat keys on the records module.
 *
 * An absent key is refused rather than written empty: the document is the only
 * thing clients read, so a field missing from it fails every action at once.
 */
async function documentFromRecords(recordsModule: `0x${string}`, version: string) {
  const keys = (await publicClient.readContract({
    address: recordsModule,
    abi: RECORDS_ABI,
    functionName: 'getAllKeys',
  })) as string[];
  const values = (await publicClient.readContract({
    address: recordsModule,
    abi: RECORDS_ABI,
    functionName: 'getRecords',
    args: [keys as string[]],
  })) as string[];

  const record = new Map(keys.map((key, index) => [key, values[index]]));

  const field = (documentField: string, recordKey: string): string => {
    const value = record.get(recordKey);
    if (!value) refuse(`${documentField}: no '${recordKey}' record on ${recordsModule}`);
    return value;
  };

  const document: Record<string, unknown> = { version };
  for (const [documentField, recordKey] of Object.entries(LEGACY_KEY)) {
    document[documentField] = field(documentField, recordKey);
  }

  const litActions: Record<string, string> = {};
  for (const [action, recordKey] of Object.entries(LEGACY_ACTION_KEY)) {
    const value = record.get(recordKey);
    if (value) litActions[action] = value;
  }
  for (const required of ['prep', 'render', 'update']) {
    if (!litActions[required]) refuse(`litActions.${required}: no record on ${recordsModule}`);
  }
  document.litActions = litActions;

  return JSON.stringify(document);
}

async function main() {
  const version = arg('version');
  if (!version) refuse('--version x.y.z is required');
  if (!/^\d+\.\d+\.\d+$/.test(version)) refuse(`--version must be x.y.z, got ${version}`);

  const document_ = arg('document');
  const fromRecords = arg('from-records');
  if (!document_ && !fromRecords) refuse('one of --document or --from-records is required');
  if (document_ && fromRecords) refuse('--document and --from-records are exclusive');

  const module = moduleAddress();

  const code = await publicClient.getBytecode({ address: module });
  if (!code || code === '0x') refuse(`no code at the manifest module ${module}`);

  const exists = (await publicClient.readContract({
    address: module,
    abi: MANIFEST_ABI,
    functionName: 'versionExists',
    args: [version],
  })) as boolean;
  if (exists) refuse(`${module} already publishes version ${version}; a version is write-once`);

  const json = document_
    ? document_
    : await documentFromRecords(
        (() => {
          if (!isAddress(fromRecords!)) refuse(`--from-records is not an address: ${fromRecords}`);
          return getAddress(fromRecords!);
        })(),
        version,
      );

  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    refuse(`the document is not JSON: ${(error as Error).message}`);
  }
  if (parsed.version !== version) {
    refuse(`the document says version ${parsed.version}, filed as ${version}`);
  }
  for (const field of ['gateway', 'ensRegistry', 'ensRecords', 'publicationFactory', 'recordsFactory', 'pkp']) {
    if (!parsed[field]) refuse(`the document has no ${field}`);
  }
  for (const action of ['prep', 'render', 'update']) {
    if (!parsed.litActions?.[action]) refuse(`the document has no litActions.${action}`);
  }

  say(
    `${module} answers ${(await publicClient.readContract({
      address: module,
      abi: MODULE_ABI,
      functionName: 'manifestVersion',
    }).catch(() => '(no version yet)')) as string}`,
    `publishing ${version}, ${json.length} bytes`,
    json,
  );

  const data = encodeFunctionData({
    abi: MANIFEST_ABI,
    functionName: 'setManifest',
    args: [version, json],
  });

  await deliver(module, data, `setManifest(${version})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
