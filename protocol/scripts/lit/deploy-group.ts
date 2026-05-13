
import { LitService, encryptAction, compactAction } from '@s2s/soul2soul-shared';
import * as dotenv from 'dotenv';
import fs from 'fs';                                                                                              
import { fileURLToPath } from 'url';                                                                              
import path from 'path';                                                                                          
                                                                                                                    
// Emulate __dirname in ES modules                                                                                
const __filename = fileURLToPath(import.meta.url);                                                                
const __dirname = path.dirname(__filename);       
 
dotenv.config({ path: '../.env'});

const configPath = path.join(__dirname, 'config.json');     

console.log(configPath)
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));   

const groupName = 's2s';

async function main() {

    const lit = new LitService({ 
        "environment": "prod",
        "accountKey": process.env.LIT_ACCOUNT_KEY!
    })

    const _encryptAction = compactAction(encryptAction);

    const [pkpAddress, encryptCid] = await Promise.all([
        lit.createPkp(),
        lit.getActionCid(_encryptAction),
    ]);

    // Step 2: Register all actions in parallel (this returns hashed CIDs)
    const [encryptResult] = await Promise.all([
        lit.registerAction(encryptCid, 'encrypt'),
    ]);


    // Step 4: Create group with PKP and actions pre-permitted
    // Note: Need to figure out pkp_id format - might be address or internal ID
    const { group_id: groupId } = await lit.createGroup(
        groupName,
        '',
        [pkpAddress],  // pkp_ids_permitted - try with address first
        [encryptResult.hashedCid]  // cid_hashes_permitted
    );

    // Step 5: Create usage key
    const { usage_api_key } = await lit.createUsageKey({ executeInGroups: [groupId] });

    console.log("API", usage_api_key)

    const groupIndex = config.groups.findIndex(                                                                     
       (g: any) => g.name === groupName                                                       
    );    

    config.groups[groupIndex] = {

        "name": groupName,
        "id" : groupId,
        "actions": [
            {
                "name" : "encrypt",
                "cid" : encryptCid,
                "hashedCid" : encryptResult.hashedCid
            }
        ],
        "pkps": [pkpAddress],
        "usage_key": usage_api_key
    }

    console.log(config);

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); 

    console.log("FINISHED")
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(0);
  });
