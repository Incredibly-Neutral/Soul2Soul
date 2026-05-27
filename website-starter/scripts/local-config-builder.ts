// config-builder.ts

import { add, dagPut, fetchFromIPFS } from "./ipfs";
import * as fs from 'fs/promises';
import * as path from 'path';
import { uploadToPinata } from "./pinata";

interface PublicationConfig {
  assets: Array<{ path: string; cid: string }>;
  assets_gateway: string;
  contract: string;
  data_gateway: string;
  domains: Array<{
    url: string;
    dns: {
      custodian: string;
      item_id: string;
      auth_key: string;
    };
  }>;
  render_action: string;
  mapping: any;
  name: string;
  rpc: string;
  stylesheets: Array<{ path: string; cid: string }>;
  table: {
    id: string;
    gateway: string;
  };
  template_cid: string;
  templates: Array<{ path: string; cid: string; body: string }>;
}

interface LocalFile {
  path: string;
  name: string;
  type: 'file' | 'dir';
  size?: number;
}

interface FileWithContent extends LocalFile {
  content: string | Buffer;
}

export class LocalConfigBuilder {
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
  // parseGitHubUrl(githubUrl: string): { owner: string; repo: string; branch: string } {
  //   // Supports: https://github.com/owner/repo or https://github.com/owner/repo/tree/branch
  //   const match = githubUrl.match(/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+))?/);
  //   if (!match) {
  //     throw new Error("Invalid GitHub URL");
  //   }
  //   return {
  //     owner: match[1],
  //     repo: match[2],
  //     branch: match[3] || "main"
  //   };
  // }

  // Fetch files from GitHub directory
  // async getGitHubFiles(owner: string, repo: string, branch: string, path: string = ""): Promise<GitHubFile[]> {
  //   const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
    
  //   const response = await fetch(url);
  //   if (!response.ok) {
  //     throw new Error(`GitHub API error: ${response.statusText}`);
  //   }
    
  //   const data = await response.json();
  //   return Array.isArray(data) ? data : [];
  // }

  async getAllFilesRecursive(dirPath: string = "."): Promise<LocalFile[]> {
    const files = await this.getLocalFiles(dirPath);
    let allFiles: LocalFile[] = [];
    
    for (const file of files) {
      if (file.type === 'file') {
        allFiles.push(file);
      } else if (file.type === 'dir') {
        // Recursively fetch files from subdirectories
        const subFiles = await this.getAllFilesRecursive(file.path);
        allFiles = allFiles.concat(subFiles);
      }
    }
    
    return allFiles;
  }

  async getLocalFiles(dirPath: string): Promise<LocalFile[]> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    
    return entries.map(entry => ({
      path: path.join(dirPath, entry.name),
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : 'file',
    }));
  }

  // async readFileContent(filePath: string): Promise<string | Buffer> {
  //   return await fs.readFile(filePath);
  // }

  // async getAllFilesWithContent(dirPath: string = "."): Promise<FileWithContent[]> {
  //   const files = await this.getAllFilesRecursive(dirPath);
  //   const filesWithContent: FileWithContent[] = [];
    
  //   for (const file of files) {
  //     const content = await this.readFileContent(file.path);
  //     filesWithContent.push({
  //       ...file,
  //       content
  //     });
  //   }
    
  //   return filesWithContent;
  // }

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
    publicationName: string,
    contractAddress: string,
    existingConfigCid?: string
  ): Promise<{ config: PublicationConfig; cid: string }> {

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
    const assetFiles = await this.getAllFilesRecursive('./assets');
    const existingAssetCids = config.assets.map((a: any) => a.cid);

    for (const file of assetFiles) {
      if (file.type !== 'file') continue;

        const buffer = await fs.readFile(file.path);
        const blob = new Blob([buffer.slice()]);
        const filename = path.basename(file.path);
        const cid = await this.uploadToPinata(blob, filename);
      
      if (!existingAssetCids.includes(cid)) {
        const existingIndex = config.assets.findIndex((a: any) => a.path === file.path);
        
        if (existingIndex !== -1) {
          config.assets[existingIndex].cid = cid;
        } else {
          config.assets.push({ path: file.path, cid });
        }
        console.log(`✅ Asset uploaded: ${file.path} -> ${cid}`);
      }
    }

    // Process stylesheets
    console.log("Processing stylesheets...");
    const cssFiles = (await this.getAllFilesRecursive('./css'))
      .filter(file => file.path.endsWith('.css'));

    for (const file of cssFiles) {
      

      const buffer = await fs.readFile(file.path);
      const blob = new Blob([buffer.slice()]);
      const filename = path.basename(file.path);
      const cid = await this.uploadToPinata(blob, filename);

      const existingIndex = config.stylesheets.findIndex((s: any) => s.path === file.path);
      
      if (existingIndex !== -1) {
        config.stylesheets[existingIndex].cid = cid;
      } else {
        config.stylesheets.push({ path: file.path, cid });
      }
      console.log(`✅ Stylesheet uploaded: ${file.path} -> ${cid}`);
    }

    // Process templates
    console.log("Processing templates...");
    const templateFiles = await this.getAllFilesRecursive('./templates');

    for (const template of templateFiles) {
      if (template.type !== 'file') continue;

      let content = await fs.readFile(template.path,'utf-8');
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


    const mappingContent = await fs.readFile('./mapping.json','utf-8')
    const mapping = JSON.parse(mappingContent);

    let render_action = await uploadToPinata("./renderer/dist/main.js");   

    // Create final config
    const finalConfig: PublicationConfig = {
      assets: config.assets,
      assets_gateway: this.pinataGateway,
      contract: contractAddress,
      data_gateway: this.ipfsGateway,
      domains: [{
        url: `${publicationName}.example.com`,
        dns: {
          custodian: "digitalocean",
          item_id: "",
          auth_key: ""
        }
      }],
      render_action: render_action.IpfsHash,
      mapping,
      name: publicationName,
      rpc: "", // Set based on chain
      stylesheets: config.stylesheets,
      table: {
        id: "", // Set based on protocol
        gateway: this.pinataGateway
      },
      template_cid: templatesCid,
      templates: config.templates
    };

    console.log("config", finalConfig)



    // Upload final config
    const configCid = await this.uploadToPinata(
      JSON.stringify(finalConfig),
      'config.json'
    );

    const configCid2 = await add(JSON.stringify(finalConfig),'config.json', this.ipfsGateway)

    console.log(`✅ Config uploaded: ${configCid} - ${configCid2}`);

    return { config: finalConfig, cid: configCid2 };
  }
}

