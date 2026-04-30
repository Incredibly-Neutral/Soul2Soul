import * as fs from 'fs';
//@ts-ignore
import electron from 'electron';
const net = electron.remote.net;
import FormData from 'form-data';
import { importer } from 'ipfs-unixfs-importer';
import { MemoryBlockstore } from 'blockstore-core/memory';
import { MainController } from 'src/main.ctrlr.js';

// Function to calculate IPFS hash locally
export const calculateIPFSHash = async (filePath: string): Promise<string> => {
    return new Promise(async (resolve, reject) => {
        try {
            const fileStream = fs.createReadStream(filePath);
            const chunks: Buffer[] = [];
            
            for await (const chunk of fileStream) {
                chunks.push(chunk);
            }
            
            const content = Buffer.concat(chunks);
            const blockstore = new MemoryBlockstore();
            let cid: any = null;
            for await (const { cid: entry } of importer([{ content }], blockstore)) {
                cid = entry;
            }
            if (!cid) {
                reject(new Error('Failed to generate IPFS hash - no CID was created'));
                return;
            }
            resolve(cid.toString());
        } catch (error) {
            reject(error);
        }
    });
}

export const calculateIPFSHashFromContent = async (content: string | Buffer, fileName?: string, contentType: string = 'application/octet-stream'): Promise<string> => {
    return new Promise(async (resolve, reject) => {
        try {
            const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
            
            const blocks = new MemoryBlockstore();
            let lastCid;
            for await (const { cid } of importer([{ content: buffer }], blocks)) {
                lastCid = cid;
            }
            if (!lastCid) {
                reject(new Error('Failed to generate IPFS hash'));
                return;
            }
            
            resolve(lastCid.toString());
        } catch (error) {
            reject(error);
        }
    });
}

export const upload = async(main: MainController, filePath: string, onlyHash: boolean = false): Promise<string> => {
    
    try {
        if (onlyHash) {
            return await calculateIPFSHash(filePath);
        }

        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath));

        const request = net.request({
            method: 'POST',
            url: 'https://api.pinata.cloud/pinning/pinFileToIPFS',
            headers: {
                'pinata_api_key': main.plugin.settings.pinata_api_key,
                'pinata_secret_api_key': main.plugin.settings.pinata_secret_key,
                'Content-Type': `multipart/form-data; boundary=${formData.getBoundary()}`
            }
        }); 

        return new Promise((resolve, reject) => {
            request.on('response', (response: any) => {
                console.log('Got response with status:', response.statusCode);
                let data = '';
                response.on('data', (chunk: any) => {
                    console.log('Response chunk:', chunk.toString());
                    data += chunk;
                    try {
                        const jsonResponse = JSON.parse(data);
                        if (response.statusCode === 200) {
                            resolve(jsonResponse.IpfsHash);
                        } else {
                            reject(new Error(`Failed to upload to Pinata: ${data}`));
                        }
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            request.on('error', (error: any) => {
                console.log('Request error:', error);
                reject(error);
            });

            request.write(formData);
            request.end();
        });

    } catch (error) {
        throw error;
    }
};

