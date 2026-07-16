// s2s-storage-tab.ts
import { FilecoinStorage } from '@s2s/soul2soul-shared/filecoin';
import { store, StoragePiece, PublicationDataSet } from '../state/index.js';
import { tableStyles } from '../styles/table-styles.js';
import { sectionStyles } from '@/styles/section-styles.js';
import { typograhyStyles } from '@/styles/typography-styles.js';
import { buttonStyles } from '@/styles/button-styles.js';

export class S2SStorageTab extends HTMLElement {
  private storage!: FilecoinStorage;
  private loading = true;
  private fetching = false;
  private deleting = new Set<string>(); // "dataSetId:pieceId" keys
  private terminating = new Set<string>(); // dataSetIds being terminated
  private unsubscriber: (() => void) | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot!.adoptedStyleSheets = [typograhyStyles, sectionStyles, tableStyles, buttonStyles];
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

    const pieces = store.pieces;
    const datasets = store.dataSets;

    // ── Cost summary ──
    let costHtml = '';
    if (pieces.length > 0 && pieces.some(p => p.confirmed)) {
      const cost = FilecoinStorage.estimateMonthlyCostFromPieces(pieces);
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
      <div class="table-header">Piece CID</div>
      <div class="table-header">Root CID</div>
      <div class="table-header">Kind</div>
      <div class="table-header">Size</div>
      <div class="table-header">Data Set</div>
      <div class="table-header">Provider</div>
      <div class="table-header">State</div>
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
      <div class="table-header">Data Set</div>
      <div class="table-header">Provider</div>
      <div class="table-header">Pieces</div>
      <div class="table-header">State</div>
      <div class="table-header">End Epoch</div>
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
                  datSkip to content
foc

Search
Ctrl
K
Github
X
Select theme
Auto
About Filecoin Onchain Cloud
Why Filecoin Onchain Cloud?
Foundations & Architecture
Proof of Data Possession (PDP)
Filecoin Pay
Filecoin Warm Storage Service
Retrieval
Filecoin Pin
Quick Start with Synapse SDK
Quick Start with Filecoin Pin
Overview
Synapse SDK
Synapse Core
Synapse React
Session Keys
Storage Operations
Storage Costs
Upload Pipeline
Migration Guide
On this page
Overview
Pricing Components
Recurring rates
One-time fees
Real-World Cost Examples
How the fees and lockup work
Querying Upload Costs
Upload Preparation
Account Queries
Next Steps
Storage Costs

Copy Markdown

Open
Understanding storage costs helps you budget effectively and avoid service interruptions. This guide covers the SDK APIs for calculating costs, funding your account, and querying account state.

How It Works

For a conceptual overview of how payments work: deposits, payment rails, lockup, and what happens when funds run low, see the Payments & Storage cookbook.

Storage operates on a pay-per-epoch model where you deposit USDFC tokens and set allowances that control how much the storage service can spend.

What is an Epoch?

An epoch is Filecoin’s block time, which is 30 seconds. Storage costs are calculated per epoch, ensuring you only pay for the storage time you actually use.

Pricing Components
Pricing has two recurring rates and a set of small one-time fees.

Recurring rates
Component	Cost	Notes
Storage	$2.50/TiB/month per copy	Charged only while pieces exist. Empty data sets have no recurring cost.
Proving Service	$0.024/data set/month	Flat per-data-set fee, added on top of the storage rate.
CDN egress	up to $14/TiB (≈ $0.014/GiB) downloaded	Optional, via Filecoin Beam. About half this when served from cache.
Be aware

“Month” means 30 days here (86,400 epochs), not a calendar month.

The monthly rate for an active data set is (bytes / TiB) × $2.50 + $0.024. There is no minimum floor: a data set with no pieces has no recurring cost, and the rate activates when the first piece is added.

One-time fees
Each on-chain operation pays a small fee to the storage provider, covering the gas that provider spends on your behalf:

Operation	Fee
Create data set	$0.025
Add pieces	$0.0005 + $0.0003 per piece
Schedule piece removals	$0.002 per call
Terminate service	$0.00112 (user-initiated only)
These are fractions of a cent. Think of them like gas: negligible for normal use, only adding up at very high operation volumes. They are paid from a small lockup reserve (~$0.10) held while the data set is active, not billed separately on every call. See How the fees and lockup work below.

CDN setup

Enabling CDN adds two refundable lockups on first use: ~0.7 USDFC for egress credits and ~0.3 USDFC for cache-miss credits. Reusing an existing CDN data set incurs no new setup. These are lockups, not fees, and are returned when the rail is finalized if unused.

Real-World Cost Examples
These examples use plain arithmetic for clarity. For programmatic cost calculation, use getUploadCosts() — see Querying Upload Costs below.

Example 1: NFT Collection (10,000 × 5 KiB ≈ 48.82 MiB)
// 48.82 MiB is tiny, so the storage rate is negligible.
// The recurring cost is dominated by the flat proving fee.
const STORAGE_PRICE_PER_TIB_PER_MONTH = 2.5;
const PROVING_FEE_PER_MONTH = 0.024;

const storageTiB = 48.82 / 1024 / 1024; // ≈ 0.0000466 TiB
const storageCostPerMonth = storageTiB * STORAGE_PRICE_PER_TIB_PER_MONTH; // ≈ $0.00012

// Per copy, per month
const costPerMonth = storageCostPerMonth + PROVING_FEE_PER_MONTH; // ≈ 0.0241 USDFC
const costFor24Months = costPerMonth * 24; // ≈ 0.578 USDFC

Duration	Per copy
1 month	≈ 0.024 USDFC
24 months	≈ 0.58 USDFC
The default 2-copy configuration roughly doubles the recurring cost. One-time fees apply once: $0.025 to create the data set plus the per-batch add-pieces fee.

Example 2: User Content Platform with CDN
Storage: 1,000 users × 100 MiB ≈ 100,000 MiB
Traffic: 1,000 users × 100 MiB/month ≈ 100,000 MiB/month egress
const STORAGE_PRICE_PER_TIB_PER_MONTH = 2.5; // $2.50/TiB/month
const PROVING_FEE_PER_MONTH = 0.024; // flat per-data-set
const CDN_EGRESS_PRICE_PER_TIB = 14; // up to $14/TiB on a cache miss
const storageMiB = 100_000;
const egressMiB = 100_000;

// Storage: 100,000 MiB ≈ 0.0953 TiB
const storageTiB = storageMiB / 1024 / 1024;

// Egress: 100,000 MiB ≈ 0.0953 TiB
const egressTiB = egressMiB / 1024 / 1024;

// Storage cost per month: 0.0953 TiB × $2.50 ≈ $0.238/month
const storageCostPerMonth = storageTiB * STORAGE_PRICE_PER_TIB_PER_MONTH;

// Egress cost per month (worst case, all cache misses): 0.0953 TiB × $14 ≈ $1.334/month
const egressCostPerMonth = egressTiB * CDN_EGRESS_PRICE_PER_TIB;

// Total cost per month: $0.238 + $0.024 proving + $1.334 egress ≈ $1.596/month
const totalCostPerMonth = storageCostPerMonth + PROVING_FEE_PER_MONTH + egressCostPerMonth;

// Total cost for 24 months: $1.596/month × 24 ≈ $38.31
const totalCostFor24Months = totalCostPerMonth * 24;

Cost Component	Per Month	24 Months
Storage	≈ 0.238 USDFC	≈ 5.71 USDFC
Proving Service	≈ 0.024 USDFC	≈ 0.576 USDFC
CDN Egress	≈ 1.334 USDFC	≈ 32.016 USDFC
Total	≈ 1.596 USDFC	≈ 38.31 USDFC
Egress here is the worst case where every byte is a cache miss. When content is served from the Filecoin Beam cache, egress is roughly half this.

How the fees and lockup work
Most developers can stop at the tables above. This section explains the mechanics behind the per-operation fees and the lockup reserve for anyone who needs the detail.

The proving fee is additive, not a floor. The rate is (bytes / TiB) × $2.50 + $0.024, so storage scales with size and the proving fee is a flat addition per data set. A data set with no pieces has no recurring charge until the first piece is added.

Add-pieces pricing scales with batch size. Each addPieces call costs $0.0005 + $0.0003 × N, where N is the number of pieces in the batch. The base fee is shared across the batch, so adding many pieces in one call is cheaper per piece than adding them one at a time. When estimating the cost of a single piece, assume the single-piece price ($0.0008); batching only makes it cheaper.

Fees are paid from a small lockup reserve, not billed per call. When a data set is created, ~$0.10 of USDFC is locked as a lifecycle reserve on the data set’s payment rail. One-time fees are drawn from this reserve as operations happen, and the reserve is topped back up toward its target as it is drawn down. You see ~$0.10 of additional locked USDFC while the data set is active. It is refunded when the rail is finalized.

Why the reserve exists: wind-down after termination
Querying Upload Costs
Use getUploadCosts() to preview costs without executing any transaction. This is useful for displaying pricing in a UI or letting users confirm before proceeding. The result reads the on-chain price list, so it reflects the rates, one-time fees, and lockups described above.

Getting the costs for uploading to an existing data set:

// Pass currentDataSetSize so rates reflect the data set's new total size
const { rates, fees, depositNeeded } = await synapse.storage.getUploadCosts({
  isNewDataSet: false,
  currentDataSetSize: 50n * SIZE_CONSTANTS.MiB,
  dataSize: 100n * SIZE_CONSTANTS.MiB,
})
// fees.addPiecesFee is the one-time fee for this upload
// (pass pieceCount when adding more than one piece)

// Without currentDataSetSize, rates cover the new data alone
const costs2 = await synapse.storage.getUploadCosts({
  isNewDataSet: false,
  dataSize: 100n * SIZE_CONSTANTS.MiB,
})

Getting the costs for uploading to a new data set:

const { rates, fees, lockups, depositNeeded, needsFwssMaxApproval, ready } = await synapse.storage.getUploadCosts({
  dataSize: 100n * SIZE_CONSTANTS.MiB,
  isNewDataSet: true,
  withCDN: true,
})

// Storage rate per epoch (30 seconds)
console.log("Rate per epoch:", formatUnits(rates.perEpoch), "USDFC")
// Storage rate per month
console.log("Rate per month:", formatUnits(rates.perMonth), "USDFC")
// One-time fees (create data set + add pieces)
console.log("One-time fees:", formatUnits(fees.total), "USDFC")
// Locked while the data set is active (lifecycle reserve, streaming, CDN)
console.log("Total lockup:", formatUnits(lockups.total), "USDFC")
// USDFC to deposit
console.log("Deposit needed:", formatUnits(depositNeeded), "USDFC")
// Whether FWSS needs to be approved
console.log("Needs approval:", needsFwssMaxApproval)
// Whether the account is ready to upload
console.log("Ready to upload:", ready)

Upload Preparation
Before uploading, the WarmStorage operator must be approved and your account must be funded. FWSS uses a 30-day lockup (prepayment) period. If your account becomes underfunded, the provider may terminate the storage agreement, after which you have 30 days before data removal.

Typical Flow

Query costs → prepare transaction → execute → upload. The prepare() method handles the middle steps in one call.

prepare() computes costs and returns a ready-to-execute transaction. This is the recommended approach — it handles deposit calculation, operator approval, and contract call routing in one step.

const { costs, transaction } = await synapse.storage.prepare({
  dataSize: SIZE_CONSTANTS.GiB,
})

// Inspect costs
const { rates, depositNeeded } = costs // Upload costs breakdown
console.log("Rate per month:", formatUnits(rates.perMonth))
console.log("Deposit needed:", formatUnits(depositNeeded))

// Execute if the account isn't ready
if (transaction) {
  const { depositAmount, includesApproval } = transaction
  console.log("Deposit amount:", formatUnits(depositAmount))
  console.log("Includes approval:", includesApproval)

  const { hash } = await transaction.execute()
  console.log("Transaction confirmed:", hash)
}

// Now safe to upload

When storing data across multiple providers, pass an array of contexts. The SDK aggregates per-context lockup while computing account-level values (debt, runway, buffer) once.

import { Synapse, formatUnits, SIZE_CONSTANTS, TIME_CONSTANTS } from "@filoz/synapse-sdk"
import { privateKeyToAccount } from 'viem/accounts'
const synapse = Synapse.create({ account: privateKeyToAccount('0x...'), source: 'my-app' })

const contexts = await synapse.storage.createContexts({ copies: 3 })

// 1-year runway
const oneYear = TIME_CONSTANTS.EPOCHS_PER_MONTH * 12n

// Prepare a single deposit covering all 3 copies for 1 year
const { costs, transaction } = await synapse.storage.prepare({
  context: contexts,
  dataSize: 50n * SIZE_CONSTANTS.GiB,
  extraRunwayEpochs: oneYear,
})

const { rates, depositNeeded, ready } = costs
console.log("Monthly rate (per copy):", formatUnits(rates.perMonth), "USDFC")
console.log("Total deposit needed:", formatUnits(depositNeeded), "USDFC")
console.log("Account ready:", ready)

if (transaction) {
  const { hash } = await transaction.execute()
  console.log("Funded:", hash)
}

prepare() returns:

costs: The full UploadCosts breakdown
transaction: A transaction object with execute(), or null if the account is already ready
The transaction automatically picks the right contract call:

Needs deposit + approval: calls depositWithPermitAndApproveOperator
Needs approval only: calls approveService
Needs deposit only: calls depositWithPermit
Already ready: returns transaction: null
Account Queries
Read-only APIs for account-level cost visibility.

// Aggregate rate across all active rails
const { ratePerEpoch, ratePerMonth } = await synapse.payments.totalAccountRate()

// Sum of lockupFixed across all rails (including terminated but not finalized)
const { totalFixedLockup } = await synapse.payments.totalAccountLockup()

// Total storage size across all live datasets
import { getAccountTotalStorageSize } from '@filoz/synapse-core/warm-storage'
const { totalSizeBytes, datasetCount } = await getAccountTotalStorageSize(client, {
  address: '0x...',
})

All rate values come in both per-epoch (contract-native) and per-month (ratePerEpoch * EPOCHS_PER_MONTH) units. Note that ratePerMonth from totalAccountRate() is computed as ratePerEpoch * EPOCHS_PER_MONTH — this is slightly less than the full-precision rates.perMonth returned by getUploadCosts() due to integer truncation. See Rate Precision for details.

API Reference

For the full API — including pure calculation functions and lower-level utilities — see the synapse-core pay reference and synapse-core warm-storage reference.

Next Steps
Payments & Storage — Deep dive into the payment model mechanics
StorageManager API Reference — Full SDK storage API
PaymentsService API Reference — Full SDK payments API
Upload Pipeline — Upload workflows from simple to advanced
Storage Operations — Contexts, data sets, and retrieval
Edit page
Last updated: Jun 24, 2026

Previous
Storage Operations
Next
Upload Pipelinea-dataset="${ds.dataSetId}"
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
          width: 2.4rem;
          height: 2.4rem;
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

      ${pieces.length === 0 ? `
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

        <div class="table">
          ${pieceHeader}
          ${pieceRows}
        </div>

        <div class="toolbar ds-section-title">
          <div class="section-title">
            <h2>Data Sets (${datasets.length})</h2>
          </div>
        </div>

        <div class="table table-datasets">
          ${dsHeader}
          ${dsRows}
        </div>
      `}
    `;

    this.attachEventListeners();
  }

  private attachEventListeners() {
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