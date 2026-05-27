import * as fs from 'fs';
// import { importer } from 'ipfs-unixfs-importer';
import { MemoryBlockstore } from 'blockstore-core/memory';

// Function to calculate IPFS hash locally
// export const calculateIPFSHash = async (filePath: string): Promise<string> => {
//     return new Promise(async (resolve, reject) => {
//         try {
//             const fileStream = fs.createReadStream(filePath);
//             const chunks = [];
            
//             for await (const chunk of fileStream) {
//                 chunks.push(chunk);
//             }
            
//             const content = Buffer.concat(chunks);
//             const blockstore = new MemoryBlockstore();
//             let cid: any = null;
//             for await (const { cid: entry } of importer([{ content }], blockstore)) {
//                 cid = entry;
//             }
//             if (!cid) {
//                 reject(new Error('Failed to generate IPFS hash - no CID was created'));
//                 return;
//             }
//             resolve(cid.toString());
//         } catch (error) {
//             reject(error);
//         }
//     });
// }

// export const calculateIPFSHashFromContent = async (content: string | Buffer, fileName?: string, contentType: string = 'application/octet-stream'): Promise<string> => {
//     return new Promise(async (resolve, reject) => {
//         try {
//             const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
            
//             const blocks = new MemoryBlockstore();
//             let lastCid;
//             for await (const { cid } of importer([{ content: buffer }], blocks)) {
//                 lastCid = cid;
//             }
//             if (!lastCid) {
//                 reject(new Error('Failed to generate IPFS hash'));
//                 return;
//             }
            
//             resolve(lastCid.toString());
//         } catch (error) {
//             reject(error);
//         }
//     });
// }
