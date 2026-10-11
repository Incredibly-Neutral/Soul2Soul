export class S2SIPFSMethods {
  private readonly kuboGateway: string;
  private readonly pinataJWT: string;
  private readonly pinataGateway: string;
  private filebaseToken: string;
  private readonly kuboToken: string;

  // Kubo MFS API timeouts — cp/pinAdd move content into the remote kubo node
  // (cp-root copies a whole tree) and need a realistic bound; metadata ops stay
  // at 5s.
  static readonly MFS_TIMEOUTS = {
    mkdir: 5_000,
    stat: 5_000,
    ls: 5_000,
    cp: 60_000,
    pinAdd: 60_000,
    rm: 5_000,
  };

  constructor(
    kuboGateway: string,
    pinataJWT: string,
    pinataGateway: string,
    filebaseToken?: string,
    /** Raw Kubo RPC bearer token for the data gateway (write auth). */
    kuboToken?: string,
  ) {
    this.kuboGateway = kuboGateway;
    this.pinataJWT = pinataJWT;
    this.pinataGateway = pinataGateway;
    this.filebaseToken = filebaseToken || '';
    this.kuboToken = kuboToken || '';
  }

  /** Set the Filebase access token after construction (e.g. from env vars). */
  setFilebaseToken(token: string) {
    this.filebaseToken = token;
  }

  /** Accessor so builders that hold only this.ipfs can read the gateway. */
  get gateway(): string {
    return this.kuboGateway;
  }

  /**
   * Pin (repin) an existing CID recursively to Filebase or Pinata, pulling the
   * blocks from our own kubo node — same remote-pin path neutralpress's render
   * uses for the rendered site root (SPEC-00 §3.2). Never throws; returns whether
   * the pin request was accepted. Used by ConfigBuilder to mirror templateCid.
   */
  async pinCidRemote(cid: string, provider: 'filebase' | 'pinata' = 'filebase'): Promise<boolean> {
    const { pinCidFromRemote } = await import('../pin/index.js');
    const token = provider === 'pinata' ? this.pinataJWT : this.filebaseToken;
    return pinCidFromRemote(cid, this.kuboGateway, token, provider);
  }

  // =========================================================================
  // Low-level kubo POST (internal; all MFS + dag helpers route through this)
  // =========================================================================

  async kuboPost(
    path: string,
    timeoutMs: number,
    body?: BodyInit,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const url = `https://${this.fixEndpoint(this.kuboGateway)}${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.kuboToken ? { Authorization: `Bearer ${this.kuboToken}` } : {}),
        ...extraHeaders,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response;
  }

  // =========================================================================
  // Template operations (string content → CID)
  // =========================================================================

  async addToKubo(fileContent: string | Blob, name: string, onlyHash?: boolean): Promise<string> {
    const formData = new FormData();
    const blob =
      typeof fileContent === 'string'
        ? new Blob([fileContent], { type: 'text/plain' })
        : fileContent;
    formData.append('file', blob, name);

    const apiPath = onlyHash ? 'api/v0/add?only-hash=true' : 'api/v0/add';

    const response = await fetch(`https://${this.fixEndpoint(this.kuboGateway)}/${apiPath}`, {
      method: 'POST',
      headers: this.kuboToken ? { Authorization: `Bearer ${this.kuboToken}` } : undefined,
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`IPFS add failed: ${response.status} ${response.statusText}\n${errorText}`);
    }

    const result = await response.json();
    return result.Hash || result.Cid?.['/'] || result.Cid;
  }

  async dagPut(fileContent: string, name: string): Promise<string> {
    const formData = new FormData();
    const blob = new Blob([fileContent], { type: 'application/json' });
    formData.append('object data', blob, name || 'dag.json');

    const response = await fetch(`https://${this.fixEndpoint(this.kuboGateway)}/api/v0/dag/put`, {
      method: 'POST',
      headers: this.kuboToken ? { Authorization: `Bearer ${this.kuboToken}` } : undefined,
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DAG put failed: ${response.status} ${response.statusText}\n${errorText}`);
    }

    const result = await response.json();
    return result.Cid['/'] || result.Cid || result.Hash;
  }

  /** Fetch a DAG node by CID and parse as JSON. */
  async dagGet(cid: string): Promise<any> {
    const res = await this.kuboPost(`/api/v0/dag/get?arg=${cid}`, S2SIPFSMethods.MFS_TIMEOUTS.cp);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`dag/get failed for ${cid}: ${text}`);
    }
    return await res.json();
  }

  // =========================================================================
  // IPFS content retrieval (cat endpoint)
  // =========================================================================

  async fetchFromKubo(cid: string): Promise<any> {
    const response = await this.kuboPost(`/api/v0/cat?arg=${cid}`, S2SIPFSMethods.MFS_TIMEOUTS.cp);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('IPFS error response:', errorText);
      throw new Error(`Failed to fetch from IPFS: ${response.status} ${response.statusText}`);
    }

    const text = await response.text();

    try {
      return JSON.parse(text);
    } catch (error) {
      console.error('Failed to parse IPFS response as JSON:', text);
      throw new Error('Invalid JSON response from IPFS');
    }
  }

  // =========================================================================
  // Upload to Filebase (was Pinata — disabled in favor of Filebase per eth.link recommendation)
  // Filebase RPC endpoint: POST https://rpc.filebase.io/api/v0/add (Kubo-compatible)
  // Auth: Authorization: Bearer <access-token>
  // =========================================================================

  /**
   * Upload content to an IPFS pinning service.
   *
   * @param content  - The payload to upload.
   * @param filename - Logical file name.
   * @param provider - Which pinning backend to use ('filebase' | 'pinata'), default 'filebase'.
   */
  async uploadToPinata(
    content: string | Blob,
    filename: string,
    provider: 'filebase' | 'pinata' = 'filebase',
  ): Promise<string> {
    const formData = new FormData();

    if (typeof content === 'string') {
      formData.append('file', new Blob([content]), filename);
    } else {
      formData.append('file', content, filename);
    }

    if (provider === 'pinata') {
      const response = await fetch(`https://api.pinata.cloud/pinning/pinFileToIPFS`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.pinataJWT}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Pinata upload failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      const data = await response.json();
      return data.IpfsHash;
    }

    // Filebase RPC: direct upload via /api/v0/add (default)
    const response = await fetch(`https://rpc.filebase.io/api/v0/add`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.filebaseToken}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Filebase upload failed: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const data = await response.json();
    return data.Hash;
  }

  // =========================================================================
  // MFS (Mutable File System) helpers
  // =========================================================================

  /** Create a temp MFS path, optionally copying from an existing root CID. */
  async prepareTempMfs(currentRoot: string, tempDirName: string): Promise<string> {
    const tmpPath = `/tmp/${tempDirName}`;

    if (currentRoot && currentRoot !== '') {
      const res = await this.kuboPost(
        `/api/v0/files/cp?arg=/ipfs/${encodeURIComponent(currentRoot)}&arg=${encodeURIComponent(tmpPath)}&parents=true`,
        S2SIPFSMethods.MFS_TIMEOUTS.cp,
      );
      if (!res.ok) {
        const text = await res.text();
        console.warn(`cp root failed, falling back to mkdir: ${text}`);
        const mkdirRes = await this.kuboPost(
          `/api/v0/files/mkdir?arg=${encodeURIComponent(tmpPath)}&parents=true`,
          S2SIPFSMethods.MFS_TIMEOUTS.mkdir,
        );
        if (!mkdirRes.ok) {
          const mkdirText = await mkdirRes.text();
          throw new Error(`Failed to create temp MFS dir: ${mkdirText}`);
        }
      }
    } else {
      const res = await this.kuboPost(
        `/api/v0/files/mkdir?arg=${encodeURIComponent(tmpPath)}&parents=true`,
        S2SIPFSMethods.MFS_TIMEOUTS.mkdir,
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to create temp MFS dir: ${text}`);
      }
    }

    return tmpPath;
  }

  /** List files in an MFS directory. */
  async mfsList(mfsPath: string): Promise<any[]> {
    const res = await this.kuboPost(
      `/api/v0/files/ls?arg=${encodeURIComponent(mfsPath)}`,
      S2SIPFSMethods.MFS_TIMEOUTS.ls,
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.Links || []).map((link: any) => ({
      name: link.Name,
      hash: link.Hash,
      size: link.Size,
      type: link.Tsize ? 'file' : 'directory',
    }));
  }

  /** Stat a single entry in MFS. */
  async mfsStat(mfsPath: string): Promise<string | null> {
    const res = await this.kuboPost(
      `/api/v0/files/stat?arg=${encodeURIComponent(mfsPath)}`,
      S2SIPFSMethods.MFS_TIMEOUTS.stat,
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.Hash || null;
  }

  /** Flush an MFS directory to get the new root CID. */
  async mfsFlush(mfsPath: string): Promise<{ ok: boolean; cid: string }> {
    const res = await this.kuboPost(
      `/api/v0/files/flush?arg=${encodeURIComponent(mfsPath)}`,
      S2SIPFSMethods.MFS_TIMEOUTS.pinAdd,
    );
    if (!res.ok) {
      return { ok: false, cid: '' };
    }
    const data = await res.json();
    const cid =
      typeof data === 'string' ? data : data['/'] || data.Hash || data.Cid?.['/'] || data.Cid || '';
    return { ok: true, cid };
  }

  /** Copy a file from IPFS (by CID) into an MFS path. */
  async mfsCp(sourceCid: string, destMfsPath: string): Promise<boolean> {
    const res = await this.kuboPost(
      `/api/v0/files/cp?arg=/ipfs/${encodeURIComponent(sourceCid)}&arg=${encodeURIComponent(destMfsPath)}&parents=true&flush=false`,
      S2SIPFSMethods.MFS_TIMEOUTS.cp,
    );
    if (!res.ok) {
      const text = await res.text();
      console.warn(`cp ${sourceCid} → ${destMfsPath} failed: ${text}`);
      return false;
    }
    return true;
  }

  // =========================================================================
  // Endpoint normalization
  // =========================================================================

  fixEndpoint(endpoint: string) {
    return endpoint
      .replace(/^(https?:\/\/)/, '') // Remove protocol if present
      .replace(/\/+$/, ''); // Remove trailing slashes
  }
}
// Contenthash helpers
export * from './contenthash';
