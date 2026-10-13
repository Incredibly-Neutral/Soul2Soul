/**
 * Kubo (IPFS) pin client for lastmile.
 *
 * Mirrors the request style of cid-mirror/src/ipfs/kubo.ts: fetch POST with
 * an AbortSignal.timeout and args carried in the query string. Used by the
 * sync loop to pin a freshly resolved CID (fail-closed: only a 200 from
 * pin/add means every block is stored AND verified locally), to keep a
 * bounded set of previous CIDs pinned for rollback, and to list what is
 * pinned for reconciliation.
 */

export interface PinAddResult {
  cid: string;
  pinned: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class KuboClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, opts?: { timeoutMs?: number }) {
    // Strip trailing slash(es) so we can append API paths cleanly.
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async post(path: string): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  /**
   * Pin a CID via /api/v0/pin/add.
   *
   * The arg is `/ipfs/<cid>`, URL-encoded. Kubo answers 200 with
   * `{ Pins: [cid] }` only once every block is stored and verified; missing
   * blocks surface as a non-2xx response with an error body, which we throw
   * on (the sync loop treats that as "do not repoint nginx" — fail closed).
   */
  async pinAdd(cid: string): Promise<PinAddResult> {
    const arg = encodeURIComponent(`/ipfs/${cid}`);
    const res = await this.post(`/api/v0/pin/add?arg=${arg}`);
    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).trim().slice(0, 200);
      throw new Error(`kubo pinAdd failed for ${cid}: ${res.status} ${snippet}`);
    }
    return { cid, pinned: true };
  }

  /**
   * Unpin a CID via /api/v0/pin/rm.
   *
   * "not pinned" (whether as a 404/500 error body or a 200 message) is
   * treated as success — unpinning something already gone is a no-op.
   */
  async unpin(cid: string): Promise<void> {
    const arg = encodeURIComponent(cid);
    const res = await this.post(`/api/v0/pin/rm?arg=${arg}`);
    if (res.ok) return;
    const body = await res.text().catch(() => '');
    if (/not pinned/i.test(body)) return;
    const snippet = body.trim().slice(0, 200);
    throw new Error(`kubo unpin failed for ${cid}: ${res.status} ${snippet}`);
  }

  /**
   * List recursively-pinned CIDs via /api/v0/pin/ls?type=recursive.
   * Kubo answers `{ Keys: { "<cid>": { "Type": "recursive" } } }`.
   */
  async listPins(): Promise<string[]> {
    const res = await this.post('/api/v0/pin/ls?type=recursive');
    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).trim().slice(0, 200);
      throw new Error(`kubo pin ls failed: ${res.status} ${snippet}`);
    }
    const data = (await res.json()) as { Keys?: Record<string, unknown> };
    return Object.keys(data.Keys ?? {});
  }
}
