// config-builder.ts

import { fetchFromIPFS } from "./ipfs.factory";
import { prepareTempMfs, kuboMfsList, kuboMfsPost, MFS_TIMEOUTS, IPFS_URL, kuboMfsStat } from "./ipfs-fs.factory";

interface GitHubFile {
  path: string;
  url: string;
  download_url: string;
  type: string;
}

// Top-level entries that must be reconciled file-by-file (additions + removals detected)
const SYNC_BY_FILENAME = new Set(['fonts', 'img', 'svg']);
// Top-level entries whose files are always re-fetched from GitHub (overwrite)
const ALWAYS_SYNC_FROM_GITHUB = new Set(['js', 'css']);

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

  async getGitHubFiles(owner: string, repo: string, branch: string, path: string = ""): Promise<GitHubFile[]> {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${import.meta.env.VITE_GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
      }
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(`GitHub API error: ${response.status} - ${(data as any).message || response.statusText}`);
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

  async fetchGitHubFile(downloadUrl: string): Promise<string> {
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.statusText}`);
    }
    return await response.text();
  }

  async fetchGitHubBlob(downloadUrl: string): Promise<Blob> {
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.statusText}`);
    }
    return await response.blob();
  }

  async getLatestCommitSHA(owner: string, repo: string, branch: string): Promise<string> {
    const url = `https://api.github.com/repos/${owner}/${repo}/commits/${branch}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to get commit: ${response.statusText}`);
    }
    const data = await response.json();
    return data.sha;
  }

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

  async uploadFromUrl(url: string): Promise<string> {
    const response = await fetch(url);
    const blob = await response.blob();
    const filename = url.split('/').pop() || 'file';
    return await this.uploadToPinata(blob, filename);
  }

  insertStylesheetLink(templateContent: string, cid: string): string {
    return templateContent.replace(
      'insert_stylesheet.css',
      `${this.pinataGateway}/ipfs/${cid}?filename=styles.css`
    );
  }

  // Get name -> cid map for the immediate children of a directory CID
  private async getDirChildren(dirCid: string): Promise<Map<string, string>> {
    const m = new Map<string, string>();
    try {
      const res = await fetch(`${IPFS_URL}/api/v0/dag/get?arg=${dirCid}`, { method: "POST" });
      const dag = await res.json();
      for (const link of dag.Links || []) {
        m.set(link.Name, link.Hash["/"]);
      }
    } catch (e) {
      console.warn(`Could not read children of ${dirCid}`);
    }
    return m;
  }

  async buildAssets(
    github_account: string,
    repo: string,
    branch: string,
    publicationName: string,
    contractAddress: string,
    configCid: string
  ): Promise<{ cid: string }> {

    console.log("Processing assets...");

    const config = await fetchFromIPFS("https://ipfs.transport-union.dev", configCid);
    const existingAssetsCid: string | undefined = config?.assetsCid;
    console.log(`Existing assetsCid from config: ${existingAssetsCid ?? 'none'}`);

    // Top-level name -> CID from existing assets DAG
    const existingCids: Map<string, string> = new Map();
    if (existingAssetsCid) {
      try {
        const dagRes = await fetch(`${IPFS_URL}/api/v0/dag/get?arg=${existingAssetsCid}`, { method: "POST" });
        const dag = await dagRes.json();
        for (const link of dag.Links || []) {
          existingCids.set(link.Name, link.Hash["/"]);
        }
        console.log(`Existing top-level entries: ${[...existingCids.keys()].join(", ")}`);
      } catch (e) {
        console.warn("Could not fetch existing DAG, will sync all from GitHub");
      }
    }

    const assetFiles = await this.getAllFilesRecursive(github_account, repo, branch, 'assets');
    console.log(`Found ${assetFiles.length} files in GitHub assets`);

    const githubTopLevel = new Set(
      assetFiles.map(f => f.path.replace(/^assets\//, '').split('/')[0])
    );
    console.log(`GitHub top-level entries: ${[...githubTopLevel].join(", ")}`);

    const tempDirName = `safe-app-${Date.now()}`;
    const tmpPath = await prepareTempMfs("", tempDirName);
    console.log(`Created temp MFS dir: ${tmpPath}`);

    const mkdirRes = await kuboMfsPost(
      `/api/v0/files/mkdir?arg=${encodeURIComponent(tmpPath)}&parents=true`,
      MFS_TIMEOUTS.mkdir,
    );
    if (!mkdirRes.ok) {
      const text = await mkdirRes.text();
      if (!text.includes("already exists")) {
        console.warn(`mkdir warning: ${text}`);
      }
    }

    // For per-file dirs, preload the existing children CIDs so we can restore unchanged files by name
    const childMaps: Map<string, Map<string, string>> = new Map();
    for (const [name, cid] of existingCids) {
      if (SYNC_BY_FILENAME.has(name) && githubTopLevel.has(name)) {
        childMaps.set(name, await this.getDirChildren(cid));
        console.log(`Preloaded ${childMaps.get(name)!.size} existing files for: ${name}`);
      }
    }

    // Restore loop — only whole-dir restore for entries NOT handled per-file and NOT force-synced
    const restoredWhole: Set<string> = new Set();
    for (const [name, cid] of existingCids) {
      if (!githubTopLevel.has(name)) {
        console.log(`✗ removed (not in GitHub): ${name}`);
        continue;
      }
      if (SYNC_BY_FILENAME.has(name) || ALWAYS_SYNC_FROM_GITHUB.has(name)) {
        continue; // handled in the file loop
      }
      const destPath = `${tmpPath}/${name}`;
      const cpRes = await kuboMfsPost(
        `/api/v0/files/cp?arg=/ipfs/${encodeURIComponent(cid)}&arg=${encodeURIComponent(destPath)}&parents=true&flush=false`,
        MFS_TIMEOUTS.cp,
      );
      if (cpRes.ok) {
        console.log(`✓ restored whole dir from IPFS: ${name}`);
        restoredWhole.add(name);
      } else {
        const text = await cpRes.text();
        if (!text.includes("already has entry")) {
          console.error(`Failed cp from IPFS: ${name}`, text);
        }
      }
    }

    // File loop
    for (const asset of assetFiles) {
      const relativePath = asset.path.replace(/^assets\//, '');
      const parts = relativePath.split('/');
      const topLevelName = parts[0];
      const assetName = parts[parts.length - 1];
      const ext = assetName.split('.').pop()?.toLowerCase() ?? '';
      const cpPath = `${tmpPath}/${relativePath}`;

      // Skip files whose whole dir was already restored from IPFS
      if (restoredWhole.has(topLevelName)) {
        continue;
      }

      // Ensure parent dir exists
      if (parts.length > 1) {
        const parentDir = `${tmpPath}/${parts.slice(0, -1).join('/')}`;
        await kuboMfsPost(
          `/api/v0/files/mkdir?arg=${encodeURIComponent(parentDir)}&parents=true`,
          MFS_TIMEOUTS.mkdir,
        ).catch(() => {});
      }

      // Per-filename dirs: if the file already exists in the old child map, restore from IPFS by name
      if (SYNC_BY_FILENAME.has(topLevelName) && !ALWAYS_SYNC_FROM_GITHUB.has(ext)) {
        const childMap = childMaps.get(topLevelName);
        const existingFileCid = childMap?.get(assetName);
        if (existingFileCid) {
          const cpRes = await kuboMfsPost(
            `/api/v0/files/cp?arg=/ipfs/${encodeURIComponent(existingFileCid)}&arg=${encodeURIComponent(cpPath)}&parents=true&flush=false`,
            MFS_TIMEOUTS.cp,
          );
          if (cpRes.ok) {
            console.log(`✓ restored file from IPFS: ${relativePath}`);
            continue;
          }
          const text = await cpRes.text();
          if (!text.includes("already has entry")) {
            console.error(`Failed cp file from IPFS: ${relativePath}`, text);
          } else {
            continue;
          }
          // fall through to GitHub if cp failed unexpectedly
        }
      }

      // Otherwise fetch from GitHub
      console.log(`Fetching from GitHub: ${relativePath}`);
      const assetBlob = await this.fetchGitHubBlob(asset.download_url);

      const formData = new FormData();
      formData.append('file', assetBlob, assetName);   // raw bytes, no corruption

      const addRes = await fetch(`${IPFS_URL}/api/v0/add`, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(MFS_TIMEOUTS.pinAdd),
      });

      if (!addRes.ok) {
        const text = await addRes.text();
        console.error(`Failed to add to IPFS: ${relativePath}`, text);
        continue;
      }

      const addResult = await addRes.json();
      const fileCid = addResult.Hash || addResult.Cid?.['/'] || addResult.Cid;
      if (!fileCid) {
        console.error(`No CID returned for: ${relativePath}`);
        continue;
      }

      const cpRes = await kuboMfsPost(
        `/api/v0/files/cp?arg=/ipfs/${encodeURIComponent(fileCid)}&arg=${encodeURIComponent(cpPath)}&parents=true&flush=false`,
        MFS_TIMEOUTS.cp,
      );

      if (!cpRes.ok) {
        const text = await cpRes.text();
        if (text.includes("already has entry")) {
          console.log(`✓ skip (exists): ${relativePath}`);
        } else {
          console.error(`Failed cp: ${relativePath}`, text);
        }
      } else {
        console.log(`✓ synced from GitHub: ${relativePath}`);
      }
    }

    console.log(`Assets sync complete.`);

    const flushRes = await kuboMfsPost(
      `/api/v0/files/flush?arg=${encodeURIComponent(tmpPath)}`,
      MFS_TIMEOUTS.pinAdd,
    );
    if (!flushRes.ok) {
      const text = await flushRes.text();
      console.error(`Flush failed: ${text}`);
    }
    const flushedData = await flushRes.json();
    const newRootCid = typeof flushedData === 'string'
      ? flushedData
      : (flushedData['/'] || flushedData.Hash || flushedData.Cid?.['/'] || flushedData.Cid);
    console.log(`Flushed assets CID: ${JSON.stringify(newRootCid)}`);

    return { cid: newRootCid };
  }
}