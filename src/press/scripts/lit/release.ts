/**
 * release.ts — one command that converges the chain onto a manifest version.
 *
 * `pnpm update-protocol <version>` reads what is already true and proposes only
 * what is not. Four facts, checked in order:
 *
 *   1. the actions are pinned        (build + CID; content addressed, so a
 *                                     rebuild of unchanged code keeps its CID)
 *   2. a group named s2s@<version> exists on the Lit AccountConfig
 *   3. the manifest module carries a document for <version>
 *   4. a publication's records module pins <version>   (when a publication is named)
 *
 * It proposes one Safe batch per run and stops, because each step is a separate
 * signature. Re-running after the approval continues at the first false fact. A
 * version that is fully settled proposes nothing and says so.
 *
 * State, not a config file, decides: `config/<version>.json` is written after a
 * proposal as the record of what was pinned and which group it became, and is
 * checked against chain rather than followed.
 *
 * Order matters within a step and not across them: the document names CIDs, not
 * a group id, and a publication pin only means something once the document
 * exists. So the pin is proposed last, and only for a publication whose Safe the
 * signer can actually propose to.
 *
 * Usage (repo root):
 *   pnpm update-protocol 0.1.1
 *   pnpm update-protocol 0.1.1 --publication test.soul2soul.eth
 *   pnpm update-protocol 0.1.1 --dry-run
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { createPublicClient, http, parseAbi, encodeFunctionData } from 'viem';
import { namehash } from 'viem/ens';
import { privateKeyToAccount } from 'viem/accounts';
import Safe from '@safe-global/protocol-kit';
import { base, mainnet } from 'viem/chains';
import { LitService, compactAction, S2SIPFSMethods } from '@s2s/soul2soul-shared';
import {
  MANIFEST_MODULE_ADDRESS,
  MANIFEST_VERSION_KEY,
  S2S_MODULE_KIND_RECORDS,
} from '@s2s/soul2soul-shared';
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
  type LitConfigFile,
  loadMonorepoEnv,
  prettyPrintBatch,
  requireProtocolPrivateKey,
  resolveLitRpcUrl,
  saveLitConfig,
  usageHash,
  viewsFacetAbi,
  writesFacetAbi,
} from '@s2s/soul2soul-shared/chain-secured';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadMonorepoEnv(__filename);

const REPO_ROOT = path.resolve(__dirname, '../../../..');
/** What a version's record holds: the config file's shape plus what it was proposed under. */
type GroupRecord = LitConfigFile & { version: string; safeTxHash?: string };

const CONFIG_DIR = path.join(__dirname, 'config');
const PREVIOUS_CONFIG = path.join(__dirname, 'config.json');
const GROUP_PREFIX = 's2s@';
/** The ENS NameWrapper on mainnet; `ownerOf(namehash(name))` is the Safe that owns a publication. */
const ENS_NAMEWRAPPER = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';
const PUBLICATION_FACTORY = '0x19D068E0d237ce77262F4647Bf51f5434A5743fd';

const ACTIONS = [
  'prep',
  'render',
  'update',
  'maintain-cache',
  'repoint-archive',
  'encrypt',
  'decrypt',
] as const;

const MANIFEST_ABI = parseAbi([
  'function versionExists(string version) view returns (bool)',
  'function manifestVersion() view returns (string)',
  'function getManifest() view returns (string version, string json)',
  'function setManifest(string version, string json)',
]);
const RECORDS_ABI = parseAbi([
  'function getRecord(string key) view returns (string)',
  'function setRecord(string key, string value)',
]);
const FACTORY_ABI = parseAbi([
  'function moduleAddress(address safe, bytes32 kind) view returns (address)',
]);
const NAME_WRAPPER_ABI = parseAbi(['function ownerOf(uint256 id) view returns (address)']);
const SAFE_ABI = parseAbi(['function nonce() view returns (uint256)']);
const TX_SERVICE = 'https://safe-transaction-base.safe.global/api/v1';

const isDryRun = () => process.env.LIT_DRY_RUN === '1' || process.argv.includes('--dry-run');

function flag(name: string): string | null {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? null : (process.argv[idx + 1] ?? null);
}

