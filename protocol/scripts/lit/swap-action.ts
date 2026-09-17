import { LitService, encryptAction, compactAction, S2SIPFSMethods } from '@s2s/soul2soul-shared';
import * as dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const groupName = 's2s';
const validActions = ['prep', 'render', 'update', 'maintain-cache', 'encrypt'];

interface ActionConfigEntry {
  name: string;
  cid: string;
  hashedCid: string;
}

/**
 * Find the previous config entry for `actionName`, if any.
 * Exported pure helper so the swap guard is unit-testable.
 */
export function findActionByName(
  actions: ActionConfigEntry[] | undefined,
  actionName: string,
): ActionConfigEntry | undefined {
  return actions?.find((a) => a.name === actionName);
}

/**
 * Best-effort removal of the previous action from the group.
 * Logs the skip reason when there is no previous entry, and logs the REAL
 * error (name + message) when the removal call fails, instead of swallowing
 * it behind a constant string. Removal failure is non-fatal: the group
 * keeps the old action and the caller still adds the new one.
 * Exported so the guard/error-logging behavior is unit-testable.
 */
export async function removePreviousAction(
  lit: Pick<LitService, 'removeActionFromGroup'>,
  groupId: number,
  oldAction: ActionConfigEntry | undefined,
  actionName: string,
): Promise<void> {
  if (!oldAction) {
    console.log(
      `removeActionFromGroup skipped: no previous '${actionName}' action in config (first deploy or post-rename) — cannot compute old hashed_cid`,
    );
    return;
  }
  try {
    await lit.removeActionFromGroup(groupId, oldAction.hashedCid);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(
      `removeActionFromGroup FAILED for group=${groupId} hashed_cid=${oldAction.hashedCid}: ${message}`,
    );
  }
}

export async function main() {
  // Emulate __dirname in ES modules
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  dotenv.config({ path: '../.env' });

  const configPath = path.join(__dirname, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  const action_name = process.argv[2];
  if (!action_name || !validActions.includes(action_name)) {
    console.error(`Usage: pnpm swap-action <action_name>`);
    console.error(`Valid actions: ${validActions.join(', ')}`);
    process.exit(1);
  }

  const actionPath = `./protocol/actions/dist/${action_name}/main.js`;
  const code = fs.readFileSync(actionPath, 'utf-8');

  const ipfs = new S2SIPFSMethods(
    process.env.IPFS_URL!,
    process.env.PINATA_JWT!,
    process.env.PINATA_GATEWAY!,
    process.env.VITE_FILEBASE_TOKEN || '',
  );

  const lit = new LitService({
    environment: 'prod',
    accountKey: process.env.LIT_ACCOUNT_KEY!,
  });

  const groupIndex = config.groups.findIndex((g: any) => g.name === groupName);

  const _action = compactAction(code);

  const [cid] = await Promise.all([lit.getActionCid(_action)]);

  const pinnedCid = await ipfs.uploadToPinata(_action, action_name);
  let check = cid == pinnedCid;
  if (!check) console.log(cid, pinnedCid);

  const [result] = await Promise.all([lit.registerAction(cid, action_name)]);

  const oldAction = findActionByName(config.groups[groupIndex].actions, action_name);

  await removePreviousAction(lit, config.groups[groupIndex].id, oldAction, action_name);

  await lit.addActionToGroup(config.groups[groupIndex].id, cid);

  // Update the action entry in config
  const actionIndex = config.groups[groupIndex].actions.findIndex(
    (a: any) => a.name === action_name,
  );
  if (actionIndex !== -1) {
    config.groups[groupIndex].actions[actionIndex] = {
      ...config.groups[groupIndex].actions[actionIndex],
      cid,
      hashedCid: result.hashedCid,
    };
  } else {
    config.groups[groupIndex].actions.push({
      name: action_name,
      cid,
      hashedCid: result.hashedCid,
    });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  console.log('FINISHED');
}

// Only run the CLI entry point when this module is executed directly
// (not when imported by tests).
function isDirectRun(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectRun()) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => {
      process.exit(0);
    });
}
