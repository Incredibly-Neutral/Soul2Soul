// import { calculateIPFSHash, calculateIPFSHashFromContent } from "./pinata.factory";
import * as fs from 'fs';

import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import {PinataSDK } from "pinata-web3";
import { CID } from 'multiformats/cid';



export class PinataService  {

    pinata: PinataSDK;

    constructor(pinataJwt: string, assetsGateway: string) {
        this.pinata = new PinataSDK({
            pinataJwt: pinataJwt,
            pinataGateway: assetsGateway
        });
    }



    uploadFileFromPath = async (filePath: string, onlyHash: boolean = false) => {

        // if (onlyHash) {
        //     const hash = await calculateIPFSHash(filePath);
        //         const v0 = CID.parse(hash);
        //         return v0.toV1().toString();
        // }

        const fileName = path.basename(filePath);
        const fileExt = path.extname(filePath).toLowerCase();

        // console.log("fileName", fileName);

        let contentType = 'text/plain';
        switch (fileExt) {
            case '.css':
                contentType = 'text/css';
                break;
            case '.jpg':
            case '.jpeg':
                contentType = 'image/jpeg';
                break;
            case '.png':
                contentType = 'image/png';
                break;
            case '.gif':
                contentType = 'image/gif';
                break;
        }

        console.log("contentType", contentType);

        try {

          const fileContent = fs.readFileSync(filePath);
          const blob = new Blob([fileContent], { type: contentType });
          const file = new File([blob], fileName, { type: contentType });
          const upload = await this.pinata.upload.file(file);
          return upload.IpfsHash;
      
        } catch (error) {
          console.log(error);
          return "QmUrU11u74YrLbj9d1Z9JvPPZ2nXmgMVTgh2ZvjrTUc4ZQ";
        }
    }

    async fetchUrl(url: string): Promise<{ data: Buffer; contentType?: string }> {
        return new Promise((resolve, reject) => {
            const protocol = url.startsWith('https:') ? https : http;
            
            // For GitHub CSS files, we need to set proper headers
            const options: any = {};
            if (url.includes('raw.githubusercontent.com') && url.endsWith('.css')) {
                options.headers = {
                    'Accept': 'text/css,*/*;q=0.1',  // Prefer CSS content type
                    'User-Agent': 'Mozilla/5.0'  // GitHub requires a user agent
                };
            }
            
            const request = protocol.get(url, options, (response: any) => {
                const contentType = response.headers['content-type'];
                const chunks: Buffer[] = [];

                response.on('data', (chunk: Buffer) => {
                    chunks.push(chunk);
                });

                response.on('end', () => {
                    const data = Buffer.concat(chunks);
                    
                    // For GitHub raw content, if it's a CSS file but served as text/plain,
                    // override the content type
                    let finalContentType = contentType;
                    if (url.includes('raw.githubusercontent.com') && 
                        url.endsWith('.css') && 
                        contentType?.includes('text/plain')) {
                        finalContentType = 'text/css';
                    }
                    
                    resolve({ data, contentType: finalContentType });
                });

                response.on('error', (error: any) => {
                    reject(error);
                });
            });

            request.on('error', (error: any) => {
                reject(error);
            });

            // Add timeout to prevent hanging
            request.setTimeout(30000, () => {
                request.destroy();
                reject(new Error('Request timed out after 30 seconds'));
            });
        });
    }

    getContentType(fileExt: string, mimeType?: string): string {
        // Get content type based on file extension
        const getExtensionType = (ext: string): string => {
            switch (ext.toLowerCase()) {
                case '.css':
                    return 'text/css';
                case '.jpg':
                case '.jpeg':
                    return 'image/jpeg';
                case '.png':
                    return 'image/png';
                case '.gif':
                    return 'image/gif';
                case '.svg':
                    return 'image/svg+xml';
                case '.webp':
                    return 'image/webp';
                case '.html':
                    return 'text/html';
                case '.js':
                    return 'application/javascript';
                case '.json':
                    return 'application/json';
                case '.txt':
                    return 'text/plain';
                default:
                    return 'application/octet-stream';
            }
        };

        const extensionType = getExtensionType(fileExt);
        
        // If we have a file extension type, use that instead of mimeType
        if (extensionType !== 'application/octet-stream') {
            return extensionType;
        }

        // If no specific extension type, fallback to mimeType or default
        return mimeType || 'application/octet-stream';
    }

    async uploadFileFromUrl(url: string, onlyHash: boolean = false): Promise<string> {

        try {
            const { data, contentType: responseMimeType } = await this.fetchUrl(url);

            console.log("responseMimeType:", responseMimeType);

            const fileName = path.basename(url);
            const fileExt = path.extname(url).toLowerCase();
            console.log("fileExt:", fileExt);
            const contentType = this.getContentType(fileExt, responseMimeType);
            

            // if (onlyHash) {
            //     // console.log("onlyHash data length:", data.length);
            //     const hash = await calculateIPFSHashFromContent(data, fileName, contentType);
            //     const v0 = CID.parse(hash);
            //     return v0.toV1().toString();
            // }

            console.log("uploading with contentType:", contentType);

            // console.log("upload data length:", data.length);
            const file = new File([new Uint8Array(data)], fileName, { type: contentType });
            // console.log("upload file size:", file.size);
            const upload = await this.pinata.upload.file(file);
            console.log("cid from upload:", upload.IpfsHash);
            return upload.IpfsHash;
          
        } catch (error) {
            console.error('Error uploading file from URL:', error);
            throw error; // Better to throw than return a hardcoded CID
        }
    }

    async uploadFileFromContent(filePath: string, data: string, onlyHash: boolean = false): Promise<string> {
        try {
            // if (onlyHash) {
            //     console.log("onlyHash data length:", data.length);
            //     const hash = await calculateIPFSHashFromContent(data);
            //     const v0 = CID.parse(hash);
            //     return v0.toV1().toString();
            // }

            console.log("upload data length:", data.length);
            const fileName = path.basename(filePath);
            const fileExt = path.extname(fileName).toLowerCase();
            const contentType = this.getContentType(fileExt);
            console.log("contentType before upload:", contentType);
            const file = new File([data], fileName, { type: contentType });
            console.log("upload file size:", file.size);
            const upload = await this.pinata.upload.file(file);
            return upload.IpfsHash;

        } catch (error) {
            console.error('Error uploading file from content:', error);
            throw error; // Better to throw than return a hardcoded CID
        }
    }
}