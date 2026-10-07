// s2s-website-tree-tab.ts
//
// View of the published website tree. Fetches the site root CID from the ENS
// records contract (`contenthash_wrapped`, INV-6) and walks the IPFS DAG from
// that root via the Kubo gateway, rendering every entry as a collapsible tree.
// The footer below the tree shows the per-publication content-cache CID
// (`content_cache_<publication>`) as a gateway link — not the site root.
// A sync button re-reads the contract + re-walks the DAG (no page reload) and
// diffs against the previous snapshot so the publisher can monitor retractions
// (removed paths) and slug renames (added + removed paths).
//
// A "Reset tree" button runs the publication-owner reset through the existing
// Lit pipeline (`renderwithLitActions` with `reset: true`) — clearing all pages
// (including home), keeping assets, and leaving on-chain deals untouched — with
// an optional "Reset & rebuild" that also re-renders every on-chain deal in the
// same call. This tab never proposes Safe transactions.
// `decodeRootCid` (lib/contenthash.ts) is the single-sourced EIP-1577 decoder
// + validator (shared/src/ipfs/contenthash.ts, re-exported through the shared
// root barrel). It replaces the fragile local `slice(6)` + `CID.decode` pair
// that threw "Incorrect length" on any contenthash that was not byte-exactly
// `0xe3 0x01 <cid bytes>`, and returns null on any value that decodes to a
// non-plausible CID (garbage codec / malformed multihash) so the sync degrades
// to the store root instead of walking an invalid CID.
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LitService, renderwithLitActions } from '@s2s/soul2soul-shared';
import { ethers } from 'ethers';
import { store } from '../state/index.js';
import { SafeIntegration } from '../lib/safe-integration.js';
import { evmRead } from '@/lib/evm.js';
import { IPFS_URL } from '@/lib/ipfs-fs.factory.js';
import { decodeRootCid } from '@/lib/contenthash.js';
import './copy-hash.js';
import { tableStyles } from '@/styles/table-styles.js';
import { ICON_SIZE, ICON_SIZE_LARGE, ICON_WEIGHT } from '@/components/icon.js';
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

@customElement('s2s-website-tree-tab')
export class S2SWebsiteTreeTab extends LitElement {
  @property({ attribute: false }) safeIntegration!: SafeIntegration;
  @property({ attribute: false }) lit!: LitService;

  @state() private syncing = false;
  @state() private resetting = false;
  @state() private error: string | null = null;
  @state() private tree: TreeNode | null = null;
  @state() private lastSynced: string | null = null;
  private previousSnapshot: Set<string> | null = null;
  @state() private addedPaths: Set<string> = new Set<string>();
  @state() private removedPaths: Set<string> = new Set<string>();
  private unsubscriber: (() => void) | null = null;
  private entryCount = 0;
  /** The DECODED per-publication content-cache CID (CIDv1) read from the ENS
   *  records contract (`content_cache_<publication>`), shown in the footer as a
   *  gateway link. Null until the first successful sync (or if missing or
   *  malformed on-chain, in which case the footer renders nothing). */
  @state() private contentCacheCid: string | null = null;

  static styles = [
    typograhyStyles,
    sectionStyles,
    tableStyles,
    buttonStyles,
    css`
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

      .cid-footer {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-top: 1.5rem;
        padding-top: 1rem;
        border-top: 1px solid var(--gray-700);
      }

      .cid-label {
        color: var(--gray-400);
        font-size: 0.85rem;
        white-space: nowrap;
      }

      .gateway-link {
        text-decoration: none;
        color: inherit;
        display: inline-flex;
        align-items: center;
      }

      .gateway-link:hover {
        text-decoration: underline;
        color: var(--blue-400, #60a5fa);
      }

      .gateway-link::after {
        content: "↗";
        margin-left: 0.25rem;
        font-size: 0.75rem;
        opacity: 0.6;
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
    `,
  ];

