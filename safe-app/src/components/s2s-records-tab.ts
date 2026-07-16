// s2s-records-tab.ts
import { ConfigBuilder, AssetsBuilder, S2SIPFSMethods } from '@s2s/soul2soul-shared/safe-app';
import { SafeIntegration } from '../lib/safe-integration.js';
import { ProtocolIntegration } from '../lib/protocol-integration.js';
import { store, OnChainRecord } from '../state/index.js';
import { tableStyles } from '@/styles/table-styles.js';
import { buttonStyles } from '@/styles/button-styles.js';
import { LitService } from '@s2s/soul2soul-shared/safe-app';
import { pinCidFromRemote, renderwithLitActions } from '@s2s/soul2soul-shared';
import { sectionStyles } from '@/styles/section-styles.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { FilecoinStorage } from '@s2s/soul2soul-shared/filecoin';
import { browserFilecoinBuilder } from '../filecoin/car-builder.js';

export class S2SRecordsTab extends HTMLElement {
  public safeIntegration!: SafeIntegration;
  public protocolIntegration!: ProtocolIntegration;
  private lit!: LitService;
  private storage!: FilecoinStorage;
  private fetching = false;
  private searchTerm = '';
  private editingKey: string | null = null;
  private storageItems: Array<{
    pieceCid: string;
    rootCid: string | null;
    dataSetId: string;
    provider: string;
    attributed: boolean;
  }> = [];
  private loadingStorage = false;
  private unsubscribers: Array<() => void> = [];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot!.adoptedStyleSheets = [typograhyStyles, sectionStyles, tableStyles, buttonStyles];
  }

  async connectedCallback() {
     console.count('connect'); 
    this.unsubscribers.forEach(fn => fn());
    this.unsubscribers = [
      store.subscribeToRecords(() => this.render()),
    ];

    this.render();

    // Only hit the chain if we have nothing cached.
    // On a remount the store is still populated, so we skip the
    // setAllRecords() that was re-triggering everything.
    if (!store.getAllRecords()) {
      await this.loadRecords();
    }
  }

  disconnectedCallback() {
    this.unsubscribers.forEach(fn => fn());
    this.unsubscribers = [];
  }

  // ← convert Record<string, OnChainRecord> | null to array, then filter
  private get filteredRecords(): OnChainRecord[] {
    const map = store.getAllRecords();
    const all: OnChainRecord[] = map ? Object.values(map) : [];
    if (!this.searchTerm) return all;
    const term = this.searchTerm.toLowerCase();
    return all.filter(r =>
      r.key.toLowerCase().includes(term) ||
      r.value.toLowerCase().includes(term)
    );
  }

  private async loadRecords() {
    this.fetching = true;
    this.render();

    try {
      const [keys, values] = await this.safeIntegration.getAllRecords();
      store.setAllRecords(
        keys.map((key: string, index: number) => ({
          key,
          value: values[index],
          type: this.determineRecordType(key),
        }))
      );
    } catch (error) {
      console.error('Error loading records:', error);
    }

    this.fetching = false;
    this.render();
  }

  private determineRecordType(key: string): 'metadata' | 'content' {
    const contentKeys = ['ipfs-root', 'content-hash', 'data-uri', 'ipfs', 'hash', 'cid'];
    return contentKeys.some(ck => key.toLowerCase().includes(ck)) ? 'content' : 'metadata';
  }

  private async addRecord(key: string, value: string) {
    if (!key.trim() || !value.trim()) {
      this.showNotification('Key and value cannot be empty', 'error');
      return;
    }

    if (this.filteredRecords.some(r => r.key === key)) {
      this.showNotification('Key already exists', 'error');
      return;
    }

    try {
      await this.safeIntegration.setRecord(key, value);
      this.showNotification('Record added! Transaction pending approval.', 'success');
      store.setRecord({ key, value, type: this.determineRecordType(key) });
    } catch (error) {
      console.error('Error adding record:', error);
      this.showNotification('Failed to add record. Please try again.', 'error');
    }
  }

  private async updateRecord(key: string, newValue: string) {
    try {
      await this.safeIntegration.setRecord(key, newValue);
      this.showNotification('Record updated! Transaction pending approval.', 'success');
      store.setRecord({ key, value: newValue, type: this.determineRecordType(key) });
      this.editingKey = null;
      this.render();
    } catch (error) {
      console.error('Error updating record:', error);
      this.showNotification('Failed to update record. Please try again.', 'error');
    }
  }

  private async deleteRecord(key: string) {
    if (!confirm(`Delete record "${key}"?`)) return;

    try {
      await this.safeIntegration.deleteRecord(key);
      this.showNotification('Record deleted! Transaction pending approval.', 'success');
      store.removeRecord(key);
    } catch (error) {
      console.error('Error deleting record:', error);
      this.showNotification('Failed to delete record. Please try again.', 'error');
    }
  }

  private startEdit(key: string) {
    this.editingKey = key;
    this.render();
  }

  private cancelEdit() {
    this.editingKey = null;
    this.render();
  }

  private async updateConfig() {
    const existingCid    = await this.safeIntegration.getRecord('config');
    const repo           = await this.safeIntegration.getRecord('repo');
    const publicationUrl = await this.safeIntegration.getRecord('name');
    const pInfo          = await this.protocolIntegration.getInfo();

    const ipfs = new S2SIPFSMethods(
      'https://ipfs.transport-union.dev',
      import.meta.env.VITE_PINATA_JWT,
      'https://neutralpress.mypinata.cloud',
    );

    const assets = new AssetsBuilder(
      ipfs,
      import.meta.env.VITE_GITHUB_TOKEN,
    );

    const [owner, repoName] = repo.split('/').slice(3);

    const { cid: assetsCid } = await assets.buildAssets(
      owner, repoName, 'main',
      publicationUrl,
      this.safeIntegration.getSafeInfo().s2sPublication || '',
    );

    const config = new ConfigBuilder(
      ipfs,
      import.meta.env.VITE_GITHUB_TOKEN,
    );

    const { cid: configCid, config: publicationConfig } = await config.buildConfig(
      owner, repoName, 'main',
      publicationUrl,
      this.safeIntegration.getSafeInfo().s2sPublication || '',
      assetsCid,
    );

    console.log("[config] templateCid from builder:", publicationConfig.templateCid);
    console.log("[config] configCid from builder:", configCid);

    console.log("cid from kubo", configCid)

    // ── Filecoin (additive, non-blocking) ──────────────────────────────
    // Fetch the built config object from Kubo so we upload the same data
    // that Pinata just pinned, then fire-and-forget.
    try {
      const configData = await ipfs.fetchFromKubo(configCid);
      this.tryFilecoinUpload(configData, 'config');
    } catch (err) {
      console.warn('[filecoin] fetchFromKubo failed (non-fatal):', err);
    }

    // ── Filecoin uploadTree (full assets tree) ────────────────────────
    // Export the full DAG from assetsCid (the actual tree of fonts, images, CSS, templates)
    // as CAR and upload to Filecoin.
    try {
      this.tryFilecoinTreeUpload(assetsCid, 'assets');
    } catch (err) {
      console.warn('[filecoin] uploadTree failed (non-fatal):', err);
    }

    // ── Filecoin uploadTree (templates DAG) ──────────────────────────
    // The templateCid was created by dagPut of the templates array (a single JSON
    // node stored as DAG).  Export it from Kubo as CAR and upload to Filecoin
    // the same way as the assets tree.
    const templateCid = publicationConfig?.templateCid;
    if (templateCid) {
      try {
        this.tryFilecoinTreeUpload(templateCid, 'templates');
      } catch (err) {
        console.warn('[filecoin] template uploadTree failed (non-fatal):', err);
      }
    }

    // ── existing ───────────────────────────────────────────────────────
    const executionUrl = await this.safeIntegration.setRecord('config', configCid);
    window.open(executionUrl, '_blank');
  }

  /**
   * Upload config data to Filecoin Storage (on-chain).
   * Fire-and-forget — never throws, never blocks the Safe tx flow.
   */
  private async tryFilecoinUpload(data: unknown, kind: string = ''): Promise<void> {
    try {
      const publicationAddress = this.safeIntegration.getSafeInfo().s2sPublication || '';
      const result = await this.storage.uploadJson(data, [publicationAddress], kind);
      console.log('[filecoin] config uploaded:', result.rootCid, result.pieceCid, kind ? `(${kind})` : '');
    } catch (err) {
      console.warn('[filecoin] upload failed (non-fatal):', err);
    }
  }

  /**
   * Upload the full assets tree (config + templates + assets) to Filecoin.
   * Exports the DAG from Kubo as CAR, then uploads to Filecoin.
   * Fire-and-forget — never throws, never blocks the Safe tx flow.
   */
  private async tryFilecoinTreeUpload(rootCid: string, kind: string = ''): Promise<void> {
    try {
      const publicationAddress = this.safeIntegration.getSafeInfo().s2sPublication || '';
      const kuboUrl = 'https://ipfs.transport-union.dev';

      // Import dagExport dynamically to avoid bundling issues
      const { dagExport } = await import('../lib/ipfs.factory.js');

      // Export the full DAG from Kubo as CAR bytes
      console.log('[filecoin] exporting tree from Kubo:', rootCid);
      const carBytes = await dagExport(rootCid, kuboUrl);
      console.log('[filecoin] exported tree from Kubo:', rootCid, `(${carBytes.length} bytes)`);

      // Upload the CAR to Filecoin
      const result = await this.storage.uploadTree(carBytes, [publicationAddress].filter(Boolean), kind);
      console.log('[filecoin] tree uploaded to Filecoin:', result.rootCid, result.pieceCid, kind ? `(${kind})` : '');
    } catch (err) {
      console.warn('[filecoin] uploadTree failed (non-fatal):', err);
    }
  }

  private async loadStorage() {
    this.loadingStorage = true;
    this.render();

    const safeAddress = this.safeIntegration.getSafeInfo().s2sPublication || '';
    if (!safeAddress) {
      console.warn('[filecoin] no publication address — skipping storage listing');
      this.loadingStorage = false;
      this.render();
      return;
    }

    try {
      this.storageItems = await this.storage.listPublicationStorage(safeAddress);
      console.log('[filecoin] storage items:', this.storageItems.length);
    } catch (err) {
      console.warn('[filecoin] loadStorage failed:', err);
      this.storageItems = [];
    }

    this.loadingStorage = false;
    this.render();
  }

  private renderStorageLink(url: string | null, label: string, icon: string): string {
    if (!url) return `<span class="storage-link-unattributed">—</span>`;
    return `<a class="storage-link" href="${url}" target="_blank" rel="noopener" title="${label}">${icon} ${label}</a>`;
  }

  private showNotification(message: string, type: 'success' | 'error') {
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed; top: 20px; right: 20px;
      padding: 16px 24px; border-radius: 8px;
      color: white; font-weight: 500; z-index: 1000; max-width: 400px;
      background: ${type === 'success' ? '#10b981' : '#ef4444'};
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;
    notification.textContent = message;
    document.body.appendChild(notification);
    setTimeout(() => document.body.contains(notification) && document.body.removeChild(notification), 5000);
  }

  private render() {
    if (!this.shadowRoot) return;
    console.count('render');

    const records = this.filteredRecords; // ← already an array, null-safe
    const hasCache = records.length > 0;  // ← was store.getAllRecords().length which threw on null

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          padding: 2rem 0;
          background: var(--gray-900);
        }

        .table { grid-template-columns: 1fr 3fr auto; }
        .button.thin { padding: 0.25rem .5rem; }

        .record-value-input {
          width: 100%;
          font-family: 'Monaco', 'Menlo', monospace;
          font-size: 0.875rem;
          padding: 0.5rem;
          border-radius: 0.375rem;
          box-sizing: border-box;
        }

        .empty-state {
          text-align: center;
          padding: 3rem;
          color: #6b7280;
        }

        .loading {
          text-align: center;
          padding: 3rem;
          color: #6b7280;
        }

        .storage-link {
          color: var(--blue-400);
          text-decoration: none;
          font-size: 0.75rem;
          &:hover { text-decoration: underline; }
        }
        .storage-link-unattributed {
          color: var(--gray-600);
          font-size: 0.75rem;
        }
      </style>

      ${!hasCache && this.fetching ? `
        <div class="loading"><p>Loading records...</p></div>
      ` : `
        <div class="section">
          <div class="list_header">
            <h2 class="section-title">Records (${records.length})</h2>
            ${this.fetching ? `<span class="refreshing-badge">Refreshing…</span>` : ''}
          </div>

          ${records.length > 0 ? `
            <div class="table">
              <div class="table-header">Key</div>
              <div class="table-header">Value</div>
              <div class="table-header"></div>

              ${records.map(record => `
                <div class="table-row">
                  <div class="table-cell" style="font-family: monospace; font-size: 0.875rem; color: var(--gray-50);">
                    ${record.key}
                  </div>

                  <div class="table-cell">
                    ${this.editingKey === record.key ? `
                      <input
                        type="text"
                        class="record-value-input"
                        value="${record.value}"
                        id="edit-value-${record.key}"
                      />
                    ` : `
                      <span style="font-family: monospace; font-size: 0.875rem; color: var(--gray-50); word-break: break-all;">
                        ${record.value}
                      </span>
                    `}
                  </div>

                  <div class="table-cell">
                    ${this.editingKey === record.key ? `
                      <div style="display: flex; gap: 0.5rem;">
                        <button class="button thin" data-action="save" data-key="${record.key}">✓ Save</button>
                        <button class="button button-secondary thin" data-action="cancel">✗ Cancel</button>
                      </div>
                    ` : `
                      <div style="display: flex; gap: 0.5rem;">
                        <button class="button thin" data-action="edit" data-key="${record.key}">✏️ Edit</button>
                        <button class="button button-danger thin" data-action="delete" data-key="${record.key}">🗑️ Delete</button>
                      </div>
                    `}
                  </div>
                </div>
              `).join('')}
            </div>
          ` : `
            <div class="empty-state">
              <div>📄</div>
              <p>${this.searchTerm ? 'No records match your search' : 'No records yet'}</p>
            </div>
          `}

          <button class="button" data-action="update">Update Config</button>
        </div>

        <div class="section">
          <div class="list_header">
            <h2 class="section-title">Filecoin Storage</h2>
            ${this.loadingStorage ? `<span class="refreshing-badge">Loading…</span>` : ''}
          </div>

          <div class="table">
            <div class="table-header">CIDs</div>
            <div class="table-header">Provider</div>
            <div class="table-header">Status</div>

            ${this.storageItems.length === 0 ? `\n                <div class="empty-state" style="grid-column: 1/-1">
                  <p>Click "Load Storage" to list your Filecoin pieces</p>
                </div>\n              ` : this.storageItems.map(item => `
                <div class="table-row">
                  <div class="table-cell" style="font-size: 0.75rem; font-family: monospace; color: var(--gray-500);">
                    ${item.rootCid ? `<a class="storage-link" href="https://ipfs.transport-union.dev/ipfs/${item.rootCid}" target="_blank" rel="noopener">🌐 ${item.rootCid.slice(0, 12)}…</a>` : '—'}
                    <br>
                    <span style="color: var(--gray-600);">${item.pieceCid ? item.pieceCid.slice(0, 12) + '…' : '—'}</span>
                  </div>
                  <div class="table-cell" style="font-size: 0.8rem;">
                    ${item.provider}<br>
                    <span style="font-size: 0.7rem; color: var(--gray-600);">${item.attributed ? '✓ attributed' : '○ unattributed'}</span>
                  </div>
                  <div class="table-cell" style="font-size: 0.75rem;">
                    <a class="storage-link" href="https://filfox.info/en/message/${item.dataSetId}" target="_blank" rel="noopener">🔗 Filfox</a>
                  </div>
                </div>
              `).join('')}
          </div>

          <button class="button button-secondary" data-action="load-storage">${this.loadingStorage ? 'Loading…' : 'Load Storage'}</button>
        </div>
      `}
    `;

    if (hasCache || !this.fetching) {
      this.attachEventListeners();
    }
  }

  private attachEventListeners() {
    this.shadowRoot?.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLButtonElement;
        const action = target.dataset.action;
        const key    = target.dataset.key;

        if (action === 'edit' && key) {
          this.startEdit(key);
        } else if (action === 'delete' && key) {
          this.deleteRecord(key);
        } else if (action === 'save' && key) {
          const input = this.shadowRoot?.querySelector(`#edit-value-${key}`) as HTMLInputElement;
          if (input) this.updateRecord(key, input.value);
        } else if (action === 'cancel') {
          this.cancelEdit();
        } else if (action === 'update') {
          this.updateConfig();
        } else if (action === 'load-storage') {
          this.loadStorage();
        }
      });
    });

    const searchInput = this.shadowRoot?.querySelector('#search-input') as HTMLInputElement;
    searchInput?.addEventListener('input', (e) => {
      this.searchTerm = (e.target as HTMLInputElement).value;
      this.render();
    });
  }
}

customElements.define('s2s-records-tab', S2SRecordsTab);