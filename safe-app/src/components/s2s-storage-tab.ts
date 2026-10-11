// s2s-storage-tab.ts
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { FilecoinStorage } from '@s2s/soul2soul-shared/filecoin';
import type { S2SProtocolInfo } from '@s2s/soul2soul-shared';
import type { CidViewReadContext } from '@s2s/soul2soul-shared/safe-app';
import { store, StoragePiece, PublicationDataSet } from '../state/index.js';
import type { SafeIntegration } from '../lib/safe-integration.js';
import type { ProtocolIntegration } from '@/lib/protocol-integration.js';
import { buildSafeAppCidViewContext } from '@/lib/cid-view/index.js';
import './s2s-cid-view-section.js';
import { tableStyles } from '../styles/table-styles.js';
import { filterStyles } from '@/styles/filter-styles.js';
import { sectionStyles } from '@/styles/section-styles.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { buttonStyles } from '@/styles/button-styles.js';
import {
  toggleSort,
  type SortState,
  type TableColumn,
} from '@/utils/sort.js';
import {
  setFilter,
  type FilterState,
} from '@/utils/filter.js';
import './s2s-table.js';
import './copy-hash.js';
import { ICON_SIZE, ICON_WEIGHT } from '@/components/icon.js';

// Per-column sort configuration for the Pieces and Data Sets tables.
const PIECE_COLUMNS: Array<TableColumn<StoragePiece>> = [
  { key: 'pieceCid', label: 'Piece CID', get: (p) => p.pieceCid },
  { key: 'rootCid', label: 'Root CID', get: (p) => p.rootCid },
  { key: 'kind', label: 'Kind', get: (p) => p.metadata?.kind },
  { key: 'size', label: 'Size', get: (p) => Number(p.size || 0) },
  { key: 'dataSetId', label: 'Data Set', get: (p) => p.dataSetId },
  { key: 'provider', label: 'Provider', get: (p) => p.provider },
  { key: 'state', label: 'State', get: (p) => (p.scheduledForRemoval ? 'Rm' : 'Active') },
];

const DATASET_COLUMNS: Array<TableColumn<PublicationDataSet>> = [
  { key: 'dataSetId', label: 'Data Set', get: (ds) => ds.dataSetId },
  { key: 'provider', label: 'Provider', get: (ds) => ds.provider },
  { key: 'pieces', label: 'Pieces', get: (ds) => ds.pieceCount },
  {
    key: 'state',
    label: 'State',
    get: (ds) => (ds.pdpEndEpoch != null && ds.pdpEndEpoch > 0n ? 'Terminated' : 'Active'),
  },
  {
    key: 'endEpoch',
    label: 'End Epoch',
    get: (ds) => (ds.pdpEndEpoch != null && ds.pdpEndEpoch > 0n ? ds.pdpEndEpoch : null),
  },
];

// Column keys that get a filter dropdown in each table, and the shared
// trailing "Actions" header content.
const PIECE_FILTER_KEYS = ['kind'];
const DATASET_FILTER_KEYS = ['state'];
const ACTIONS_HEADER = html`Actions`;

@customElement('s2s-storage-tab')
export class S2SStorageTab extends LitElement {
  @property({ attribute: false }) storage!: FilecoinStorage;
  @property({ attribute: false }) safeIntegration?: SafeIntegration;
  @property({ attribute: false }) protocolIntegration?: ProtocolIntegration;

  // Memoized CID-inventory read context (built once when both modules are up).
  private cidCtx: CidViewReadContext | undefined = undefined;
  private cidCtxSafe: SafeIntegration | null = null;
  private cidCtxProtocol: S2SProtocolInfo | null = null;

  private deleting = new Set<string>(); // "dataSetId:pieceId" keys
  private terminating = new Set<string>(); // dataSetIds being terminated
  private unsubscribers: Array<() => void> = [];

  @state() private piecesSort: SortState | null = null;
  @state() private datasetsSort: SortState | null = null;
  @state() private piecesFilters: FilterState = {};
  @state() private datasetsFilters: FilterState = {};
  @state() private revision = 0;

