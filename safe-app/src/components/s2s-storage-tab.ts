// s2s-storage-tab.ts
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
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
  sortIndicator,
  type SortState,
  type TableColumn,
} from '@/utils/sort.js';
import {
  filterByColumn,
  uniqueValuesForColumn,
  type FilterState,
} from '@/utils/filter.js';
import './copy-hash.js';
import './table-filter.js';

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

@customElement('s2s-storage-tab')
export class S2SStorageTab extends LitElement {
  @property({ attribute: false }) storage!: FilecoinStorage;

  private deleting = new Set<string>(); // "dataSetId:pieceId" keys
  private terminating = new Set<string>(); // dataSetIds being terminated
  private unsubscribers: Array<() => void> = [];

  @state() private piecesSort: SortState | null = null;
  @state() private datasetsSort: SortState | null = null;
  @state() private piecesFilters: FilterState = {};
  @state() private datasetsFilters: FilterState = {};

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

  private async handleDelete(dataSetId: string, pieceId: string, pieceCid: string) {
    const key = `${dataSetId}:${pieceId}`;
    if (this.deleting.has(key)) return;
    this.deleting.add(key);
    this.requestUpdate();

    try {
      await this.storage.deletePiece(BigInt(dataSetId), BigInt(pieceId));
      this.showNotification(`scheduled piece ${this.shortenCid(pieceCid)} for removal`, 'success');
    } catch (e) {
      console.error('Remove failed:', e);
      this.showNotification('Failed to remove piece', 'error');
    }

    this.deleting.delete(key);
    this.requestUpdate();
  }

  private async handleTerminate(dataSetId: string) {
    if (this.terminating.has(dataSetId)) return;
    this.terminating.add(dataSetId);
    this.requestUpdate();

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

  private sortableHeader<T>(
    col: TableColumn<T>,
    sort: SortState | null,
    onSort: (key: string) => void,
  ) {
    return html`
      <button
        class="table-header sortable${col.cls ? ' ' + col.cls : ''}"
        data-sort="${col.key}"
        title="Sort by ${col.label}"
        @click=${() => onSort(col.key)}
      >
        <span>${col.label}</span>
        <span class="sort-indicator">${sortIndicator(sort, col.key)}</span>
      </button>
    `;
  }

  private handlePiecesSort(key: string) {
    this.piecesSort = toggleSort(this.piecesSort, key);
  }

  private handleDatasetsSort(key: string) {
    this.datasetsSort = toggleSort(this.datasetsSort, key);
  }

  private handleFilter(source: 'pieces' | 'datasets', key: string, e: CustomEvent) {
    const value = e.detail.value as string;
    const next =
      source === 'pieces' ? { ...this.piecesFilters } : { ...this.datasetsFilters };
    if (value) next[key] = value;
    else delete next[key];
    if (source === 'pieces') this.piecesFilters = next;
    else this.datasetsFilters = next;
  }

  render() {
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

    return html`
      <div class="toolbar">
        <div class="section-title">
          <h2>Filecoin Storage (${pieces.length} pieces)</h2>
        </div>
        <button class="button has-icon" id="refresh-btn"
          @click=${() => window.location.reload()}>
          <span><img src="/icons/noun-refresh-2073720.svg" class="refresh-icon" alt="Refresh" /></span>
        </button>
      </div>

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

      <div class="table-filters pieces-filters">
        <table-filter data-key="kind" label="Kind" .value=${this.piecesFilters.kind ?? ''}
          .options=${uniqueValuesForColumn(allPieces, PIECE_COLUMNS, 'kind')}
          @change=${(e: CustomEvent) => this.handleFilter('pieces', 'kind', e)}></table-filter>
      </div>

      ${pieces.length > 0
        ? html`
            <div class="table table-pieces">
              ${PIECE_COLUMNS.map((c) => this.sortableHeader(c, this.piecesSort, (k) => this.handlePiecesSort(k)))}
              <div class="table-header">Actions</div>

              ${pieces.map((p: StoragePiece) => {
                const key = `${p.dataSetId}:${p.pieceId}`;
                const isDeleting = this.deleting.has(key);
                const rootCid = p.rootCid || '';
                const kind = p.metadata?.kind || '-';
                const className = p.confirmed ? '' : 'cached';

                return html`
                  <div class="table-row ${className}">
                    <div class="table-cell">
                      <copy-hash .value=${this.shortenCid(p.pieceCid || '-')}></copy-hash>
                    </div>
                    <div class="table-cell">
                      ${rootCid
                        ? html`<a href="${this.gatewayUrl(rootCid)}" target="_blank" rel="noopener noreferrer" class="gateway-link"
                            title="Open on IPFS gateway">
                            <copy-hash .value=${this.shortenCid(rootCid)}></copy-hash>
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
                        ?disabled=${isDeleting}
                        @click=${() => void this.handleDelete(p.dataSetId, p.pieceId, p.pieceCid)}>
                        ${isDeleting ? '...' : '🗑️'}
                      </button>
                    </div>
                  </div>
                `;
              })}
            </div>
          `
        : html`
            <div class="empty-state">
              <div class="empty-icon">📄</div>
              <p>No pieces match the current filters</p>
            </div>
          `}

      <div class="toolbar ds-section-title">
        <div class="section-title">
          <h2>Data Sets (${datasets.length})</h2>
        </div>
      </div>

      <div class="table-filters datasets-filters">
        <table-filter data-key="state" label="State" .value=${this.datasetsFilters.state ?? ''}
          .options=${uniqueValuesForColumn(allDatasets, DATASET_COLUMNS, 'state')}
          @change=${(e: CustomEvent) => this.handleFilter('datasets', 'state', e)}></table-filter>
      </div>

      ${datasets.length === 0 && allDatasets.length > 0
        ? html`
            <div class="empty-state">
              <div class="empty-icon">📄</div>
              <p>No data sets match the current filters</p>
            </div>
          `
        : html`
            <div class="table table-datasets">
              ${DATASET_COLUMNS.map((c) => this.sortableHeader(c, this.datasetsSort, (k) => this.handleDatasetsSort(k)))}
              <div class="table-header">Actions</div>

              ${datasets.map((ds: PublicationDataSet) => {
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
                        ${isTerminating ? '...' : 'X'}
                      </button>
                    </div>
                  </div>
                `;
              })}
            </div>
          `}
    `;
  }
}
