import { App, TFile, parseFrontMatterTags } from "obsidian";
import { slugify } from "../utils.js";
import { dagPut } from "./remotekubo.service.js";
import { IpldPod } from "src/types/ipld.js";

const ipfs_endpoint = "https://ipfs.transport-union.dev";

export const podToDag = async (app: App, folderPath: string) : Promise<string> => {

    return new Promise ( async (resolve, reject) => {

        const pod : IpldPod = {
            "Links" : []
        };

        for (const file of app.vault.getFiles()) {
            if (file.path.startsWith(folderPath + '/')) {    
                const note = await formatNote(app, file);
                const cid = await dagPut(note, ipfs_endpoint);
                console.log(cid);
                pod.Links.push({
                    "/" : cid
                })
            }
        }

        resolve(await dagPut(pod, ipfs_endpoint));
    });
}


export const formatNote = async (app: App, file: TFile) => {

   let content = await app.vault.read(file);
   let note : {[key:string]:any} = {};

   for (let [key,value] of Object.entries(await parseFrontMatter(app,file))) {
        note[key] = value
   }

   note.title = file.basename;
   note.slug = slugify(file.basename);
   note.path = file.path;
   note.body = isolateBody(content);

   return note
}

export const parseFrontMatter = async (app: App, file: TFile) : Promise<{[key:string]:any}> => {

    return new Promise ( async (resolve,reject) => {
        await app.fileManager.processFrontMatter(file, (frontmatter) => {
            resolve(frontmatter)
        });
    });
}

export const isolateBody = (content: string) => {
   
    const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
    const match = content.match(frontmatterRegex);

    if (match) {
        const body = content.slice(match[0].length).trim();
        return body;
    } else {
        return content
    }
}