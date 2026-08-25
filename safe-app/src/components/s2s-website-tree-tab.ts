// s2s-website-tree-tab.ts
//
// View of the published website tree. Fetches the site root CID from the ENS
// records contract (`contenthash_wrapped`, INV-6) and walks the IPFS DAG from
// that root via the Kubo gateway, rendering every entry as a collapsible tree.
// A sync button re-reads the contract + re-walks the DAG (no page reload) and
// diffs against the previous snapshot so the publisher can monitor retractions
// (removed paths) and slug renames (added + removed paths).
//
// A "Reset tree" button runs the publication-owner reset through the existing
// Lit pipeline (`renderwithLitActions` with `reset: true`) — clearing all pages
// (including home), keeping assets, and leaving on-chain deals untouched — with
// an optional "Reset & rebuild" that also re-renders every on-chain deal in the
// same call. This tab never proposes Safe transactions.
// `decodeContenthashWrapped` is the single-sourced EIP-1577 decoder
// (shared/src/ipfs/contenthash.ts, re-exported through the shared root barrel).
// It replaces the fragile local `slice(6)` + `CID.decode` pair that threw
// "Incorrect length" on any contenthash that was not byte-exactly
// `0xe3 0x01 <cid bytes>`.
import {
  LitService,
  renderwithLitActions,
  decodeContenthashWrapped,
} from '@s2s/soul2soul-shared';
import { ethers } from 'ethers';
import { store } from '../state/index.js';
import { SafeIntegration } from '../lib/safe-integration.js';
import { evmRead } from '@/lib/evm.js';
import { IPFS_URL } from '@/lib/ipfs-fs.factory.js';
import { tableStyles } from '@/styles/table-styles.js';
import { sectionStyles } from '@/styles/section-styles.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { buttonStyles } from '@/styles/button-styles.js';

// NOTE: human-readable fragments only. ethers v6 rejects a trailing
// state-mutability token on a named-parameter fragment ("Invalid Fragment"),
// so setText is declared with bare types and no `nonpayable`. This tab never
// writes — setText is here purely so the interface matches the deployed
// contract. The protocol ABI is separate and unchanged.
const RECORDS_CONTRACT_ABI = [
  'function getText(bytes32 node, string key) view returns (string)',
  'function setText(bytes32,string,string)',
];

const MAX_DEPTH = 6;
const MAX_ENTRIES = 400;
const LS_TIMEOUT_MS = 15_000;
const SNAPSHOT_KEY = 's2s:website-tree:prev-snapshot';

interface DagLink {
  Name: string;
  Hash: string;
  Size: number;
  Type: number;
}

interface TreeNode {
  name: string;
  hash: string;
  size: number;
  type: number; // 1 = file, 2 = directory
  path: string; // '' for the root, otherwise e.g. 'about/index.html' or 'assets/'
  children: TreeNode[];
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class S2SWebsiteTreeTab extends HTMLElement {
  public safeIntegration!: SafeIntegration;
  public lit!: LitService;
  private syncing = false;
  private resetting = false;
  private error: string | null = null;
  private tree: TreeNode | null = null;
  private lastSynced: string | null = null;
  private previousSnapshot: Set<string> | null = null;
  private addedPaths: Set<string> = new Set<string>();
  private removedPaths: Set<string> = new Set<string>();
  private unsubscriber: (() => void) | null = null;
  private entryCount = 0;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [typograhyStyles, sectionStyles, tableStyles, buttonStyles];
  }

  async connectedCallback() {
    this.unsubscriber = store.subscribeToRoot(() => {
      this.render();
    });
    this.previousSnapshot = this.loadSnapshot();
    this.render();
    await this.sync();
  }

  disconnectedCallback() {
    this.unsubscriber?.();
    this.unsubscriber = null;
  }

