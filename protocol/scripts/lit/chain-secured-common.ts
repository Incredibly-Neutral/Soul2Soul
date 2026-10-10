/**
 * chain-secured-common.ts — shared helpers for the ChainSecured Lit scripts
 * (deploy-group / swap-action / add-action / remove-action).
 */
import { ACCOUNT_CONFIG_DIAMOND, type ActionDef } from '@s2s/soul2soul-shared';
import * as dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); // <repo>/protocol/scripts/lit

dotenv.config({ path: '../.env' });

export const configPath = path.join(__dirname, 'config.json');
export const pendingPath = path.join(__dirname, 'config.pending.json');

/**
 * The ChainSecured account's on-chain admin — the protocol Safe.
 * PROTOCOL_SAFE_ADDRESS must equal 0x24936f87442673B7c057BF3f5dCCB726baF20c6B.
 */
export const SAFE_ADDRESS: string =
  process.env.PROTOCOL_SAFE_ADDRESS ?? '0x24936f87442673B7c057BF3f5dCCB726baF20c6B';

/** Base RPC used for verification / simulation / receipt reads (nullable). */
export function resolveRpcUrl(): string | null {
  return (
    process.env.BASE_RPC_URL ||
    (process.env.VITE_DRPC_API_KEY
      ? `https://lb.drpc.live/base/${process.env.VITE_DRPC_API_KEY}`
      : null) ||
    null
  );
}

export function isDryRun(argv: string[]): boolean {
  return argv.includes('--dry-run') || process.env.LIT_DRY_RUN === '1';
}

export interface GroupConfig {
  groups: {
    name: string;
    id: number;
    actions: { name: string; cid: string; hashedCid: string }[];
    pkps: string[];
    usage_key: string;
  }[];
}

export function loadConfig(): GroupConfig {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as GroupConfig;
}

export function findGroup(config: GroupConfig, groupName: string) {
  const group = config.groups.find((g) => g.name === groupName);
  if (!group) throw new Error(`Group "${groupName}" not found in ${configPath}`);
  return group;
}

/** The 5 actions currently in config.json — reuse their pinned CIDs verbatim. */
export function actionDefsFromConfig(groupName: string): ActionDef[] {
  const group = findGroup(loadConfig(), groupName);
  return group.actions.map((a) => ({
    name: a.name,
    cid: a.cid,
    hashedCid: BigInt(a.hashedCid),
    description: a.name,
  }));
}

export function writeConfig(config: GroupConfig): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function printEnvInstructions(usageKey: string, pkpAddress: string): void {
  console.log('\n── .env instructions ────────────────────────────────────────────');
  console.log(`VITE_LIT_USAGE_KEY=${usageKey}   # new chain-secured usage key`);
  console.log(
    'LIT_ACCOUNT_KEY                # OBSOLETE for this account — chain-secured accounts have no account key; remove from .env',
  );
  console.log(`PROTOCOL_SAFE_ADDRESS=${SAFE_ADDRESS}  # unchanged`);
  console.log('──────────────────────────────────────────────────────────────────');
}

export function printRunbookReminder(): void {
  console.log('\n── Next steps ────────────────────────────────────────────────────');
  console.log(
    '1. Open the Safe UI and confirm the proposed Safe transaction (owners must approve).',
  );
  console.log(
    '2. After execution, re-run the protocol records update so on-chain records point at',
  );
  console.log('   the new group / PKP / action CIDs:');
  console.log('     tsx --require dotenv/config protocol/scripts/lit/update-protocol.ts');
  console.log('   (it reads the new values from config.json and proposes its own Safe batch).');
  console.log('──────────────────────────────────────────────────────────────────');
}

export function requirePrivateKey(): string {
  const key = process.env.PROTOCOL_PRIVATE_KEY;
  if (!key) {
    throw new Error('PROTOCOL_PRIVATE_KEY is required to propose the Safe batch (set it in .env).');
  }
  return key;
}

export const diamondAddress = ACCOUNT_CONFIG_DIAMOND;
