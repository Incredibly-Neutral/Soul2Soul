// s2s-records-tab.ts
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
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
import { ICON_SIZE, ICON_SIZE_LARGE, ICON_WEIGHT } from '@/components/icon.js';
import './s2s-sliding-add-button.js';
import { FilecoinStorage } from '@s2s/soul2soul-shared/filecoin';
import { browserFilecoinBuilder } from '../filecoin/car-builder.js';
import { ethers } from 'ethers';
import { evmRead } from '../lib/evm.js';
import {
  maybeVerifyDomainOwnership,
  DOMAIN_VALIDATION_CONFIG,
} from '../lib/domain-validation.js';

@customElement('s2s-records-tab')
export class S2SRecordsTab extends LitElement {
  @property({ attribute: false }) safeIntegration!: SafeIntegration;
  @property({ attribute: false }) protocolIntegration!: ProtocolIntegration;
  @property({ attribute: false }) lit!: LitService;
  @property({ attribute: false }) storage!: FilecoinStorage;

  @state() private fetching = false;
  @state() private searchTerm = '';
  @state() private editingKey: string | null = null;
  /** Keys that were changed by the last updateConfig call — gets a yellow highlight. */
  private changedKeys: Set<string> = new Set();
  private storageItems: Array<{
    pieceCid: string;
    rootCid: string | null;
    dataSetId: string;
    provider: string;
    attributed: boolean;
  }> = [];
  @state() private loadingStorage = false;
  /** The publication's ENS write-target aliases, read from the on-chain
   *  config. Empty when no custom write-targets are set (default subdomain
   *  write target). A legacy `domain`-only config is surfaced as a
   *  single-element alias list. */
  @state() private aliases: string[] = [];
  private unsubscribers: Array<() => void> = [];

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

