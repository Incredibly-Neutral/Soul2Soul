// s2s-app.ts
import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { SafeIntegration } from '../lib/safe-integration.js';
import './s2s-deals-tab.js';
import './s2s-whitelist-tab.js';
import './s2s-records-tab.js';
import './s2s-storage-tab.js';
import './s2s-website-tree-tab.js';
import { ProtocolIntegration } from '@/lib/protocol-integration.js';
import { store } from '@/state/store.js';
import { LitService } from '@s2s/soul2soul-shared';
import { FilecoinStorage } from '@s2s/soul2soul-shared/filecoin';
import { mainStyles } from '@/styles/main-styles.js';
import { pillStyles } from '@/styles/pill-styles.js';
import { evmRead } from '@/lib/evm.js';
import { CID } from 'multiformats';
import './copy-link.js';
import './copy-hash.js';
import './copy-module.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { ICON_SIZE, ICON_WEIGHT } from '@/components/icon.js';
import { tabStyles } from '@/styles/tab-styles.js';
import { browserFilecoinBuilder } from '../filecoin/car-builder.js';

const RECORDS_CONTRACT_ABI = [
  'function getText(bytes32 node, string key) view returns (string)',
  'function setText(bytes32 node, string key, string value) nonpayable',
];

@customElement('s2s-app')
export class S2SApp extends LitElement {
  private safeIntegration: SafeIntegration;
  private protocolIntegration: ProtocolIntegration;
  private lit: LitService;
  private filecoinStorage: FilecoinStorage;
  private fcInitPromise: Promise<void> | null = null;

  @state() private currentTab: 'deals' | 'whitelist' | 'records' | 'storage' | 'websiteTree' = 'deals';
  @state() private fetching = false;

  private unsubscribers: Array<() => void> = [];

  static styles = [mainStyles, tabStyles, typograhyStyles, pillStyles];

  constructor() {
    super();
    this.safeIntegration = new SafeIntegration();
    this.protocolIntegration = new ProtocolIntegration();
    this.lit = new LitService({ environment: 'prod' });
    this.filecoinStorage = new FilecoinStorage({}, browserFilecoinBuilder);
    this.fcInitPromise = this.initFC();
  }

  async initFC() {
    const skRes = await fetch('/session-key.json');
    const skData = await skRes.json();
    const rpcUrl = 'https://lb.drpc.live/filecoin/AouQTyDbwExLrOsOS2mMBR_2kteqUQMR8az6tiKh6MJI'; // 'https://rpc.ankr.com/filecoin' // 'https://api.node.glif.io/rpc/v1',
    await this.filecoinStorage.initWithSessionKey(skData, rpcUrl);
  }

  connectedCallback() {
    super.connectedCallback();
    // Subscribe to every store slice that affects the view;
    // each setter in fetchFreshData will trigger re-renders automatically.
    this.unsubscribers = [
      store.subscribeToSafeInfo(() => this.requestUpdate()),
      store.subscribeToProtocolInfo(() => this.requestUpdate()),
      store.subscribeToRoot(() => this.requestUpdate()),
      store.subscribeToRecords(() => this.requestUpdate()), // covers publication (name record)
    ];

    // Phase 2 — fetch fresh data; store updates drive subsequent renders
    this.fetchFreshData();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribers.forEach((unsub) => unsub());
    this.unsubscribers = [];
  }

  private async fetchFreshData() {
    this.fetching = true;

    try {
      const safeInfo = await this.safeIntegration.initialize();
      store.setSafeInfo(safeInfo);

      const protocolInfo = await this.protocolIntegration.initialize();
      store.setProtocolInfo(protocolInfo);
      console.log(protocolInfo);

      const [keys, values] = await this.safeIntegration.getAllRecords();
      store.setAllRecords(
        keys.map((key: string, index: number) => ({
          key,
          value: values[index],
          type: 'metadata',
        }))
      );

      const publication = store.getRecord('name');

      if (publication && protocolInfo) {
        const node = window.ethers.namehash(publication);
        const onchainHash = await evmRead(
          8453,
          protocolInfo.ensRecords,
          RECORDS_CONTRACT_ABI,
          'getText',
          [node, 'contenthash_wrapped']
        );

        const hex = onchainHash.slice(6); // strip 0x + ipfs-ns(0xe3) + contenthash-version(0x01)
        const bytes = window.ethers.getBytes('0x' + hex);
        const rootCid = CID.decode(bytes).toV1().toString();
        store.setRoot(rootCid);
      }

      // === Fetch Filecoin storage pieces (store already has cache from constructor) ===
      if (this.filecoinStorage) {
        // Wait for FC init to complete before using storage
        await this.fcInitPromise;

        try {
          const freshPieces = await this.filecoinStorage.listPublicationStorage(
            this.filecoinStorage.walletAddress.toLowerCase()
          );
          const typed = freshPieces.map((p) => ({ ...p, confirmed: true }));
          store.setPieces(typed);

          // Derive datasets from pieces (one pass, no extra chain call)
          const datasetMap = new Map<string, {
            dataSetId: string;
            provider: string;
            pieceCount: number;
            pdpEndEpoch: bigint | null;
            isLive: boolean;
            metadata: Record<string, string>;
          }>();
          for (const p of typed) {
            if (!datasetMap.has(p.dataSetId)) {
              datasetMap.set(p.dataSetId, {
                dataSetId: p.dataSetId,
                provider: p.provider,
                pieceCount: 0,
                pdpEndEpoch: p.pdpEndEpoch,
                isLive: p.isLive,
                metadata: p.dataSetMetadata,
              });
            }
            datasetMap.get(p.dataSetId)!.pieceCount++;
          }
          store.setDataSets(Array.from(datasetMap.values()));
        } catch (e) {
          console.warn('[storage] chain fetch failed, keeping cache:', e);
        }
      }
    } catch (error) {
      console.error('Failed to fetch fresh data:', error);
    }

    this.fetching = false;
  }

