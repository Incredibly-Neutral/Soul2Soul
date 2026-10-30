import { singleFileFormDataFromPath } from "./formdata.js";
//@ts-ignore
import electron from 'electron.js';
const net = electron.remote.net;


export const pinFile = async (path: any): Promise<string> => {

    return new Promise( async (resolve,reject) => {

        const formData = await singleFileFormDataFromPath(path);

        const headers = {
            'Content-Type': `multipart/form-data; boundary=${formData.getBoundary()}`,
        }

        const request = net.request({
            method: 'POST',
            protocol: 'https:',
            hostname: 'nft.autonomous-times.com',
            path: '/api/v0/add',
            headers
        });

      //  formData.pipe(request);

        request.on('response', (response: any) => {

            response.on('data', (chunk: any) => {
                const a = chunk.toString().split('\n');
                console.log(a);
                let parsnip = JSON.parse(a[0]);
                console.log(parsnip)
                resolve(parsnip["Hash"]);
            });
        });
        request.on('error', (error: any) => {
            console.log(`ERROR: ${JSON.stringify(error)}`)
            reject();
        });
        request.write(await formData.buffer());
        request.end();
    });
};