/**
 * Mirror engine — traverses an IPFS tree and downloads every leaf to disk.
 *
 * Primitive choice: **`ls` (IPFS links listing)** + recursive traversal with
 * `cat` for leaf content.
 *
 * Rationale:
 * - `ls` returns typed links (dir vs file) without loading the full DAG node,
 *   making it efficient for deep trees.
 * - `dag/get` is heavier and unpacks full dag-pb nodes into JSON, which is
 *   useful when you need the DAG structure but wasteful for simple traversal.
 * - `get` does a single-call recursive dump but does not give us the
 *   incremental control needed for concurrency-limited downloads.
 * - `ls` + `cat` gives us a clear split: list links first, then download
 *   leaves with bounded concurrency. This handles arbitrary unixFS trees
 *   including those with sharded directories.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { KuboClient, type KuboLink } from './ipfs/kubo.js';

export interface MirrorState {
  rootCid: string;
  files: number;
  refreshedAt: string | null;
  error: string | null;
}

export interface RefreshResult {
  rootCid: string;
  files: number;
  durationMs: number;
  refreshedAt: string;
}

const WEBCONTENT_DIR = 'webcontent';
const STAGING_DIR = '.staging';

/**
 * Map an IPFS path to a local filesystem path.
 * - Root entry ('') → index.html
 * - All other paths preserved as-is
 */
export function mapPath(ipfsPath: string): string {
  if (!ipfsPath || ipfsPath === '') return 'index.html';
  return ipfsPath;
}

/**
 * Mirror engine: traverses an IPFS DAG and downloads all leaf files.
 */
export class Mirror {
  private readonly kubo: KuboClient;
  private readonly webRoot: string;
  private state: MirrorState;

  constructor(kubo: KuboClient, webRoot: string = WEBCONTENT_DIR) {
    this.kubo = kubo;
    this.webRoot = webRoot;
    this.state = {
      rootCid: '',
      files: 0,
      refreshedAt: null,
      error: null,
    };
  }

  getState(): MirrorState {
    return { ...this.state };
  }

  /**
   * Perform a full refresh: resolve root CID → traverse → download → atomic swap.
   */
  async refresh(rootCid: string, concurrency = 10): Promise<RefreshResult> {
    const start = Date.now();

    this.state.error = null;

    // Ensure webRoot and staging dir exist
    const stagingDir = path.join(this.webRoot, STAGING_DIR);
    const targetDir = path.join(this.webRoot, 'current');

    await fsp.mkdir(stagingDir, { recursive: true });

    // Traverse and download
    const fileCount = await this.downloadTree(rootCid, '', stagingDir, concurrency);

    // If fileCount is 0, we didn't actually download anything — keep previous state
    if (fileCount === 0) {
      this.state.error = 'No files downloaded from IPFS tree';
      throw new Error('No files downloaded from IPFS tree');
    }

    // Atomic swap: rename staging → current, then remove old current
    const oldDir = path.join(this.webRoot, 'old');
    // Remove old backup if exists
    try { await fsp.rm(oldDir, { recursive: true, force: true }); } catch { /* ignore */ }
    // Rename current → old (if exists)
    try { await fsp.rename(targetDir, oldDir); } catch { /* first time, no current dir */ }
    // Rename staging → current
    try { await fsp.rename(stagingDir, targetDir); } catch (err) {
      // Rollback: try to restore old
      try { await fsp.rename(oldDir, targetDir); } catch { /* best effort */ }
      this.state.error = `Atomic swap failed: ${err}`;
      throw err;
    }
    // Clean up old
    try { await fsp.rm(oldDir, { recursive: true, force: true }); } catch { /* ignore */ }

    const now = new Date().toISOString();
    this.state = {
      rootCid,
      files: fileCount,
      refreshedAt: now,
      error: null,
    };

    return {
      rootCid,
      files: fileCount,
      durationMs: Date.now() - start,
      refreshedAt: now,
    };
  }

  /**
   * Recursively traverse and download an IPFS tree into a local directory.
   * Returns the number of files downloaded.
   */
  private async downloadTree(
    cid: string,
    prefix: string,
    destDir: string,
    concurrency: number,
  ): Promise<number> {
    let fileCount = 0;

    // List links via /api/v0/ls
    let links: KuboLink[];
    try {
      const lsResult = await this.kubo.ls(cid);
      links = lsResult.Objects?.[0]?.Links || [];
    } catch {
      // If ls fails, try treating this CID as a single file leaf
      await this.downloadLeaf(cid, prefix, destDir);
      return 1;
    }

    if (links.length === 0) {
      // No links — it's a file leaf
      await this.downloadLeaf(cid, prefix, destDir);
      return 1;
    }

    // Separate directories and files
    const dirs: KuboLink[] = [];
    const files: KuboLink[] = [];

    for (const link of links) {
      // In IPFS ls, directories usually have Tsize = 0 (or very small)
      // Files have real sizes. This is heuristic but works for unixFS.
      if (link.Tsize === 0 || link.Name.endsWith('/')) {
        dirs.push(link);
      } else {
        files.push(link);
      }
    }

    // Download files with concurrency limit.
    // Use link.Name only (not the full prefix path) because destDir already
    // reflects the directory nesting from the traversal.
    const fileDownloadTasks = files.map((link) => async () => {
      const childCid = link.Hash['/'];
      await this.downloadLeaf(childCid, link.Name, destDir);
    });

    await runWithLimit(fileDownloadTasks, concurrency);

    fileCount += files.length;

    // Recurse into directories
    for (const link of dirs) {
      const childCid = link.Hash['/'];
      const childPrefix = prefix ? `${prefix}/${link.Name}` : link.Name;
      const childDest = path.join(destDir, link.Name);
      await fsp.mkdir(childDest, { recursive: true });
      fileCount += await this.downloadTree(childCid, childPrefix, childDest, concurrency);
    }

    return fileCount;
  }

  /**
   * Download a single leaf file and write it to disk.
   */
  private async downloadLeaf(cid: string, ipfsPath: string, destDir: string): Promise<void> {
    const filename = mapPath(ipfsPath);
    // If the ipfsPath ends with /, append index.html (implicit dir index)
    const finalName = ipfsPath.endsWith('/') ? `${filename}index.html` : filename;
    const localPath = path.join(destDir, finalName);

    // Ensure parent directory exists
    await fsp.mkdir(path.dirname(localPath), { recursive: true });

    // Download bytes
    const bytes = await this.kubo.catBytes(cid);

    // Write to disk
    await fsp.writeFile(localPath, Buffer.from(bytes));
  }
}

/**
 * Run async tasks with a concurrency limit.
 */
async function runWithLimit(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  const results: Promise<void>[] = [];
  const executing = new Set<Promise<void>>();

  for (const task of tasks) {
    const p = task().finally(() => executing.delete(p));
    executing.add(p);
    results.push(p);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(results);
}
