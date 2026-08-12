// config-builder.ts — canonical ConfigBuilder
// Replaces both safe-app/src/lib/config-builder.ts and the old shared S2SConfigBuilder.
// D1-D4 resolved: no import.meta.env, no hardcoded IPFS_URL, all IPFS through S2SIPFSMethods.

import type { S2SIPFSMethods } from "../ipfs";
import type { S2SPublicationConfig } from "./types";

/**
 * Upper bound on the publication-supplied template-helper source size in
 * characters, mirrored from the render-time cap (protocol renderer
 * helpers.ts: TEMPLATE_HELPERS_SOURCE_SIZE_CAP = 64 * 1024). This build-time
 * check is an advisory fail-fast for a clearly-broken source; the render
 * action remains the authoritative gate.
 */
const HELPERS_SOURCE_SIZE_CAP = 64 * 1024;

/** File name a publication-owner supplies for their template-helper module. */
const HELPERS_SOURCE_FILENAME = "helpers.source";

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

  /**
   * Locate a publication-supplied template-helper module in the repo.
   *
   * Resolution order:
   *   1. the repo ROOT `helpers.source` (canonical — level with mapping.json,
   *      a config-level publication artifact);
   *   2. `fixtures/helpers.source` (legacy fallback, the website-starter-style
   *      dev-kit layout), found by recursively listing the `fixtures/` dir.
   *
   * Returns `null` when neither exists (clean no-op — the config is built
   * without a helpersCid and the render action degrades to built-ins only).
   * A missing `fixtures/` directory (GitHub 404) is treated as "no fixtures",
   * not an error.
   */
  private async findHelpersSource(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<GitHubFile | null> {
    // Canonical location: the repo ROOT, level with mapping.json — a
    // config-level publication artifact, not a dev fixture.
    try {
      const rootFiles = await this.getGitHubFiles(owner, repo, branch, "");
      const rootHelper = rootFiles.find(
        (f) => f.type === "file" && f.path === HELPERS_SOURCE_FILENAME,
      );
      if (rootHelper) return rootHelper;
    } catch {
      // Root listing failed — treat as no helper source.
    }

    // Legacy fallback: the dev-kit fixtures path (website-starter-style layout).
    try {
      const fixturesFiles = await this.getAllFilesRecursive(
        owner,
        repo,
        branch,
        "fixtures",
      );
      const fixturesHelper = fixturesFiles.find(
        (f) =>
          f.type === "file" &&
          f.path.split("/").pop() === HELPERS_SOURCE_FILENAME,
      );
      if (fixturesHelper) return fixturesHelper;
    } catch {
      // `fixtures/` may not exist in the repo — fall through to no helper.
    }

    return null;
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
      // console.log("existing", existingConfigCid);
      try {
        config = await this.ipfs.fetchFromKubo(existingConfigCid);
      } catch (error) {
        console.warn("Could not load existing config, creating new one");
      }
    }

    // Initialize config sections
    config.templates = config.templates || [];

    // --- Process templates (from templates/ directory in GitHub) ---
    // console.log("Processing templates...");
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
      // console.log(`✅ Template uploaded: ${template.path} -> ${cid}`);
    }

    // --- Upload templates DAG ---
    const templatesCid = await this.ipfs.dagPut(
      JSON.stringify(config.templates),
      "templates.json",
    );
    console.log("[config-builder] templates dagPut CID:", templatesCid);

    // --- Fetch mapping.json at the pinned commit SHA ---
    const commitSHA = await this.getLatestCommitSHA(
      github_account,
      repo,
      branch,
    );
    const mappingUrl = `https://raw.githubusercontent.com/${github_account}/${repo}/${commitSHA}/mapping.json`;
    const mappingContent = await this.fetchGitHubFile(mappingUrl);
    const mapping = JSON.parse(mappingContent);

    // --- Capture a publication-supplied template-helper module, if present ---
    // The render action reads the helper source at render time and evaluates it
    // VERBATIM (no newline-stripping / unescaping, unlike templates), so the raw
    // text is stored as-is. `config.helpersCid` is the SOLE source for
    // publication helpers at render time — there is no on-chain record fallback
    // (renderer helpers.ts). Render-time validation remains the authoritative
    // gate; the checks below are an advisory build-time fail-fast for a
    // clearly-broken source.
    let helpersCid: string | undefined;
    const helpersFile = await this.findHelpersSource(
      github_account,
      repo,
      branch,
    );
    if (helpersFile) {
      const helpersSource = await this.fetchGitHubFile(
        helpersFile.download_url,
      );
      if (!helpersSource || helpersSource.length === 0) {
        throw new Error(
          `Template helpers source found (${helpersFile.path}) but is empty; ` +
            "refusing to build a config with a broken helper module. " +
            "Remove the file or supply a valid pure-expression module.",
        );
      }
      if (helpersSource.length > HELPERS_SOURCE_SIZE_CAP) {
        throw new Error(
          `Template helpers source (${helpersFile.path}) exceeds size cap ` +
            `(${helpersSource.length} > ${HELPERS_SOURCE_SIZE_CAP} chars = 64 KiB); ` +
            "shrink the helper module. Render-time validation is the authoritative gate.",
        );
      }
      // Build-time advisory fail-fast: the source must parse as a bare pure-JS
      // expression (e.g. `({ reverse: (s) => ... })`). A statement (`const x = 1;`),
      // a trailing semicolon, or an unbalanced brace is a red flag well before
      // render. Render-time validation remains the authoritative gate.
      try {
        // eslint-disable-next-line no-new-func
        new Function(`return (${helpersSource});`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Template helpers source (${helpersFile.path}) is not a valid bare ` +
            `pure-JS expression: ${reason}. It must be a bare expression ` +
            `(e.g. ({ reverse: (s) => ... })) with no trailing semicolon. ` +
            "Render-time validation is the authoritative gate.",
        );
      }
      // REAL add on the same Kubo the render catFile's against, so the CID is
      // pinned and retrievable at render time. Mirrored to Pinata following
      // the config dual-write pattern below.
      helpersCid = await this.ipfs.addToKubo(
        helpersSource,
        HELPERS_SOURCE_FILENAME,
      );
      await this.ipfs.uploadToPinata(helpersSource, HELPERS_SOURCE_FILENAME);
      console.log(
        `[config-builder] helpers.source uploaded: ${helpersFile.path} -> ${helpersCid}`,
      );
    }

    // --- Build final config ---
    const finalConfig: S2SPublicationConfig = {
      assetsCid,
      contract: contractAddress,
      dataGateway: this.ipfs.gateway,
      mapping,
      name: publicationName,
      templateCid: templatesCid,
      ...(helpersCid ? { helpersCid } : {}),
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