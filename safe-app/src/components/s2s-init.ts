// s2s-init.ts — "New publication" component (SPEC-hosts.md AD-3).
//
// Shown by <s2s-app> when the loaded Safe has neither the records nor the
// publication module. It drives the two-proposal init flow end-to-end using
// the exported building blocks of publication-init.ts (the pure lib, PR #147):
//
//   1. propose create-batch  (buildCreateModuleBatch)   → Safe queue URL
//   2. await execution, detect module addresses          (detectModuleAddresses)
//   3. propose enable-batch  (buildEnableModuleBatch)    → Safe queue URL
//   4. await enable execution, then propose name record  (buildNameRecordBatch)
//
// Step 4 waits for the human to EXECUTE the enable batch in the Safe app
// before proposing the name record — verification used to run immediately
// after proposing and failed whenever the enable batch was still pending
// in the queue (the real-world init failure).
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
import './s2s-sliding-add-button.js';
import './s2s-button.js';
import './pet-name.js';
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

/** How long to wait for the enable batch to be executed in the Safe app. */
const DEFAULT_ENABLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_ENABLE_POLL_INTERVAL_MS = 2_000;

/** Suffix appended to the publication name (displayed and recorded). */
const SOUL2SOUL_ETH = '.soul2soul.eth';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

type Step =
  | 'idle'
  | 'creating'
  | 'detecting'
  | 'enabling'
  | 'awaiting-enable'
  | 'naming'
  | 'done'
  | 'error';

@customElement('s2s-publication-init')
export class S2SPublicationInit extends LitElement {
  /** Duck-typed SafeIntegration (see InitSafeIntegration). */
  @property({ attribute: false }) safeIntegration?: InitSafeIntegration;

  /** Deployed factory addresses (recordsFactory + publicationFactory). */
  @property({ attribute: false }) protocolInfo?: ProtocolInfo;

  /** How long to wait for the enable batch to be executed in the Safe app. */
  @property({ type: Number }) enableTimeoutMs = DEFAULT_ENABLE_TIMEOUT_MS;
  /** Poll interval while waiting for the enable batch to be executed. */
  @property({ type: Number }) enablePollIntervalMs = DEFAULT_ENABLE_POLL_INTERVAL_MS;

  /** The current Safe (safeAddress / chainId / owners). */
  @property({ attribute: false }) safeInfo?: SafeInfo;

  /** Publication name label (the .soul2soul.eth suffix is appended). */
  @state() private name = '';
  @state() private nameError = '';
  @state() private authors: string[] = [];
  @state() private step: Step = 'idle';
  @state() private proposals: string[] = [];
  @state() private error = '';

