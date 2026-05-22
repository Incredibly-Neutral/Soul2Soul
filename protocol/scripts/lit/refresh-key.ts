
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

   
    const groupIndex = config.groups.findIndex(                                                                     
       (g: any) => g.name === groupName                                                       
    );    

    const groupId = config.groups[groupIndex].id


    // Step 5: Create usage key
    const { usage_api_key } = await lit.createUsageKey({ executeInGroups: [groupId] });

    console.log("API", usage_api_key)

    config.groups[groupIndex]["usage_key"] = usage_api_key;

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
