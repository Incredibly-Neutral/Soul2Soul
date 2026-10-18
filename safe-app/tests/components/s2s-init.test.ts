import { describe, it, expect, vi } from 'vitest';
import { Interface } from 'ethers';
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

/** Decode the single setRecord call so we can assert the recorded value. */
function decodeSetRecord(tx: MetaTransactionData): { key: string; value: string } {
  const parsed = new Interface(['function setRecord(string key, string value)']).parseTransaction({
    data: tx.data,
  });
  return { key: String(parsed!.args[0]), value: String(parsed!.args[1]) };
}

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
  it('renders the new-publication form with owner pills and the .soul2soul.eth suffix', async () => {
    const el = await mount();

    expect(bodyText(el)).toContain('New publication');

    // Name field: input + rendered .soul2soul.eth suffix.
    const name = el.shadowRoot!.querySelector<HTMLInputElement>('#init-name');
    expect(name).not.toBeNull();
    expect(bodyText(el)).toContain('.soul2soul.eth');

    // Authors prefilled as pills (one per Safe owner), not a textarea.
    // pet-name renders the address in its own shadow root, so assert the
    // pill's value binding rather than bodyText.
    const pills = el.shadowRoot!.querySelectorAll<HTMLElement>('.alias-pill');
    expect(pills.length).toBe(2);
    expect(el.shadowRoot!.querySelector(`pet-name[value="${OWNER_A}"]`)).not.toBeNull();
    expect(el.shadowRoot!.querySelector(`pet-name[value="${OWNER_B}"]`)).not.toBeNull();
    expect(el.shadowRoot!.querySelector('#init-authors')).toBeNull();

    const start = el.shadowRoot!.querySelector<HTMLElement>('#init-start')!;
    expect(start.textContent).toContain('Create');
    // Uses the app's s2s-button with the primary (yellow) type.
    expect(start.tagName.toLowerCase()).toBe('s2s-button');
    expect(start.getAttribute('type')).toBe('primary');
  });

  it('prefills the repo + branch with the starter template and records edits in the name batch', async () => {
    const si = makeSafeIntegration();
    const el = await mount({ safeIntegration: si });

    // Repo + branch inputs are present and prefilled.
    const repoInput = el.shadowRoot!.querySelector<HTMLInputElement>('#init-repo');
    const branchInput = el.shadowRoot!.querySelector<HTMLInputElement>('#init-branch');
    expect(repoInput).not.toBeNull();
    expect(branchInput).not.toBeNull();
    expect(repoInput!.value).toBe('https://github.com/Joera/website-starter');
    expect(branchInput!.value).toBe('main');

    // Customizing them flows into the name batch's repo/branch records.
    setInput(el, '#init-name', 'my-publication');
    setInput(el, '#init-repo', 'https://github.com/Joera/other-site');
    setInput(el, '#init-branch', 'dev');

    const complete = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('s2s-init-complete', (e) => resolve(e as CustomEvent), { once: true });
    });
    clickInit(el);
    const evt = await complete;
    await flush();

    const nameBatch = si.proposeBatch.mock.calls[2][0] as MetaTransactionData[];
    expect(nameBatch).toHaveLength(3);
    expect(decodeSetRecord(nameBatch[1])).toEqual({
      key: 'repo',
      value: 'https://github.com/Joera/other-site',
    });
    expect(decodeSetRecord(nameBatch[2])).toEqual({ key: 'branch', value: 'dev' });
    expect(evt.detail.repo).toBe('https://github.com/Joera/other-site');
    expect(evt.detail.branch).toBe('dev');
  });

  it('runs the full three-proposal flow (create -> detect -> enable -> name)', async () => {
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

    // 3) name-record: name + starter repo + branch set on the records module.
    const nameBatch = si.proposeBatch.mock.calls[2][0] as MetaTransactionData[];
    expect(nameBatch).toHaveLength(3);
    expect(nameBatch.every((tx) => tx.to === RECORDS_MODULE)).toBe(true);
    expect(decodeSetRecord(nameBatch[0])).toEqual({
      key: 'name',
      value: 'my-publication.soul2soul.eth',
    });
    expect(decodeSetRecord(nameBatch[1])).toEqual({
      key: 'repo',
      value: 'https://github.com/Joera/website-starter',
    });
    expect(decodeSetRecord(nameBatch[2])).toEqual({ key: 'branch', value: 'main' });

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
    expect(evt.detail.name).toBe('my-publication.soul2soul.eth');
    expect(evt.detail.repo).toBe('https://github.com/Joera/website-starter');
    expect(evt.detail.branch).toBe('main');
    expect(bodyText(el)).toContain('Publication initialized');
    expect(bodyText(el)).toContain('open in Safe app');
  });

  it('requires a name: empty name blocks the flow with an inline error', async () => {
    const si = makeSafeIntegration();
    const el = await mount({ safeIntegration: si });

    clickInit(el);
    await flush();

    // No proposals proposed; form stays with a validation message.
    expect(si.proposeBatch).not.toHaveBeenCalled();
    expect(bodyText(el)).toContain('Publication name is required.');
    expect(bodyText(el)).toContain('New publication');
    expect(el.shadowRoot!.querySelector('#init-start')).not.toBeNull();

    // Typing clears the error.
    setInput(el, '#init-name', 'ok');
    await el.updateComplete;
    expect(bodyText(el)).not.toContain('Publication name is required.');
  });

  it('supports adding and removing author pills', async () => {
    const el = await mount();

    // Owner pills present; remove one.
    let pills = el.shadowRoot!.querySelectorAll<HTMLElement>('.alias-pill');
    expect(pills.length).toBe(2);
    const removeBtn = el.shadowRoot!.querySelector<HTMLButtonElement>(
      `.alias-pill__remove[data-address="${OWNER_A}"]`,
    )!;
    removeBtn.click();
    await el.updateComplete;
    pills = el.shadowRoot!.querySelectorAll<HTMLElement>('.alias-pill');
    expect(pills.length).toBe(1);
    expect(el.shadowRoot!.querySelector(`pet-name[value="${OWNER_A}"]`)).toBeNull();

    // Dispatch a sliding-add for a new author -> pill appears.
    const addBtn = el.shadowRoot!.querySelector('s2s-sliding-add-button')!;
    addBtn.dispatchEvent(new CustomEvent('s2s-sliding-add', { detail: { value: OWNER_A } }));
    await el.updateComplete;
    pills = el.shadowRoot!.querySelectorAll<HTMLElement>('.alias-pill');
    expect(pills.length).toBe(2);
    expect(el.shadowRoot!.querySelector(`pet-name[value="${OWNER_A}"]`)).not.toBeNull();
  });

  it('waits for the enable batch to be executed before proposing the name record', async () => {
    // Modules become enabled only after a few polls — simulating the human
    // executing the enable proposal in the Safe app mid-flow.
    let calls = 0;
    const si = makeSafeIntegration();
    si.readIsModuleEnabled = vi.fn(async () => {
      calls += 1;
      return calls >= 5; // calls 5 & 6 (3rd poll) → both true
    });
    const el = await mount({ safeIntegration: si, enablePollIntervalMs: 5 });

    const complete = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('s2s-init-complete', (e) => resolve(e as CustomEvent), { once: true });
    });

    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    await complete;
    await flush();

    // The name record is only proposed AFTER the modules became enabled.
    expect(si.proposeBatch).toHaveBeenCalledTimes(3);
    expect(calls).toBeGreaterThanOrEqual(5);
    const nameBatch = si.proposeBatch.mock.calls[2][0] as MetaTransactionData[];
    expect(nameBatch).toHaveLength(3);
    expect(nameBatch.every((tx) => tx.to === RECORDS_MODULE)).toBe(true);
    expect(bodyText(el)).toContain('Publication initialized');
  });

  it('stays incomplete and surfaces a timeout when the enable batch is never executed', async () => {
    const si = makeSafeIntegration({ enabled: false });
    const el = await mount({
      safeIntegration: si,
      enableTimeoutMs: 30,
      enablePollIntervalMs: 10,
    });

    let completed = false;
    el.addEventListener('s2s-init-complete', () => (completed = true));

    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    // Enable never becomes true → the wait times out before the name is
    // proposed; only create + enable were proposed.
    await vi.waitFor(() => expect(bodyText(el)).toContain('Initialization failed'));
    expect(completed).toBe(false);
    expect(si.proposeBatch).toHaveBeenCalledTimes(2);
    expect(bodyText(el)).toContain('not enabled');

    // "Try again" returns to the form.
    el.shadowRoot!.querySelector<HTMLButtonElement>('button')!.click();
    await el.updateComplete;
    expect(bodyText(el)).toContain('New publication');
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
