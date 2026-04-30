import { S2SPublication } from "@s2s/soul2soul-shared";
import { requestUrl } from "obsidian";

// export const getFilesFromGithub = async (publication: S2SPublication, folder: string) : Promise<any[]> => {

//     //const branch = 'main';

//     const r = publication.devRepository?.split("/");

//     if (!r) {
//         return Promise.resolve([]);
//     }

//     const profile = r[r.length - 2];
//     const repo = r[r.length - 1];

//     console.log("R", r, profile, repo, r.length)

//     const commit_sha = await getLatestCommitSHA(publication);
//     const GITHUB_API_URL = `https://api.github.com/repos/${profile}/${repo}/git/trees/${commit_sha}?recursive=1`;

//     try {
//         const response = await requestUrl({
//             url: GITHUB_API_URL,
//             method: 'GET',
//             headers: { "Accept": "application/vnd.github.v3+json" }
//         });
//         const jsonData = JSON.parse(response.text);
//         // console.log(jsonData);
//         return jsonData.tree
//             .filter((file: any) => file.type === "blob")
//             .filter((file: any) => file.path.startsWith(folder + "/"))
//             .map((file: any) => ({
//                 path: file.path,
//                 url: `https://raw.githubusercontent.com/${profile}/${repo}/${commit_sha}/${file.path}`
//             }));
//     } catch (error) {
//         console.error("Error fetching folder contents:", error);
//         return Promise.resolve([]);
//     }
    
// }

  export const getGitHubFiles = async (owner: string, repo: string, branch: string, path: string = ""): Promise<any[]> => {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.statusText}`);
    }
    
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  }

export const getAllFilesRecursive = async (owner: string, repo: string, branch: string, path: string = ""): Promise<any[]>  => {
  const files = await getGitHubFiles(owner, repo, branch, path);
  let allFiles: any[] = [];
  
  for (const file of files) {
    if (file.type === 'file') {
      allFiles.push(file);
    } else if (file.type === 'dir') {
      // Recursively fetch files from subdirectories
      const subFiles = await getAllFilesRecursive(owner, repo, branch, file.path);
      allFiles = allFiles.concat(subFiles);
    }
  }
  
  return allFiles;
}


export const getLatestCommitSHA = async (publication: any) => {

    const r = publication.devRepository.split("/");
    const profile = r[r.length - 2];
    const repo = r[r.length - 1];
    const branch = publication.branch;

    const GITHUB_API_URL = `https://api.github.com/repos/${profile}/${repo}/branches/${branch}`;

    try {
        const response = await requestUrl({
            url: GITHUB_API_URL,
            method: 'GET',
            headers: { "Accept": "application/vnd.github.v3+json" }
        });
        const jsonData = JSON.parse(response.text);
        // console.log(jsonData);
        return jsonData.commit.sha;
    } catch (error) {
        console.error("Error fetching latest commit SHA:", error);
        return null;
    }
}

export const fetchFileFromGithub = async (url: string): Promise<string> => {

    try {
        const response = await requestUrl({
            url: url,
            method: 'GET',
            headers: { 
                "Accept": "text/css,text/javascript,text/html,text/plain,application/json;q=0.9,*/*;q=0.8"
            }
        });

        return response.text;
    } catch (error) {
        console.error('Error fetching file:', error);
        return "";
    }
};