      .table { grid-template-columns: 1fr 3fr auto; }
      .button.thin {
        padding: 0.25rem .5rem;
        border: none;
        height: 2rem;
        margin-left: .5rem;
        font-size: .875rem;
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
      }

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
      }

      .storage-link:hover {
        text-decoration: underline;
      }

      .storage-link-unattributed {
        color: var(--gray-600);
        font-size: 0.75rem;
      }

      .record-changed {
        background: rgba(238, 181, 29, 0.15);
        border-left: 3px solid var(--color-yellow);
      }

      .domain-current {
        color: var(--gray-50);
        font-size: 0.875rem;
        margin: 0.5rem 0 0;
      }
      .domain-current code {
        color: var(--blue-400);
        font-family: 'Monaco', 'Menlo', monospace;
      }
      .domain-hint {
        color: var(--gray-500);
        font-size: 0.75rem;
        margin: 0.375rem 0 0;
      }

      .alias-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin-top: 0.75rem;
      }

      .alias-pill {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.25rem 0.75rem;
        border-radius: 999px;
        background: var(--gray-800);
        border: 1px solid var(--gray-600);
        color: var(--gray-50);
        font-family: var(--font-mono);
        font-size: 0.85rem;
      }

      .alias-pill__remove {
        display: inline-flex;
        align-items: center;
        padding: 0;
        margin: 0;
        background: transparent;
        border: none;
        color: var(--gray-400);
        cursor: pointer;
      }

      .alias-pill__remove:hover {
        color: var(--color-red);
      }
    `,
  ];

  connectedCallback() {
    super.connectedCallback();
    console.count('connect');
    this.unsubscribers.forEach((fn) => fn());
    this.unsubscribers = [store.subscribeToRecords(() => this.requestUpdate())];

    // Only hit the chain if we have nothing cached.
    // On a remount the store is still populated, so we skip the
    // setAllRecords() that was re-triggering everything.
    if (!store.getAllRecords()) {
      void this.loadRecords();
    } else {
      // Store is already populated from app-boot fetchFreshData(); this tab
      // instance is fresh (recreated per tab switch), so (re)load the current
      // write-target aliases from the on-chain config record. This only reads
      // (no setAllRecords), so it is safe to run on every mount.
      void this.loadCurrentAliases();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribers.forEach((fn) => fn());
    this.unsubscribers = [];
  }

  /** Record keys that are no longer used — hidden from the records table.
   *  `feed` was written by the legacy publication-creation flow
   *  (shared/src/publication/new.ts) and nothing reads it anymore; the feed
   *  address now lives in the built config (mapping.json). */
  private static readonly HIDDEN_RECORD_KEYS: ReadonlySet<string> = new Set(['feed']);

  // ← convert Record<string, OnChainRecord> | null to array, then filter
  private get filteredRecords(): OnChainRecord[] {
    const map = store.getAllRecords();
    const all: OnChainRecord[] = map
      ? Object.values(map).filter((r) => !S2SRecordsTab.HIDDEN_RECORD_KEYS.has(r.key))
      : [];
    if (!this.searchTerm) return all;
    const term = this.searchTerm.toLowerCase();
    return all.filter(
      (r) => r.key.toLowerCase().includes(term) || r.value.toLowerCase().includes(term),
    );
  }

  private async loadRecords() {
    this.fetching = true;

    try {
      const [keys, values] = await this.safeIntegration.getAllRecords();
      store.setAllRecords(
        keys.map((key: string, index: number) => ({
          key,
          value: values[index],
          type: this.determineRecordType(key),
        })),
      );
      // Fresh chain read clears changed-state highlights
      this.changedKeys.clear();
      this.requestUpdate();
      await this.loadCurrentAliases();
    } catch (error) {
      console.error('Error loading records:', error);
    }

    this.fetching = false;
  }

  private determineRecordType(key: string): 'metadata' | 'content' {
    const contentKeys = ['ipfs-root', 'content-hash', 'data-uri', 'ipfs', 'hash', 'cid'];
    return contentKeys.some((ck) => key.toLowerCase().includes(ck)) ? 'content' : 'metadata';
  }

  private async addRecord(key: string, value: string) {
    if (!key.trim() || !value.trim()) {
      this.showNotification('Key and value cannot be empty', 'error');
      return;
    }

    if (this.filteredRecords.some((r) => r.key === key)) {
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
  }

  private cancelEdit() {
    this.editingKey = null;
  }

  /**
   * Read the publication's current ENS write-target aliases from the `config`
   * record (the `aliases` array of the config JSON at the config CID). A legacy
   * `domain`-only config is treated as a single-element alias list for compat.
   * Empty when unset (default subdomain write target).
   */
  private async loadCurrentAliases(): Promise<void> {
    const cached = store.getRecord('config');
    const configCid =
      cached ?? (await this.safeIntegration.getRecord('config').catch(() => null));
    if (!configCid) {
      this.aliases = [];
      return;
    }
    try {
      const config = await this.makeIPFS().fetchFromKubo(configCid);
      const cfg = config as { aliases?: unknown; domain?: string } | undefined;
      this.aliases =
        Array.isArray(cfg?.aliases) && (cfg!.aliases as unknown[]).length > 0
          ? (cfg!.aliases as string[]).slice()
          : cfg?.domain
            ? [cfg.domain]
            : [];
    } catch (error) {
      console.warn('[records] could not read current aliases from config:', error);
      this.aliases = [];
    }
  }

  /** Shared IPFS client for config reads/writes in this tab. */
  private makeIPFS(): S2SIPFSMethods {
    return new S2SIPFSMethods(
      'https://ipfs.transport-union.dev',
      import.meta.env.VITE_PINATA_JWT,
      'https://neutralpress.mypinata.cloud',
      import.meta.env.VITE_FILEBASE_TOKEN || '',
    );
  }

  /**
   * 'Add alias' flow: appends the entered ENS name to the write-target alias
   * list and persists it via updateConfig → buildConfig → config.aliases. By
   * default the same-Safe ownership check is OFF (see DOMAIN_VALIDATION_CONFIG
   * — the single enforcement toggle in domain-validation.ts); when it is ON,
   * each entered alias must resolve to the SAME publication Safe as the current
   * publication name and is rejected with a clear message (nothing saved)
   * otherwise.
   */
  private async addAlias(name: string) {
    const alias = name.trim();
    if (!alias) {
      this.showNotification('Enter an ENS alias to add.', 'error');
      return;
    }
    if (this.aliases.includes(alias)) {
      this.showNotification(`"${alias}" is already a write-target alias.`, 'error');
      return;
    }

    const publication = await this.safeIntegration.getRecord('name').catch(() => '');
    const check = await maybeVerifyDomainOwnership(alias, publication, {
      namehash: (name: string) => ethers.namehash(name),
      evmRead,
    });

    if (!check.ok) {
      this.showNotification(check.reason || 'Alias ownership verification failed.', 'error');
      return;
    }

    this.showNotification(
      DOMAIN_VALIDATION_CONFIG.enforceOwnership
        ? `Alias "${alias}" verified — updating config…`
        : `Alias "${alias}" saved as write-target — updating config…`,
      'success',
    );
    await this.updateConfig([...this.aliases, alias]);
  }

  /**
   * 'Remove alias' flow: drops the alias from the write-target list and
   * persists the reduced list. The next EVM update clears the removed alias's
   * on-chain record (empty value) so it stops resolving.
   */
  private async removeAlias(alias: string) {
    const next = this.aliases.filter((a) => a !== alias);
    this.showNotification(`Alias "${alias}" removed — updating config…`, 'success');
    await this.updateConfig(next);
  }

  private async updateConfig(aliasesOverride?: string[]) {
    const existingCid = await this.safeIntegration.getRecord('config');
    const repo = await this.safeIntegration.getRecord('repo');
    const publicationUrl = await this.safeIntegration.getRecord('name');
    const pInfo = await this.protocolIntegration.getInfo();

    const ipfs = this.makeIPFS();

    console.log(import.meta.env.VITE_GITHUB_TOKEN);

    const assets = new AssetsBuilder(ipfs, import.meta.env.VITE_GITHUB_TOKEN);

    const [owner, repoName] = repo.split('/').slice(3);

    const { cid: assetsCid } = await assets.buildAssets(
      owner,
      repoName,
      'main',
      publicationUrl,
      this.safeIntegration.getSafeInfo().s2sPublication || '',
    );

    const config = new ConfigBuilder(ipfs, import.meta.env.VITE_GITHUB_TOKEN);

    const { cid: configCid, config: publicationConfig } = await config.buildConfig(
      owner,
      repoName,
      'main',
      publicationUrl,
      this.safeIntegration.getSafeInfo().s2sPublication || '',
      assetsCid,
      existingCid,
      undefined, // legacy `domain` — the tab now manages the multi-alias list
      aliasesOverride,
    );

    console.log('[config] templateCid from builder:', publicationConfig.templateCid);
    console.log('[config] configCid from builder:', configCid);
    // Keep the current write-targets in sync with what we just built. Without
    // an override the existing config's aliases (or legacy domain) are carried
    // through, so previously-set targets survive later plain 'Update' runs.
    this.aliases = Array.isArray(publicationConfig.aliases)
      ? publicationConfig.aliases.slice()
      : publicationConfig.domain
        ? [publicationConfig.domain]
        : [];

    console.log('cid from kubo', configCid);

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
    const oldConfigCid = store.getRecord('config');
    const executionUrl = await this.safeIntegration.setRecord('config', configCid);
    window.open(executionUrl, '_blank');

    // Mark changed keys for yellow highlight (before store update so the first
    // subscriber-triggered render already has the class)
    this.changedKeys.add('config');
    const oldRepo = store.getRecord('repo');
    if (oldRepo !== repo) {
      this.changedKeys.add('repo');
    }
    this.requestUpdate();

    // Optimistic local update so the new value shows immediately
    store.setRecord({ key: 'config', value: configCid, type: 'content' });
  }

  /**
   * Upload config data to Filecoin Storage (on-chain).
   * Fire-and-forget — never throws, never blocks the Safe tx flow.
   */
  private async tryFilecoinUpload(data: unknown, kind: string = ''): Promise<void> {
    try {
      const publicationAddress = this.safeIntegration.getSafeInfo().s2sPublication || '';
      const result = await this.storage.uploadJson(data, [publicationAddress], kind);
      console.log(
        '[filecoin] config uploaded:',
        result.rootCid,
        result.pieceCid,
        kind ? `(${kind})` : '',
      );
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
      const result = await this.storage.uploadTree(
        carBytes,
        [publicationAddress].filter(Boolean),
        kind,
      );
      console.log(
        '[filecoin] tree uploaded to Filecoin:',
        result.rootCid,
        result.pieceCid,
        kind ? `(${kind})` : '',
      );
    } catch (err) {
      console.warn('[filecoin] uploadTree failed (non-fatal):', err);
    }
  }

  private async loadStorage() {
    this.loadingStorage = true;

    const safeAddress = this.safeIntegration.getSafeInfo().s2sPublication || '';
    if (!safeAddress) {
      console.warn('[filecoin] no publication address — skipping storage listing');
      this.loadingStorage = false;
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
    setTimeout(
      () => document.body.contains(notification) && document.body.removeChild(notification),
      5000,
    );
  }

  private valueTemplate(record: OnChainRecord) {
    if (record.key === 'config' && record.value) {
      return html`<a href="https://ipfs.io/ipfs/${record.value}" target="_blank" rel="noopener noreferrer" style="color: var(--blue-400); font-size: 0.875rem; word-break: break-all;">${record.value} ↗</a>`;
    }
    if (record.key === 'repo' && record.value) {
      return html`<a href="${record.value}" target="_blank" rel="noopener noreferrer" style="color: var(--blue-400); font-size: 0.875rem; word-break: break-all;">${record.value} ↗</a>`;
    }
    return html`<span style="font-size: 0.875rem; color: var(--gray-50); word-break: break-all;">${record.value}</span>`;
  }

  render() {
    console.count('render');

    const records = this.filteredRecords; // ← already an array, null-safe
    const hasCache = records.length > 0; // ← was store.getAllRecords().length which threw on null

    if (!hasCache && this.fetching) {
      return html`<div class="loading"><p>Loading records...</p></div>`;
    }

    return html`
      <div class="section">
        <div class="alias-section">
          <h3 class="section-title" style="margin-top: 1.5rem;">Aliases</h3>
          ${this.aliases.length > 0
            ? html`
                <div class="alias-pills">
                  ${this.aliases.map(
                    (alias) => html`
                      <span class="alias-pill">
                        ${alias}
                        <button
                          class="alias-pill__remove"
                          aria-label="Remove ${alias}"
                          title="Remove ${alias}"
                          @click=${() => void this.removeAlias(alias)}
                        >
                          <ph-x size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-x>
                        </button>
                      </span>
                    `,
                  )}
                </div>
              `
            : html`<p class="domain-current">No custom write-targets set — the contenthash is written to the default subdomain of the publication name.</p>`}
          <div style="margin-top: 0.75rem;">
            <s2s-sliding-add-button
              placeholder="e.g. s3ntiment.eth"
              buttonLabel="Add"
              @s2s-sliding-add=${(e: CustomEvent) => void this.addAlias(e.detail.value)}
            ></s2s-sliding-add-button>
          </div>
        </div>

        <div class="list_header" style="margin-top: 2rem;">
          <h2 class="section-title">Records (${records.length})</h2>
        </div>

        ${records.length > 0
          ? html`
              <div class="table">
                <div class="table-header">Key</div>
                <div class="table-header">Value</div>
                <div class="table-header"></div>

                ${records.map((record) => {
                  const isChanged = this.changedKeys.has(record.key);
                  const rowClass = isChanged ? 'table-row record-changed' : 'table-row';
                  return html`
                    <div class="${rowClass}">
                      <div class="table-cell" style="font-size: 0.875rem; color: var(--gray-50);">
                        ${record.key}
                      </div>

                      <div class="table-cell">
                        ${this.editingKey === record.key
                          ? html`<input
                              type="text"
                              class="record-value-input"
                              value="${record.value}"
                              id="edit-value-${record.key}"
                            />`
                          : this.valueTemplate(record)}
                      </div>

                      <div class="table-cell">
                        ${this.editingKey === record.key
                          ? html`
                              <div style="display: flex; gap: 0.5rem;">
                                <button class="button thin"
                                  @click=${() => {
                                    const input = this.renderRoot.querySelector(
                                      `#edit-value-${record.key}`,
                                    ) as HTMLInputElement;
                                    if (input) void this.updateRecord(record.key, input.value);
                                  }}><ph-check size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-check> Save</button>
                                <button class="button button-secondary thin" @click=${this.cancelEdit}><ph-x size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-x> Cancel</button>
                              </div>
                            `
                          : record.key === 'config'
                            ? html`
                                <div style="display: flex; gap: 0.5rem;">
                                  <button class="button thin" @click=${() => void this.updateConfig()}><ph-arrow-clockwise size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-arrow-clockwise> Update</button>
                                </div>
                              `
                            : html`
                              <div style="display: flex; gap: 0.5rem;">
                                <button class="button thin" @click=${() => this.startEdit(record.key)}><ph-pencil-simple size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-pencil-simple> Edit</button>
                                <button class="button button-danger thin" @click=${() => void this.deleteRecord(record.key)}><ph-trash size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-trash> Delete</button>
                              </div>
                            `}
                      </div>
                    </div>
                  `;
                })}
              </div>
            `
          : html`
              <div class="empty-state">
                <div><ph-file-text size="${ICON_SIZE_LARGE}" weight="${ICON_WEIGHT}"></ph-file-text></div>
                <p>${this.searchTerm ? 'No records match your search' : 'No records yet'}</p>
              </div>
            `}
      </div>
    `;
  }
}
