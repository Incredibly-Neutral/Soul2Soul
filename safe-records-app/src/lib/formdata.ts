const fs = require('fs');
const recursive = require('recursive-fs');

import { createReadStream } from 'fs';
import * as path from 'path';
// @ts-expect-error - No type definitions available
import Multipart from './multi-part-lite-adopted/main.js';

// @ts-ignore 
import basePathConverter from 'base-path-converter';

export function directoryFormData(sourcePath: string) : Promise<any> {

    return new Promise( async (resolve, reject) => {

        fs.stat(sourcePath, async (err: any, stats:any) => {
            if (err) {
                reject(err);
            }
            if (!stats.isFile()) {


                recursive.readdirr(sourcePath, async (err: any, dirs: any, files: any) => {
                    if (err) {
                        console.log("err" + err)
                        reject(new Error(err));
                    }

                    let data = new Multipart();

                    files.forEach(async (file: any) => {
                        
                        if (!path.basename(file).startsWith('_')) {

                            // console.log("file", file);
                            // Blob is a browser-specific object used to represent raw data in the browser environment. Instead, fs.createReadStream() returns a ReadableStream object, which is a Node.js API for reading data from a stream source.
                            // For binary files like images, we should not use UTF-8 encoding
                            const ext = path.extname(file).toLowerCase();
                            const isBinaryFile = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.ico', '.tiff', '.tif'].includes(ext);
                            
                            let fileStream;
                            if (isBinaryFile) {
                                fileStream = createReadStream(file);
                            } else {
                                fileStream = createReadStream(file, { encoding: 'utf-8' });
                            }

                            const contentType = isBinaryFile ? 'image/' + ext.slice(1) : 
                                              ext === '.css' ? 'text/css' : 'text/plain'

                            //for each file stream, we need to include the correct relative file path
                            data.append('file', fileStream, {
                                'filename': basePathConverter(sourcePath, file),
                                'contentType': contentType
                            });
                        }
                    });

                    resolve({
                        formData: await data.buffer(),
                        boundary: data.getBoundary()
                    });
                });
            } 
        });
    });
}

export function singleFileFormData(filename: string, content: Buffer) : Promise<any> {

    return new Promise( async (resolve, reject) => {

        // const slug = note.slug || note.name || note.path ||"nft";

        let data = new Multipart();
        // JSON data is already text, so we can use Buffer.from
        data.append('file', content, {
            'filename': filename,
            'contentType': 'application/json'
        });

        resolve({
            formData: await data.buffer(),  // Keep as buffer for consistency
            boundary: data.getBoundary()
        })
    });
}

export function singleFileFormDataFromPath(filePath: string) : any {

    // return new Promise( async (resolve, reject) => {
        // console.log(filePath);
        let filename = filePath.split("/")[filePath.split("/").length - 1];
        const ext = path.extname(filePath).toLowerCase();
        const isBinaryFile = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.ico', '.tiff', '.tif'].includes(ext);
        
        const fileStream = fs.createReadStream(filePath, isBinaryFile ? undefined : { encoding: 'utf-8' });

        console.log("ext", ext); 
        
        const contentType = isBinaryFile ? 'image/' + ext.slice(1) : 
                          ext === '.css' ? 'text/css' : 'text/plain'

        console.log("contentType", contentType);

        let data = new Multipart({
            defaults: {
                type: contentType // Set the default type for this instance
            }
        });
        
        data.append('file', fileStream, {
            'filename': filename,
            'contentType': contentType // Explicitly set it in append as well
        });

        return data

        // resolve({
        //     formData: data,
        //     boundary: data.getBoundary()
        // })
   // });
}

export function directoryFormDataStream(sourcePath: string): Promise<any> {
    return new Promise(async (resolve, reject) => {
        try {
            const stats = await fs.promises.stat(sourcePath);


            // console.log("directoryFormData: " + sourcePath);
            
            if (!stats.isFile()) {
                recursive.readdirr(sourcePath, async (err: any, dirs: any, files: any) => {
                    if (err) {
                        console.error("Error reading directory:", err);
                        return reject(err);
                    }

                    let data = new Multipart();
                    
                    try {
                        // Process files sequentially to maintain order and prevent memory issues
                        for (const file of files) {
                            
                            if (!path.basename(file).startsWith('_')) {
                                // console.log("file", file);
                                const ext = path.extname(file).toLowerCase();
                                const isBinaryFile = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.ico', '.tiff', '.tif'].includes(ext);
                                
                                let fileStream;
                                if (isBinaryFile) {
                                    fileStream = createReadStream(file);
                                } else {
                                    fileStream = createReadStream(file, { encoding: 'utf-8' });
                                }

                                const contentType = isBinaryFile ? 'image/' + ext.slice(1) : 
                                              ext === '.css' ? 'text/css' : 'text/plain'

                                data.append('file', fileStream, {
                                    filename: basePathConverter(sourcePath, file),
                                    'contentType': contentType
                                });
                            }
                        }

                        const formData = await data.buffer();

                        // console.log("directoryFormData: " + formData);

                        resolve({
                            formData: formData,  // Return raw buffer instead of string
                            boundary: data.getBoundary()
                        });
                    } catch (error) {
                        console.error("Error processing files:", error);
                        reject(error);
                    }
                });
            } else {
                reject(new Error("Source path must be a directory"));
            }       
        } catch (error) {
            console.error("Error checking source path:", error);
            reject(error);
        }
    });
}

export async function assembleFormData(assets: any[]) : Promise<any> {

    let data = new Multipart();

    assets.forEach(async (asset: any) => {

        const ext = path.extname(asset.path).toLowerCase();
        const isBinaryFile = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.ico', '.tiff', '.tif'].includes(ext);
                            
        const contentType = isBinaryFile ? 'image/' + ext.slice(1) : 
                            ext === '.css' ? 'text/css' : 'text/plain'
        
        let fileStream;
        if (isBinaryFile) {
            fileStream = createReadStream(asset.body);
        } else {
            fileStream = createReadStream(asset.body, { encoding: 'utf-8' });
        }

        //for each file stream, we need to include the correct relative file path
        data.append('file', fileStream, {
            'filename': asset.path, // basePathConverter(asset.path),
            'contentType': contentType
        });

    })

    return({
        formData: await data.buffer(),
        boundary: data.getBoundary()
    });

}