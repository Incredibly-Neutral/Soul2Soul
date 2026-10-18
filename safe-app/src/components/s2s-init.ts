// s2s-init.ts — "New publication init" component (SPEC-hosts.md AD-3).
//
// Shown by <s2s-app> when the loaded Safe has neither the records nor the
// publication module. It drives the two-proposal init flow end-to-end using
// the exported building blocks of publication-init.ts (the pure lib, PR #147):
//
//   1. propose create-batch  (buildCreateModuleBatch)   → Safe queue URL
//   2. await execution, detect module addresses          (detectModuleAddresses)
//   3. propose enable-batch  (buildEnableModuleBatch)    → Safe queue URL
//   4. (optional) propose name-record batch              (buildNameRecordBatch)
//   5. verify both modules are enabled                   (readIsModuleEnabled)
//
// The component deliberately drives the steps itself (rather than calling the
// single-shot initializePublication) so each Safe-proposal queue URL can be
// surfaced the moment it is created — a human has to open the Safe app and
// execute each proposal before the next step can run.
//
// It depends on the SafeIntegration only through a small duck-typed surface
// (proposeBatch / getProvider / fetchFactoryModuleCreatedLogs /
// readIsModuleEnabled) so component tests can hand-roll a mock — the same
// pattern as the other tabs.

import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { buttonStyles } from '@/styles/button-styles.js';
import { ICON_SIZE, ICON_WEIGHT } from '@/components/icon.js';
import {
  buildCreateModuleBatch,
  buildEnableModuleBatch,
  buildNameRecordBatch,
  detectModuleAddresses,
  type MetaTransactionData,
  type ProtocolInfo,
} from '../lib/publication-init.js';
import type { SafeInfo } from '@/types/index.js';

/**
 * Smallest SafeIntegration surface the init flow needs. The component never
 * imports safe-integration.ts — it is driven by whatever object s2s-app (or a
 * test) hands it, as long as it satisfies this shape.
 */
interface InitSafeIntegration {
  proposeBatch(txs: MetaTransactionData[]): Promise<string>;
  getProvider(): { getBlockNumber(): Promise<number> };
  fetchFactoryModuleCreatedLogs(
    factoryAddress: string,
    safeAddress: string,
    topic0: string,
    fromBlock: number,
  ): Promise<{ topics: string[] }[]>;
  readIsModuleEnabled(moduleAddress: string): Promise<boolean>;
}

/** How long to keep polling for the create-batch execution (human-in-the-loop). */
const DEFAULT_DETECTION_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_LOOKBACK_BLOCKS = 10_000;

type Step =
  | 'idle'
  | 'creating'
  | 'detecting'
  | 'enabling'
  | 'naming'
  | 'verifying'
  | 'done'
  | 'error';

@customElement('s2s-publication-init')
export class S2SPublicationInit extends LitElement {
  /** Duck-typed SafeIntegration (see InitSafeIntegration). */
  @property({ attribute: false }) safeIntegration?: InitSafeIntegration;

  /** Deployed factory addresses (recordsFactory + publicationFactory). */
  @property({ attribute: false }) protocolInfo?: ProtocolInfo;

  /** The current Safe (safeAddress / chainId / owners). */
  @property({ attribute: false }) safeInfo?: SafeInfo;

  @state() private name = '';
  @state() private authorsText = '';
  @state() private step: Step = 'idle';
  @state() private proposals: string[] = [];
  @state() private detail = '';
  @state() private error = '';

