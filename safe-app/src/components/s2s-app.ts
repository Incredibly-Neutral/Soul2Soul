// s2s-app.ts
import { SafeIntegration } from '../lib/safe-integration.js';
import './s2s-deals-tab.js';
import './s2s-whitelist-tab.js';
import './s2s-records-tab.js';
import './s2s-storage-tab.js';
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
import { tabStyles } from '@/styles/tab-styles.js';
import { browserFilecoinBuilder } from '../filecoin/car-builder.js';

const RECORDS_CONTRACT_ABI = [
  'function getText(bytes32 node, string key) view returns (string)',
  'function setText(bytes32 node, string key, string value) nonpayable',
];

export class S2SApp extends HTMLElement {
  private safeIntegration: SafeIntegration;
  private protocolIntegration: ProtocolIntegration;
  private lit: LitService;
  private filecoinStorage: FilecoinStorage;
  private fcInitPromise: Promise<void> | null = null;
  private currentTab: 'deals' | 'whitelist' | 'records' | 'storage' = 'deals';
  private fetching = false;
  private unsubscribers: Array<() => void> = [];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot!.adoptedStyleSheets = [mainStyles, tabStyles, typograhyStyles, pillStyles];
    this.safeIntegration = new SafeIntegration();
    this.protocolIntegration = new ProtocolIntegration();
    this.lit = new LitService({ environment: 'prod' });
    this.filecoinStorage = new FilecoinStorage({}, browserFilecoinBuilder);
    this.fcInitPromise = this.initFC()

  }

  async initFC() {
    console.log("FC init")

    const skRes  = await fetch('/session-key.json');
    const skData = await skRes.json();
    const rpcUrl = 'https://lb.drpc.live/filecoin/REDACTED'; // 'https://rpc.ankr.com/filecoin' // 'https://api.node.glif.io/rpc/v1',
     await this.filecoinStorage.initWithSessionKey(
        skData,
        rpcUrl 
      );
      console.log("FC inititalised")
  }

  async connectedCallback() {
    // Subscribe to every store slice that affects the view;
    // each setter in fetchFreshData will trigger re-renders automatically.
    this.unsubscribers = [
      store.subscribeToSafeInfo(() => this.render()),
      store.subscribeToProtocolInfo(() => this.render()),
      store.subscribeToRoot(() => this.render()),
      store.subscribeToRecords(() => this.render()), // covers publication (name record)
    ];

    // Phase 1 — render immediately from whatever is cached in localStorage via the store
    this.render();

    // Phase 2 — fetch fresh data; store updates drive subsequent renders
    await this.fetchFreshData();
  }

  disconnectedCallback() {
    this.unsubscribers.forEach(unsub => unsub());
    this.unsubscribers = [];
  }

  private async fetchFreshData() {
    this.fetching = true;
    this.render();

    try {
      const safeInfo = await this.safeIntegration.initialize();
      store.setSafeInfo(safeInfo);

      const protocolInfo = await this.protocolIntegration.initialize();
      store.setProtocolInfo(protocolInfo);
      console.log(protocolInfo)

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
          const typed = freshPieces.map(p => ({ ...p, confirmed: true }));
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
    this.render();
  }

  private switchTab(tab: 'deals' | 'whitelist' | 'records' | 'storage') {
    this.currentTab = tab;
    this.render();
  }

  private render() {
    if (!this.shadowRoot) return;

    // All view values come exclusively from the store
    const safeInfo    = store.safeInfo;
    const rootCid     = store.getRoot() ?? '';
    const publication = store.getRecord('name') ?? '';
    const hasCache    = !!safeInfo;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          min-height: 100vh;
        }
      </style>

      ${!hasCache && this.fetching ? `
        <div class="loading">
          <div class="spinner"></div>
          <p>Loading Soul2Soul Safe App...</p>
        </div>
      ` : `
        <div class="container">

          <div class="header">

            ${this.fetching ? `<div class="refreshing-badge">Refreshing…</div>` : ''}

            <div class="module-status">
              <div class="pill safe-status ${this.safeIntegration.isConnected() ? 'module-active' : 'module-inactive'}">
                ${this.safeIntegration.isConnected() ? 'Connected to Safe' : 'Not Connected'}
              </div>
              <div class="pill module-badge ${this.safeIntegration.hasPublicationModule() ? 'module-active' : 'module-inactive'}">
                <copy-module value="${safeInfo?.s2sPublication ?? ''}" label="Publication Module"></copy-module>
              </div>
              <div class="pill module-badge ${this.safeIntegration.hasRecordsModule() ? 'module-active' : 'module-inactive'}">
                <copy-module value="${safeInfo?.s2sRecords ?? ''}" label="Records Module"></copy-module>
              </div>
            </div>

            <h1 class="title">Soul2Soul Publication Manager</h1>

            <div class="web-status">
              <div><copy-hash>${rootCid}</copy-hash></div>
              <div><a href="https://${rootCid}.preview.transport-union.dev" target="_blank">preview</a></div>
              <div><a href="https://${publication}.limo" target="_blank">${publication}.limo</a></div>
            </div>

          </div>

          ${!this.safeIntegration.hasPublicationModule() && !this.safeIntegration.hasRecordsModule() ? `
            <div class="error-message">
              ⚠️ No S2S modules found. Please install the Publication Module and/or Records Module first.
            </div>
          ` : ''}

          <div class="tabs">
            <button
              class="tab ${this.currentTab === 'deals' ? 'active' : ''}"
              id="deals-tab"
              ${!this.safeIntegration.hasPublicationModule() ? 'disabled' : ''}
            >Deals</button>
            <button
              class="tab ${this.currentTab === 'whitelist' ? 'active' : ''}"
              id="whitelist-tab"
              ${!this.safeIntegration.hasPublicationModule() ? 'disabled' : ''}
            >Whitelists</button>
            <button
              class="tab ${this.currentTab === 'records' ? 'active' : ''}"
              id="records-tab"
              ${!this.safeIntegration.hasRecordsModule() ? 'disabled' : ''}
            >Records</button>
            <button
              class="tab ${this.currentTab === 'storage' ? 'active' : ''}"
              id="storage-tab"
            >Storage</button>
          </div>

          <div class="tab-content" id="tab-content"></div>

        </div>
      `}
    `;

    if (hasCache || !this.fetching) {
      this.attachEventListeners();
      this.renderCurrentTab();
    }
  }

  private attachEventListeners() {
    this.shadowRoot?.querySelector('#deals-tab')
      ?.addEventListener('click', () => this.switchTab('deals'));
    this.shadowRoot?.querySelector('#whitelist-tab')
      ?.addEventListener('click', () => this.switchTab('whitelist'));
    this.shadowRoot?.querySelector('#records-tab')
      ?.addEventListener('click', () => this.switchTab('records'));
    this.shadowRoot?.querySelector('#storage-tab')
      ?.addEventListener('click', () => this.switchTab('storage'));
  }

  private renderCurrentTab() {
    const tabContent = this.shadowRoot?.querySelector('#tab-content');
    if (!tabContent) return;
    tabContent.innerHTML = '';

    switch (this.currentTab) {
      case 'deals':
        if (this.safeIntegration.hasPublicationModule()) {
          const el = document.createElement('s2s-deals-tab');
          (el as any).safeIntegration = this.safeIntegration;
          (el as any).protocolIntegration = this.protocolIntegration;
          (el as any).lit = this.lit;
          tabContent.appendChild(el);
        }
        break;

      case 'whitelist':
        if (this.safeIntegration.hasPublicationModule()) {
          const el = document.createElement('s2s-whitelist-tab');
          (el as any).safeIntegration = this.safeIntegration;
          tabContent.appendChild(el);
        }
        break;

      case 'records':
        if (this.safeIntegration.hasRecordsModule()) {
          const el = document.createElement('s2s-records-tab');
          (el as any).safeIntegration = this.safeIntegration;
          (el as any).protocolIntegration = this.protocolIntegration;
          (el as any).lit = this.lit;
          (el as any).storage = this.filecoinStorage;
          tabContent.appendChild(el);
        }
        break;

      case 'storage':
        {
          const el = document.createElement('s2s-storage-tab');
          (el as any).storage = this.filecoinStorage;
          tabContent.appendChild(el);
        }
        break;
    }
  }
}

customElements.define('s2s-app', S2SApp);