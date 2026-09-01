// assets-builder.ts — canonical AssetsBuilder (MFS-based incremental asset sync)
// Moved from safe-app/src/lib/assets-builder.ts. D1-D4 resolved.

import { S2SIPFSMethods } from '../ipfs';
import { authenticatedGitHubFetch, parseGitHubUrl } from './config-builder';
import type { GitHubFile } from './config-builder';

// Top-level entries that must be reconciled file-by-file (additions + removals detected)
const SYNC_BY_FILENAME = new Set(['fonts', 'img', 'svg']);
// Top-level entries whose files are always re-fetched from GitHub (overwrite)
const ALWAYS_SYNC_FROM_GITHUB = new Set(['js', 'css']);

export class AssetsBuilder {
  private readonly ipfs: S2SIPFSMethods;
  private readonly githubToken: string;

  constructor(ipfs: S2SIPFSMethods, githubToken: string) {
    this.ipfs = ipfs;
    this.githubToken = githubToken;
  }

  parseGitHubUrl(githubUrl: string): {
    owner: string;
    repo: string;
    branch: string;
  } {
    return parseGitHubUrl(githubUrl);
  }

  async getGitHubFiles(
    owner: string,
    repo: string,
    branch: string,
    path = '',
  ): Promise<GitHubFile[]> {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
    const response = await authenticatedGitHubFetch(url, this.githubToken);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(
        `GitHub API error: ${response.status} - ${data.message || response.statusText}`,
      );
    }
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  }

  async getAllFilesRecursive(
    owner: string,
    repo: string,
    branch: string,
    path = '',
  ): Promise<GitHubFile[]> {
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
    const response = await authenticatedGitHubFetch(url, this.githubToken);
    if (!response.ok) {
      throw new Error(`Failed to get commit: ${response.statusText}`);
    }
    const data = await response.json();
    return data.sha;
  }

  async uploadToPinata(content: string | Blob, filename: string): Promise<string> {
    return this.ipfs.uploadToPinata(content, filename);
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
      `https://${this.ipfs.gateway}/ipfs/${cid}?filename=styles.css`,
    );
  }

  /** Get name→cid map for the immediate children of a directory CID via dag/get. */
  private async getDirChildren(dirCid: string): Promise<Map<string, string>> {
    const m = new Map<string, string>();
    try {
      const dag = await this.ipfs.dagGet(dirCid);
      for (const link of dag.Links || []) {
        m.set(link.Name, link.Hash['/']);
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
    configCid?: string,
  ): Promise<{ cid: string }> {
    // console.log("Processing assets...");

    // Fetch existing config to get the old assetsCid
    let existingAssetsCid: string | undefined;
    if (configCid) {
      try {
        const config = await this.ipfs.fetchFromKubo(configCid);
        existingAssetsCid = config?.assetsCid;
      } catch {
        console.log('No existing config found, starting fresh');
      }
    } else {
      console.log('No existing config found, starting fresh');
    }
    console.log(`Existing assetsCid from config: ${existingAssetsCid ?? 'none'}`);

    // Top-level name → CID from existing assets DAG
    const existingCids = new Map<string, string>();
    if (existingAssetsCid) {
      try {
        const dag = await this.ipfs.dagGet(existingAssetsCid);
        for (const link of dag.Links || []) {
          existingCids.set(link.Name, link.Hash['/']);
        }
        console.log(`Existing top-level entries: ${[...existingCids.keys()].join(', ')}`);
      } catch (e) {
        console.warn('Could not fetch existing DAG, will sync all from GitHub');
      }
    }

    const assetFiles = await this.getAllFilesRecursive(github_account, repo, branch, 'assets');
    console.log(`Found ${assetFiles.length} files in GitHub assets`);

    const githubTopLevel = new Set(
      assetFiles.map((f) => f.path.replace(/^assets\//, '').split('/')[0]),
    );
    console.log(`GitHub top-level entries: ${[...githubTopLevel].join(', ')}`);

    const tempDirName = `safe-app-${Date.now()}`;
    const tmpPath = await this.ipfs.prepareTempMfs('', tempDirName);
    // console.log(`Created temp MFS dir: ${tmpPath}`);

    const mkdirRes = await this.ipfs.kuboPost(
      `/api/v0/files/mkdir?arg=${encodeURIComponent(tmpPath)}&parents=true`,
      S2SIPFSMethods.MFS_TIMEOUTS.mkdir,
    );
    if (!mkdirRes.ok) {
      const text = await mkdirRes.text();
      if (!text.includes('already exists')) {
        console.warn(`mkdir warning: ${text}`);
      }
    }

    // For per-file dirs, preload existing children CIDs so we can restore unchanged files by name
    const childMaps = new Map<string, Map<string, string>>();
    for (const [name, cid] of existingCids) {
      if (SYNC_BY_FILENAME.has(name) && githubTopLevel.has(name)) {
        childMaps.set(name, await this.getDirChildren(cid));
        // console.log(
        //   `Preloaded ${childMaps.get(name)!.size} existing files for: ${name}`,
        // );
      }
    }

    // Restore whole-dir entries NOT handled per-file and NOT force-synced
    const restoredWhole = new Set<string>();
    for (const [name, cid] of existingCids) {
      if (!githubTopLevel.has(name)) {
        // console.log(`✗ removed (not in GitHub): ${name}`);
        continue;
      }
      if (SYNC_BY_FILENAME.has(name) || ALWAYS_SYNC_FROM_GITHUB.has(name)) {
        continue; // handled in the file loop
      }
      const destPath = `${tmpPath}/${name}`;
      const ok = await this.ipfs.mfsCp(cid, destPath);
      if (ok) {
        // console.log(`✓ restored whole dir from IPFS: ${name}`);
        restoredWhole.add(name);
      } else {
        console.error(`Failed cp from IPFS: ${name}`);
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

      if (restoredWhole.has(topLevelName)) {
        continue;
      }

      // Ensure parent dir exists
      if (parts.length > 1) {
        const parentDir = `${tmpPath}/${parts.slice(0, -1).join('/')}`;
        await this.ipfs
          .kuboPost(
            `/api/v0/files/mkdir?arg=${encodeURIComponent(parentDir)}&parents=true`,
            S2SIPFSMethods.MFS_TIMEOUTS.mkdir,
          )
          .catch(() => {});
      }

      // Per-filename dirs: if the file exists in the old child map, restore from IPFS by name
      if (SYNC_BY_FILENAME.has(topLevelName) && !ALWAYS_SYNC_FROM_GITHUB.has(ext)) {
        const childMap = childMaps.get(topLevelName);
        const existingFileCid = childMap?.get(assetName);
        if (existingFileCid) {
          const ok = await this.ipfs.mfsCp(existingFileCid, cpPath);
          if (ok) {
            // console.log(`✓ restored file from IPFS: ${relativePath}`);
            continue;
          }
          const fallback = await this.ipfs
            .kuboPost(
              `/api/v0/files/cp?arg=/ipfs/${encodeURIComponent(existingFileCid)}&arg=${encodeURIComponent(cpPath)}&parents=true&flush=false`,
              S2SIPFSMethods.MFS_TIMEOUTS.cp,
            )
            .then((r) => r.text());
          if (fallback.includes('already has entry')) {
            continue;
          }
          // fall through to GitHub
        }
      }

      // Otherwise fetch from GitHub
      // console.log(`Fetching from GitHub: ${relativePath}`);
      const assetBlob = await this.fetchGitHubBlob(asset.download_url);

      const cid = await this.ipfs.addToKubo(assetBlob, assetName);

      const cpRes = await this.ipfs.kuboPost(
        `/api/v0/files/cp?arg=/ipfs/${encodeURIComponent(cid)}&arg=${encodeURIComponent(cpPath)}&parents=true&flush=false`,
        S2SIPFSMethods.MFS_TIMEOUTS.cp,
      );

      if (!cpRes.ok) {
        const text = await cpRes.text();
        if (text.includes('already has entry')) {
          // console.log(`✓ skip (exists): ${relativePath}`);
        } else {
          console.error(`Failed cp: ${relativePath}`, text);
        }
      } else {
        // console.log(`✓ synced from GitHub: ${relativePath}`);
      }
    }

    console.log('Assets sync complete.');

    const flushRes = await this.ipfs.mfsFlush(tmpPath);
    if (!flushRes.ok) {
      console.error(`Flush failed`);
    }
    const newRootCid = flushRes.cid;
    console.log(`Flushed assets CID: ${newRootCid}`);

    return { cid: newRootCid };
  }
}
