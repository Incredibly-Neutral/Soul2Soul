// config-builder.ts — canonical ConfigBuilder
// Replaces both safe-app/src/lib/config-builder.ts and the old shared S2SConfigBuilder.
// D1-D4 resolved: no import.meta.env, no hardcoded IPFS_URL, all IPFS through S2SIPFSMethods.

import type { S2SIPFSMethods } from "../ipfs";
import type { S2SPublicationConfig } from "./types";

export interface GitHubFile {
  path: string;
  url: string;
  download_url: string;
  type: string;
}

/**
 * Helper: fetch from the GitHub API with the configured token.
 * Used by both ConfigBuilder and AssetsBuilder.
 */
export async function authenticatedGitHubFetch(
  url: string,
  token: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const response = await fetch(url, {
    headers,
  });
  return response;
}

/**
 * Parse a GitHub URL (github.com/owner/repo or github.com/owner/repo/tree/branch)
 * into owner, repo name, and branch. The canonical parser for the codebase.
 */
export function parseGitHubUrl(githubUrl: string): {
  owner: string;
  repo: string;
  branch: string;
} {
  const match = githubUrl.match(
    /github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+))?/,
  );
  if (!match) {
    throw new Error("Invalid GitHub URL");
  }
  return {
    owner: match[1],
    repo: match[2],
    branch: match[3] || "main",
  };
}

export class ConfigBuilder {
  private ipfs: S2SIPFSMethods;
  private githubToken: string;

  constructor(ipfs: S2SIPFSMethods, githubToken: string) {
    this.ipfs = ipfs;
    this.githubToken = githubToken;
  }

  /** Parse GitHub URL to get owner, repo, branch. */
  static parseGitHubUrl(githubUrl: string): {
    owner: string;
    repo: string;
    branch: string;
  } {
    return parseGitHubUrl(githubUrl);
  }

  // =========================================================================
  // GitHub API helpers
  // =========================================================================

  async getGitHubFiles(
    owner: string,
    repo: string,
    branch: string,
    path: string = "",
  ): Promise<GitHubFile[]> {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
    const response = await authenticatedGitHubFetch(url, this.githubToken);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(
        `GitHub API error: ${response.status} - ${(data as any).message || response.statusText}`,
      );
    }
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  }

  async getAllFilesRecursive(
    owner: string,
    repo: string,
    branch: string,
    path: string = "",
  ): Promise<GitHubFile[]> {
    const files = await this.getGitHubFiles(owner, repo, branch, path);
    let allFiles: GitHubFile[] = [];

    for (const file of files) {
      if (file.type === "file") {
        allFiles.push(file);
      } else if (file.type === "dir") {
        const subFiles = await this.getAllFilesRecursive(
          owner,
          repo,
          branch,
          file.path,
        );
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

  async getLatestCommitSHA(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<string> {
    const url = `https://api.github.com/repos/${owner}/${repo}/commits/${branch}`;
    const response = await authenticatedGitHubFetch(url, this.githubToken);
    if (!response.ok) {
      throw new Error(
        `Failed to get commit: ${response.statusText}`,
      );
    }
    const data = await response.json();
    return data.sha;
  }

  // =========================================================================
  // Config building
  // =========================================================================

  async buildConfig(
    github_account: string,
    repo: string,
    branch: string,
    publicationName: string,
    contractAddress: string,
    assetsCid: string,
    existingConfigCid?: string,
  ): Promise<{ config: S2SPublicationConfig; cid: string }> {
    // Load existing config or create new one
    let config: any = {};
    if (existingConfigCid) {
      console.log("existing", existingConfigCid);
      try {
        config = await this.ipfs.fetchFromKubo(existingConfigCid);
      } catch (error) {
        console.warn("Could not load existing config, creating new one");
      }
    }

    // Initialize config sections
    config.templates = config.templates || [];

    // --- Process templates (from templates/ directory in GitHub) ---
    console.log("Processing templates...");
    const templateFiles = await this.getAllFilesRecursive(
      github_account,
      repo,
      branch,
      "templates",
    );

    for (const template of templateFiles) {
      if (template.type !== "file") continue;

      let content = await this.fetchGitHubFile(template.download_url);
      content = content.replace(/\n/g, "");
      content = content.replace(/\\([^\\])/g, "$1");

      const cid = await this.ipfs.addToKubo(
        content,
        template.path.split("/").pop() || "template",
      );

      const existingIndex = config.templates.findIndex(
        (t: any) => t.path === template.path,
      );

      if (existingIndex !== -1) {
        config.templates[existingIndex].cid = cid;
        config.templates[existingIndex].body = content;
      } else {
        config.templates.push({ path: template.path, cid, body: content });
      }
      console.log(`✅ Template uploaded: ${template.path} -> ${cid}`);
    }

    // --- Upload templates DAG ---
    const templatesCid = await this.ipfs.dagPut(
      JSON.stringify(config.templates),
      "templates.json",
    );

    // --- Fetch mapping.json at the pinned commit SHA ---
    const commitSHA = await this.getLatestCommitSHA(
      github_account,
      repo,
      branch,
    );
    const mappingUrl = `https://raw.githubusercontent.com/${github_account}/${repo}/${commitSHA}/mapping.json`;
    const mappingContent = await this.fetchGitHubFile(mappingUrl);
    const mapping = JSON.parse(mappingContent);

    // --- Build final config ---
    const finalConfig: S2SPublicationConfig = {
      assetsCid,
      contract: contractAddress,
      dataGateway: this.ipfs.gateway,
      mapping,
      name: publicationName,
      templateCid: templatesCid,
    };

    // --- Upload final config to both Pinata + Kubo ---
    // (Dual-write preserves both CDNs; return the kubo CID for on-chain records)
    await this.ipfs.uploadToPinata(
      JSON.stringify(finalConfig),
      "config.json",
    );
    const kuboConfigCid = await this.ipfs.addToKubo(
      JSON.stringify(finalConfig),
      "config.json",
    );

    console.log(`✅ Config uploaded: ${kuboConfigCid}`);

    return { config: finalConfig, cid: kuboConfigCid };
  }
}