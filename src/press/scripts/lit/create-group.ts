/**
 * create-group.ts — one Lit group per manifest version.
 *
 * A group is never mutated after it exists: the actions bound to it are what a
 * publication on that manifest version executes, and content encrypted to the
 * PKP stays readable through them. So a new build does not swap actions out of
 * the live group — it opens a new group, with the same PKP and the same usage
 * key, and binds the new CIDs to that one. The old group keeps its old hashes
 * and stays usable for anything still pinned to it.
 *
 * Flow:
 *   1. build each action bundle, compact it, compute its CID, pin it (content
 *      addressed — an unchanged bundle pins to the same CID as before)
 *   2. read the PKP and usage key from the previous version's config
 *   3. build + propose ONE Safe batch against ACCOUNT_CONFIG_ADDRESS
 *        addGroup(name `s2s@<version>`, the new cidHashes, [pkp])
 *        addAction x N
 *        addActionToGroup(groupId, hashedCid) x N
 *        addPkpToGroup(groupId, pkp)                     (same PKP, new group)
 *        setUsageApiKey(same key hash, cumulative group scopes)
 *   4. write press/scripts/lit/config/<version>.json
 *   5. print the manifest document for `pnpm set:manifest --version <version>`
 *
 * Usage (repo root):
 *   pnpm actions:group 0.1.1
 *   pnpm actions:group 0.1.1 -- --dry-run
 *   pnpm actions:group 0.1.1 -- --finalize <safeTxHash>
 *
 * Dry-run: LIT_DRY_RUN=1 or --dry-run builds and computes CIDs, prints the full
 * batch decoded, and stops BEFORE pinning and BEFORE proposing.
 */
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { LitService, compactAction, S2SIPFSMethods } from '@s2s/soul2soul-shared';
import { createPublicClient, http, parseAbi } from 'viem';
import {
  ACCOUNT_CONFIG_ADDRESS,
  PROTOCOL_SAFE_ADDRESS,
  actionHash,
  adminHash,
  buildSafeBatch,
  encodeAddAction,
  encodeAddActionToGroup,
  encodeAddGroup,
  encodeAddPkpToGroup,
  encodeSetUsageApiKey,
  loadLitConfig,
  loadMonorepoEnv,
  predictNextGroupId,
  prettyPrintBatch,
  proposeToSafe,
  readExecutedGroupId,
  requireProtocolPrivateKey,
  resolveLitRpcUrl,
  saveLitConfig,
  usageHash,
} from '@s2s/soul2soul-shared/chain-secured';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadMonorepoEnv(__filename);

const CONFIG_DIR = path.join(__dirname, 'config');
const PREVIOUS_CONFIG = path.join(__dirname, 'config.json');
const GROUP_NAME_PREFIX = 's2s@';
const MANIFEST_MODULE = '0x0CbCB9FbbEA0A8DE0547fDb5389b24edB447873F';

const ACTIONS = [
  'prep',
  'render',
  'update',
  'maintain-cache',
  'repoint-archive',
  'encrypt',
  'decrypt',
] as const;

const isDryRun = () => process.env.LIT_DRY_RUN === '1' || process.argv.includes('--dry-run');

