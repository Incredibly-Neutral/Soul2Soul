import { LitService, encryptAction, compactAction, S2SIPFSMethods } from '@s2s/soul2soul-shared';
import * as dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

// Emulate __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: '../.env' });

const configPath = path.join(__dirname, 'config.json');

console.log(configPath);
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const groupName = 's2s';
const action_name = 'updateEvm';
const actionPath = `/home/joera/code/s2s/protocol/actions/dist/${action_name}/main.js`;
const code = fs.readFileSync(actionPath, 'utf-8');

const ipfs = new S2SIPFSMethods(
  process.env.IPFS_URL!,
  process.env.PINATA_JWT!,
  process.env.PINATA_GATEWAY!,
  process.env.VITE_FILEBASE_TOKEN || '',
);

async function main(action_name: string, code: string) {
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

  const r = await lit.addActionToGroup(config.groups[groupIndex].id, cid);

  console.log('registered', r);

  config.groups[groupIndex].actions.push({
    name: action_name,
    cid,
    hashedCid: result.hashedCid,
  });

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  console.log('FINISHED');
}

main(action_name, code)
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(0);
  });