  static styles = [
    typograhyStyles,
    buttonStyles,
    css`
      :host {
        display: block;
        padding: 1.5rem;
        border-radius: 8px;
        background: var(--gray-800);
        border: 1px solid var(--gray-600);
        color: var(--gray-50);
      }

      .init__heading {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 1.05rem;
        font-weight: 600;
        margin: 0 0 0.5rem;
      }

      .init__sub {
        margin: 0 0 1.25rem;
        color: var(--gray-400);
        font-size: 0.9rem;
      }

      .init__field {
        margin-bottom: 1rem;
      }

      .init__label {
        display: block;
        margin-bottom: 0.35rem;
        font-size: 0.85rem;
        color: var(--gray-300);
      }

      .init__input,
      .init__textarea {
        width: 100%;
        box-sizing: border-box;
        padding: 0.5rem 0.75rem;
        border-radius: 6px;
        border: 1px solid var(--gray-500);
        background: var(--gray-900);
        color: var(--gray-50);
        font-family: var(--font-mono);
        font-size: 0.85rem;
        outline: none;
      }

      .init__input:focus,
      .init__textarea:focus {
        border-color: var(--accent);
      }

      .init__textarea {
        min-height: 4rem;
        resize: vertical;
      }

      .init__hint {
        margin-top: 0.3rem;
        font-size: 0.78rem;
        color: var(--gray-400);
      }

      .init__status {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        margin-bottom: 0.75rem;
        font-size: 0.9rem;
      }

      .init__spinner {
        width: 1rem;
        height: 1rem;
        border: 2px solid var(--gray-500);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: init-spin 0.8s linear infinite;
        flex-shrink: 0;
      }

      @keyframes init-spin {
        to {
          transform: rotate(360deg);
        }
      }

      .init__detail {
        color: var(--gray-300);
        font-size: 0.85rem;
        margin: 0 0 0.75rem;
      }

      .init__proposals {
        margin: 0.5rem 0 1rem;
        padding: 0;
        list-style: none;
      }

      .init__proposal {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-bottom: 0.4rem;
        font-size: 0.85rem;
      }

      .init__proposal a {
        color: var(--accent);
        font-family: var(--font-mono);
        font-size: 0.8rem;
        word-break: break-all;
      }

      .init__error {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
        padding: 0.75rem;
        margin: 0.5rem 0 1rem;
        border-radius: 6px;
        background: var(--error-bg, #3a1414);
        border: 1px solid var(--error-border, #7a2a2a);
        color: #ffb4b4;
        font-size: 0.85rem;
        white-space: pre-wrap;
      }

      .init__success {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.75rem;
        margin: 0.5rem 0 1rem;
        border-radius: 6px;
        background: var(--success-bg, #123a1a);
        border: 1px solid var(--success-border, #1f5a2c);
        color: #a9e6b4;
        font-size: 0.85rem;
      }

      .init__actions {
        display: flex;
        gap: 0.75rem;
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    // Prefill authors with the Safe's owners the first time we connect.
    // (owners is defensive: some callers pass a partial safeInfo.)
    const owners = this.safeInfo?.owners;
    if (!this.authorsText && owners?.length) {
      this.authorsText = owners.join(', ');
    }
  }

  private parseAuthors(): string[] {
    return [
      ...new Set(
        this.authorsText
          .split(/[\s,]+/)
          .map((a) => a.trim())
          .filter(Boolean),
      ),
    ];
  }

  private get safeAddress(): string {
    return this.safeInfo?.safeAddress ?? '';
  }

  /** Reset to the form (also used as "try again" after an error). */
  private readonly reset = (): void => {
    this.step = 'idle';
    this.error = '';
    this.detail = '';
    this.proposals = [];
  };

  private fail(message: string): void {
    this.error = message;
    this.step = 'error';
  }

  private async start(): Promise<void> {
    const si = this.safeIntegration;
    const info = this.protocolInfo;
    const safeAddress = this.safeAddress;

    if (!si || !info || !safeAddress) {
      this.fail('Not connected to a Safe yet. Reload the app inside the Safe and try again.');
      return;
    }

    this.error = '';
    this.detail = '';
    this.proposals = [];
    const authors = this.parseAuthors();
    const cleanName = this.name.trim();

    try {
      // 1. Propose create-batch (both modules from their factories).
      this.step = 'creating';
      this.detail = 'Proposing module creation...';
      const createBatch = buildCreateModuleBatch(info, safeAddress, authors);
      const createUrl = await si.proposeBatch(createBatch);
      this.proposals = [createUrl];
      this.step = 'detecting';

      // 2. Await execution and detect the deployed module addresses.
      //    The human must open the Safe app and execute proposal 1 for the
      //    ModuleCreated logs to appear — detection polls until they do.
      this.detail = `Proposal 1 (create modules) is in the queue. Open it in the Safe app and execute it — this app continues automatically once it lands on-chain.`;
      const { recordsModule, publicationModule } = await detectModuleAddresses(
        {
          fetchModuleCreatedLogs: (factoryAddress, safe, topic0, fromBlock) =>
            si.fetchFactoryModuleCreatedLogs(factoryAddress, safe, topic0, fromBlock),
          safeAddress,
          recordsFactory: info.recordsFactory,
          publicationFactory: info.publicationFactory,
          getBlockNumber: () => si.getProvider().getBlockNumber(),
        },
        {
          timeoutMs: DEFAULT_DETECTION_TIMEOUT_MS,
          pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
          lookbackBlocks: DEFAULT_LOOKBACK_BLOCKS,
        },
      );

      // 3. Propose enable-batch (Safe self-calls).
      this.step = 'enabling';
      this.detail = 'Proposing module enable...';
      const enableBatch = buildEnableModuleBatch(safeAddress, recordsModule, publicationModule);
      const enableUrl = await si.proposeBatch(enableBatch);
      this.proposals = [...this.proposals, enableUrl];

      // 4. Optional: record the publication name.
      if (cleanName) {
        this.step = 'naming';
        this.detail = 'Proposing name record...';
        const nameBatch = buildNameRecordBatch(recordsModule, cleanName);
        const nameUrl = await si.proposeBatch(nameBatch);
        this.proposals = [...this.proposals, nameUrl];
      }

      // 5. Verify both modules are enabled on the Safe.
      this.step = 'verifying';
      this.detail = 'Verifying modules...';
      const [recordsEnabled, publicationEnabled] = await Promise.all([
        si.readIsModuleEnabled(recordsModule),
        si.readIsModuleEnabled(publicationModule),
      ]);
      if (!recordsEnabled || !publicationEnabled) {
        const missing: string[] = [];
        if (!recordsEnabled) missing.push('records');
        if (!publicationEnabled) missing.push('publication');
        this.fail(
          `Module enable verification failed — not enabled: ${missing.join(', ')}. ` +
            'Check the Safe queue and execute any remaining proposals, then try again.',
        );
        return;
      }

      this.step = 'done';
      this.detail = '';
      this.dispatchEvent(
        new CustomEvent('s2s-init-complete', {
          detail: { recordsModule, publicationModule, proposals: this.proposals },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  private renderProposals(): unknown {
    const links = this.proposals;
    if (!links.length) return '';
    return html`
      <ul class="init__proposals">
        ${links.map(
          (url, i) => html`
            <li class="init__proposal">
              <span>Proposal ${i + 1}:</span>
              <a href=${url} target="_blank" rel="noopener noreferrer">open in Safe app</a>
            </li>
          `,
        )}
      </ul>
    `;
  }

  private renderWorking(): unknown {
    const running =
      this.step === 'creating' ||
      this.step === 'detecting' ||
      this.step === 'enabling' ||
      this.step === 'naming' ||
      this.step === 'verifying';
    if (!running) return '';

    const labels: Partial<Record<Step, string>> = {
      creating: 'Proposing module creation…',
      detecting: 'Waiting for proposal 1 to be executed…',
      enabling: 'Proposing module enable…',
      naming: 'Proposing name record…',
      verifying: 'Verifying modules…',
    };

    return html`
      <div class="init__status">
        <span class="init__spinner" aria-hidden="true"></span>
        <span>${labels[this.step]}</span>
      </div>
      <p class="init__detail">${this.detail}</p>
      ${this.renderProposals()}
    `;
  }

  render() {
    if (this.step === 'done') {
      return html`
        <div class="init__heading">
          <ph-check-circle size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-check-circle>
          Publication initialized
        </div>
        <div class="init__success">
          Records and Publication modules are installed and enabled on this Safe.
        </div>
        ${this.renderProposals()}
      `;
    }

    if (this.step === 'error') {
      return html`
        <div class="init__heading">
          <ph-warning size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-warning>
          Initialization failed
        </div>
        <div class="init__error">${this.error}</div>
        <div class="init__actions">
          <button class="btn" @click=${this.reset}>Try again</button>
        </div>
      `;
    }

    if (this.step !== 'idle') {
      return html`
        <div class="init__heading">
          <ph-rocket size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-rocket>
          Initializing publication
        </div>
        ${this.renderWorking()}
      `;
    }

    return html`
      <div class="init__heading">
        <ph-rocket size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-rocket>
        No S2S modules found
      </div>
      <p class="init__sub">
        This Safe is not yet a Soul2Soul publication. Initialize it now — the app will propose a
        create + enable sequence for the Records and Publication modules, and you approve each step
        in the Safe app.
      </p>

      <div class="init__field">
        <label class="init__label" for="init-name">Publication name (optional)</label>
        <input
          id="init-name"
          class="init__input"
          .value=${this.name}
          placeholder="e.g. my-publication"
          @input=${(e: Event) => (this.name = (e.target as HTMLInputElement).value)}
        />
        <div class="init__hint">
          Stored as a <code>name</code> record on the Records module (proposed in a final step).
          Leave empty to skip.
        </div>
      </div>

      <div class="init__field">
        <label class="init__label" for="init-authors">Authors</label>
        <textarea
          id="init-authors"
          class="init__textarea"
          .value=${this.authorsText}
          placeholder="Comma or space separated addresses — defaults to this Safe's owners"
          @input=${(e: Event) => (this.authorsText = (e.target as HTMLTextAreaElement).value)}
        ></textarea>
        <div class="init__hint">
          Whitelisted authors (addresses that may publish). Defaults to this Safe's owners.
        </div>
      </div>

      <div class="init__actions">
        <button class="btn" id="init-start" @click=${() => void this.start()}>
          Initialize publication
        </button>
      </div>
    `;
  }
}