function flag(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

const version = process.argv.find((a) => /^\d+\.\d+\.\d+$/.test(a)) ?? null;

if (!version) {
  console.error('Usage: pnpm actions:group <major.minor.patch> [--dry-run] [--finalize <safeTxHash>]');
  process.exit(1);
}

const groupName = `${GROUP_NAME_PREFIX}${version}`;
const versionConfigPath = path.join(CONFIG_DIR, `${version}.json`);

function previousGroup() {
  if (!fs.existsSync(PREVIOUS_CONFIG)) {
    throw new Error(`No previous config at ${PREVIOUS_CONFIG}; pass --pkp and --usage-key`);
  }
  const config = loadLitConfig(PREVIOUS_CONFIG);
  const group = config.groups[0];
  if (!group) throw new Error(`${PREVIOUS_CONFIG} has no group to inherit the PKP from`);

  const pkp = flag('--pkp') ?? group.pkps[0];
  const usageKey = flag('--usage-key') ?? process.env.VITE_LIT_USAGE_KEY ?? group.usage_key;
  if (!pkp) throw new Error('No PKP: pass --pkp or set pkps[0] in config.json');
  if (!usageKey) throw new Error('No usage key: pass --usage-key or set VITE_LIT_USAGE_KEY');

  return { pkp, usageKey, groupIds: config.groups.map((g) => g.id) };
}

async function pinActions(dryRun: boolean) {
  const lit = new LitService({ environment: 'prod' }); // no-auth helpers only
  const ipfs = dryRun
    ? null
    : new S2SIPFSMethods(
        process.env.IPFS_URL!,
        process.env.PINATA_JWT!,
        process.env.PINATA_GATEWAY!,
        process.env.VITE_FILEBASE_TOKEN || '',
      );

  const pinned: Array<{ name: string; cid: string; hashedCid: string }> = [];

  for (const name of ACTIONS) {
    const file = path.resolve(__dirname, '../../actions/dist', name, 'main.js');
    if (!fs.existsSync(file)) {
      throw new Error(`${file} is missing — run \`pnpm run build\` in src/press/actions first`);
    }
    const compact = compactAction(fs.readFileSync(file, 'utf-8'));
    const computed = await lit.getActionCid(compact);
    const cid = dryRun ? computed : await ipfs!.uploadToPinata(compact, name);
    if (cid !== computed) throw new Error(`Pinata returned ${cid} for "${name}", computed ${computed}`);
    pinned.push({ name, cid, hashedCid: actionHash(cid) });
    console.log(`${name.padEnd(16)} ${cid}`);
  }

  return pinned;
}

async function finalize(safeTxHash: string): Promise<void> {
  if (!fs.existsSync(versionConfigPath)) {
    throw new Error(`No proposed config at ${versionConfigPath}; propose first, then finalize`);
  }
  const config = loadLitConfig(versionConfigPath);
  const group = config.groups[0];
  const { isExecuted, executionTxHash, groupId } = await readExecutedGroupId({
    safeTxHash,
    adminHash: adminHash(PROTOCOL_SAFE_ADDRESS),
    safeAddress: PROTOCOL_SAFE_ADDRESS,
    rpcUrl: resolveLitRpcUrl(),
  });
  if (!isExecuted || groupId === null) {
    console.error(`❌ ${safeTxHash} is not executed yet (execution ${executionTxHash ?? 'none'})`);
    process.exitCode = 1;
    return;
  }
  if (group.id !== Number(groupId)) {
    group.id = Number(groupId);
    saveLitConfig(versionConfigPath, config);
  }
  console.log(`✅ group ${groupName} is id ${String(groupId)} (${executionTxHash})`);
}

async function main(): Promise<void> {
  const finalizeTx = flag('--finalize');
  if (finalizeTx) return finalize(finalizeTx);

  const dryRun = isDryRun();
  const { pkp, usageKey, groupIds } = previousGroup();
  const admin = adminHash(PROTOCOL_SAFE_ADDRESS);
  const usage = usageHash(usageKey);
  console.log(`version ${version}, group ${groupName}`);
  console.log(`pkp ${pkp} (inherited), usage key hash ${usage}`);

  const actions = await pinActions(dryRun);
  const predicted = (await predictNextGroupId({ adminHash: admin })) ?? 1n;
  console.log(`predicted group id ${predicted}`);

  const scopes = [...new Set([...groupIds, Number(predicted)])];

  const transactions = buildSafeBatch(
    [
      encodeAddGroup({
        apiKeyHash: admin,
        name: groupName,
        description: `${groupName} — manifest ${version}`,
        cidHashes: actions.map((a) => a.hashedCid as `0x${string}`),
        pkpIds: [pkp as `0x${string}`],
      }),
      ...actions.flatMap((a) => [
        encodeAddAction({
          apiKeyHash: admin,
          name: a.name,
          description: a.name,
          actionHash: a.hashedCid as `0x${string}`,
        }),
        encodeAddActionToGroup({
          apiKeyHash: admin,
          groupId: predicted,
          action: a.hashedCid as `0x${string}`,
        }),
      ]),
      encodeAddPkpToGroup({ apiKeyHash: admin, groupId: predicted, pkpId: pkp as `0x${string}` }),
      // The same usage key, widened to the new group. Every earlier group stays
      // in the scope lists, so a publication on 0.1.0 keeps executing.
      encodeSetUsageApiKey({
        apiKeyHash: admin,
        usageApiKeyHash: usage,
        expiration: 0,
        balance: 0,
        name: 's2s usage key',
        description: `Executes the s2s Lit actions in groups ${scopes.join(', ')} (chain-secured)`,
        createGroups: false,
        deleteGroups: false,
        createPKPs: false,
        manageIPFSIdsInGroups: scopes,
        addPkpToGroups: [],
        removePkpFromGroups: [],
        executeInGroups: scopes,
      }),
    ],
    ACCOUNT_CONFIG_ADDRESS,
  );

  console.log(`\n=== Safe batch (${transactions.length} calls) ===`);
  console.log(prettyPrintBatch(transactions));

  const config = {
    version,
    groups: [
      { name: groupName, id: Number(predicted), actions, pkps: [pkp], usage_key: usageKey },
    ],
  };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  saveLitConfig(versionConfigPath, config);
  console.log(`📝 Wrote ${versionConfigPath}`);

  if (dryRun) {
    console.log('\ndry-run: STOPPING before proposing to the Safe.');
    return;
  }

  const { safeTxHash } = await proposeToSafe({
    transactions,
    safeAddress: PROTOCOL_SAFE_ADDRESS,
    signerPrivateKey: requireProtocolPrivateKey(),
    rpcUrl: resolveLitRpcUrl(),
  });

  console.log('\n=== NEXT STEPS ===');
  console.log(`1. Approve ${safeTxHash} in the Safe UI (owners confirm, then execute).`);
  console.log(`2. pnpm actions:group ${version} -- --finalize ${safeTxHash}   (reads the real group id)`);
  console.log(`3. pnpm set:manifest --version ${version} --document '<json>'   (made below)`);
  console.log(`4. On each publication that should follow ${version}:`);
  console.log('     setRecord("manifest_version", "' + version + '") from its own Safe');
  console.log(`\nmanifest document for ${version}:`);
  console.log(await nextDocument(version, actions));
}

/**
 * The document to file for this version: the module's current document with
 * `version` and `litActions` replaced. The addresses do not move when only an
 * action does, so they are carried over rather than retyped.
 */
async function nextDocument(
  version: string,
  actions: Array<{ name: string; cid: string }>,
): Promise<string> {
  const client = createPublicClient({ transport: http(resolveLitRpcUrl()) });
  const abi = parseAbi(['function getManifest() view returns (string version, string json)']);
  let current: Record<string, unknown> = {};
  try {
    const [, json] = await client.readContract({
      address: MANIFEST_MODULE as `0x${string}`,
      abi,
      functionName: 'getManifest',
    });
    current = JSON.parse(json);
  } catch {
    console.warn('warning: could not read the current document; printing only version + litActions');
  }
  return JSON.stringify({
    ...current,
    version,
    litActions: Object.fromEntries(actions.map((a) => [camel(a.name), a.cid])),
  });
}

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

main()
  .catch((error: any) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });
