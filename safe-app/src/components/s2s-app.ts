// s2s-app.ts
import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { SafeIntegration } from '../lib/safe-integration.js';
import './s2s-deals-tab.js';
import './s2s-init.js';
import './s2s-button.js';
import './s2s-confirm-modal.js';
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
import { buttonStyles } from '@/styles/button-styles.js';
import { buildDeletePublicationBatch } from '../lib/publication-init.js';
import { evmRead } from '@/lib/evm.js';
import { CID } from 'multiformats';
import './copy-link.js';
import './copy-hash.js';
import './copy-module.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { tabStyles } from '@/styles/tab-styles.js';
import { browserFilecoinBuilder } from '@s2s/soul2soul-shared/filecoin/car-builder/browser';

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

  @state() private currentTab: 'deals' | 'whitelist' | 'records' | 'storage' | 'websiteTree' =
    'deals';
  @state() private fetching = false;

  // Reset/teardown: opens a confirmation modal → propose the disable+deleteRecord
  // batch. 'done' closes the modal and surfaces the Safe queue link.
  @state() private resetState: 'idle' | 'confirming' | 'proposing' | 'done' = 'idle';
  @state() private resetUrl: string | null = null;
  @state() private resetError: string | null = null;

  private unsubscribers: Array<() => void> = [];

  static styles = [
    mainStyles,
    tabStyles,
    typograhyStyles,
    pillStyles,
    buttonStyles,
    css`
      .reset-button {
        /* Push the reset action to the right end of the module-status row. */
        margin: auto 0 auto auto;
      }
      .reset-button.armed {
        /* Intensify the warning accent while the reset is armed for confirm. */
        --gb-accent: rgba(219, 66, 51, 0.95);
      }
      .reset-status {
        margin-top: 1rem;
        font-family: var(--font-mono);
        font-size: 0.82rem;
        letter-spacing: 0.04em;
        color: var(--gray-300);
      }
      .reset-status a {
        color: var(--color-yellow);
      }
      .reset-status.error {
        color: var(--color-red);
      }
    `,
  ];

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
    // Same RPC sourcing as the 0xobsidian plugin (settings.rpc_key → DRPC lb,
    // glif fallback) — keeps the Filecoin RPC endpoint configurable instead of
    // a hardcoded API key baked into the bundle.
    const rpcKey = import.meta.env.VITE_DRPC_API_KEY as string | undefined;
    const rpcUrl = rpcKey
      ? `https://lb.drpc.live/filecoin/${rpcKey}`
      : 'https://api.node.glif.io/rpc/v1';
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
        })),
      );

      const publication = store.getRecord('name');

      if (publication && protocolInfo) {
        const node = window.ethers.namehash(publication);
        const onchainHash = await evmRead(
          8453,
          protocolInfo.ensRecords,
          RECORDS_CONTRACT_ABI,
          'getText',
          [node, 'contenthash_wrapped'],
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
          const pubAddress = this.safeIntegration.getSafeInfo().s2sPublication?.toLowerCase() ?? '';
          const freshPieces = await this.filecoinStorage.listPublicationStorage(
            this.filecoinStorage.walletAddress.toLowerCase(),
          );
          // listPublicationStorage returns every wallet piece regardless of
          // attribution, so scope the Storage tab to THIS publication: keep only
          // pieces attributed to the current publication module (the config-update
          // flow attributes uploads to it).
          const scoped = freshPieces.filter((p) => {
            const raw = p.metadata.attributedTo;
            if (!raw) return false;
            try {
              const owners: unknown = JSON.parse(raw);
              return (
                Array.isArray(owners) &&
                owners.map((o) => String(o).toLowerCase()).includes(pubAddress)
              );
            } catch {
              return false;
            }
          });
          const typed = scoped.map((p) => ({ ...p, confirmed: true }));
          store.setPieces(typed);

          // Derive datasets from pieces (one pass, no extra chain call)
          const datasetMap = new Map<
            string,
            {
              dataSetId: string;
              provider: string;
              pieceCount: number;
              pdpEndEpoch: bigint | null;
              isLive: boolean;
              metadata: Record<string, string>;
            }
          >();
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

  /**
   * Reset/start-over: propose the teardown batch (disable both S2S modules +
   * records.deleteRecord("name")). Only runs from the confirmation modal's
   * confirm action — the modal stays open, busy, while the batch is proposed.
   * Human-in-the-loop, like the init flow — the batch lands in the Safe queue.
   */
  private async handleReset(): Promise<void> {
    if (this.resetState !== 'confirming') return;

    const safeInfo = store.safeInfo;
    if (!safeInfo) return;

    this.resetState = 'proposing';
    this.resetError = null;
    try {
      const safeModules = await this.safeIntegration.fetchSafeModules();
      const batch = buildDeletePublicationBatch(
        safeInfo.safeAddress,
        {
          recordsModule: safeInfo.s2sRecords ?? '',
          publicationModule: safeInfo.s2sPublication ?? '',
        },
        safeModules,
      );
      this.resetUrl = await this.safeIntegration.proposeBatch(batch);
      this.resetState = 'done';
    } catch (e) {
      this.resetError = e instanceof Error ? e.message : String(e);
      this.resetState = 'idle';
    }
  }

  /**
   * Fresh publication proposed by the init flow. The name/repo/branch records
   * are proposed but still pending Safe execution, so the chain read in
   * fetchFreshData cannot see them yet — write them to the store optimistically
   * so the title + web-status populate immediately (no reload needed), clear
   * any stale root from a previous publication, then run the first config
   * build automatically on the Config tab.
   */
  private readonly onInitComplete = async (e: Event): Promise<void> => {
    const detail = (e as CustomEvent<{ name?: string; repo?: string; branch?: string } | undefined>)
      .detail;
    const { name, repo, branch } = detail ?? {};

    // Surface the Config tab — the immediate config update below runs there.
    this.currentTab = 'records';
    await this.fetchFreshData();

    // Re-apply the pending (not-yet-executed) records on top of the chain read.
    if (name) store.setRecord({ key: 'name', value: name, type: 'metadata' });
    if (repo) store.setRecord({ key: 'repo', value: repo, type: 'metadata' });
    if (branch) store.setRecord({ key: 'branch', value: branch, type: 'metadata' });
    // A brand-new publication has no content published yet — drop any root that
    // still points at a previous publication's content.
    if (name) store.setRoot('');

    await this.updateComplete;
    const tab = this.renderRoot.querySelector('s2s-records-tab') as {
      updateConfig?: () => Promise<unknown>;
    } | null;
    if (tab?.updateConfig) {
      void tab.updateConfig().catch((err: unknown) => {
        console.error('[s2s-app] immediate config update failed:', err);
      });
    }
  };

  private activeTabTemplate() {
    switch (this.currentTab) {
      case 'deals':
        return this.safeIntegration.hasPublicationModule()
          ? html`<s2s-deals-tab
              .safeIntegration=${this.safeIntegration}
              .protocolIntegration=${this.protocolIntegration}
              .lit=${this.lit}
            ></s2s-deals-tab>`
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
              .storage=${this.filecoinStorage}
            ></s2s-records-tab>`
          : html``;
      case 'storage':
        return html`<s2s-storage-tab
          .storage=${this.filecoinStorage}
          .safeIntegration=${this.safeIntegration}
          .protocolIntegration=${this.protocolIntegration}
        ></s2s-storage-tab>`;
      case 'websiteTree':
        return this.safeIntegration.hasRecordsModule()
          ? html`<s2s-website-tree-tab
              .safeIntegration=${this.safeIntegration}
              .lit=${this.lit}
            ></s2s-website-tree-tab>`
          : html``;
    }
  }

  render() {
    // All view values come exclusively from the store
    const safeInfo = store.safeInfo;
    const rootCid = store.getRoot() ?? '';
    const publication = store.getRecord('name') ?? '';
    const hasCache = !!safeInfo;
    // The init flow is the whole screen until both modules are installed:
    // header status, tabs and tab content are all hidden while it runs.
    const hasModules =
      this.safeIntegration.hasPublicationModule() || this.safeIntegration.hasRecordsModule();

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
            <div
              class="pill safe-status ${this.safeIntegration.isConnected()
                ? 'module-active'
                : 'module-inactive'}"
            >
              ${this.safeIntegration.isConnected() ? 'Connected to Safe' : 'Not Connected'}
            </div>
            <div
              class="pill module-badge ${this.safeIntegration.hasPublicationModule()
                ? 'module-active'
                : 'module-inactive'}"
            >
              <copy-module
                .value=${safeInfo?.s2sPublication ?? ''}
                label="Publication Module"
              ></copy-module>
            </div>
            <div
              class="pill module-badge ${this.safeIntegration.hasRecordsModule()
                ? 'module-active'
                : 'module-inactive'}"
            >
              <copy-module
                .value=${safeInfo?.s2sRecords ?? ''}
                label="Records Module"
              ></copy-module>
            </div>
            ${hasModules
              ? html`
                  <s2s-button
                    type="warning"
                    class="reset-button"
                    id="reset-publication"
                    ?disabled=${this.resetState === 'proposing'}
                    title="Disable the S2S modules and clear the publication name so you can start a new publication."
                    @click=${() => (this.resetState = 'confirming')}
                  >
                    Reset
                  </s2s-button>
                `
              : ''}
          </div>

          ${this.resetUrl
            ? html`
                <div class="reset-status" id="reset-status">
                  Reset proposed — execute it in the
                  <a href=${this.resetUrl} target="_blank" rel="noreferrer">Safe queue</a>, then
                  reload the app to start a new publication.
                </div>
              `
            : ''}
          ${this.resetError
            ? html`
                <div class="reset-status error" id="reset-error">
                  Reset failed: ${this.resetError}
                </div>
              `
            : ''}

          <h1 class="title">${publication}</h1>

          ${hasModules
            ? html`
                <div class="web-status">
                  ${rootCid
                    ? html`
                        <div><copy-hash .value=${rootCid}></copy-hash></div>
                        <div>
                          <a href="https://${rootCid}.preview.transport-union.dev" target="_blank"
                            >preview</a
                          >
                        </div>
                      `
                    : ''}
                  <div>
                    <a href="https://${publication}.limo" target="_blank">${publication}.limo</a>
                  </div>
                </div>
              `
            : ''}
        </div>

        ${!hasModules
          ? html`
              <s2s-publication-init
                .safeIntegration=${this.safeIntegration}
                .protocolInfo=${store.protocolInfo}
                .safeInfo=${safeInfo}
                @s2s-init-complete=${this.onInitComplete}
              ></s2s-publication-init>
            `
          : ''}
        ${hasModules
          ? html`
              <div class="tabs">
                <button
                  class="tab ${this.currentTab === 'deals' ? 'active' : ''}"
                  id="deals-tab"
                  ?disabled=${!this.safeIntegration.hasPublicationModule()}
                  @click=${() => this.switchTab('deals')}
                >
                  Deals
                </button>
                <button
                  class="tab ${this.currentTab === 'whitelist' ? 'active' : ''}"
                  id="whitelist-tab"
                  ?disabled=${!this.safeIntegration.hasPublicationModule()}
                  @click=${() => this.switchTab('whitelist')}
                >
                  Whitelists
                </button>
                <button
                  class="tab ${this.currentTab === 'records' ? 'active' : ''}"
                  id="records-tab"
                  ?disabled=${!this.safeIntegration.hasRecordsModule()}
                  @click=${() => this.switchTab('records')}
                >
                  Config
                </button>
                <button
                  class="tab ${this.currentTab === 'storage' ? 'active' : ''}"
                  id="storage-tab"
                  @click=${() => this.switchTab('storage')}
                >
                  Storage
                </button>
                <button
                  class="tab ${this.currentTab === 'websiteTree' ? 'active' : ''}"
                  id="website-tree-tab"
                  ?disabled=${!this.safeIntegration.hasRecordsModule()}
                  @click=${() => this.switchTab('websiteTree')}
                >
                  Tree
                </button>
              </div>

              <div class="tab-content" id="tab-content">${this.activeTabTemplate()}</div>
            `
          : ''}
      </div>

      <s2s-confirm-modal
        .open=${this.resetState === 'confirming' || this.resetState === 'proposing'}
        headline="Reset publication?"
        message="This disables the S2S Records and Publication modules on this Safe and clears the publication name record. It creates a Safe proposal you must execute — once executed it cannot be undone. You can start a new publication afterwards, which re-creates the modules."
        confirmLabel=${this.resetState === 'proposing' ? 'Proposing…' : 'Confirm reset'}
        .busy=${this.resetState === 'proposing'}
        variant="warning"
        @s2s-confirm=${() => void this.handleReset()}
        @s2s-cancel=${() => (this.resetState = 'idle')}
      ></s2s-confirm-modal>
    `;
  }
}
