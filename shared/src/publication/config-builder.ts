// config-builder.ts — canonical ConfigBuilder
// Replaces both safe-app/src/lib/config-builder.ts and the old shared S2SConfigBuilder.
// D1-D4 resolved: no import.meta.env, no hardcoded IPFS_URL, all IPFS through S2SIPFSMethods.

import type { S2SIPFSMethods } from '../ipfs';
import type { S2SPublicationConfig } from './types';
import { CID } from 'multiformats/cid';

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
export async function authenticatedGitHubFetch(url: string, token: string): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
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
  const match = /github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+))?/.exec(githubUrl);
  if (!match) {
    throw new Error('Invalid GitHub URL');
  }
  return {
    owner: match[1],
    repo: match[2],
    branch: match[3] || 'main',
  };
}

export class ConfigBuilder {
  private readonly ipfs: S2SIPFSMethods;
  private readonly githubToken: string;

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

  async getLatestCommitSHA(owner: string, repo: string, branch: string): Promise<string> {
    const url = `https://api.github.com/repos/${owner}/${repo}/commits/${branch}`;
    const response = await authenticatedGitHubFetch(url, this.githubToken);
    if (!response.ok) {
      throw new Error(`Failed to get commit: ${response.statusText}`);
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
    domain?: string,
    aliases?: string[],
  ): Promise<{ config: S2SPublicationConfig; cid: string }> {
    // Load existing config or create new one
    let config: any = {};
    if (existingConfigCid) {
      // console.log("existing", existingConfigCid);
      try {
        config = await this.ipfs.fetchFromKubo(existingConfigCid);
      } catch (error) {
        console.warn('Could not load existing config, creating new one');
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
      'templates',
    );

    for (const template of templateFiles) {
      if (template.type !== 'file') continue;

      let content = await this.fetchGitHubFile(template.download_url);
      content = content.replace(/\n/g, '');
      content = content.replace(/\\([^\\])/g, '$1');

      const cid = await this.ipfs.addToKubo(content, template.path.split('/').pop() || 'template');

      const existingIndex = config.templates.findIndex((t: any) => t.path === template.path);

      if (existingIndex !== -1) {
        config.templates[existingIndex].cid = cid;
        config.templates[existingIndex].body = content;
      } else {
        config.templates.push({ path: template.path, cid, body: content });
      }
      // console.log(`✅ Template uploaded: ${template.path} -> ${cid}`);
    }

    // --- Upload templates DAG ---
    // Normalize the templates array into a dag-json payload whose entries carry
    // REAL IPLD links (`{ '/': <cid> }`) derived from each entry's cid, so the
    // templates DAG traverses to the actual template files — consumed by the
    // recursive Filebase pin of templateCid (records-tab change) and by the
    // Filecoin CAR export path (dagExport of templateCid). The link is derived
    // from cid at this single point so it can never drift — including entries
    // carried forward through the existing-config merge path (where an entry's
    // cid/body may be updated in place, and any stale link from a previously
    // built config is overwritten here). An entry whose cid is NOT a valid CID
    // string gets no link: Kubo's dag-json decoder validates the link target
    // and would reject the whole payload, turning a corrupt/legacy
    // carried-forward entry into a hard publish failure. The original array is
    // left untouched (path/cid/body exactly as before).
    const templatesPayload = config.templates.map((t: any) => {
      let link: { '/': string } | undefined;
      try {
        CID.parse(t.cid);
        link = { '/': t.cid };
      } catch {
        // Invalid CID string → no link (JSON.stringify drops the undefined key).
        link = undefined;
      }
      return { ...t, link };
    });
    const templatesCid = await this.ipfs.dagPut(JSON.stringify(templatesPayload), 'templates.json');
    console.log('[config-builder] templates dagPut CID:', templatesCid);

    // --- Mirror templates DAG to Filebase + Pinata (fire-and-forget) ---
    // templateCid is a dag-cbor node; re-uploading its JSON bytes would create a
    // DIFFERENT CID, so the only way to make it (and its real IPLD links from the
    // templatesPayload above) durable on the pinning services is a recursive
    // pin-by-CID that pulls the blocks from our own kubo node — the same remote-pin
    // path neutralpress uses for the rendered site root. Mirrors the config.json
    // mirror block below. Non-blocking: pinCidRemote never throws, so a pin failure
    // can never break the publish.
    void this.ipfs.pinCidRemote(templatesCid, 'filebase')
      .then((ok) => {
        console.log(`[config-builder] templateCid ${templatesCid} pinned on filebase: ${ok}`);
      })
      .catch((err: unknown) => {
        console.warn('[config-builder] Filebase templateCid pin failed (non-fatal):', err);
      });
    void this.ipfs.pinCidRemote(templatesCid, 'pinata')
      .then((ok) => {
        console.log(`[config-builder] templateCid ${templatesCid} pinned on pinata: ${ok}`);
      })
      .catch((err: unknown) => {
        console.warn('[config-builder] Pinata templateCid pin failed (non-fatal):', err);
      });

    // --- Fetch mapping.json at the pinned commit SHA ---
    const commitSHA = await this.getLatestCommitSHA(github_account, repo, branch);
    const mappingUrl = `https://raw.githubusercontent.com/${github_account}/${repo}/${commitSHA}/mapping.json`;
    const mappingContent = await this.fetchGitHubFile(mappingUrl);
    const mapping = JSON.parse(mappingContent);

    // --- Build final config ---
    // Resolve the optional ENS write-target aliases. Precedence:
    //   1. An explicit `aliases` array override (the safe-app multi-alias path).
    //      An empty array clears ALL write-targets (restores the default
    //      subdomain write target).
    //   2. An explicit `domain` override (legacy single-target path, backward
    //      compatible — treated as a one-element alias list [domain]). An
    //      empty string clears the target.
    //   3. Carry from the existing config (if any): `aliases` (modern) wins
    //      over the legacy `domain`. A legacy domain-only existing config with
    //      no explicit override is MIGRATED to the aliases model — the rebuilt
    //      config writes `aliases: [domain]` and omits the `domain` field, so
    //      the EVM update action writes the canonical node AND the alias
    //      additively.
    //   4. Otherwise leave unset — the default subdomain write target stays
    //      unchanged (exactly today's behaviour).
    //
    // Output shape: a CARRIED domain-only existing config is MIGRATED to
    // `aliases: [domain]` (output writes `config.aliases`, no `domain` field).
    // An EXPLICIT `domain` override still writes `config.domain` (no aliases
    // field) so the EVM update action keeps treating it as a single write-node
    // override — identical to today.
    const existingConfig = config as
      | { aliases?: unknown; domain?: unknown }
      | undefined;
    const loadedAliases =
      Array.isArray(existingConfig?.aliases) &&
      (existingConfig!.aliases as unknown[]).length > 0
        ? ((existingConfig!.aliases as unknown[]).filter(
            (a) => typeof a === 'string',
          ) as string[])
        : undefined;
    const loadedDomain =
      typeof existingConfig?.domain === 'string' &&
      (existingConfig!.domain as string) !== ''
        ? (existingConfig!.domain as string)
        : undefined;

    let aliasesOut: string[] | undefined;
    let domainOut: string | undefined;

    if (aliases !== undefined) {
      // Explicit aliases array (modern path). Empty → clears all targets.
      const cleaned = aliases.filter(
        (a) => typeof a === 'string' && a.trim() !== '',
      );
      aliasesOut = cleaned.length > 0 ? [...new Set(cleaned)] : undefined;
      domainOut = undefined;
    } else if (domain !== undefined) {
      // Explicit legacy domain override (backward compatible single target).
      if (domain !== '') {
        domainOut = domain;
        aliasesOut = undefined;
      } else {
        // Empty string clears the carried target.
        domainOut = undefined;
        aliasesOut = undefined;
      }
    } else if (loadedAliases !== undefined) {
      aliasesOut = loadedAliases;
    } else if (loadedDomain !== undefined) {
      // Migration: a legacy `domain`-only existing config (no explicit
      // override) is promoted to the aliases model — the rebuilt config lists
      // the name as an alias (`aliases: [domain]`, no `domain` field), so the
      // EVM update action writes the canonical node AND the alias additively.
      aliasesOut = [loadedDomain];
    }

    const finalConfig: S2SPublicationConfig = {
      assetsCid,
      contract: contractAddress,
      dataGateway: this.ipfs.gateway,
      mapping,
      name: publicationName,
      templateCid: templatesCid,
      localePaths: mapping.localePaths,
      ...(domainOut !== undefined ? { domain: domainOut } : {}),
      ...(aliasesOut !== undefined ? { aliases: aliasesOut } : {}),
    };

    // --- Upload final config to Filebase + Pinata (fire-and-forget) + Kubo (primary) ---
    // The kubo add below is the awaited primary (its CID is what we record
    // on-chain). The pinning-service mirrors never block the publish flow —
    // they only add copies so the same CID is retrievable from more providers.
    // All three upload the identical bytes, so (content-addressed) they share
    // the same CID.
    const configJson = JSON.stringify(finalConfig);
    void this.ipfs
      .uploadToPinata(configJson, 'config.json', 'filebase')
      .catch((err: unknown) => {
        console.warn('[config-builder] Filebase mirror upload failed (non-fatal):', err);
      });
    void this.ipfs
      .uploadToPinata(configJson, 'config.json', 'pinata')
      .catch((err: unknown) => {
        console.warn('[config-builder] Pinata mirror upload failed (non-fatal):', err);
      });
    const kuboConfigCid = await this.ipfs.addToKubo(configJson, 'config.json');

    console.log(`✅ Config uploaded: ${kuboConfigCid}`);

    return { config: finalConfig, cid: kuboConfigCid };
  }
}
