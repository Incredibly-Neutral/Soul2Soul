import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Interface } from 'ethers';
import type { S2SPublicationInit } from '../../src/components/s2s-init';
import type { MetaTransactionData } from '../../src/lib/publication-init';
import { INIT_SESSION_KEY, saveInitSession, type InitSession } from '../../src/lib/init-session';
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
const PUB_NAME = 'my-publication.soul2soul.eth';

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

/** Decode a single setRecord call so we can assert the recorded value. */
function decodeSetRecord(tx: MetaTransactionData): { key: string; value: string } {
  const parsed = new Interface(['function setRecord(string key, string value)']).parseTransaction({
    data: tx.data,
  });
  return { key: String(parsed!.args[0]), value: String(parsed!.args[1]) };
}

/** Duck-typed SafeIntegration that resolves the flow instantly.
 *
 * Models the proposals EXECUTING on-chain:
 *  - modules are enabled once a batch containing Safe self-calls is proposed;
 *  - the name record is on-chain once a batch containing records-module calls
 *    (the merged finalize batch) is proposed.
 */
function makeSafeIntegration(opts: { enabled?: boolean } = {}) {
  let enableProposed = false;
  let nameProposed = false;
  const proposeBatch = vi.fn(async (txs: MetaTransactionData[]) => {
    if (txs.some((t) => t.to.toLowerCase() === SAFE_ADDRESS.toLowerCase())) {
      enableProposed = true;
    }
    if (txs.some((t) => t.to.toLowerCase() === RECORDS_MODULE.toLowerCase())) {
      nameProposed = true;
    }
    return QUEUE_URL;
  });
  return {
    proposeBatch,
    getProvider: vi.fn(() => ({
      getBlockNumber: vi.fn(async () => 12_000_000),
    })),
    fetchFactoryModuleCreatedLogs: vi.fn(async (factoryAddress: string) =>
      factoryAddress === RECORDS_FACTORY
        ? [{ topics: [TOPIC0, PADDED_SAFE, PADDED_RECORDS] }]
        : [{ topics: [TOPIC0, PADDED_SAFE, PADDED_PUB] }],
    ),
    readIsModuleEnabled: vi.fn(async () =>
      opts.enabled !== undefined ? opts.enabled : enableProposed,
    ),
    getRecord: vi.fn(async (key: string) => (key === 'name' && nameProposed ? PUB_NAME : '')),
  };
}

