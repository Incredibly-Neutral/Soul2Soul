import { describe, it, expect, vi } from 'vitest';
import type { S2SPublicationInit } from '../../src/components/s2s-init';
import type { MetaTransactionData } from '../../src/lib/publication-init';
import { mountLit } from '../helpers/mount';
import '../../src/components/s2s-init';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const SAFE_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const RECORDS_FACTORY = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const PUB_FACTORY = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const RECORDS_MODULE = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const PUB_MODULE = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
const OWNER_A = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc';
const OWNER_B = '0x976EA74026E726554dB657fA54763abd0C3a0aa9';
const QUEUE_URL = 'https://app.safe.global/transactions/queue?safe=8453:0xAbC';

const SAFE_INFO = {
  safeAddress: SAFE_ADDRESS,
  chainId: 8453,
  network: 'base-sepolia',
  modules: [],
  owners: [OWNER_A, OWNER_B],
  threshold: 1,
};

const PROTOCOL_INFO = {
  recordsFactory: RECORDS_FACTORY,
  publicationFactory: PUB_FACTORY,
};

/** Left-pad an address to the 32-byte indexed-topic form (publication-init.ts). */
const pad = (addr: string) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');

const TOPIC0 = '0x' + 'a'.repeat(64);
const PADDED_SAFE = pad(SAFE_ADDRESS);
const PADDED_RECORDS = pad(RECORDS_MODULE);
const PADDED_PUB = pad(PUB_MODULE);

/** Duck-typed SafeIntegration that resolves the flow instantly. */
function makeSafeIntegration(opts: { enabled?: boolean } = {}) {
  const enabled = opts.enabled ?? true;
  return {
    proposeBatch: vi.fn(async (_txs: MetaTransactionData[]) => QUEUE_URL),
    getProvider: vi.fn(() => ({
      getBlockNumber: vi.fn(async () => 12_000_000),
    })),
    fetchFactoryModuleCreatedLogs: vi.fn(async (factoryAddress: string) =>
      factoryAddress === RECORDS_FACTORY
        ? [{ topics: [TOPIC0, PADDED_SAFE, PADDED_RECORDS] }]
        : [{ topics: [TOPIC0, PADDED_SAFE, PADDED_PUB] }],
    ),
    readIsModuleEnabled: vi.fn(async () => enabled),
  };
}

/** Wait for the component's async flow to settle (next microtask flush). */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function mount(props: Record<string, unknown> = {}) {
  return mountLit<S2SPublicationInit>('s2s-publication-init', {
    protocolInfo: PROTOCOL_INFO,
    safeInfo: SAFE_INFO,
    ...props,
  });
}

function setInput(el: S2SPublicationInit, selector: string, value: string): void {
  const input = el.shadowRoot!.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

function clickInit(el: S2SPublicationInit): void {
  el.shadowRoot!.querySelector<HTMLButtonElement>('#init-start')!.click();
}

function bodyText(el: S2SPublicationInit): string {
  return (el.shadowRoot!.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('s2s-publication-init', () => {
  it('renders the form with authors prefilled from the Safe owners', async () => {
    const el = await mount();

    expect(bodyText(el)).toContain('No S2S modules found');
    const name = el.shadowRoot!.querySelector<HTMLInputElement>('#init-name')!;
    expect(name).not.toBeNull();

    const authors = el.shadowRoot!.querySelector<HTMLTextAreaElement>('#init-authors')!;
    expect(authors.value).toBe(`${OWNER_A}, ${OWNER_B}`);

    const start = el.shadowRoot!.querySelector<HTMLButtonElement>('#init-start')!;
    expect(start.textContent).toContain('Initialize publication');
  });

  it('runs the full two-proposal flow (create -> detect -> enable -> name)', async () => {
    const si = makeSafeIntegration();
    const el = await mount({ safeIntegration: si });

    const complete = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('s2s-init-complete', (e) => resolve(e as CustomEvent), { once: true });
    });

    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    const evt = await complete;
    await flush();

    // Three proposals: create-batch, enable-batch, name-record.
    expect(si.proposeBatch).toHaveBeenCalledTimes(3);

    // 1) create-batch: records + publication factory calls.
    const createBatch = si.proposeBatch.mock.calls[0][0] as MetaTransactionData[];
    expect(createBatch).toHaveLength(2);
    expect(createBatch[0].to).toBe(RECORDS_FACTORY);
    expect(createBatch[0].value).toBe('0');
    expect(createBatch[1].to).toBe(PUB_FACTORY);
    expect(createBatch[1].value).toBe('0');

    // 2) enable-batch: both modules enabled via Safe self-calls.
    const enableBatch = si.proposeBatch.mock.calls[1][0] as MetaTransactionData[];
    expect(enableBatch).toHaveLength(2);
    expect(enableBatch.every((tx) => tx.to === SAFE_ADDRESS)).toBe(true);

    // 3) name-record: single setRecord on the records module.
    const nameBatch = si.proposeBatch.mock.calls[2][0] as MetaTransactionData[];
    expect(nameBatch).toHaveLength(1);
    expect(nameBatch[0].to).toBe(RECORDS_MODULE);

    // Detection queried the correct factories with the right safe.
    expect(si.fetchFactoryModuleCreatedLogs).toHaveBeenCalledWith(
      RECORDS_FACTORY,
      SAFE_ADDRESS,
      expect.any(String),
      expect.any(Number),
    );

    // Done state surfaced the module addresses and proposal links.
    expect(evt.detail.recordsModule).toBe(RECORDS_MODULE);
    expect(evt.detail.publicationModule).toBe(PUB_MODULE);
    expect(bodyText(el)).toContain('Publication initialized');
    expect(bodyText(el)).toContain('open in Safe app');
  });

  it('skips the name-record proposal when no name is given', async () => {
    const si = makeSafeIntegration();
    const el = await mount({ safeIntegration: si });

    const complete = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('s2s-init-complete', (e) => resolve(e as CustomEvent), { once: true });
    });

    clickInit(el);
    await complete;
    await flush();

    // Only create + enable — no name-record batch.
    expect(si.proposeBatch).toHaveBeenCalledTimes(2);
    const enableBatch = si.proposeBatch.mock.calls[1][0] as MetaTransactionData[];
    expect(enableBatch).toHaveLength(2);
  });

  it('surfaces an error and stays incomplete when enable verification fails', async () => {
    const si = makeSafeIntegration({ enabled: false });
    const el = await mount({ safeIntegration: si });

    let completed = false;
    el.addEventListener('s2s-init-complete', () => (completed = true));

    clickInit(el);

    // Verification rejects after proposing create + enable.
    await vi.waitFor(() => expect(bodyText(el)).toContain('Initialization failed'));
    expect(completed).toBe(false);
    expect(si.proposeBatch).toHaveBeenCalledTimes(2);
    expect(bodyText(el)).toContain('not enabled');

    // "Try again" returns to the form.
    el.shadowRoot!.querySelector<HTMLButtonElement>('button')!.click();
    await el.updateComplete;
    expect(bodyText(el)).toContain('No S2S modules found');
  });

  it('fails fast when not connected to a Safe', async () => {
    const si = makeSafeIntegration();
    const el = await mount({ safeIntegration: si, safeInfo: undefined });

    clickInit(el);
    await flush();

    expect(bodyText(el)).toContain('Initialization failed');
    expect(bodyText(el)).toContain('Not connected to a Safe');
    expect(si.proposeBatch).not.toHaveBeenCalled();
  });
});
