// s2s-storage-tab.ts
import { FilecoinStorage } from '@s2s/soul2soul-shared/filecoin';
import { store, StoragePiece, PublicationDataSet } from '../state/index.js';
import { tableStyles } from '../styles/table-styles.js';
import { filterStyles } from '@/styles/filter-styles.js';
import { sectionStyles } from '@/styles/section-styles.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { buttonStyles } from '@/styles/button-styles.js';
import {
  sortByColumn,
  toggleSort,
  renderSortableHeader,
  type SortState,
  type TableColumn,
} from '@/utils/sort.js';
import {
  filterByColumn,
  uniqueValuesForColumn,
  type FilterState,
} from '@/utils/filter.js';
import { TableFilter } from './table-filter.js';

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

export class S2SStorageTab extends HTMLElement {
  private storage!: FilecoinStorage;
  private loading = true;
  private fetching = false;
  private deleting = new Set<string>(); // "dataSetId:pieceId" keys
  private terminating = new Set<string>(); // dataSetIds being terminated
  private unsubscriber: (() => void) | null = null;
  private piecesSort: SortState | null = null;
  private datasetsSort: SortState | null = null;
  private piecesFilters: FilterState = {};
  private datasetsFilters: FilterState = {};

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot!.adoptedStyleSheets = [typograhyStyles, sectionStyles, tableStyles, buttonStyles, filterStyles];
  }

  async connectedCallback() {
    this.unsubscriber = store.subscribeToPieces(() => this.render());
    store.subscribeToDataSets(() => this.render());
    this.render();
  }

  disconnectedCallback() {
    this.unsubscriber?.();
    this.unsubscriber = null;
  }

  private async handleDelete(dataSetId: string, pieceId: string, pieceCid: string) {
    const key = `${dataSetId}:${pieceId}`;
    if (this.deleting.has(key)) return;
    this.deleting.add(key);
    this.render();

    try {
      await this.storage.deletePiece(BigInt(dataSetId), BigInt(pieceId));
      this.showNotification(`scheduled piece ${this.shortenCid(pieceCid)} for removal`, 'success');
    } catch (e) {
      console.error('Remove failed:', e);
      this.showNotification('Failed to remove piece', 'error');
    }

    this.deleting.delete(key);
    this.render();
  }

  private async handleTerminate(dataSetId: string) {
    if (this.terminating.has(dataSetId)) return;
    this.terminating.add(dataSetId);
    this.render();

    console.log('ht')
    try {
      const result = await this.storage.terminateDataSet(BigInt(dataSetId));
      console.log("TR", result)
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
    this.render();
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

  private render() {
    if (!this.shadowRoot) return;

    const allPieces = store.pieces;
    const allDatasets = store.dataSets;
    // Filter first, then sort (filters narrow the rows, sort orders the result).
    const pieces = sortByColumn(
      filterByColumn(allPieces, PIECE_COLUMNS, this.piecesFilters),
      PIECE_COLUMNS,
      this.piecesSort,
    );
    const datasets = sortByColumn(
      filterByColumn(allDatasets, DATASET_COLUMNS, this.datasetsFilters),
      DATASET_COLUMNS,
      this.datasetsSort,
    );

    // ── Cost summary ──
    let costHtml = '';
    if (allPieces.length > 0 && allPieces.some(p => p.confirmed)) {
      const cost = FilecoinStorage.estimateMonthlyCostFromPieces(allPieces);
      costHtml = `
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
      `;
    }

    // ── Pieces table ──
    const pieceHeader = `
      ${PIECE_COLUMNS.map((c) => renderSortableHeader(c, this.piecesSort)).join('')}
      <div class="table-header">Actions</div>
    `;

    const pieceRows = pieces.map((p: StoragePiece) => {
      const key = `${p.dataSetId}:${p.pieceId}`;
      const isDeleting = this.deleting.has(key);
      const rootCid = p.rootCid || '';
      const kind = p.metadata?.kind || '-';
      const className = p.confirmed ? '' : 'cached';

      return `
      <div class="table-row ${className}">
        <div class="table-cell">
          <copy-hash>${this.shortenCid(p.pieceCid || '-')}</copy-hash>
        </div>
        <div class="table-cell">
          ${rootCid
            ? `<a href="${this.gatewayUrl(rootCid)}" target="_blank" rel="noopener noreferrer" class="gateway-link"
                  title="Open on IPFS gateway">
                  <copy-hash>${this.shortenCid(rootCid)}</copy-hash>
                </a>`
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
                  data-dataset="${p.dataSetId}"
                  data-pieceid="${p.pieceId}"
                  data-piececid="${p.pieceCid}"
                  ${isDeleting ? 'disabled' : ''}>
            ${isDeleting ? '...' : '🗑️'}
          </button>
        </div>
      </div>`;
    }).join('');

    // ── Data sets table ──
    const dsHeader = `
      ${DATASET_COLUMNS.map((c) => renderSortableHeader(c, this.datasetsSort)).join('')}
      <div class="table-header">Actions</div>
    `;

    const dsRows = datasets.map((ds: PublicationDataSet) => {
      const isTerminating = this.terminating.has(ds.dataSetId);
      const isTerminated = ds.pdpEndEpoch != null && ds.pdpEndEpoch > 0n;

      return `
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
                  data-dataset="${ds.dataSetId}"
                  ${isTerminating ? 'disabled' : ''}>
            ${isTerminating ? '...' : 'X'}
          </button>
        </div>
      </div>`;
    }).join('');

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
          gap: 1.5rem;
          margin-bottom: 1.5rem;
        }

        .refresh-icon {
          width: 2rem;
          height: 2rem;
          vertical-align: middle;
          filter: brightness(0) invert(1);
        }

        .table {
          grid-template-columns: 1.5fr 1.5fr 0.5fr 0.5fr 0.5fr 0.75fr 0.75fr 0.5fr;
        }
        .table-datasets {
          grid-template-columns: 0.75fr 0.75fr 0.5fr 0.75fr 0.75fr 0.5fr;
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

        .ds-section-title {
          margin-top: 2rem;
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
      </style>

      ${allPieces.length === 0 ? `
        <div class="loading">
          <p>Loading storage data...</p>
        </div>
      ` : `
        <div class="toolbar">
          <div class="section-title">
            <h2>Filecoin Storage (${pieces.length} pieces)</h2>
          </div>
          <button class="button has-icon" id="refresh-btn">
            <span><img src="/icons/noun-refresh-2073720.svg" class="refresh-icon" alt="Refresh" /></span>
          </button>
        </div>

        ${costHtml}

        <div class="table-filters">
          <table-filter data-key="kind" label="Kind" value="${this.piecesFilters.kind ?? ''}"></table-filter>
        </div>

        ${
          pieces.length > 0
            ? `
        <div class="table table-pieces">
          ${pieceHeader}
          ${pieceRows}
        </div>
      `
            : `
        <div class="empty-state">
          <div class="empty-icon">📄</div>
          <p>No pieces match the current filters</p>
        </div>
      `
        }

        <div class="toolbar ds-section-title">
          <div class="section-title">
            <h2>Data Sets (${datasets.length})</h2>
          </div>
        </div>

        <div class="table-filters">
          <table-filter data-key="state" label="State" value="${this.datasetsFilters.state ?? ''}"></table-filter>
        </div>

        ${
          datasets.length === 0 && allDatasets.length > 0
            ? `
        <div class="empty-state">
          <div class="empty-icon">📄</div>
          <p>No data sets match the current filters</p>
        </div>
      `
            : `
        <div class="table table-datasets">
          ${dsHeader}
          ${dsRows}
        </div>
      `
        }
      `}
    `;

    this.attachEventListeners();
  }

  private attachEventListeners() {
    // Column header sorting — Pieces table
    this.shadowRoot?.querySelectorAll('.table-pieces .table-header.sortable').forEach((el) => {
      el.addEventListener('click', () => {
        const key = (el as HTMLElement).dataset.sort;
        if (key) {
          this.piecesSort = toggleSort(this.piecesSort, key);
          this.render();
        }
      });
    });

    // Column header sorting — Data Sets table
    this.shadowRoot?.querySelectorAll('.table-datasets .table-header.sortable').forEach((el) => {
      el.addEventListener('click', () => {
        const key = (el as HTMLElement).dataset.sort;
        if (key) {
          this.datasetsSort = toggleSort(this.datasetsSort, key);
          this.render();
        }
      });
    });

    // Filter dropdowns — Pieces table
    this.shadowRoot?.querySelectorAll('.table-pieces .table-filters table-filter').forEach((el) => {
      const filterEl = el as TableFilter;
      const key = (el as HTMLElement).dataset.key;
      if (!key) return;
      filterEl.options = uniqueValuesForColumn(store.pieces, PIECE_COLUMNS, key);
      filterEl.addEventListener('change', (e) => {
        const value = (e as CustomEvent).detail.value as string;
        const next = { ...this.piecesFilters };
        if (value) next[key] = value;
        else delete next[key];
        this.piecesFilters = next;
        this.render();
      });
    });

    // Filter dropdowns — Data Sets table
    this.shadowRoot?.querySelectorAll('.table-datasets .table-filters table-filter').forEach((el) => {
      const filterEl = el as TableFilter;
      const key = (el as HTMLElement).dataset.key;
      if (!key) return;
      filterEl.options = uniqueValuesForColumn(store.dataSets, DATASET_COLUMNS, key);
      filterEl.addEventListener('change', (e) => {
        const value = (e as CustomEvent).detail.value as string;
        const next = { ...this.datasetsFilters };
        if (value) next[key] = value;
        else delete next[key];
        this.datasetsFilters = next;
        this.render();
      });
    });

    const refreshBtn = this.shadowRoot?.querySelector('#refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        // Trigger a fresh fetch from the host app by re-rendering after a short delay
        // The actual fetch happens in s2s-app.fetchFreshData
        window.location.reload();
      });
    }

    this.shadowRoot?.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const dataSetId = target.dataset.dataset;
        const pieceId = target.dataset.pieceid;
        const pieceCid = target.dataset.piececid;
        if (dataSetId && pieceId && pieceCid) {
          this.handleDelete(dataSetId, pieceId, pieceCid);
        }
      });
    });

    this.shadowRoot?.querySelectorAll('.btn-terminate').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const dataSetId = target.dataset.dataset;
        if (dataSetId) this.handleTerminate(dataSetId);
      });
    });
  }
}

customElements.define('s2s-storage-tab', S2SStorageTab);