  connectedCallback() {
    super.connectedCallback();
    this.unsubscriber = store.subscribeToRoot(() => this.requestUpdate());
    this.previousSnapshot = this.loadSnapshot();
    void this.sync();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
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
   *  caller can degrade to the store root instead of blowing up the sync.
   *  Single-sourced in lib/contenthash.ts (pure, unit-tested). */
  private decodeRootCid(onchainHash: unknown): string | null {
    return decodeRootCid(onchainHash);
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
        const onchainHash: unknown = await evmRead(
          8453,
          protocolInfo.ensRecords,
          RECORDS_CONTRACT_ABI,
          'getText',
          [node, 'contenthash_wrapped'],
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

  /** Per-publication content-cache CID: re-read `content_cache_<publication>`
   *  from the ENS records contract (mirrors fetchRootCid's ENS read + decode)
   *  and decode it to a CIDv1 string. Unlike the site root this never falls
   *  back to the store — it returns null (never throws) when the value is
   *  absent or malformed, so the footer simply renders nothing. */
  private async fetchContentCacheCid(): Promise<string | null> {
    const publication = store.getRecord('name');
    const protocolInfo = store.protocolInfo;
    if (publication && protocolInfo?.ensRecords) {
      try {
        const node = ethers.namehash(publication);
        const onchainHash: unknown = await evmRead(
          8453,
          protocolInfo.ensRecords,
          RECORDS_CONTRACT_ABI,
          'getText',
          [node, `content_cache_${publication}`],
        );
        return this.decodeRootCid(onchainHash);
      } catch (e) {
        console.warn('[website-tree] content-cache CID read failed:', e);
      }
    }
    return null;
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
    this.renderRoot.appendChild(overlay);

    const close = () => {
      overlay.remove();
    };
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
        import.meta.env.VITE_LIT_USAGE_KEY as string,
        protocolInfo,
        undefined, // notice
        store.safeInfo?.safeAddress ?? '',
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
        const resetError: unknown = res.error;
        this.error =
          typeof resetError === 'string'
            ? resetError
            : 'Reset failed — the pipeline did not report success.';
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
    }
  }

  /** Walk + render the tree. `rootOverride` short-circuits the ENS read: it is
   *  passed straight after a reset, where the pipeline already handed us the
   *  fresh root and an ENS re-read would race the just-issued write. */
  private async sync(rootOverride?: string): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.error = null;

    try {
      const rootCid = rootOverride ?? (await this.fetchRootCid());
      if (!rootCid) {
        this.error =
          'No site root available. Is the publication name and ENS records module configured?';
        return;
      }

      // Fetch the per-publication content-cache CID before the DAG walk so the
      // footer shows it even if the walk later fails. Missing/malformed values
      // decode to null and the footer simply renders nothing.
      this.contentCacheCid = await this.fetchContentCacheCid();

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
      this.error =
        e instanceof Error ? e.message : 'Failed to fetch the website tree from ENS/IPFS.';
    } finally {
      this.syncing = false;
    }
  }

  /** Shorten a CID to `len` leading/trailing chars with an ellipsis, mirroring
   *  the s2s-storage-tab helper so the footer link looks consistent with the
   *  rest of the app. Never throws: empty input short-circuits to '-'. */
  private shortenCid(cid: string, len = 8): string {
    if (!cid || cid.length <= len * 2) return cid || '-';
    return `${cid.slice(0, len)}...${cid.slice(-len)}`;
  }

  private gatewayUrl(cid: string): string {
    return `https://ipfs.io/ipfs/${cid}`;
  }

  /** Footer row showing the decoded per-publication content-cache CID as an
   *  ipfs.io gateway link with a copy button (reusing the <copy-hash> web
   *  component). Renders nothing when no content-cache CID is known yet
   *  (initial load / error / missing record) — never throws. */
  private contentCacheFooter(): TemplateResult | typeof nothing {
    if (!this.contentCacheCid) return nothing;
    return html`
      <div class="cid-footer">
        <span class="cid-label">Content cache CID</span>
        <a href="${this.gatewayUrl(this.contentCacheCid)}" target="_blank" rel="noopener noreferrer" class="gateway-link" title="Open on IPFS gateway">
          <copy-hash .value=${this.shortenCid(this.contentCacheCid)}></copy-hash>
        </a>
      </div>`;
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

  private renderNode(node: TreeNode, depth: number): TemplateResult {
    const isDir = node.type === 2;
    const isPage = !isDir && node.name === 'index.html';
    const isAdded = this.addedPaths.has(node.path);
    const indent = depth * 16;
    const addedTag = isAdded ? html`<span class="tag tag-added">new</span>` : '';

    if (isDir) {
      const children = node.children.map((c) => this.renderNode(c, depth + 1));
      return html`
        <details class="tree-dir${isAdded ? ' added' : ''}">
          <summary style="padding-left:${String(indent)}px">
            <span class="tree-icon"><ph-folder size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-folder></span>
            <span class="tree-name">${node.name}</span>
            <span class="tree-count">(${String(node.children.length)})</span>
            ${addedTag}
          </summary>
          <div class="tree-children">${children}</div>
        </details>`;
    }

    return html`
      <div class="tree-file${isAdded ? ' added' : ''}" style="padding-left:${String(indent)}px">
        <span class="tree-icon"><ph-file-text size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-file-text></span>
        <span class="tree-name">${node.name}</span>
        ${isPage ? html`<span class="badge badge-page">page</span>` : ''}
        <span class="tree-size">${this.formatBytes(node.size)}</span>
        ${addedTag}
      </div>`;
  }

  private renderRemoved(): TemplateResult | typeof nothing {
    if (this.removedPaths.size === 0) return nothing;
    const items = ([...this.removedPaths] as string[]).sort().map(
      (p) => html`
        <div class="removed-row">
          <span class="tree-icon"><ph-trash size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-trash></span>
          <span class="removed-name">${p}</span>
          <span class="tag tag-removed">removed</span>
        </div>`,
    );
    return html`
      <div class="removed-section">
        <div class="removed-title">Removed since last sync (${String(this.removedPaths.size)})</div>
        <div class="removed-list">${items}</div>
      </div>`;
  }

  render(): TemplateResult {
    let body: TemplateResult;
    if (!this.tree && !this.syncing) {
      body = html`<div class="loading">Loading website tree…</div>`;
    } else if (this.tree) {
      if (this.tree.type === 2) {
        const stats = this.computeStats();
        const children = this.tree.children.map((c) => this.renderNode(c, 1));
        body = html`
          <div class="tree-root">
            <div class="tree-children">${children}</div>
          </div>
          <div class="stats">
            <span class="stat">${String(stats.entries)} entries</span>
            <span class="stat">${String(stats.pages)} pages</span>
            ${this.addedPaths.size > 0 ? html`<span class="stat stat-added">+${String(this.addedPaths.size)} added</span>` : ''}
            ${this.removedPaths.size > 0 ? html`<span class="stat stat-removed">−${String(this.removedPaths.size)} removed</span>` : ''}
          </div>
          ${this.renderRemoved()}
        `;
      } else {
        body = html`
          <div class="tree-root">
            <div class="tree-file">
              <span class="tree-icon"><ph-file-text size="${ICON_SIZE_LARGE}" weight="${ICON_WEIGHT}"></ph-file-text></span>
              <span class="tree-name">${this.tree.name || this.tree.hash}</span>
            </div>
          </div>
        `;
      }
    } else {
      body = html``;
    }

    return html`
      <div class="toolbar">
        <div class="section-title">
          <h2>Website Tree</h2>
        </div>
        <button class="button has-icon" id="sync-btn" ?disabled=${this.syncing || this.resetting}
          @click=${() => void this.sync()}>
          ${this.syncing ? 'Syncing…' : html`<ph-arrow-clockwise size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-arrow-clockwise> Sync`}
        </button>
        <button class="button btn-danger" id="reset-btn" ?disabled=${this.syncing || this.resetting}
          @click=${this.showResetDialog}>
          ${this.resetting ? 'Resetting…' : html`<ph-trash size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-trash> Reset tree`}
        </button>
        ${this.lastSynced ? html`<span class="last-synced">Last synced: ${this.lastSynced}</span>` : ''}
      </div>

      ${this.error ? html`<div class="error"><ph-warning size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-warning> ${this.error}</div>` : ''}

      ${body}

      ${this.contentCacheFooter()}
    `;
  }
}
