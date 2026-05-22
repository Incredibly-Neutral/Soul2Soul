import { LitService, encryptAction, compactAction, S2SIPFSMethods } from '@s2s/soul2soul-shared';
import * as dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: '../.env'});

const configPath = path.join(__dirname, 'config.json');
console.log(configPath);
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const groupName = 's2s';
const ipfs = new S2SIPFSMethods(process.env.IPFS_URL!, process.env.PINATA_JWT!, process.env.PINATA_GATEWAY!);

const ACTION_DEFS = [
    { name: 'encrypt', source: null as string | null },  // handled separately via encryptAction
    { name: 'prep',    source: '/home/joera/code/s2s/protocol/actions/dist/prep/main.js' },
    { name: 'single',  source: '/home/joera/code/s2s/protocol/actions/dist/single/main.js' },
    { name: 'cbor',    source: '/home/joera/code/s2s/protocol/actions/dist/cbor/main.js' },
    { name: 'updateEvm',    source: '/home/joera/code/s2s/protocol/actions/dist/updateEvm/main.js' }
];

async function main() {

    const lit = new LitService({
        environment: 'prod',
        accountKey: process.env.LIT_ACCOUNT_KEY!
    });

    const pkpAddress = await lit.createPkp();

    const actions = [];

    for (const def of ACTION_DEFS) {
        const raw = def.source ? fs.readFileSync(def.source, 'utf-8') : encryptAction;
        const compacted = compactAction(raw);
        const cid = await lit.getActionCid(compacted);

        const pinnedCid = await ipfs.uploadToPinata(compacted, def.name);
        if (cid !== pinnedCid) console.warn(`CID mismatch for ${def.name}:`, cid, pinnedCid);

        const { hashedCid } = await lit.registerAction(cid, def.name);

        actions.push({ name: def.name, cid, hashedCid });
    }

    const { group_id: groupId } = await lit.createGroup(
        groupName,
        '',
        [pkpAddress],
        actions.map(a => a.hashedCid)
    );

    const { usage_api_key } = await lit.createUsageKey({ executeInGroups: [groupId] });

    console.log("API", usage_api_key);

    const groupIndex = config.groups.findIndex((g: any) => g.name === groupName);

    config.groups[groupIndex] = {
        name: groupName,
        id: groupId,
        actions,
        pkps: [pkpAddress],
        usage_key: usage_api_key
    };

    console.log(config);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log("FINISHED");
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        process.exit(0);
    });