const version = process.argv.find((a) => /^\d+\.\d+\.\d+$/.test(a)) ?? null;
if (!version) {
  console.error('Usage: pnpm update-protocol <major.minor.patch> [--publication <ens>] [--dry-run]');
  process.exit(1);
}

const groupName = `${GROUP_PREFIX}${version}`;
const versionConfigPath = path.join(CONFIG_DIR, `${version}.json`);

const l2 = createPublicClient({ chain: base, transport: http(resolveLitRpcUrl()) });
const l1 = createPublicClient({
  chain: mainnet,
  transport: http(process.env.MAINNET_RPC_URL ?? 'https://eth.llamarpc.com'),
});
const adminHex = adminHash(PROTOCOL_SAFE_ADDRESS) as `0x${string}`;
const admin = BigInt(adminHex);

// ── Facts ───────────────────────────────────────────────────────────────────
//
// Each read answers "is this already true" and nothing else. A read that cannot
// answer is an error, not a "no": converging on a guess is how a version gets
// created twice.

async function groupId(): Promise<bigint | null> {
  const groups = await l2.readContract({
    address: ACCOUNT_CONFIG_ADDRESS,
    abi: viewsFacetAbi,
    functionName: 'listGroups',
    args: [admin, 0n, 100n],
  });
  const found = groups.filter((g) => g.name === groupName);
  if (found.length > 1) {
    throw new Error(
      `group ${groupName} exists ${found.length} times (ids ${found.map((g) => g.id).join(', ')}) — remove the duplicates with \`pnpm actions:remove-group <id>\` first`,
    );
  }
  return found[0] ? BigInt(found[0].id) : null;
}

async function documentFiled(): Promise<boolean> {
  return l2.readContract({
    address: MANIFEST_MODULE_ADDRESS,
    abi: MANIFEST_ABI,
    functionName: 'versionExists',
    args: [version!],
  });
}

async function publicationPin(
  publication: string,
): Promise<{ records: `0x${string}`; pinned: string }> {
  const safe = await l1.readContract({
    address: ENS_NAMEWRAPPER as `0x${string}`,
    abi: NAME_WRAPPER_ABI,
    functionName: 'ownerOf',
    args: [BigInt(namehash(publication))],
  });
  const records = await l2.readContract({
    address: PUBLICATION_FACTORY,
    abi: FACTORY_ABI,
    functionName: 'moduleAddress',
    args: [safe, S2S_MODULE_KIND_RECORDS as `0x${string}`],
  });
  const pinned = await l2
    .readContract({
      address: records,
      abi: RECORDS_ABI,
      functionName: 'getRecord',
      args: [MANIFEST_VERSION_KEY],
    })
    .catch(() => '');
  return { records, pinned };
}

// ── Steps ───────────────────────────────────────────────────────────────────

/**
 * Rebuild `src/shared` and the action bundles before anything is pinned. A CID is
 * content addressed, so this cannot disturb a version that is already filed, and
 * it closes the one way a stale `src/shared/dist` reached the chain: pinning a
 * bundle from the last build rather than from this tree.
 */
