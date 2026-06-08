// config-builder.ts

import { S2SPublicationConfig } from "@s2s/soul2soul-shared/safe-app";
import { add, dagPut, fetchFromIPFS } from "./ipfs.factory";
import { evmRead } from "./evm";
import { ethers } from "ethers";
import { prepareTempMfs, kuboMfsList, kuboMfsPost, MFS_TIMEOUTS, IPFS_URL, kuboMfsStat } from "./ipfs-fs.factory";

// Kubo IPFS URL for MFS operations



interface GitHubFile {
  path: string;
  url: string;
  download_url: string;
  type: string;
}

export class AssetsBuilder {
  private ensAddress: string;
  private pinataJWT: string;
  private pinataGateway: string;
  private ipfsGateway: string;

  constructor(
    ensRecords: string,
    pinataJWT: string,
    pinataGateway: string = "https://neutralpress.mypinata.cloud",
    ipfsGateway: string = "https://ipfs.transport-union.dev"
  ) {
    this.ensAddress = ensRecords;
    this.pinataJWT = pinataJWT;
    this.pinataGateway = pinataGateway;
    this.ipfsGateway = ipfsGateway;
  }

  // Parse GitHub URL to get owner, repo, branch
  parseGitHubUrl(githubUrl: string): { owner: string; repo: string; branch: string } {
    const match = githubUrl.match(/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+))?/)
    if (!match) {
      throw new Error("Invalid GitHub URL");
    }
    return {
      owner: match[1],
      repo: match[2],
      branch: match[3] || "main"
    };
  }

  // Fetch files from GitHub directory
  async getGitHubFiles(owner: string, repo: string, branch: string, path: string = ""): Promise<GitHubFile[]> {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.statusText}`);
    }
    
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  }

  async getAllFilesRecursive(owner: string, repo: string, branch: string, path: string = ""): Promise<GitHubFile[]> {
    const files = await this.getGitHubFiles(owner, repo, branch, path);
    let allFiles: GitHubFile[] = [];
    
    for (const file of files) {
      if (file.type === 'file') {
        allFiles.push(file);
      } else if (file.type === 'dir') {
        const subFiles = await this.getAllFilesRecursive(owner, repo, branch, file.path);
        allFiles = allFiles.concat(subFiles);
      }
    }
    
    return allFiles;
  }

  // Fetch file content from GitHub
  async fetchGitHubFile(downloadUrl: string): Promise<string> {
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.statusText}`);
    }
    return await response.text();
  }

  // Get latest commit SHA
  async getLatestCommitSHA(owner: string, repo: string, branch: string): Promise<string> {
    const url = `https://api.github.com/repos/${owner}/${repo}/commits/${branch}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to get commit: ${response.statusText}`);
    }
    const data = await response.json();
    return data.sha;
  }

  // Upload file to Pinata
  async uploadToPinata(content: string | Blob, filename: string): Promise<string> {
    const formData = new FormData();
    
    if (typeof content === 'string') {
      formData.append('file', new Blob([content]), filename);
    } else {
      formData.append('file', content, filename);
    }

    const response = await fetch(`https://api.pinata.cloud/pinning/pinFileToIPFS`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.pinataJWT}`
      },
      body: formData
    });

    if (!response.ok) {
      throw new Error(`Pinata upload failed: ${response.statusText}`);
    }

    const data = await response.json();
    return data.IpfsHash;
  }

  // Upload from URL to Pinata
  async uploadFromUrl(url: string): Promise<string> {
    const response = await fetch(url);
    const blob = await response.blob();
    const filename = url.split('/').pop() || 'file';
    return await this.uploadToPinata(blob, filename);
  }

  // Insert stylesheet link into template
  insertStylesheetLink(templateContent: string, cid: string): string {
    return templateContent.replace(
      'insert_stylesheet.css',
      `${this.pinataGateway}/ipfs/${cid}?filename=styles.css`
    );
  }

  // Insert asset image CIDs into template
  insertAssetImageCids(
    templateContent: string,
    assets: Array<{ path: string; cid: string }>
  ): string {
    for (const asset of assets) {
      const filename = asset.path.split('/').pop()?.split('.')[0];
      if (!filename) continue;

      const imgRegex = new RegExp(`<img[^>]+id=["']${filename}["'][^>]*>`, 'gi');
      templateContent = templateContent.replace(imgRegex, (match) => {
        return match.replace(
          /src=["'][^"']*["']/,
          `src="${this.pinataGateway}/ipfs/${asset.cid}"`
        );
      });
    }
    return templateContent;
  }

  // Build configuration from GitHub repository
  async buildAssets(
    github_account: string,
    repo: string,
    branch: string,
    publicationName: string,
    contractAddress: string,
    existingConfigCid?: string
  ): Promise<{  cid: string }> {
    // Load existing config or create new one


    // Process assets
    console.log("Processing assets...");
    const assetFiles = await this.getAllFilesRecursive(github_account, repo, branch, 'assets');
    const node = ethers.namehash(publicationName);
    const currentRoot = await evmRead(8453, this.ensAddress, ["function getText(bytes32 node, string key) view returns (string)"], "getText", [node, "contenthash_wrapped"])

    const tempDirName = `safe-app-${Date.now()}`;
    const tmpPath = await prepareTempMfs(currentRoot || "", tempDirName);
    console.log(`Created temp MFS dir: ${tmpPath}`);

    // STEP 2: Read what files are in the assets folder
    const existingAssetsPath = `${tmpPath}/assets`;
    let existingAssetNames: string[] = [];
    let assetsPathExists = false;

    try {
      const assetsLinks = await kuboMfsList(existingAssetsPath);
      assetsPathExists = true;
      existingAssetNames = assetsLinks.map((link: any) => link.name.toLowerCase());
      console.log(`Existing assets in Kubo MFS: ${existingAssetNames.join(", ") || "(none)"}`);
    } catch (error) {
      assetsPathExists = false;
      console.log(`No assets folder in temp MFS, will create it`);
    }

    // STEP 3: If no assets folder, create it
    if (!assetsPathExists) {
      const mkdirRes = await kuboMfsPost(
        `/api/v0/files/mkdir?arg=${encodeURIComponent(existingAssetsPath)}&parents=true`,
        MFS_TIMEOUTS.mkdir,
      );
      if (!mkdirRes.ok) {
        const text = await mkdirRes.text();
        console.warn(`Failed to create assets folder: ${text}`);
      } else {
        assetsPathExists = true;
        existingAssetNames = [];
        console.log(`Created new assets folder: ${existingAssetsPath}`);
      }
    }

    // STEP 4: For each asset, check if it exists in Kubo, add if missing
    for (const asset of assetFiles) {
      const assetName = asset.path?.split('/').pop() || '';
      const assetNameLower = assetName.toLowerCase();

      // Check if this asset already exists in the Kubo node's assets folder
      if (existingAssetNames.includes(assetNameLower)) {
        console.log(`✓ Asset already exists, skipping: ${assetName}`);
        continue;
      }

      // Fetch the asset content from GitHub
      console.log(`Fetching asset: ${assetName} from GitHub`);
      const assetContent = await this.fetchGitHubFile(asset.download_url);

      // Step 1: Create the file in IPFS locally via api/v0/add
      const formData = new FormData();
      formData.append('file', new Blob([assetContent]), assetName);

      const addRes = await fetch(`${IPFS_URL}/api/v0/add`, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(MFS_TIMEOUTS.pinAdd),
      });

      if (!addRes.ok) {
        const text = await addRes.text();
        console.error(`Failed to add asset to IPFS: ${assetName}`, text);
        continue;
      }
      const addResult = await addRes.json();
      const fileCid = addResult.Hash || addResult.Cid?.['/'] || addResult.Cid;
      if (!fileCid) {
        console.error(`Failed to get CID for asset: ${assetName}`);
        continue;
      }

      // Step 2: Copy the IPFS object into MFS at the target path
      const cpPath = `${existingAssetsPath}/${assetName}`;
      const cpRes = await kuboMfsPost(
        `/api/v0/files/cp?arg=/ipfs/${encodeURIComponent(fileCid)}&arg=${encodeURIComponent(cpPath)}&parents=true&flush=false`,
        MFS_TIMEOUTS.cp,
      );
      if (!cpRes.ok) {
        const text = await cpRes.text();
        console.error(`Failed to copy asset to MFS: ${assetName}`, text);
        continue;
      }

      console.log(`✓ Synced asset to MFS: ${assetName} → /ipfs/${fileCid}`);

      // Track it
      existingAssetNames.push(assetNameLower);
    }

    console.log(`Assets sync complete. Existing+new assets: ${existingAssetNames.join(", ")}`);

    // FLUSH the temp directory to get the updated root CID that includes all added assets
    const flushRes = await kuboMfsPost(
      `/api/v0/files/flush?arg=${encodeURIComponent(tmpPath)}`,
      MFS_TIMEOUTS.pinAdd,
    );
    if (!flushRes.ok) {
      const text = await flushRes.text();
      console.error(`Flush failed: ${text}`);
    }
    const flushedData = await flushRes.json();
    const newRootCid = typeof flushedData === 'string' ? flushedData : (flushedData['/'] || flushedData.Hash || flushedData.Cid?.['/'] || flushedData.Cid);
    console.log(`Flushed root CID (includes assets): ${JSON.stringify(newRootCid)}`);

    // Verify: list the flushed directory
    const verifyLinks = await kuboMfsList(tmpPath);
    console.log(`Flushed directory contains: ${verifyLinks.map(l => l.name).join(", ")}`);



    // --- Process stylesheets (from css/ directory in GitHub) ---
    console.log("Processing stylesheets...");
    const cssFiles = (await this.getAllFilesRecursive(github_account, repo, branch, 'css'))
      .filter(file => file.path.endsWith('.css'));

    for (const cssFile of cssFiles) {
    //   const cid = await this.uploadFromUrl(cssFile.download_url);
    //   const existingIndex = config.stylesheets.findIndex((s: any) => s.path === cssFile.path);
    //   if (existingIndex !== -1) {
    //     config.stylesheets[existingIndex].cid = cid;
    //   } else {
    //     config.stylesheets.push({ path: cssFile.path, cid });
    //   }
    //   console.log(`✅ Stylesheet uploaded: ${cssFile.path} -> ${cid}`);
    }


    const configCid2 = "";
    return { cid: configCid2 };
  }
}