  static styles = [
    typograhyStyles,
    buttonStyles,
    css`
      :host {
        display: block;
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

      .init__name {
        display: flex;
        align-items: stretch;
      }

      .init__input {
        width: 240px;
        box-sizing: border-box;
        padding: 0.5rem 0.75rem;
        border-radius: 6px 0 0 6px;
        border: 1px solid var(--gray-500);
        background: var(--gray-900);
        color: var(--gray-50);
        font-family: var(--font-mono);
        font-size: 0.85rem;
        outline: none;
      }

      .init__input:focus {
        border-color: var(--accent);
      }

      .init__suffix {
        display: inline-flex;
        align-items: center;
        padding: 0.5rem 0.75rem;
        border-radius: 0 6px 6px 0;
        border: 1px solid var(--gray-500);
        border-left: none;
        background: var(--gray-900);
        color: var(--gray-400);
        font-family: var(--font-mono);
        font-size: 0.85rem;
        white-space: nowrap;
      }

      .init__name-error {
        margin-top: 0.35rem;
        font-size: 0.8rem;
        color: #ffb4b4;
      }

      .alias-pills {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
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
    if (this.authors.length === 0 && owners?.length) {
      this.authors = [...new Set(owners)];
    }
  }

  private get safeAddress(): string {
    return this.safeInfo?.safeAddress ?? '';
  }

  /** Reset to the form (also used as "try again" after an error). */
  private readonly reset = (): void => {
    this.step = 'idle';
    this.error = '';
    this.proposals = [];
  };

  private fail(message: string): void {
    this.error = message;
    this.step = 'error';
  }

  private readonly onNameInput = (e: Event): void => {
    this.name = (e.target as HTMLInputElement).value;
    if (this.nameError) this.nameError = '';
  };

  private readonly addAuthor = (value: string): void => {
    const address = value.trim();
    if (!ADDRESS_RE.test(address)) return;
    if (this.authors.includes(address)) return;
    this.authors = [...this.authors, address];
  };

  private readonly removeAuthor = (address: string): void => {
    this.authors = this.authors.filter((a) => a !== address);
  };

  private async start(): Promise<void> {
    const si = this.safeIntegration;
    const info = this.protocolInfo;
    const safeAddress = this.safeAddress;

    if (!si || !info || !safeAddress) {
      this.fail('Not connected to a Safe yet. Reload the app inside the Safe and try again.');
      return;
    }

    const label = this.name.trim();
    if (!label) {
      this.nameError = 'Publication name is required.';
      return;
    }

    this.error = '';
    this.proposals = [];
    const publicationName = `${label}${SOUL2SOUL_ETH}`;

    try {
      // 1. Propose create-batch (both modules from their factories).
      this.step = 'creating';
      const createBatch = buildCreateModuleBatch(info, safeAddress, this.authors);
      const createUrl = await si.proposeBatch(createBatch);
      this.proposals = [createUrl];
      this.step = 'detecting';

      // 2. Await execution and detect the deployed module addresses.
      //    The human must open the Safe app and execute proposal 1 for the
      //    ModuleCreated logs to appear — detection polls until they do.
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
      const enableBatch = buildEnableModuleBatch(safeAddress, recordsModule, publicationModule);
      const enableUrl = await si.proposeBatch(enableBatch);
      this.proposals = [...this.proposals, enableUrl];

      // 3b. Wait for the human to EXECUTE the enable batch in the Safe queue
      //     before proposing the name record — verification used to run
      //     immediately after proposing and failed whenever the enable batch
      //     was still pending (the real-world init failure).
      this.step = 'awaiting-enable';
      const enableStart = Date.now();
      for (;;) {
        const [recordsEnabled, publicationEnabled] = await Promise.all([
          si.readIsModuleEnabled(recordsModule),
          si.readIsModuleEnabled(publicationModule),
        ]);
        if (recordsEnabled && publicationEnabled) break;
        if (Date.now() - enableStart > this.enableTimeoutMs) {
          const missing: string[] = [];
          if (!recordsEnabled) missing.push('records');
          if (!publicationEnabled) missing.push('publication');
          this.fail(
            `Timed out waiting for the enable proposal to be executed — not enabled: ${missing.join(', ')}. ` +
              'Open the enable proposal in the Safe app, execute it, then try again.',
          );
          return;
        }
        await new Promise((r) => setTimeout(r, this.enablePollIntervalMs));
      }

      // 4. Record the publication name.
      this.step = 'naming';
      const nameBatch = buildNameRecordBatch(recordsModule, publicationName);
      const nameUrl = await si.proposeBatch(nameBatch);
      this.proposals = [...this.proposals, nameUrl];

      this.step = 'done';
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
    if (this.proposals.length === 0) return '';
    return html`
      <ul class="init__proposals">
        ${this.proposals.map(
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
      this.step === 'awaiting-enable' ||
      this.step === 'naming';
    if (!running) return '';

    const labels: Partial<Record<Step, string>> = {
      creating: 'Proposing module creation…',
      detecting: 'Waiting for proposal 1 to be executed…',
      enabling: 'Proposing module enable…',
      'awaiting-enable': 'Waiting for proposal 2 to be executed…',
      naming: 'Proposing name record…',
    };

    return html`
      <div class="init__status">
        <span class="init__spinner" aria-hidden="true"></span>
        <span>${labels[this.step]}</span>
      </div>
      ${this.renderProposals()}
    `;
  }

  render() {
    if (this.step === 'done') {
      return html`
        <h2>Publication initialized</h2>
        <div class="init__success">
          Records and Publication modules are installed and enabled on this Safe.
        </div>
        ${this.renderProposals()}
      `;
    }

    if (this.step === 'error') {
      return html`
        <h2>Initialization failed</h2>
        <div class="init__error">${this.error}</div>
        <div class="init__actions">
          <button class="button" @click=${this.reset}>Try again</button>
        </div>
      `;
    }

    if (this.step !== 'idle') {
      return html`
        <h2>Initializing publication</h2>
        ${this.renderWorking()}
      `;
    }

    return html`
      <h2>New publication</h2>

      <div class="init__field">
        <label class="init__label" for="init-name">Publication name</label>
        <div class="init__name">
          <input
            id="init-name"
            class="init__input"
            .value=${this.name}
            placeholder="my-publication"
            @input=${this.onNameInput}
          />
          <span class="init__suffix">${SOUL2SOUL_ETH}</span>
        </div>
        ${this.nameError ? html`<div class="init__name-error">${this.nameError}</div>` : ''}
      </div>

      <div class="init__field">
        <label class="init__label">Authors</label>
        <div class="alias-pills">
          ${this.authors.map(
            (author) => html`
              <span class="alias-pill">
                <pet-name value=${author}></pet-name>
                <button
                  class="alias-pill__remove"
                  data-address="${author}"
                  aria-label="Remove ${author}"
                  title="Remove ${author}"
                  @click=${() => {
                    this.removeAuthor(author);
                  }}
                >
                  <ph-x size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-x>
                </button>
              </span>
            `,
          )}
          <s2s-sliding-add-button
            placeholder="Author address (0x...)"
            buttonLabel="Add author"
            @s2s-sliding-add=${(e: CustomEvent<{ value: string }>) => {
              this.addAuthor(e.detail.value);
            }}
          ></s2s-sliding-add-button>
        </div>
      </div>

      <div class="init__actions">
        <s2s-button type="primary" id="init-start" @click=${() => void this.start()}
          >Create</s2s-button
        >
      </div>
    `;
  }
}
