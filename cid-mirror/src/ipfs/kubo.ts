/**
 * Kubo RPC client — mirrors the patterns from S2SIPFSMethods (shared/src/ipfs/index.ts)
 * and ipfs.factory.ts (protocol/actions/src/libs/ipfs.factory.ts).
 *
 * Provides typed methods for the IPFS endpoints needed by the mirror engine:
 * - `cat(cid)` — fetch file bytes (for leaf content)
 * - `ls(cid)` — list directory links (for tree traversal)
 * - `dagGet(cid)` — fetch a DAG node as JSON (for inspection)
 *
 * Concurrency is NOT handled here; the caller (mirror engine) manages a limit.
 */

/**
 * A kubo link Hash is normally a plain CID string — `/api/v0/ls` returns
 * each link's Hash as e.g. `"Qm..."`. Some endpoints (notably
 * `/api/v0/dag/get`) instead wrap CIDs as a JSON-CID object
 * (`{ "/": "Qm..." }`). Accept both shapes so we interoperate with
 * whichever a real node returns.
 */
export type KuboHash = string | { '/': string };

/**
 * Normalize a kubo link Hash to a plain CID string.
 *
 * Accepts the two shapes kubo can return: a plain string (`/api/v0/ls`)
 * or a JSON-CID object (`{ "/": "Qm..." }`, from `/api/v0/dag/get`).
 * Throws a clear error if the value is neither.
 */
export function hashToString(h: unknown): string {
  if (typeof h === 'string' && h !== '') return h;
  if (typeof h === 'object' && h !== null && typeof (h as { '/': unknown })['/'] === 'string') {
    return (h as { '/': string })['/'];
  }
  throw new Error(
    `Cannot resolve IPFS link hash to a CID string: expected a string or a { "/": string } JSON-CID object, got ${JSON.stringify(h)}`,
  );
}

export interface KuboLink {
  Name: string;
  Hash: KuboHash;
  Size: number;
  /** 1 = directory, 2 = file (kubo >= 0.12); omitted by older kubo */
  Type?: number;
}

export interface KuboLsResult {
  Objects: Array<{
    Hash: KuboHash;
    Links: KuboLink[];
  }>;
}

export class KuboClient {
  private readonly baseUrl: string;
  private readonly auth: string;

  constructor(baseUrl: string, auth = '') {
    // Strip trailing slash so we can append paths cleanly
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.auth = auth;
  }

  private async request(path: string, timeoutMs: number): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.auth) {
      headers['Authorization'] = this.auth;
    }
    const response = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response;
  }

  /**
   * Fetch raw bytes for a CID leaf via /api/v0/cat.
   * Returns the full response body as an ArrayBuffer (binary safe).
   */
  async catBytes(cid: string, timeoutMs = 60_000): Promise<ArrayBuffer> {
    const res = await this.request(`/api/v0/cat?arg=${encodeURIComponent(cid)}`, timeoutMs);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`kubo cat failed for ${cid}: ${res.status} ${text}`);
    }
    return res.arrayBuffer();
  }

  /**
   * List directory links via /api/v0/ls.
   */
  async ls(cid: string, timeoutMs = 30_000): Promise<KuboLsResult> {
    const res = await this.request(`/api/v0/ls?arg=${encodeURIComponent(cid)}`, timeoutMs);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`kubo ls failed for ${cid}: ${res.status} ${text}`);
    }
    return (await res.json()) as KuboLsResult;
  }

  /**
   * Fetch a DAG node as JSON via /api/v0/dag/get.
   */
  async dagGet(cid: string, timeoutMs = 30_000): Promise<any> {
    const res = await this.request(`/api/v0/dag/get?arg=${encodeURIComponent(cid)}`, timeoutMs);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`kubo dag/get failed for ${cid}: ${res.status} ${text}`);
    }
    return res.json();
  }
}