  private switchTab(tab: 'deals' | 'whitelist' | 'records' | 'storage' | 'websiteTree') {
    this.currentTab = tab;
  }

  private activeTabTemplate() {
    switch (this.currentTab) {
      case 'deals':
        return this.safeIntegration.hasPublicationModule()
          ? html`<s2s-deals-tab
              .safeIntegration=${this.safeIntegration}
              .protocolIntegration=${this.protocolIntegration}
              .lit=${this.lit}></s2s-deals-tab>`
          : html``;
      case 'whitelist':
        return this.safeIntegration.hasPublicationModule()
          ? html`<s2s-whitelist-tab .safeIntegration=${this.safeIntegration}></s2s-whitelist-tab>`
          : html``;
      case 'records':
        return this.safeIntegration.hasRecordsModule()
          ? html`<s2s-records-tab
              .safeIntegration=${this.safeIntegration}
              .protocolIntegration=${this.protocolIntegration}
              .lit=${this.lit}
              .storage=${this.filecoinStorage}></s2s-records-tab>`
          : html``;
      case 'storage':
        return html`<s2s-storage-tab
          .storage=${this.filecoinStorage}
          .safeIntegration=${this.safeIntegration}
          .protocolIntegration=${this.protocolIntegration}></s2s-storage-tab>`;
      case 'websiteTree':
        return this.safeIntegration.hasRecordsModule()
          ? html`<s2s-website-tree-tab
              .safeIntegration=${this.safeIntegration}
              .lit=${this.lit}></s2s-website-tree-tab>`
          : html``;
    }
  }

  render() {
    // All view values come exclusively from the store
    const safeInfo = store.safeInfo;
    const rootCid = store.getRoot() ?? '';
    const publication = store.getRecord('name') ?? '';
    const hasCache = !!safeInfo;

    if (!hasCache && this.fetching) {
      return html`
        <div class="loading">
          <div class="spinner"></div>
          <p>Loading Soul2Soul Safe App...</p>
        </div>
      `;
    }

    return html`
      <div class="container">
        <div class="header">
          <div class="module-status">
            <div class="pill safe-status ${this.safeIntegration.isConnected() ? 'module-active' : 'module-inactive'}">
              ${this.safeIntegration.isConnected() ? 'Connected to Safe' : 'Not Connected'}
            </div>
            <div class="pill module-badge ${this.safeIntegration.hasPublicationModule() ? 'module-active' : 'module-inactive'}">
              <copy-module .value=${safeInfo?.s2sPublication ?? ''} label="Publication Module"></copy-module>
            </div>
            <div class="pill module-badge ${this.safeIntegration.hasRecordsModule() ? 'module-active' : 'module-inactive'}">
              <copy-module .value=${safeInfo?.s2sRecords ?? ''} label="Records Module"></copy-module>
            </div>
          </div>

          <h1 class="title">${publication}</h1>

          <div class="web-status">
            <div><copy-hash .value=${rootCid}></copy-hash></div>
            <div><a href="https://${rootCid}.preview.transport-union.dev" target="_blank">preview</a></div>
            <div><a href="https://${publication}.limo" target="_blank">${publication}.limo</a></div>
          </div>
        </div>

        ${!this.safeIntegration.hasPublicationModule() && !this.safeIntegration.hasRecordsModule()
          ? html`
              <div class="error-message">
                <ph-warning size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-warning> No S2S modules found. Please install the Publication Module and/or Records Module first.
              </div>
            `
          : ''}

        <div class="tabs">
          <button
            class="tab ${this.currentTab === 'deals' ? 'active' : ''}"
            id="deals-tab"
            ?disabled=${!this.safeIntegration.hasPublicationModule()}
            @click=${() => this.switchTab('deals')}
          >Deals</button>
          <button
            class="tab ${this.currentTab === 'whitelist' ? 'active' : ''}"
            id="whitelist-tab"
            ?disabled=${!this.safeIntegration.hasPublicationModule()}
            @click=${() => this.switchTab('whitelist')}
          >Whitelists</button>
          <button
            class="tab ${this.currentTab === 'records' ? 'active' : ''}"
            id="records-tab"
            ?disabled=${!this.safeIntegration.hasRecordsModule()}
            @click=${() => this.switchTab('records')}
          >Records</button>
          <button
            class="tab ${this.currentTab === 'storage' ? 'active' : ''}"
            id="storage-tab"
            @click=${() => this.switchTab('storage')}
          >Storage</button>
          <button
            class="tab ${this.currentTab === 'websiteTree' ? 'active' : ''}"
            id="website-tree-tab"
            ?disabled=${!this.safeIntegration.hasRecordsModule()}
            @click=${() => this.switchTab('websiteTree')}
          >Tree</button>
        </div>

        <div class="tab-content" id="tab-content">
          ${this.activeTabTemplate()}
        </div>
      </div>
    `;
  }
}