/** Seed an in-flight session into localStorage so the next mount resumes it. */
function seedSession(overrides: Partial<InitSession> = {}): void {
  saveInitSession(window.localStorage, INIT_SESSION_KEY, {
    version: 2,
    chainId: 8453,
    safeAddress: SAFE_ADDRESS,
    phase: 'detecting',
    name: 'my-publication',
    publicationName: PUB_NAME,
    repo: 'https://github.com/Joera/website-starter',
    branch: 'main',
    authors: [OWNER_A, OWNER_B],
    proposals: [],
    ...overrides,
  });
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

/** The merged finalize batch layout: 2 enable self-calls + 3 setRecord calls. */
function expectFinalizeShape(batch: MetaTransactionData[], expectedName: string): void {
  expect(batch).toHaveLength(5);
  // Enable both modules via Safe self-calls.
  expect(batch[0].to).toBe(SAFE_ADDRESS);
  expect(batch[1].to).toBe(SAFE_ADDRESS);
  expect(batch.every((tx, i) => (i < 2 ? tx.to === SAFE_ADDRESS : true))).toBe(true);
  // Identity records on the records module.
  expect(batch.slice(2).every((tx) => tx.to === RECORDS_MODULE)).toBe(true);
  expect(decodeSetRecord(batch[2])).toEqual({ key: 'name', value: expectedName });
  expect(decodeSetRecord(batch[3])).toEqual({
    key: 'repo',
    value: 'https://github.com/Joera/website-starter',
  });
  expect(decodeSetRecord(batch[4])).toEqual({ key: 'branch', value: 'main' });
}

describe('s2s-publication-init', () => {
  // The component persists its flow to localStorage; a completed/aborted flow
  // from a previous test must never bleed into the next mount.
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders the new-publication form with owner pills and the .soul2soul.eth suffix', async () => {
    const el = await mount();

    expect(bodyText(el)).toContain('New publication');

    // Name field: input + rendered .soul2soul.eth suffix.
    const name = el.shadowRoot!.querySelector<HTMLInputElement>('#init-name');
    expect(name).not.toBeNull();
    expect(bodyText(el)).toContain('.soul2soul.eth');

    // Authors prefilled as pills (one per Safe owner), not a textarea.
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

  it('prefills repo + branch and records custom edits in the merged finalize batch', async () => {
    const si = makeSafeIntegration();
    const el = await mount({ safeIntegration: si });

    // Repo + branch inputs are present and prefilled.
    const repoInput = el.shadowRoot!.querySelector<HTMLInputElement>('#init-repo');
    const branchInput = el.shadowRoot!.querySelector<HTMLInputElement>('#init-branch');
    expect(repoInput).not.toBeNull();
    expect(branchInput).not.toBeNull();
    expect(repoInput!.value).toBe('https://github.com/Joera/website-starter');
    expect(branchInput!.value).toBe('main');

    // Customizing them flows into the merged batch's repo/branch records.
    setInput(el, '#init-name', 'my-publication');
    setInput(el, '#init-repo', 'https://github.com/Joera/other-site');
    setInput(el, '#init-branch', 'dev');

    const complete = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('s2s-init-complete', (e) => resolve(e as CustomEvent), { once: true });
    });
    clickInit(el);
    const evt = await complete;
    await flush();

    const finalizeBatch = si.proposeBatch.mock.calls[1][0] as MetaTransactionData[];
    expect(finalizeBatch).toHaveLength(5);
    expect(decodeSetRecord(finalizeBatch[3])).toEqual({
      key: 'repo',
      value: 'https://github.com/Joera/other-site',
    });
    expect(decodeSetRecord(finalizeBatch[4])).toEqual({ key: 'branch', value: 'dev' });
    expect(evt.detail.repo).toBe('https://github.com/Joera/other-site');
    expect(evt.detail.branch).toBe('dev');
  });

  it('runs the direct two-proposal flow (create -> merged finalize)', async () => {
    const si = makeSafeIntegration();
    const el = await mount({ safeIntegration: si });

    const complete = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('s2s-init-complete', (e) => resolve(e as CustomEvent), { once: true });
    });

    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    const evt = await complete;
    await flush();

    // Exactly two proposals: create-batch then the merged finalize batch.
    expect(si.proposeBatch).toHaveBeenCalledTimes(2);

    // 1) create-batch: records + publication factory calls.
    const createBatch = si.proposeBatch.mock.calls[0][0] as MetaTransactionData[];
    expect(createBatch).toHaveLength(2);
    expect(createBatch[0].to).toBe(RECORDS_FACTORY);
    expect(createBatch[0].value).toBe('0');
    expect(createBatch[1].to).toBe(PUB_FACTORY);
    expect(createBatch[1].value).toBe('0');

    // 2) merged finalize: enable both modules + set name/repo/branch.
    expectFinalizeShape(si.proposeBatch.mock.calls[1][0] as MetaTransactionData[], PUB_NAME);

    // Detection queried the correct factories with the right safe.
    expect(si.fetchFactoryModuleCreatedLogs).toHaveBeenCalledWith(
      RECORDS_FACTORY,
      SAFE_ADDRESS,
      expect.any(String),
      expect.any(Number),
    );

    // Done state surfaced the module addresses and identity.
    expect(evt.detail.recordsModule).toBe(RECORDS_MODULE);
    expect(evt.detail.publicationModule).toBe(PUB_MODULE);
    expect(evt.detail.name).toBe(PUB_NAME);
    expect(evt.detail.repo).toBe('https://github.com/Joera/website-starter');
    expect(evt.detail.branch).toBe('main');
    expect(evt.detail.proposals).toHaveLength(2);
    expect(bodyText(el)).not.toContain('Publication initialized');
    // No external "open in Safe app" links anywhere — the app runs embedded
    // in the Safe web; proposal queue entries render as plain text instead.
    expect(bodyText(el)).not.toContain('open in Safe app');
    expect(bodyText(el)).not.toContain('http');
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

  it('completes only after the merged finalize batch is executed', async () => {
    // Modules become enabled only after a few polls — simulating the human
    // executing the merged finalize proposal in the Safe app mid-flow.
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

    // The merged batch is proposed once (up front); execution is polled.
    expect(si.proposeBatch).toHaveBeenCalledTimes(2);
    expect(calls).toBeGreaterThanOrEqual(5);
    expect(bodyText(el)).not.toContain('Publication initialized');
  });

  it('stays incomplete and surfaces a timeout when the finalize batch is never executed', async () => {
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

    // Enable never becomes true → the wait times out before the flow finishes;
    // only create + finalize were proposed.
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

  // ---- Crash-safe resume (persisted session) ---------------------------------

  /** Create + connect the element with the listener already attached, so the
   * async auto-resume (which starts in connectedCallback) is never missed. */
  async function mountWithListener(
    si: ReturnType<typeof makeSafeIntegration>,
    props: Record<string, unknown> = {},
  ): Promise<{ el: S2SPublicationInit; complete: Promise<CustomEvent> }> {
    const el = document.createElement('s2s-publication-init') as S2SPublicationInit;
    Object.assign(el, {
      protocolInfo: PROTOCOL_INFO,
      safeInfo: SAFE_INFO,
      safeIntegration: si,
      ...props,
    });
    const complete = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('s2s-init-complete', (e) => resolve(e as CustomEvent), { once: true });
    });
    document.body.appendChild(el);
    await el.updateComplete;
    return { el, complete };
  }

  it('auto-resumes a mid-flow session without re-proposing the create batch', async () => {
    // Reload happened while the create proposal was pending execution.
    seedSession({
      phase: 'detecting',
      proposals: [QUEUE_URL], // create already proposed in the previous session
    });
    const si = makeSafeIntegration();

    const { el, complete } = await mountWithListener(si);
    const evt = await complete;
    await flush();

    // Create was NOT re-proposed — only the merged finalize batch is new.
    expect(si.proposeBatch).toHaveBeenCalledTimes(1);
    expectFinalizeShape(si.proposeBatch.mock.calls[0][0] as MetaTransactionData[], PUB_NAME);
    expect(evt.detail.recordsModule).toBe(RECORDS_MODULE);
    expect(evt.detail.publicationModule).toBe(PUB_MODULE);
    expect(evt.detail.name).toBe(PUB_NAME);
    // The restored create proposal is kept in front of the new finalize one.
    expect(evt.detail.proposals).toHaveLength(2);
    expect(evt.detail.proposals[0]).toBe(QUEUE_URL);
    expect(bodyText(el)).not.toContain('Publication initialized');
  });

  it('finishes immediately on resume when the whole flow already executed', async () => {
    seedSession({
      phase: 'awaiting-finalize',
      recordsModule: RECORDS_MODULE,
      publicationModule: PUB_MODULE,
      proposals: [QUEUE_URL, QUEUE_URL],
    });
    const si = makeSafeIntegration({ enabled: true });
    si.getRecord = vi.fn(async (key: string) => (key === 'name' ? PUB_NAME : ''));

    const { complete } = await mountWithListener(si);
    const evt = await complete;
    await flush();

    // Nothing left to propose — the whole flow was already executed.
    expect(si.proposeBatch).not.toHaveBeenCalled();
    expect(evt.detail.name).toBe(PUB_NAME);
    // The session is cleared once everything is on-chain.
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
  });

  it('re-proposes the merged batch on resume when modules are enabled but the name is missing', async () => {
    // The legacy dead-end state: modules enabled on-chain, name never recorded.
    // planNextAction must recover it by re-proposing the merged finalize batch
    // (enableModule is idempotent on the Safe).
    seedSession({
      phase: 'finalizing',
      recordsModule: RECORDS_MODULE,
      publicationModule: PUB_MODULE,
      proposals: [QUEUE_URL],
    });
    const si = makeSafeIntegration({ enabled: true });
    let recorded = false;
    si.getRecord = vi.fn(async (key: string) => (key === 'name' && recorded ? PUB_NAME : ''));

    const { el, complete } = await mountWithListener(si, { enablePollIntervalMs: 5 });
    // The human executes the re-proposed finalize batch after a few polls.
    setTimeout(() => {
      recorded = true;
    }, 40);

    const evt = await complete;
    await flush();

    expect(si.proposeBatch).toHaveBeenCalledTimes(1);
    expectFinalizeShape(si.proposeBatch.mock.calls[0][0] as MetaTransactionData[], PUB_NAME);
    expect(evt.detail.name).toBe(PUB_NAME);
    expect(bodyText(el)).not.toContain('Publication initialized');
  });

  it('waits for the finalize batch to be executed on resume, then clears the session', async () => {
    seedSession({
      phase: 'awaiting-finalize',
      recordsModule: RECORDS_MODULE,
      publicationModule: PUB_MODULE,
      proposals: [QUEUE_URL, QUEUE_URL],
    });
    const si = makeSafeIntegration({ enabled: true });
    let recorded = false;
    si.getRecord = vi.fn(async (key: string) => (key === 'name' && recorded ? PUB_NAME : ''));

    const { complete } = await mountWithListener(si, { enablePollIntervalMs: 5 });
    // The human executes the finalize proposal after a few polls.
    setTimeout(() => {
      recorded = true;
    }, 40);
    const evt = await complete;
    await flush();

    expect(evt.detail.name).toBe(PUB_NAME);
    expect(si.proposeBatch).not.toHaveBeenCalled();
    // Once both modules are enabled AND the name is on-chain, the session is cleared.
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
  });

  it('broadcasts the restored phase so the host can keep the progress modal in sync', async () => {
    seedSession({
      phase: 'awaiting-finalize',
      recordsModule: RECORDS_MODULE,
      publicationModule: PUB_MODULE,
      proposals: [QUEUE_URL, QUEUE_URL],
    });
    const progress: Array<{ step: string; phase: string; proposals: string[]; name?: string }> = [];

    const el = document.createElement('s2s-publication-init') as S2SPublicationInit;
    Object.assign(el, {
      protocolInfo: PROTOCOL_INFO,
      safeInfo: SAFE_INFO,
      safeIntegration: makeSafeIntegration(),
    });
    el.addEventListener('s2s-init-progress', (e) =>
      progress.push(
        (
          e as CustomEvent<{
            step: string;
            phase: string;
            proposals: string[];
            name?: string;
          }>
        ).detail,
      ),
    );
    document.body.appendChild(el);
    await el.updateComplete;
    await flush();

    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0].phase).toBe('awaiting-finalize');
    expect(progress[0].step).toBe('awaiting-finalize');
    // The progress event carries the publication name for the modal title.
    expect(progress[0].name).toBe(PUB_NAME);
  });
});
