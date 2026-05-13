
import { LitService, encryptAction, compactAction } from '@s2s/soul2soul-shared';
import * as dotenv from 'dotenv';
// import fs from 'fs';                                                                                              
// import { fileURLToPath } from 'url';                                                                              
// import path from 'path';                                                                                          
                                                                                                                    
// // Emulate __dirname in ES modules                                                                                
// const __filename = fileURLToPath(import.meta.url);                                                                
// const __dirname = path.dirname(__filename);       
 
// dotenv.config({ path: '../.env'});

// const configPath = path.join(__dirname, 'config.json');     

// console.log(configPath)
// const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));   

const groupId = 7;

async function main() {

    const lit = new LitService({ 
        "environment": "prod",
        "accountKey": process.env.LIT_ACCOUNT_KEY!
    })

    console.log(lit);

    const info  = await lit.inspectGroup(groupId);

    console.log(info)
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(0);
  });