  // Stable row renderers (bound once) so <s2s-table> only re-renders on real
  // data/state changes. `revision` is bumped alongside requestUpdate() so the
  // table reflects transient per-row state (in-flight delete/terminate).
  private pieceRowRenderer = (p: StoragePiece) => this.renderPieceRow(p);
  private datasetRowRenderer = (ds: PublicationDataSet) => this.renderDataSetRow(ds);

  static styles = [
    typograhyStyles,
    sectionStyles,
    tableStyles,
    buttonStyles,
    filterStyles,
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

      /* Cached (unconfirmed) rows use light text */
      .table-row.cached,
      .table-row.cached .table-cell,
      .table-row.cached a,
      .table-row.cached copy-hash,
      .table-row.cached .state-badge {
        color: var(--gray-500, #6b7280) !important;
      }

      .state-badge {
        display: inline-block;
        padding: 0.15rem 0.5rem;
        border-radius: 4px;
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .state-badge.active {
        background: rgba(16, 185, 129, 0.15);
        color: #34d399;
      }
      .state-badge.removing {
        background: rgba(239, 68, 68, 0.15);
        color: #f87171;
      }
      .state-badge.cached {
        background: rgba(148, 163, 184, 0.15);
        color: #9ca3af;
      }
      .state-badge.terminated {
        background: rgba(239, 68, 68, 0.15);
        color: #f87171;
      }

      .btn-delete {
        all: unset;
        cursor: pointer;
        padding: 0.25rem 0.5rem;
        border-radius: 4px;
        font-size: 1rem;
        transition: background 0.15s;
      }
      .btn-delete:hover:not(:disabled) {
        background: rgba(239, 68, 68, 0.15);
      }
      .btn-delete.deleting {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-delete:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-terminate {
        all: unset;
        cursor: pointer;
        padding: 0.25rem 0.5rem;
        border-radius: 4px;
        font-size: 1rem;
        transition: background 0.15s;
      }
      .btn-terminate:hover:not(:disabled) {
        background: rgba(239, 68, 68, 0.15);
      }
      .btn-terminate.terminating {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-terminate:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .cost-summary {
        display: flex;
        flex-wrap: wrap;
        gap: 1.5rem;
        padding: 1rem 1.25rem;
        margin-bottom: 1.5rem;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid var(--gray-700, #374151);
        border-radius: 8px;
      }
      .cost-item {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
      }
      .cost-label {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--gray-400, #9ca3af);
      }
      .cost-value {
        font-size: 1.05rem;
        font-weight: 600;
        color: var(--gray-100, #f3f4f6);
      }
      .cost-total .cost-value {
        color: #34d399;
      }
      .cost-bytes .cost-value {
        font-size: 0.85rem;
      }
    `,
  ];

  connectedCallback() {
    super.connectedCallback();
    this.unsubscribers = [
      store.subscribeToPieces(() => this.requestUpdate()),
      store.subscribeToDataSets(() => this.requestUpdate()),
    ];
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribers.forEach((fn) => fn());
    this.unsubscribers = [];
  }

  /** Build (and memoize) the CID-view context once modules + protocolInfo exist. */
  private memoCidCtx(): CidViewReadContext | undefined {
    const safe = this.safeIntegration;
    const protocolInfo = this.protocolIntegration?.protocolInfo ?? store.protocolInfo;
    if (!safe || !protocolInfo) return undefined;
    if (this.cidCtxSafe === safe && this.cidCtxProtocol === protocolInfo) {
      return this.cidCtx;
    }
    this.cidCtxSafe = safe;
    this.cidCtxProtocol = protocolInfo;
    this.cidCtx = buildSafeAppCidViewContext({ safeIntegration: safe, protocolInfo });
    return this.cidCtx;
  }

  private async handleDelete(dataSetId: string, pieceId: string, pieceCid: string) {
    const key = `${dataSetId}:${pieceId}`;
    if (this.deleting.has(key)) return;
    this.deleting.add(key);
    this.requestUpdate();
    this.revision++;

    try {
      await this.storage.deletePiece(BigInt(dataSetId), BigInt(pieceId));
      this.showNotification(`scheduled piece ${this.shortenCid(pieceCid)} for removal`, 'success');
    } catch (e) {
      console.error('Remove failed:', e);
      this.showNotification('Failed to remove piece', 'error');
    }

    this.deleting.delete(key);
    this.requestUpdate();
    this.revision++;
  }

  private async handleTerminate(dataSetId: string) {
    if (this.terminating.has(dataSetId)) return;
    this.terminating.add(dataSetId);
    this.requestUpdate();
    this.revision++;

    console.log('ht');
    try {
      const result = await this.storage.terminateDataSet(BigInt(dataSetId));
      console.log('TR', result);
      const ep = result.serviceTerminationEpoch;
      this.showNotification(
        `dataset ${dataSetId} terminated${ep != null ? ` (epoch ${ep})` : ''}`,
        'success'
      );
    } catch (e) {
      console.error('Terminate failed:', e);
      this.showNotification('Failed to terminate dataset', 'error');
    }

    this.terminating.delete(dataSetId);
    this.requestUpdate();
    this.revision++;
  }

  private epochDisplay(epoch: bigint | null): string {
    if (epoch == null || epoch === 0n) return 'Active';
    const FILECOIN_GENESIS = 1598313600; // 2020-08-25 06:00:00 UTC
    const EPOCH_DURATION = 30;
    const ms = (FILECOIN_GENESIS + Number(epoch) * EPOCH_DURATION) * 1000;
    return new Date(ms).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  private shortenCid(cid: string, len: number = 8): string {
    if (!cid || cid.length <= len * 2) return cid || '-';
    return `${cid.slice(0, len)}...${cid.slice(-len)}`;
  }

  private gatewayUrl(cid: string): string {
    return `https://ipfs.io/ipfs/${cid}`;
  }

  private showNotification(message: string, type: 'success' | 'error') {
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 16px 24px;
      border-radius: 8px;
      color: white;
      font-weight: 500;
      z-index: 1000;
      max-width: 400px;
      background: ${type === 'success' ? '#10b981' : '#ef4444'};
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
      if (document.body.contains(notification)) {
        document.body.removeChild(notification);
      }
    }, 5000);
  }

  private renderPieceRow(p: StoragePiece): TemplateResult {
    const key = `${p.dataSetId}:${p.pieceId}`;
    const isDeleting = this.deleting.has(key);
    const rootCid = p.rootCid || '';
    const kind = p.metadata?.kind || '-';
    const className = p.confirmed ? '' : 'cached';

    return html`
      <div class="table-row ${className}">
        <div class="table-cell">
          <copy-hash .value=${p.pieceCid || '-'} display=${this.shortenCid(p.pieceCid || '-')}></copy-hash>
        </div>
        <div class="table-cell">
          ${rootCid
            ? html`<copy-hash .value=${rootCid} display=${this.shortenCid(rootCid)} href=${this.gatewayUrl(rootCid)}></copy-hash>`
            : '-'}
        </div>
        <div class="table-cell">${kind}</div>
        <div class="table-cell">${this.formatBytes(Number(p.size || 0))}</div>
        <div class="table-cell">${p.dataSetId}</div>
        <div class="table-cell">${this.shortenCid(p.provider || '-', 6)}</div>
        <div class="table-cell">
          <span class="state-badge ${p.scheduledForRemoval ? 'removing' : 'active'}">
            ${p.scheduledForRemoval ? 'Rm' : 'Active'}
          </span>
        </div>
        <div class="table-cell">
          <button class="btn-delete ${isDeleting ? 'deleting' : ''}"
            ?disabled=${isDeleting}
            @click=${() => void this.handleDelete(p.dataSetId, p.pieceId, p.pieceCid)}>
            ${isDeleting ? '...' : html`<ph-trash size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-trash>`}
          </button>
        </div>
      </div>
    `;
  }

  private renderDataSetRow(ds: PublicationDataSet): TemplateResult {
    const isTerminating = this.terminating.has(ds.dataSetId);
    const isTerminated = ds.pdpEndEpoch != null && ds.pdpEndEpoch > 0n;

    return html`
      <div class="table-row">
        <div class="table-cell">${ds.dataSetId}</div>
        <div class="table-cell">${this.shortenCid(ds.provider || '-', 6)}</div>
        <div class="table-cell">${ds.pieceCount}</div>
        <div class="table-cell">
          <span class="state-badge ${isTerminated ? 'removing' : 'active'}">
            ${isTerminated ? 'Terminated' : 'Active'}
          </span>
        </div>
        <div class="table-cell">${this.epochDisplay(ds.pdpEndEpoch)}</div>
        <div class="table-cell">
          <button class="btn-terminate ${isTerminating ? 'terminating' : ''}"
            ?disabled=${isTerminating}
            @click=${() => void this.handleTerminate(ds.dataSetId)}>
            ${isTerminating ? '...' : html`<ph-x size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-x>`}
          </button>
        </div>
      </div>
    `;
  }

  render() {
    const allPieces = store.pieces;
    const allDatasets = store.dataSets;

    if (allPieces.length === 0) {
      return html`
        <div class="loading">
          <p>Loading storage data...</p>
        </div>
      `;
    }

    // ── Cost summary ──
    const showCost =
      allPieces.length > 0 && allPieces.some((p) => p.confirmed);
    const cost = showCost
      ? FilecoinStorage.estimateMonthlyCostFromPieces(allPieces)
      : null;
    const cidCtx = this.memoCidCtx();

    return html`
      <s2s-cid-view-section .ctx=${cidCtx}></s2s-cid-view-section>
      ${cost
        ? html`
            <div class="cost-summary">
              <div class="cost-item">
                <span class="cost-label">Storage</span>
                <span class="cost-value">$${cost.storage.toFixed(4)}/mo</span>
              </div>
              <div class="cost-item">
                <span class="cost-label">Proving (${cost.datasetCount} datasets)</span>
                <span class="cost-value">$${cost.proving.toFixed(4)}/mo</span>
              </div>
              <div class="cost-item cost-total">
                <span class="cost-label">Total</span>
                <span class="cost-value">$${cost.total.toFixed(4)}/mo</span>
              </div>
              <div class="cost-item cost-bytes">
                <span class="cost-label">Total size</span>
                <span class="cost-value">${this.formatBytes(cost.totalBytes)}</span>
              </div>
            </div>
          `
        : ''}

      <s2s-table
        title="Filecoin Storage"
        countSuffix=" pieces"
        .titleAction=${html`<button class="button thin" @click=${() => window.location.reload()}>
          <ph-arrow-clockwise size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-arrow-clockwise> Sync
        </button>`}
        .columns=${PIECE_COLUMNS}
        .rows=${allPieces}
        .sort=${this.piecesSort}
        .filters=${this.piecesFilters}
        .filterKeys=${PIECE_FILTER_KEYS}
        .rowRenderer=${this.pieceRowRenderer}
        .revision=${this.revision}
        .actionsHeader=${true}
        .actionsContent=${ACTIONS_HEADER}
        emptyText="No pieces match the current filters"
        gridTemplate="1.5fr 1.5fr 0.5fr 0.5fr 0.5fr 0.75fr 0.75fr 0.5fr"
        @sort=${(e: CustomEvent) => { this.piecesSort = toggleSort(this.piecesSort, e.detail.key); }}
        @filter=${(e: CustomEvent) => { this.piecesFilters = setFilter(this.piecesFilters, e.detail.key, e.detail.value); }}
      ></s2s-table>

      <s2s-table
        title="Data Sets"
        .columns=${DATASET_COLUMNS}
        .rows=${allDatasets}
        .sort=${this.datasetsSort}
        .filters=${this.datasetsFilters}
        .filterKeys=${DATASET_FILTER_KEYS}
        .rowRenderer=${this.datasetRowRenderer}
        .revision=${this.revision}
        .actionsHeader=${true}
        .actionsContent=${ACTIONS_HEADER}
        emptyText=${allDatasets.length > 0 ? 'No data sets match the current filters' : ''}
        gridTemplate="0.75fr 0.75fr 0.5fr 0.75fr 0.75fr 0.5fr"
        @sort=${(e: CustomEvent) => { this.datasetsSort = toggleSort(this.datasetsSort, e.detail.key); }}
        @filter=${(e: CustomEvent) => { this.datasetsFilters = setFilter(this.datasetsFilters, e.detail.key, e.detail.value); }}
      ></s2s-table>
    `;
  }
}