  private loadSnapshot(): Set<string> | null {
    try {
      const raw = localStorage.getItem(SNAPSHOT_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((item): item is string => typeof item === 'string'));
      }
    } catch {
      // ignore a corrupt snapshot
    }
    return null;
  }

  private saveSnapshot(paths: Set<string>): void {
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(([...paths] as string[]).sort()));
    } catch {
      // ignore quota / availability errors
    }
  }

  /** Decode an on-chain `contenthash_wrapped` value to a CIDv1 string.
   *  Returns null (never throws) when the value is absent or malformed, so the
   *  caller can degrade to the store root instead of blowing up the sync. */
  private decodeRootCid(onchainHash: unknown): string | null {
    if (typeof onchainHash !== 'string') return null;
    const raw = onchainHash.trim();
    // Sanity check before decoding: 0x-prefixed, even-length, ipfs-ns (0xe3)
    // + contenthash version (0x01) prefix, and long enough to carry a CID.
    // '0x' + 'e301' + at least a 34-byte CIDv0 multihash => >= 74 chars.
    if (!/^0x[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) return null;
    if (!raw.toLowerCase().startsWith('0xe301')) return null;
    if (raw.length < 74) return null;
    try {
      const cid = decodeContenthashWrapped(raw);
      const label = cid.toV1().toString();
      return label.length > 0 ? label : null;
    } catch (e) {
      console.warn('[website-tree] contenthash decode failed:', e);
      return null;
    }
  }

  /** Fresh root CID: re-read `contenthash_wrapped` from the ENS records contract
   *  (mirrors s2s-app.ts fetchFreshData), falling back to the store root.
   *  Any read or decode failure degrades to the store root — this never throws. */
  private async fetchRootCid(): Promise<string | null> {
    const publication = store.getRecord('name');
    const protocolInfo = store.protocolInfo;
    if (publication && protocolInfo?.ensRecords) {
      try {
        const node = ethers.namehash(publication);
        const onchainHash = await evmRead(
          8453,
          protocolInfo.ensRecords,
          RECORDS_CONTRACT_ABI,
          'getText',
          [node, 'contenthash_wrapped']
        );
        const decoded = this.decodeRootCid(onchainHash);
        if (decoded) return decoded;
        console.warn('[website-tree] unusable contenthash on-chain, using store root');
      } catch (e) {
        console.warn('[website-tree] ENS read failed, falling back to store root:', e);
      }
    }
    return store.getRoot();
  }

  /** List the direct children of a DAG node by CID via /api/v0/ls. A file root
   *  (or an unreachable node) is reported as `isFile` so the caller can degrade
   *  gracefully instead of recursing into a non-directory. */
  private async listLinks(cid: string): Promise<{ links: DagLink[]; isFile: boolean }> {
    const url = `${IPFS_URL}/api/v0/ls?arg=${encodeURIComponent(cid)}`;
    try {
      const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(LS_TIMEOUT_MS) });
      if (!res.ok) {
        return { links: [], isFile: true };
      }
      const data = (await res.json()) as { Objects?: { Links?: DagLink[] | null }[] };
      const obj = data.Objects?.[0];
      const links = obj?.Links;
      // On this gateway (Kubo), ls on a FILE returns { Links: [] } — an empty
      // array, not null. A node whose ls returns no links is a leaf (a file or
      // an empty directory), so report it as isFile and let the caller render
      // it as a leaf instead of recursing into a phantom empty folder.
      if (links === null || links === undefined || links.length === 0) {
        return { links: [], isFile: true };
      }
      return { links, isFile: false };
    } catch {
      return { links: [], isFile: true };
    }
  }

  private async walkDag(cid: string): Promise<TreeNode> {
    this.entryCount = 0;
    return this.fetchDir(cid, '', 0);
  }

  private async fetchDir(cid: string, path: string, depth: number): Promise<TreeNode> {
    const name = path === '' ? '' : (path.split('/').pop() ?? '');
    const node: TreeNode = { name, hash: cid, size: 0, type: 2, path, children: [] };
    if (depth >= MAX_DEPTH) return node;

    const { links, isFile } = await this.listLinks(cid);
    if (isFile) {
      node.type = 1;
      return node;
    }

    for (const link of links) {
      if (this.entryCount >= MAX_ENTRIES) break;
      this.entryCount++;
      const childPath = path === '' ? link.Name : `${path}/${link.Name}`;
      // On this gateway, Type 1 = directory, Type 2 = file (inverted vs the
      // original assumption). Recurse only into Type 1 links; everything else
      // is a file leaf.
      if (link.Type === 1) {
        const child = await this.fetchDir(link.Hash, childPath, depth + 1);
        node.children.push(child);
      } else {
        node.children.push({
          name: link.Name,
          hash: link.Hash,
          size: link.Size,
          type: 1,
          path: childPath,
          children: [],
        });
      }
    }
    return node;
  }

  private collectPaths(node: TreeNode): Set<string> {
    const paths = new Set<string>();
    const walk = (n: TreeNode): void => {
      if (n.path !== '') {
        paths.add(n.type === 2 ? `${n.path}/` : n.path);
      }
      for (const child of n.children) walk(child);
    };
    walk(node);
    return paths;
  }

  /** Destructive-action confirm dialog: explains what a reset clears and keeps
   *  (all pages incl. home, assets kept, on-chain deals unchanged) and offers
   *  "Reset only" (clear-only) vs "Reset & rebuild" (clear + bulk re-render of
   *  every on-chain deal). Default is "Reset only". */
  private showResetDialog(): void {
    if (!this.shadowRoot) return;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h3 class="modal-title">Reset website tree?</h3>
        <p class="modal-text">
          This <strong>clears ALL pages</strong> from the website tree — including the home
          page (<code>index.html</code>). Assets are kept and re-copied from the config.
          On-chain deals are <strong>unchanged</strong> (they remain the source of truth).
        </p>
        <div class="modal-actions">
          <button class="button btn-secondary" id="reset-cancel-btn">Cancel</button>
          <button class="button btn-danger" id="reset-only-btn">Reset only</button>
          <button class="button btn-danger" id="reset-rebuild-btn">Reset &amp; rebuild</button>
        </div>
      </div>
    `;
    this.shadowRoot.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#reset-cancel-btn')?.addEventListener('click', close);
    overlay.querySelector('#reset-only-btn')?.addEventListener('click', () => {
      close();
      void this.resetTree(false);
    });
    overlay.querySelector('#reset-rebuild-btn')?.addEventListener('click', () => {
      close();
      void this.resetTree(true);
    });
  }

  /** Run the reset through the existing write pipeline (same as
   *  s2s-deals-tab.ts bulkRender): `signWithSigner('lit actions auth')` then
   *  `renderwithLitActions(..., reset: true)`. For "Reset only" contentIds is
   *  empty (reset-only path — skips prep/render and drives the update action
   *  directly with jobs:[] + reset:true). For "Reset & rebuild" all deal genesis
   *  IDs are passed with reset:true so a single call runs prep+render AND the
   *  mkdir-branch reset — reconstructing the tree from current on-chain state.
   *  On success the tree is re-synced so the cleared/rebuilt tree shows at once.
   *  The on-chain gate (canReset, publication-Safe owner) is not re-implemented
   *  here — a non-owner signer surfaces as a pipeline error. */
  private async resetTree(rebuild: boolean): Promise<void> {
    if (this.syncing || this.resetting) return;
    this.resetting = true;
    this.error = null;
    this.render();

    try {
      const configCid = store.getRecord('config');
      const publication = store.getRecord('name');
      const protocolInfo = store.protocolInfo;
      const safeInfo = store.safeInfo;
      if (
        configCid == null ||
        publication == null ||
        protocolInfo == undefined ||
        safeInfo == undefined
      ) {
        this.error = 'Cannot reset: missing config, publication, protocol, or Safe info.';
        return;
      }

      const signature = await this.safeIntegration.signWithSigner('lit actions auth');

      const contentIds = rebuild ? store.deals.map((d) => d.genesis) : [];

      // DRPC endpoints, one URL per chain (L1 = Ethereum, L2 = Base). Mirrors
      // s2s-deals-tab.ts bulkRender / getRpcUrl in lib/evm.ts — no hardcoded keys.
      const apiKey = String(import.meta.env.VITE_DRPC_API_KEY ?? 'default');
      const rpcs = {
        L1: [`https://lb.drpc.live/ethereum/${apiKey}`],
        L2: [`https://lb.drpc.live/base/${apiKey}`],
      };

      const res = await renderwithLitActions(
        false, // preview — a reset is a real write, not a preview
        this.lit,
        signature,
        import.meta.env.VITE_LIT_USAGE_KEY,
        protocolInfo,
        undefined, // notice
        store.safeInfo?.safeAddress || '',
        publication,
        contentIds,
        configCid,
        rpcs,
        undefined, // ipfsGateway — fall back to protocolInfo.gateway
        undefined, // remove
        true, // reset — 14th positional arg
      );

      if (!res.success) {
        // Log the full result — the trace contains the evmWrite outcome, so the
        // real on-chain failure (e.g. a reverted contenthash_wrapped write) is
        // visible in the console.
        console.error('[website-tree] reset failed:', res);
        this.error =
          (res as any)?.error ?? 'Reset failed — the pipeline did not report success.';
        return;
      }

      // Use the FRESH root the pipeline just produced (the mkdir root written
      // to `contenthash_wrapped` by the update action) rather than re-reading
      // ENS: the write may not have propagated to the read RPC yet, and the
      // store root is otherwise only ever set by s2s-app.ts fetchFreshData —
      // i.e. stale — so a fallback there would re-render the OLD tree and make
      // the reset look like a no-op.
      if (res.cid) {
        store.setRoot(res.cid);
      }

      // Re-sync the tree so the cleared/rebuilt tree is reflected immediately.
      await this.sync(res.cid ?? undefined);
    } catch (e) {
      // Surface the pipeline error (e.g. a non-owner signer rejected by canReset).
      console.error('[website-tree] reset failed:', e);
      this.error = e instanceof Error ? e.message : 'Reset failed.';
    } finally {
      this.resetting = false;
      this.render();
    }
  }

  /** Walk + render the tree. `rootOverride` short-circuits the ENS read: it is
   *  passed straight after a reset, where the pipeline already handed us the
   *  fresh root and an ENS re-read would race the just-issued write. */
  private async sync(rootOverride?: string): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.error = null;
    this.render();

    try {
      const rootCid = rootOverride ?? (await this.fetchRootCid());
      if (!rootCid) {
        this.error = 'No site root available. Is the publication name and ENS records module configured?';
        return;
      }

      const tree = await this.walkDag(rootCid);
      const paths = this.collectPaths(tree);

      const prev = this.previousSnapshot;
      if (prev) {
        this.addedPaths = new Set([...paths].filter((p) => !prev.has(p)));
        this.removedPaths = new Set([...prev].filter((p) => !paths.has(p)));
      } else {
        this.addedPaths = new Set();
        this.removedPaths = new Set();
      }

      this.previousSnapshot = paths;
      this.saveSnapshot(paths);
      this.tree = tree;
      this.lastSynced = new Date().toLocaleString();
    } catch (e) {
      console.error('[website-tree] sync failed:', e);
      this.error = e instanceof Error ? e.message : 'Failed to fetch the website tree from ENS/IPFS.';
    } finally {
      this.syncing = false;
      this.render();
    }
  }

  private computeStats(): { entries: number; pages: number } {
    let entries = 0;
    let pages = 0;
    const walk = (n: TreeNode): void => {
      entries++;
      if (n.type === 1 && n.name === 'index.html') pages++;
      for (const child of n.children) walk(child);
    };
    if (this.tree) walk(this.tree);
    return { entries, pages };
  }

  private formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return '';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return `${String(parseFloat((bytes / Math.pow(k, i)).toFixed(1)))} ${sizes[i]}`;
  }

  private renderNode(node: TreeNode, depth: number): string {
    const isDir = node.type === 2;
    const isPage = !isDir && node.name === 'index.html';
    const isAdded = this.addedPaths.has(node.path);
    const indent = depth * 16;
    const addedTag = isAdded ? '<span class="tag tag-added">new</span>' : '';

    if (isDir) {
      const children = node.children.map((c) => this.renderNode(c, depth + 1)).join('');
      return `
        <details class="tree-dir${isAdded ? ' added' : ''}">
          <summary style="padding-left:${String(indent)}px">
            <span class="tree-icon">📁</span>
            <span class="tree-name">${escapeHtml(node.name)}</span>
            <span class="tree-count">(${String(node.children.length)})</span>
            ${addedTag}
          </summary>
          <div class="tree-children">${children}</div>
        </details>`;
    }

    return `
      <div class="tree-file${isAdded ? ' added' : ''}" style="padding-left:${String(indent)}px">
        <span class="tree-icon">📄</span>
        <span class="tree-name">${escapeHtml(node.name)}</span>
        ${isPage ? '<span class="badge badge-page">page</span>' : ''}
        <span class="tree-size">${escapeHtml(this.formatBytes(node.size))}</span>
        ${addedTag}
      </div>`;
  }

  private renderRemoved(): string {
    if (this.removedPaths.size === 0) return '';
    const items = ([...this.removedPaths] as string[])
      .sort()
      .map(
        (p) => `
      <div class="removed-row">
        <span class="tree-icon">🗑️</span>
        <span class="removed-name">${escapeHtml(p)}</span>
        <span class="tag tag-removed">removed</span>
      </div>`
      )
      .join('');
    return `
      <div class="removed-section">
        <div class="removed-title">Removed since last sync (${String(this.removedPaths.size)})</div>
        <div class="removed-list">${items}</div>
      </div>`;
  }

  private render(): void {
    if (!this.shadowRoot) return;

    let body = '';
    if (!this.tree && !this.syncing) {
      body = '<div class="loading">Loading website tree…</div>';
    } else if (this.tree) {
      if (this.tree.type === 2) {
        const stats = this.computeStats();
        const children = this.tree.children.map((c) => this.renderNode(c, 1)).join('');
        body = `
          <div class="tree-root">
            <div class="tree-children">${children}</div>
          </div>
          <div class="stats">
            <span class="stat">${String(stats.entries)} entries</span>
            <span class="stat">${String(stats.pages)} pages</span>
            ${this.addedPaths.size > 0 ? `<span class="stat stat-added">+${String(this.addedPaths.size)} added</span>` : ''}
            ${this.removedPaths.size > 0 ? `<span class="stat stat-removed">−${String(this.removedPaths.size)} removed</span>` : ''}
          </div>
          ${this.renderRemoved()}
        `;
      } else {
        body = `
          <div class="tree-root">
            <div class="tree-file">
              <span class="tree-icon">📄</span>
              <span class="tree-name">${escapeHtml(this.tree.name || this.tree.hash)}</span>
            </div>
          </div>
        `;
      }
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          padding: 2rem 0;
          background: var(--gray-900);
        }

        .loading {
          text-align: center;
          padding: 3rem;
          color: var(--gray-400);
        }

        .toolbar {
          display: flex;
          flex-direction: row;
          align-items: center;
          gap: 1rem;
          margin-bottom: 1rem;
        }

        .last-synced {
          color: var(--gray-400);
          font-size: 0.85rem;
        }

        .error {
          margin: 1rem 0;
          padding: 0.75rem 1rem;
          border-radius: 6px;
          background: rgba(239, 68, 68, 0.12);
          color: #f87171;
          border: 1px solid rgba(239, 68, 68, 0.3);
        }

        .tree-root {
          margin-top: 1rem;
        }

        .tree-children {
          border-left: 1px solid var(--gray-700);
          margin-left: 0.5rem;
          padding-left: 0.5rem;
        }

        .tree-dir {
          margin: 0;
        }

        .tree-dir summary {
          cursor: pointer;
          list-style: none;
          display: flex;
          align-items: center;
          gap: 0.4rem;
          padding-top: 0.3rem;
          padding-bottom: 0.3rem;
          color: var(--gray-100);
        }

        .tree-dir summary::-webkit-details-marker {
          display: none;
        }

        .tree-dir summary::before {
          content: "▸";
          color: var(--gray-500);
        }

        .tree-dir[open] summary::before {
          content: "▾";
        }

        .tree-file {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          padding-top: 0.3rem;
          padding-bottom: 0.3rem;
          color: var(--gray-100);
        }

        .tree-icon {
          width: 1.1rem;
          text-align: center;
        }

        .tree-name {
          color: var(--gray-100);
        }

        .tree-count {
          color: var(--gray-500);
          font-size: 0.8rem;
        }

        .tree-size {
          color: var(--gray-500);
          font-size: 0.8rem;
        }

        .badge {
          display: inline-block;
          padding: 0.05rem 0.45rem;
          border-radius: 4px;
          font-size: 0.7rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }

        .badge-page {
          background: rgba(16, 185, 129, 0.15);
          color: #34d399;
        }

        .tag {
          display: inline-block;
          padding: 0.05rem 0.45rem;
          border-radius: 4px;
          font-size: 0.7rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }

        .tag-added {
          background: rgba(16, 185, 129, 0.15);
          color: #34d399;
        }

        .tag-removed {
          background: rgba(239, 68, 68, 0.15);
          color: #f87171;
        }

        .tree-dir.added summary .tree-name,
        .tree-file.added .tree-name {
          color: #34d399;
        }

        .stats {
          display: flex;
          gap: 1.25rem;
          margin-top: 1.5rem;
          padding: 0.75rem 1rem;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid var(--gray-700);
          border-radius: 8px;
        }

        .stat {
          color: var(--gray-300);
          font-size: 0.85rem;
        }

        .stat-added {
          color: #34d399;
        }

        .stat-removed {
          color: #f87171;
        }

        .removed-section {
          margin-top: 1.5rem;
        }

        .removed-title {
          font-size: 0.85rem;
          font-weight: 600;
          color: #f87171;
          margin-bottom: 0.5rem;
        }

        .removed-row {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.25rem 0;
          color: var(--gray-400);
        }

        .removed-name {
          text-decoration: line-through;
          color: #f87171;
        }

        .modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.6);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }

        .modal {
          background: var(--gray-800);
          border: 1px solid var(--gray-600);
          border-radius: 10px;
          padding: 1.5rem;
          max-width: 420px;
          width: 90%;
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
        }

        .modal-title {
          margin: 0 0 0.75rem;
          color: #f87171;
          font-size: 1.1rem;
        }

        .modal-text {
          margin: 0 0 1.25rem;
          color: var(--gray-300);
          line-height: 1.5;
        }

        .modal-actions {
          display: flex;
          gap: 0.5rem;
          justify-content: flex-end;
          flex-wrap: wrap;
        }
      </style>

      <div class="toolbar">
        <div class="section-title">
          <h2>Website Tree</h2>
        </div>
        <button class="button has-icon" id="sync-btn" ${this.syncing || this.resetting ? 'disabled' : ''}>
          ${this.syncing ? 'Syncing…' : '↻ Sync'}
        </button>
        <button class="button btn-danger" id="reset-btn" ${this.syncing || this.resetting ? 'disabled' : ''}>
          ${this.resetting ? 'Resetting…' : '🗑 Reset tree'}
        </button>
        ${this.lastSynced ? `<span class="last-synced">Last synced: ${escapeHtml(this.lastSynced)}</span>` : ''}
      </div>

      ${this.error ? `<div class="error">⚠️ ${escapeHtml(this.error)}</div>` : ''}

      ${body}
    `;

    this.attachEventListeners();
  }

  private attachEventListeners(): void {
    const syncBtn = this.shadowRoot?.querySelector('#sync-btn');
    if (syncBtn) {
      syncBtn.addEventListener('click', () => {
        void this.sync();
      });
    }
    const resetBtn = this.shadowRoot?.querySelector('#reset-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        this.showResetDialog();
      });
    }
  }
}

customElements.define('s2s-website-tree-tab', S2SWebsiteTreeTab);