function buildBundles(): void {
  execSync('pnpm actions:build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

/**
 * The CIDs an earlier run of this version recorded, when it recorded all seven.
 * A version is pinned once: after that the record is what the document names, and
 * rebuilding would only re-derive the same CIDs.
 */
function recordedActions(): Array<{ name: string; cid: string; hashedCid: string }> | null {
  if (!fs.existsSync(versionConfigPath)) return null;
  const recorded = loadLitConfig(versionConfigPath).groups[0]?.actions ?? [];
  return recorded.length === ACTIONS.length ? recorded : null;
}

/**
 * Pin every bundle and return the CIDs. Only a version without a record reaches
 * this: it builds first, so a CID can only be the one this tree produces.
 */
async function pinActions(): Promise<Array<{ name: string; cid: string; hashedCid: string }>> {
  const lit = new LitService({ environment: 'prod' });
  const ipfs = isDryRun()
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
    if (!fs.existsSync(file)) throw new Error(`${file} is missing after the build`);
    const compact = compactAction(fs.readFileSync(file, 'utf-8'));
    const computed = await lit.getActionCid(compact);
    const cid = ipfs ? await ipfs.uploadToPinata(compact, name) : computed;
    if (cid !== computed) throw new Error(`pinata returned ${cid} for ${name}, computed ${computed}`);
    pinned.push({ name, cid, hashedCid: actionHash(cid) });
    console.log(`  ${name.padEnd(16)} ${cid}`);
  }
  return pinned;
}

function inheritedTransfer(): { pkp: string; usageKey: string; groupIds: number[] } {
  if (!fs.existsSync(PREVIOUS_CONFIG)) throw new Error(`no ${PREVIOUS_CONFIG} to inherit the PKP from`);
  const config = loadLitConfig(PREVIOUS_CONFIG);
  const group = config.groups[0];
  const pkp = flag('--pkp') ?? group?.pkps[0];
  const usageKey = flag('--usage-key') ?? process.env.VITE_LIT_USAGE_KEY ?? group?.usage_key;
  if (!pkp || !usageKey) throw new Error('no PKP or usage key: pass --pkp and --usage-key');
  return { pkp, usageKey, groupIds: config.groups.map((g) => g.id) };
}

/**
 * The id `addGroup` would hand out, asked of the facet itself. Counting the
 * groups that exist answers highest + 1, which is wrong as soon as one has been
 * removed: the facet keeps counting, so the batch would address a group that
 * never gets created. The simulation is a read, so nothing is signed or written,
 * and a revert here names the reason instead of becoming a GS013 days later.
 */
async function simulatedGroupId(args: {
  cidHashes: `0x${string}`[];
  pkpIds: `0x${string}`[];
  description: string;
}): Promise<bigint> {
  try {
    const id = await l2.readContract({
      address: ACCOUNT_CONFIG_ADDRESS,
      abi: writesFacetAbi,
      functionName: 'addGroup',
      args: [admin, groupName, args.description, args.cidHashes, args.pkpIds],
      account: PROTOCOL_SAFE_ADDRESS,
    } as any);
    return BigInt(id as bigint);
  } catch (error: any) {
    throw new Error(
      `addGroup(\"${groupName}\") reverts as ${PROTOCOL_SAFE_ADDRESS}: ${error.shortMessage ?? error.message}`,
    );
  }
}

/**
 * The id to address in the batch: take the highest group id + 1 and increment
 * while that id is taken, then let the facet confirm it. A removed group can leave
 * its id occupied in the counter while `listGroups` no longer shows it, so counting and
 * asking answer differently; the facet wins, and the difference is printed.
 */
async function nextGroupId(args: {
  cidHashes: `0x${string}`[];
  pkpIds: `0x${string}`[];
  description: string;
}): Promise<bigint> {
  const groups = (await l2.readContract({
    address: ACCOUNT_CONFIG_ADDRESS,
    abi: viewsFacetAbi,
    functionName: 'listGroups',
    args: [admin, 0n, 100n],
  } as any)) as ReadonlyArray<{ id: bigint }>;

  const taken = new Set(groups.map((g) => g.id));
  let candidate = groups.reduce((max, g) => (g.id > max ? g.id : max), 0n) + 1n;
  while (taken.has(candidate)) candidate += 1n;

  const simulated = await simulatedGroupId(args);
  if (simulated !== candidate) {
    console.log(`  group id     ${candidate} by count, ${simulated} from the facet — using ${simulated}`);
  }
  return simulated;
}

/**
 * `addAction` for every bundle, asked of the facet before the batch is proposed.
 * These calls do not depend on the group, so a revert here is the same revert the
 * Safe would report as a bare GS013.
 */
async function assertActionsAddable(
  actions: Array<{ name: string; hashedCid: string }>,
): Promise<void> {
  for (const action of actions) {
    try {
      await l2.readContract({
        address: ACCOUNT_CONFIG_ADDRESS,
        abi: writesFacetAbi,
        functionName: 'addAction',
        args: [admin, action.name, action.name, BigInt(action.hashedCid)],
        account: PROTOCOL_SAFE_ADDRESS,
      } as any);
    } catch (error: any) {
      throw new Error(
        `addAction(${action.name}) reverts as ${PROTOCOL_SAFE_ADDRESS}: ${error.shortMessage ?? error.message}`,
      );
    }
  }
  console.log('  addAction    all seven answer without a revert');
}

/**
 * The group that a version's next build needs: the same PKP and the same usage
 * key, widened to the new group, no removals.
 */
async function proposeGroup(actions: Array<{ name: string; cid: string; hashedCid: string }>) {
  const { pkp, usageKey, groupIds } = inheritedTransfer();
  const predicted = await nextGroupId({
    description: `${groupName} — manifest ${version}`,
    cidHashes: actions.map((a) => a.hashedCid as `0x${string}`),
    pkpIds: [pkp as `0x${string}`],
  });
  const scopes = [...new Set([...groupIds, Number(predicted)])];
  await assertActionsAddable(actions);

  const transactions = buildSafeBatch(
    [
      encodeAddGroup({
        apiKeyHash: adminHex,
        name: groupName,
        description: `${groupName} — manifest ${version}`,
        cidHashes: actions.map((a) => a.hashedCid as `0x${string}`),
        pkpIds: [pkp as `0x${string}`],
      }),
      ...actions.flatMap((a) => [
        encodeAddAction({
          apiKeyHash: adminHex,
          name: a.name,
          description: a.name,
          actionHash: a.hashedCid as `0x${string}`,
        }),
        encodeAddActionToGroup({
          apiKeyHash: adminHex,
          groupId: predicted,
          action: a.hashedCid as `0x${string}`,
        }),
      ]),
      encodeAddPkpToGroup({
        apiKeyHash: adminHex,
        groupId: predicted,
        pkpId: pkp as `0x${string}`,
      }),
      encodeSetUsageApiKey({
        apiKeyHash: adminHex,
        usageApiKeyHash: usageHash(usageKey),
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

  const record: Omit<GroupRecord, 'safeTxHash'> = {
    version: version!,
    groups: [
      { name: groupName, id: Number(predicted), actions, pkps: [pkp], usage_key: usageKey },
    ],
  };
  console.log(`\n=== group ${groupName} (predicted id ${predicted}, ${transactions.length} calls) ===`);
  console.log(prettyPrintBatch(transactions));
  return { transactions, predicted, record };
}

/** Written once the proposal exists, as the record of what it pinned. Never read back. */
function recordProposal(record: Omit<GroupRecord, 'safeTxHash'>, safeTxHash: string): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const file: GroupRecord = { ...record, safeTxHash };
  saveLitConfig(versionConfigPath, file);
}

/** The document: the module's current one with `version` and the CIDs replaced. */
async function documentJson(actions: Array<{ name: string; cid: string }>): Promise<string> {
  const [, json] = await l2.readContract({
    address: MANIFEST_MODULE_ADDRESS,
    abi: MANIFEST_ABI,
    functionName: 'getManifest',
  });
  const current = JSON.parse(json) as Record<string, unknown>;
  return JSON.stringify({
    ...current,
    version,
    litActions: Object.fromEntries(
      actions.map((a) => [a.name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), a.cid]),
    ),
  });
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const publication = flag('--publication') ?? process.env.TEST_PUBLICATION ?? null;
  console.log(`version ${version}`);
  const pinned = recordedActions();
  if (!pinned) buildBundles();

  const [bound, filed] = await Promise.all([groupId(), documentFiled()]);
  const pin = publication ? await publicationPin(publication) : null;

  console.log(
    `  bundles    ${pinned ? `already pinned, ${pinned.length} CIDs from the record` : 'built from this tree'}`,
  );
  console.log(`  group      ${bound === null ? 'absent' : `id ${bound}`}`);
  console.log(`  document   ${filed ? 'filed' : 'absent'}`);
  if (pin) console.log(`  ${publication} pin ${pin.pinned || '(none)'}`);

  const actions = pinned ?? (await pinActions());

  if (bound === null) {
    console.log('\nactions:');
    const { transactions, predicted, record } = await proposeGroup(actions);
    if (isDryRun()) return console.log('\ndry-run: STOPPING before proposing.');
    const { safeTxHash } = await propose({
      transactions,
      what: `group ${groupName} (predicted id ${predicted})`,
    });
    recordProposal(record, safeTxHash);
    return next(`approve ${safeTxHash}, then re-run to file the document`);
  }

  if (!filed) {
    const json = await documentJson(actions);
    const data = encodeFunctionData({
      abi: MANIFEST_ABI,
      functionName: 'setManifest',
      args: [version!, json],
    });
    const transactions = buildSafeBatch(
      [{ functionName: 'setManifest', args: [version, json], data }],
      MANIFEST_MODULE_ADDRESS,
    );
    console.log(`\n=== document ${version} (${json.length} bytes) ===`);
    console.log(json);
    if (isDryRun()) return console.log('\ndry-run: STOPPING before proposing.');
    const { safeTxHash } = await propose({
      transactions,
      what: `setManifest(${version})`,
    });
    return next(`approve ${safeTxHash}, then re-run to pin the publication`);
  }

  if (pin && pin.pinned !== version) {
    const data = encodeFunctionData({
      abi: RECORDS_ABI,
      functionName: 'setRecord',
      args: [MANIFEST_VERSION_KEY, version!],
    });
    console.log(`\n${publication} pins ${pin.pinned || 'nothing'}; it needs ${version}.`);
    console.log(`  to     ${pin.records}`);
    console.log(`  data   ${data}`);
    console.log(`\nThis Safe is not the protocol Safe, so the signer here cannot propose it.`);
    console.log(`Settle it in the Safe app for that publication's owners.`);
    return;
  }

  console.log(`\nnothing to propose: ${version} is group ${bound}, filed, and pinned where asked.`);
}

/** The chain's view of the Safe, to compare with the nonce the batch took. */
async function explainProposeFailure(): Promise<void> {
  const nonce = await l2.readContract({
    address: PROTOCOL_SAFE_ADDRESS as `0x${string}`,
    abi: SAFE_ABI,
    functionName: 'nonce',
  });
  console.log(`  safe nonce on chain: ${nonce}`);
  try {
    const response = await fetch(
      `${TX_SERVICE}/safes/${PROTOCOL_SAFE_ADDRESS}/multisig-transactions/?executed=false&limit=20`,
      { headers: { Accept: 'application/json' } },
    );
    const body = (await response.json()) as { results?: Array<Record<string, any>> };
    const rows = body.results ?? [];
    console.log(`  queued at the service: ${rows.length}`);
    for (const row of rows) {
      const selector = String(row.data ?? '').slice(0, 10);
      console.log(`    nonce ${row.nonce}  ${row.safeTxHash}  ${selector}`);
    }
  } catch (error: any) {
    console.log(`  could not read the queue: ${error.shortMessage ?? error.message}`);
  }
}

/**
 * Propose the batch and print what the service answered. api-kit throws away the
 * body of a 422 and keeps the status text, which names nothing; this asks the same
 * endpoint with the same body and keeps the answer.
 */
async function propose(opts: {
  transactions: ReturnType<typeof buildSafeBatch>;
  what: string;
}): Promise<{ safeTxHash: string }> {
  const privateKey = requireProtocolPrivateKey();
  const protocolKit = await Safe.init({
    provider: resolveLitRpcUrl(),
    signer: privateKey,
    safeAddress: PROTOCOL_SAFE_ADDRESS,
  });
  const transaction = await protocolKit.createTransaction({ transactions: opts.transactions });
  const safeTxHash = await protocolKit.getTransactionHash(transaction);
  const signature = await protocolKit.signHash(safeTxHash);
  const sender = privateKeyToAccount(privateKey).address;

  const { nonce, to, value, data, operation } = transaction.data;
  console.log(
    `\n  proposing nonce ${nonce}, ${to}, operation ${operation}, ${String(data).length / 2 - 1} bytes`,
  );

  const response = await fetch(`${TX_SERVICE}/safes/${PROTOCOL_SAFE_ADDRESS}/multisig-transactions/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      ...transaction.data,
      contractTransactionHash: safeTxHash,
      sender,
      signature: signature.data,
    }),
  });
  const answer = await response.text();
  if (!response.ok) {
    await explainProposeFailure();
    throw new Error(`
      the Safe service refused nonce ${nonce} with ${response.status}:\n      ${answer.slice(0, 600)}
    `);
  }

  console.log(`\nproposed ${opts.what}: ${safeTxHash}`);
  return { safeTxHash };
}

function next(instruction: string): void {
  console.log(`\nnext: ${instruction}.`);
}

main().catch((error: any) => {
  console.error(error);
  process.exitCode = 1;
});
