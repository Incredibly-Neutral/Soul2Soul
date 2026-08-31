import { LitService } from '@s2s/soul2soul-shared';
import * as dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

// Emulate __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: '../.env' });

interface GroupConfig {
  groups: {
    name: string;
    id: number;
    actions: { name: string; cid: string; hashedCid: string }[];
    pkps: string[];
    usage_key: string;
  }[];
}

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as GroupConfig;

const groupName = 's2s';

async function main() {
  const lit = new LitService({
    environment: 'prod',
    accountKey: process.env.LIT_ACCOUNT_KEY!,
  });

  const groupIndex = config.groups.findIndex((g) => g.name === groupName);
  if (groupIndex === -1) {
    throw new Error(`Group "${groupName}" not found in ${configPath}`);
  }

  const groupId = config.groups[groupIndex].id;

  console.log(`Inspecting group "${groupName}" (id ${groupId})...`);

  const info = await lit.inspectGroup(groupId);

  console.log(JSON.stringify(info, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(0);
  });
