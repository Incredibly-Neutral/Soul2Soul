// config-builder.ts

import { S2SPublicationConfig } from "@s2s/soul2soul-shared";
import { add, dagPut, fetchFromIPFS } from "./ipfs.factory";



interface GitHubFile {
  path: string;
  url: string;
  download_url: string;
  type: string;
}

export class ConfigBuilder {
  private pinataJWT: string;
  private pinataGateway: string;
  private ipfsGateway: string;

  constructor(
    pinataJWT: string,
    pinataGateway: string = "https://neutralpress.mypinata.cloud",
    ipfsGateway: string = "https://ipfs.transport-union.dev"
  ) {
    this.pinataJWT = pinataJWT;
    this.pinataGateway = pinataGateway;
    this.ipfsGateway = ipfsGateway;
  }

  // Parse GitHub URL to get owner, repo, branch
  parseGitHubUrl(githubUrl: string): { owner: string; repo: string; branch: string } {
    // Supports: https://github.com/owner/repo or https://github.com/owner/repo/tree/branch
    const match = githubUrl.match(/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+))?/);
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
        // Recursively fetch files from subdirectories
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
  async buildConfig(
    github_account: string,
    repo: string,
    branch: string,
    // commit: string,
    publicationName: string,
    contractAddress: string,
    existingConfigCid?: string
  ): Promise<{ config: S2SPublicationConfig; cid: string }> {
    // Load existing config or create new one
    let config: any = {};
    if (existingConfigCid) {

        console.log("existing", existingConfigCid)
      try {
        config = await fetchFromIPFS(this.ipfsGateway, existingConfigCid);
      } catch (error) {
        console.warn("Could not load existing config, creating new one");
      }
    }

    console.log("existing config", config)

    // Initialize config sections
    config.assets = config.assets || [];
    config.stylesheets = config.stylesheets || [];
    config.templates = config.templates || [];

    // Process assets
    console.log("Processing assets...");
    const assetFiles = await this.getAllFilesRecursive(github_account, repo, branch, 'assets');
    // const existingAssetCids = config.assets.map((a: any) => a.cid);

    // stat the assets folder on the ipfs tree 

    for (const asset of assetFiles) {
      // if (asset.type !== 'file') continue;

      // const cid = await this.uploadFromUrl(asset.download_url);
      
      // if (!existingAssetCids.includes(cid)) {
      //   const existingIndex = config.assets.findIndex((a: any) => a.path === asset.path);
        
      //   if (existingIndex !== -1) {
      //     config.assets[existingIndex].cid = cid;
      //   } else {
      //     config.assets.push({ path: asset.path, cid });
      //   }
      //   console.log(`✅ Asset uploaded: ${asset.path} -> ${cid}`);
      // }
    }

    // Process stylesheets
    console.log("Processing stylesheets...");
    const cssFiles = (await this.getAllFilesRecursive(github_account, repo, branch, 'css'))
      .filter(file => file.path.endsWith('.css'));

    for (const cssFile of cssFiles) {
      const cid = await this.uploadFromUrl(cssFile.download_url);
      const existingIndex = config.stylesheets.findIndex((s: any) => s.path === cssFile.path);
      
      if (existingIndex !== -1) {
        config.stylesheets[existingIndex].cid = cid;
      } else {
        config.stylesheets.push({ path: cssFile.path, cid });
      }
      console.log(`✅ Stylesheet uploaded: ${cssFile.path} -> ${cid}`);
    }

    // Process templates
    console.log("Processing templates...");
    const templateFiles = await this.getAllFilesRecursive(github_account, repo, branch, 'templates');

    for (const template of templateFiles) {
      if (template.type !== 'file') continue;

      let content = await this.fetchGitHubFile(template.download_url);
      content = content.replace(/\n/g, '');
      content = content.replace(/\\([^\\])/g, '$1');

      // Insert stylesheet link for head.handlebars
      if (template.path.includes('head.handlebars') && config.stylesheets.length > 0) {
        content = this.insertStylesheetLink(content, config.stylesheets[0].cid);
      }

      // Insert asset image CIDs
      content = this.insertAssetImageCids(content, config.assets);

      const cid = await add(content, template.path.split('/').pop() || 'template', 'https://ipfs.transport-union.dev');
      
      const existingIndex = config.templates.findIndex((t: any) => t.path === template.path);
      
      if (existingIndex !== -1) {
        config.templates[existingIndex].cid = cid;
        config.templates[existingIndex].body = content;
      } else {
        config.templates.push({ path: template.path, cid, body: content });
      }
      console.log(`✅ Template uploaded: ${template.path} -> ${cid}`);
    }

    // Upload templates DAG
    const templatesCid = await dagPut(
      JSON.stringify(config.templates),
      'templates.json',
      'https://ipfs.transport-union.dev'
    );

    // Get commit SHA
    const commitSHA = await this.getLatestCommitSHA(github_account, repo, branch);

    // Fetch mapping.json
    const mappingUrl = `https://raw.githubusercontent.com/${github_account}/${repo}/${commitSHA}/mapping.json`;
    const mappingContent = await this.fetchGitHubFile(mappingUrl);
    const mapping = JSON.parse(mappingContent);

    // Upload render action
    const renderActionUrl = `https://raw.githubusercontent.com/${github_account}/${repo}/${commitSHA}/renderer/dist/main.js`;
    const renderActionCid = await this.uploadFromUrl(renderActionUrl);

    // Create final config
    const finalConfig: S2SPublicationConfig = {
      assets: config.assets,
      assetsGateway: this.pinataGateway,
      contract: contractAddress,
      dataGateway: this.ipfsGateway,
      renderAction: renderActionCid,
      mapping,
      name: publicationName,
      stylesheets: config.stylesheets,
      templateCid: templatesCid,
    };

    console.log("config", finalConfig)

    // Upload final config
    const configCid = await this.uploadToPinata(
      JSON.stringify(finalConfig),
      'config.json'
    );

    const configCid2 = await add( JSON.stringify(finalConfig),'config.json','https://ipfs.transport-union.dev')

    console.log(`✅ Config uploaded: ${configCid} ${configCid2}`);

    return { config: finalConfig, cid: configCid2 };
  }
}

