import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Interface, namehash } from 'ethers';
import type { S2SPublicationInit } from '../../src/components/s2s-init';
import type { MetaTransactionData } from '../../src/lib/publication-init';
import { INIT_SESSION_KEY, saveInitSession, type InitSession } from '../../src/lib/init-session';
import { LEGACY_PUBLICATION_FACTORIES } from '@s2s/soul2soul-shared/protocol';
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

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const NAME_WRAPPER = '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ENS_PARENT_NODE = namehash('soul2soul.eth');

const PROTOCOL_INFO = {
  recordsFactory: RECORDS_FACTORY,
  publicationFactory: PUB_FACTORY,
  ensRegistry: ENS_REGISTRY,
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
 *  - the create batch deploying a module pair, so ModuleCreated logs for this
 *    Safe exist only once a create batch has been proposed (or when the caller
 *    declares a pair that was deployed by an earlier run via `existing`);
 *  - modules are enabled once a batch containing Safe self-calls is proposed;
 *  - the name record is on-chain once a batch containing records-module calls
 *    (the merged finalize batch) is proposed.
 *
 * `existing` models the state the component now has to cope with: the modules
 * are already on-chain while the session knows nothing about them (earlier run,
 * lost session). A partial pair (only one factory) is allowed.
 */
function makeSafeIntegration(
  opts: {
    enabled?: boolean;
    existing?: { recordsModule?: string; publicationModule?: string };
    /** Byte size of each factory's code on this chain; 0 models "wrong chain". */
    factoryCode?: { records?: number; publication?: number };
    /**
     * ENS (step 1) state on L1. The default models the happy legacy/hand-made
     * case — the subnode is already registered to THIS Safe — so the module
     * steps start immediately and pre-ENS expectations keep their shape. The
     * object is captured by reference: a test can flip `owner` mid-flow to
     * model the human executing the registration.
     */
    ens?: { owner?: string; registered?: boolean };
  } = {},
) {
  const ens = {
    owner: opts.ens?.owner ?? SAFE_ADDRESS,
    registered: opts.ens?.registered ?? true,
  };
  let enableProposed = false;
  let nameProposed = false;
  let createProposed = false;
  const proposeBatch = vi.fn(async (txs: MetaTransactionData[]) => {
    const to = (addr: string) => addr.toLowerCase();
    if (txs.some((t) => to(t.to) === to(SAFE_ADDRESS))) {
      enableProposed = true;
    }
    if (txs.some((t) => to(t.to) === to(RECORDS_MODULE))) {
      nameProposed = true;
    }
    if (txs.length === 2 && txs[0] && to(txs[0].to) === to(RECORDS_FACTORY)) {
      createProposed = true;
    }
    return QUEUE_URL;
  });

  /** ModuleCreated logs for one factory, for THIS safe only. */
  const logsFor = (existingAddr: string | undefined, createdAddr: string) => {
    const addr = existingAddr ?? (createProposed ? createdAddr : undefined);
    return addr ? [{ topics: [TOPIC0, PADDED_SAFE, pad(addr)] }] : [];
  };

  const isCreateBatch = (txs: MetaTransactionData[]) =>
    txs.length === 2 &&
    txs[0] !== undefined &&
    txs[0].to.toLowerCase() === RECORDS_FACTORY.toLowerCase();

  /** The registry/wrapper reads readEnsRegistration makes. */
  const evmRead = vi.fn(
    async (
      _chainId: number,
      _contract: string,
      _abi: unknown,
      method: string,
      _args: unknown[],
    ) => {
      switch (method) {
        case 'parentNode':
          return ENS_PARENT_NODE;
        case 'isParentWrapped':
          return true;
        case 'nameWrapper':
          return NAME_WRAPPER;
        case 'ens':
          return ENS_REGISTRY;
        case 'registeredSubdomains':
          return ens.registered;
        case 'ownerOf':
        case 'owner':
          return ens.owner;
        default:
          throw new Error(`unexpected EVM read: ${method}`);
      }
    },
  );

  return {
    proposeBatch,
    evmRead,
    /** Mutable ENS state (see the `ens` option). */
    ens,
    /** Calls that proposed the (non-idempotent) create batch. */
    createProposals: () =>
      proposeBatch.mock.calls
        .map(([txs]) => txs as MetaTransactionData[])
        .filter((txs) => isCreateBatch(txs)),
    adoptModules: vi.fn(async (_recordsModule?: string, _publicationModule?: string) => {
      // In the real integration this wires freshly-created modules into the
      // shared SafeIntegration so getRecord works live. Mocks expose it so
      // the component's call sites run.
    }),
    getProvider: vi.fn(() => ({
      getBlockNumber: vi.fn(async () => 12_000_000),
    })),
    /** eth_getCode on the Safe's chain: the factory byte sizes declared above. */
    contractCodeSize: vi.fn(async (address: string) => {
      const code = opts.factoryCode ?? {};
      const addr = address.toLowerCase();
      if (addr === RECORDS_FACTORY.toLowerCase()) return code.records ?? 4321;
      if (addr === PUB_FACTORY.toLowerCase()) return code.publication ?? 5432;
      return 0;
    }),
    fetchFactoryModuleCreatedLogs: vi.fn(async (factoryAddress: string) =>
      factoryAddress === RECORDS_FACTORY
        ? logsFor(opts.existing?.recordsModule, RECORDS_MODULE)
        : logsFor(opts.existing?.publicationModule, PUB_MODULE),
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
    version: 3,
    chainId: 8453,
    safeAddress: SAFE_ADDRESS,
    phase: 'detecting',
    name: 'my-publication',
    publicationName: PUB_NAME,
    repo: 'https://github.com/Joera/website-starter',
    branch: 'main',
    authors: [OWNER_A, OWNER_B],
    proposals: [],
    updatedAt: Date.now(),
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

    // The error view offers two actions: retry (keeps the session) and an
    // explicit start-over (clears it and returns to the form).
    const retryBtn = el.shadowRoot!.querySelector<HTMLElement>('#init-retry');
    const startOverBtn = el.shadowRoot!.querySelector<HTMLElement>('#init-start-over');
    expect(retryBtn).not.toBeNull();
    expect(startOverBtn).not.toBeNull();
    expect(retryBtn!.textContent).toContain('Try again');
    expect(startOverBtn!.textContent).toContain('Start over');

    // "Start over" returns to the form and drops the persisted session.
    startOverBtn!.click();
    await el.updateComplete;
    expect(bodyText(el)).toContain('New publication');
    expect((el as unknown as { session: unknown }).session).toBeNull();
  });

  it('retry keeps the session and resumes from the persisted phase (no duplicate create)', async () => {
    const si = makeSafeIntegration({ enabled: false });
    const el = await mount({
      safeIntegration: si,
      enableTimeoutMs: 30,
      enablePollIntervalMs: 10,
    });

    let completions = 0;
    const complete = new Promise<CustomEvent>((resolve) => {
      el.addEventListener(
        's2s-init-complete',
        (e) => {
          completions += 1;
          resolve(e as CustomEvent);
        },
        { once: true },
      );
    });

    setInput(el, '#init-name', 'my-publication');
    clickInit(el);
    await vi.waitFor(() => expect(bodyText(el)).toContain('Initialization failed'));

    // Create + finalize were proposed; the session survived the timeout at the
    // phase that records both proposals (awaiting execution).
    expect(si.proposeBatch).toHaveBeenCalledTimes(2);
    const persisted = JSON.parse(window.localStorage.getItem(INIT_SESSION_KEY)!);
    expect(persisted.phase).toBe('awaiting-finalize');
    expect(persisted.recordsModule).toBe(RECORDS_MODULE);

    // The human finally executes the merged proposal → both modules enabled
    // and the name recorded on-chain.
    si.readIsModuleEnabled = vi.fn(async () => true);
    si.getRecord = vi.fn(async (key: string) => (key === 'name' ? PUB_NAME : ''));

    el.shadowRoot!.querySelector<HTMLElement>('#init-retry')!.click();
    const evt = await complete;
    await flush();

    // Resumed from the persisted phase: no third proposal, no second create
    // batch (which would have deployed a duplicate module pair).
    expect(si.proposeBatch).toHaveBeenCalledTimes(2);
    const createBatches = si.proposeBatch.mock.calls
      .map((c) => c[0])
      .filter((txs) => txs.length === 2 && txs[0].to === RECORDS_FACTORY);
    expect(createBatches).toHaveLength(1);
    expect(completions).toBe(1);
    expect(evt.detail.recordsModule).toBe(RECORDS_MODULE);
    expect(evt.detail.publicationModule).toBe(PUB_MODULE);
    expect(evt.detail.name).toBe(PUB_NAME);
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
  });

  it('retry while the finalize batch is still unexecuted resumes waiting, without re-proposing it', async () => {
    const si = makeSafeIntegration({ enabled: false });
    const el = await mount({
      safeIntegration: si,
      enableTimeoutMs: 30,
      enablePollIntervalMs: 10,
    });
    const progress: Array<{ step: string; phase: string }> = [];
    el.addEventListener('s2s-init-progress', (e) =>
      progress.push((e as CustomEvent<{ step: string; phase: string }>).detail),
    );

    setInput(el, '#init-name', 'my-publication');
    clickInit(el);
    await vi.waitFor(() => expect(bodyText(el)).toContain('Initialization failed'));
    expect(si.proposeBatch).toHaveBeenCalledTimes(2);

    // Retry with the merged batch STILL unexecuted (modules disabled, no name
    // record): the plan must return await-finalize — the enable/name batch is
    // already queued, so proposing it again would duplicate it.
    el.enableTimeoutMs = 2_000;
    el.enablePollIntervalMs = 5;
    let recorded = false;
    si.readIsModuleEnabled = vi.fn(async () => false);
    si.getRecord = vi.fn(async (key: string) => (key === 'name' && recorded ? PUB_NAME : ''));

    const complete = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('s2s-init-complete', (e) => resolve(e as CustomEvent), { once: true });
    });
    el.shadowRoot!.querySelector<HTMLElement>('#init-retry')!.click();

    // A few poll rounds pass with the proposal still unexecuted: no new batch
    // is proposed and the component sits in awaiting-finalize.
    await new Promise((r) => setTimeout(r, 60));
    expect(si.proposeBatch).toHaveBeenCalledTimes(2);
    expect(progress.at(-1)?.step).toBe('awaiting-finalize');
    expect(progress.at(-1)?.phase).toBe('awaiting-finalize');
    expect(bodyText(el)).not.toContain('Initialization failed');

    // The human executes the queued batch → the same loop finishes.
    recorded = true;
    si.readIsModuleEnabled = vi.fn(async () => true);
    const evt = await complete;
    await flush();

    expect(si.proposeBatch).toHaveBeenCalledTimes(2);
    expect(evt.detail.recordsModule).toBe(RECORDS_MODULE);
    expect(evt.detail.publicationModule).toBe(PUB_MODULE);
    expect(evt.detail.name).toBe(PUB_NAME);
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
  });

  it('retry after a failed create proposes exactly one new create batch and completes', async () => {
    // The uncovered failure mode documented in the component header: a
    // proposeBatch that throws while phase is 'creating'. The retry replays
    // the create step (the session says no create was sent) — this test pins
    // that behaviour to ONE queued create batch, so a regression to more than
    // one duplicate module deployment is visible.
    const si = makeSafeIntegration();
    const originalPropose = si.proposeBatch;
    const createOutcomes: Array<'threw' | 'queued'> = [];
    let failNextCreate = true;
    si.proposeBatch = vi.fn(async (txs: MetaTransactionData[]) => {
      const isCreate = txs.length === 2 && txs[0].to === RECORDS_FACTORY;
      if (isCreate) {
        if (failNextCreate) {
          failNextCreate = false;
          createOutcomes.push('threw');
          throw new Error('signature rejected');
        }
        createOutcomes.push('queued');
      }
      return originalPropose(txs);
    });

    const el = await mount({ safeIntegration: si });
    setInput(el, '#init-name', 'my-publication');
    clickInit(el);
    await vi.waitFor(() => expect(bodyText(el)).toContain('signature rejected'));

    // The session was persisted at 'creating' before the batch was sent, and
    // exactly one create attempt exists (the one that threw, unqueued).
    expect(JSON.parse(window.localStorage.getItem(INIT_SESSION_KEY)!).phase).toBe('creating');
    expect(createOutcomes).toEqual(['threw']);

    const complete = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('s2s-init-complete', (e) => resolve(e as CustomEvent), { once: true });
    });
    el.shadowRoot!.querySelector<HTMLElement>('#init-retry')!.click();
    const evt = await complete;
    await flush();

    // One create batch was queued by the retry (the failed attempt returned no
    // queue URL), then the merged finalize batch — nothing else.
    expect(createOutcomes).toEqual(['threw', 'queued']);
    expect(si.proposeBatch).toHaveBeenCalledTimes(3);
    expect(evt.detail.recordsModule).toBe(RECORDS_MODULE);
    expect(evt.detail.publicationModule).toBe(PUB_MODULE);
    expect(evt.detail.name).toBe(PUB_NAME);
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
  });

  it('start over after an error clears the session and returns to the blank form', async () => {
    const si = makeSafeIntegration({ enabled: false });
    const el = await mount({
      safeIntegration: si,
      enableTimeoutMs: 30,
      enablePollIntervalMs: 10,
    });

    setInput(el, '#init-name', 'my-publication');
    clickInit(el);
    await vi.waitFor(() => expect(bodyText(el)).toContain('Initialization failed'));
    expect(si.proposeBatch).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).not.toBeNull();

    el.shadowRoot!.querySelector<HTMLElement>('#init-start-over')!.click();
    await el.updateComplete;

    // Session gone, blank form back (name field empty again).
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
    expect(bodyText(el)).toContain('New publication');
    expect(bodyText(el)).not.toContain('Initialization failed');
    expect(el.shadowRoot!.querySelector<HTMLInputElement>('#init-name')!.value).toBe('');
    expect(el.shadowRoot!.querySelector('#init-start')).not.toBeNull();

    // No extra proposals were made by starting over.
    await flush();
    expect(si.proposeBatch).toHaveBeenCalledTimes(2);
  });

  it('a double start() proposes the create batch only once', async () => {
    const si = makeSafeIntegration();
    const el = await mount({ safeIntegration: si });

    const complete = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('s2s-init-complete', (e) => resolve(e as CustomEvent), { once: true });
    });

    setInput(el, '#init-name', 'my-publication');
    // Two clicks in the same tick: the re-entrancy guard makes the second a
    // no-op, so only one plan loop runs.
    const start = (el as unknown as { start(): Promise<void> }).start.bind(el);
    void start();
    void start();

    await complete;
    await flush();

    const createBatches = si.proposeBatch.mock.calls
      .map((c) => c[0])
      .filter((txs) => txs.length === 2 && txs[0].to === RECORDS_FACTORY);
    expect(createBatches).toHaveLength(1);
    expect(si.proposeBatch).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
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
    // The pair was deployed by that earlier session.
    const si = makeSafeIntegration({
      existing: { recordsModule: RECORDS_MODULE, publicationModule: PUB_MODULE },
    });

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

  it('completes from a restored awaiting-finalize session when the modules are already installed', async () => {
    // The host keeps <s2s-publication-init> mounted even after the modules are
    // adopted, and may hand over safeInfo only after connect. A session that
    // says "both proposals sent" + on-chain modules enabled + name recorded
    // must finish the flow from the component itself: emit s2s-init-complete
    // with the session's addresses/name and clear the session.
    seedSession({
      phase: 'awaiting-finalize',
      recordsModule: RECORDS_MODULE,
      publicationModule: PUB_MODULE,
      proposals: [QUEUE_URL, QUEUE_URL],
    });
    const si = makeSafeIntegration({ enabled: true });
    si.getRecord = vi.fn(async (key: string) => (key === 'name' ? PUB_NAME : ''));

    // Mount WITHOUT safeInfo first (the Safe has not resolved yet).
    const el = document.createElement('s2s-publication-init') as S2SPublicationInit;
    Object.assign(el, { protocolInfo: PROTOCOL_INFO, safeIntegration: si });
    const complete = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('s2s-init-complete', (e) => resolve(e as CustomEvent), { once: true });
    });
    document.body.appendChild(el);
    await el.updateComplete;
    await flush();
    expect(si.proposeBatch).not.toHaveBeenCalled();

    // safeInfo arrives late → the session matches and the plan says done.
    Object.assign(el, { safeInfo: SAFE_INFO });
    await el.updateComplete;

    const evt = await complete;
    await flush();

    expect(si.proposeBatch).not.toHaveBeenCalled();
    expect(evt.detail.recordsModule).toBe(RECORDS_MODULE);
    expect(evt.detail.publicationModule).toBe(PUB_MODULE);
    expect(evt.detail.name).toBe(PUB_NAME);
    // The full identity rides on the event — the component has already cleared
    // storage, so the host cannot fall back to reading the session.
    expect(evt.detail.repo).toBe('https://github.com/Joera/website-starter');
    expect(evt.detail.branch).toBe('main');
    expect(evt.detail.authors).toEqual([OWNER_A, OWNER_B]);
    expect(evt.detail.proposals).toEqual([QUEUE_URL, QUEUE_URL]);
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
  });

  it('retry after a "not connected" failure restores the persisted session instead of wiping it', async () => {
    // The failure happened before any session existed in memory (no safeInfo),
    // but a half-finished flow is still persisted. Retry must restore it and
    // resume from the persisted phase — not show a blank form, and not leave
    // the old session behind to be overwritten by a fresh create.
    seedSession({ phase: 'detecting', proposals: [QUEUE_URL] });
    const si = makeSafeIntegration({
      existing: { recordsModule: RECORDS_MODULE, publicationModule: PUB_MODULE },
    });

    const el = document.createElement('s2s-publication-init') as S2SPublicationInit;
    Object.assign(el, { protocolInfo: PROTOCOL_INFO, safeIntegration: si });
    document.body.appendChild(el);
    await el.updateComplete;

    // No Safe yet → Create fails fast, and the persisted session is untouched.
    clickInit(el);
    await vi.waitFor(() => expect(bodyText(el)).toContain('Not connected to a Safe'));
    expect(si.proposeBatch).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).not.toBeNull();

    const complete = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('s2s-init-complete', (e) => resolve(e as CustomEvent), { once: true });
    });

    // The safeInfo race resolves → retry takes the restore path.
    Object.assign(el, { safeInfo: SAFE_INFO });
    await el.updateComplete;
    el.shadowRoot!.querySelector<HTMLElement>('#init-retry')!.click();
    // The session was read (not cleared) on the way in.
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).not.toBeNull();

    const evt = await complete;
    await flush();

    // Resumed at 'detecting': only the merged finalize batch is proposed.
    expect(si.proposeBatch).toHaveBeenCalledTimes(1);
    expectFinalizeShape(si.proposeBatch.mock.calls[0][0] as MetaTransactionData[], PUB_NAME);
    expect(evt.detail.recordsModule).toBe(RECORDS_MODULE);
    expect(evt.detail.name).toBe(PUB_NAME);
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
  });

  it('a late safeInfo does not clobber typed input (name and edited repo survive)', async () => {
    seedSession({ phase: 'detecting', proposals: [QUEUE_URL] });
    const si = makeSafeIntegration({
      existing: { recordsModule: RECORDS_MODULE, publicationModule: PUB_MODULE },
    });

    const el = document.createElement('s2s-publication-init') as S2SPublicationInit;
    Object.assign(el, { protocolInfo: PROTOCOL_INFO, safeIntegration: si });
    document.body.appendChild(el);
    await el.updateComplete;

    // The user starts typing while the Safe is still resolving.
    setInput(el, '#init-name', 'typed-by-user');
    setInput(el, '#init-repo', 'https://github.com/Joera/typed-site');
    await el.updateComplete;

    Object.assign(el, { safeInfo: SAFE_INFO });
    await el.updateComplete;
    await flush();

    // Nothing was restored over the input: the name and repo survive, the
    // component stays on the form, and the persisted session is untouched
    // (no proposals either).
    expect(el.shadowRoot!.querySelector<HTMLInputElement>('#init-name')!.value).toBe(
      'typed-by-user',
    );
    expect(el.shadowRoot!.querySelector<HTMLInputElement>('#init-repo')!.value).toBe(
      'https://github.com/Joera/typed-site',
    );
    expect(el.shadowRoot!.querySelector('#init-start')).not.toBeNull();
    expect(si.proposeBatch).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).not.toBeNull();
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

  it("leaves a host-owned config-phase session untouched on resume (step 3 is s2s-app's)", async () => {
    // A persisted 'configuring'/'awaiting-config' session is driven by the
    // host — the init component unmounts once the modules are live, so
    // restorePersisted must leave it alone: no auto-resume, no proposals.
    seedSession({ phase: 'configuring' });
    const si = makeSafeIntegration();

    let completed = false;
    const el = await mount({ safeIntegration: si });
    el.addEventListener('s2s-init-complete', () => (completed = true), { once: true });
    await el.updateComplete;
    await flush();

    expect(completed).toBe(false);
    expect(si.proposeBatch).not.toHaveBeenCalled();
    // The session stays in storage for the host to drive.
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).not.toBeNull();
    // The component remained on the form — no flow was started.
    expect(el.shadowRoot?.querySelector('#init-start')).toBeTruthy();
  });

  it('picks up the executed finalize live: getRecord only works after the module addresses are adopted', async () => {
    // Regression: on the live page SafeIntegration.recordsModule is null (the
    // module was created AFTER the connect-time module scan), so getRecord
    // throws "Records module not initialized" every poll and the flow would
    // hang on the finalize step with the spinner running forever. The init
    // component must adopt the addresses it learned so the finish-poll works
    // without a reload.
    seedSession({
      phase: 'awaiting-finalize',
      recordsModule: RECORDS_MODULE,
      publicationModule: PUB_MODULE,
      proposals: [QUEUE_URL, QUEUE_URL],
    });
    const si = makeSafeIntegration({ enabled: true });
    let adopted = false;
    si.adoptModules = vi.fn(async () => {
      adopted = true;
    });
    si.getRecord = vi.fn(async (key: string) => {
      if (!adopted) throw new Error('Records module not initialized');
      return key === 'name' ? PUB_NAME : '';
    });

    const { complete } = await mountWithListener(si, { enablePollIntervalMs: 5 });
    const evt = await complete;
    await flush();

    expect(si.adoptModules).toHaveBeenCalledWith(RECORDS_MODULE, PUB_MODULE);
    expect(evt.detail.name).toBe(PUB_NAME);
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

  // -------------------------------------------------------------------------
  // Create-batch skip: the module factories are plain CREATE (non-idempotent),
  // so a Safe that already has a pair must not be asked to deploy another one.
  // -------------------------------------------------------------------------

  it('skips the create batch when the module pair already exists, and goes straight to finalize', async () => {
    // Created by an earlier run; the session was lost, so the component starts
    // from a blank form and would previously have proposed a duplicate pair.
    // `enabled: false` keeps the merged finalize batch unexecuted, so the flow
    // parks at 'awaiting-finalize' instead of racing to done.
    const si = makeSafeIntegration({
      enabled: false,
      existing: { recordsModule: RECORDS_MODULE, publicationModule: PUB_MODULE },
    });

    const el = await mount({ safeIntegration: si });
    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    await vi.waitFor(() => {
      const raw = window.localStorage.getItem(INIT_SESSION_KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!).phase).toBe('awaiting-finalize');
    });

    // No create batch at all — the only proposal is the enable+name batch.
    expect(si.createProposals()).toEqual([]);
    expect(si.proposeBatch).toHaveBeenCalledTimes(1);
    expectFinalizeShape(si.proposeBatch.mock.calls[0][0] as MetaTransactionData[], PUB_NAME);

    // The existing addresses were adopted and persisted, so the flow's next
    // plan is 'finalize' (waiting for the human to execute it).
    expect(si.adoptModules).toHaveBeenCalledWith(RECORDS_MODULE, PUB_MODULE);
    const persisted = JSON.parse(window.localStorage.getItem(INIT_SESSION_KEY)!);
    expect(persisted.recordsModule).toBe(RECORDS_MODULE);
    expect(persisted.publicationModule).toBe(PUB_MODULE);
    expect(bodyText(el)).not.toContain('Publication initialized');
  });

  it('completes without any proposal when the existing pair is enabled and the name is recorded', async () => {
    const si = makeSafeIntegration({
      enabled: true,
      existing: { recordsModule: RECORDS_MODULE, publicationModule: PUB_MODULE },
    });
    // Half-initialized/fully-initialized on-chain state from an earlier run.
    si.getRecord = vi.fn(async (key: string) => (key === 'name' ? PUB_NAME : ''));

    const { el, complete } = await mountWithListener(si);
    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    const evt = await complete;
    await flush();

    expect(si.proposeBatch).not.toHaveBeenCalled();
    expect(evt.detail.recordsModule).toBe(RECORDS_MODULE);
    expect(evt.detail.publicationModule).toBe(PUB_MODULE);
    expect(evt.detail.name).toBe(PUB_NAME);
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
  });

  it('still proposes the create batch exactly once when no modules exist', async () => {
    const si = makeSafeIntegration({ enabled: true });

    const { el, complete } = await mountWithListener(si);
    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    const evt = await complete;
    await flush();

    expect(si.createProposals()).toHaveLength(1);
    expect(evt.detail.recordsModule).toBe(RECORDS_MODULE);
    expect(evt.detail.publicationModule).toBe(PUB_MODULE);
  });

  it('proposes the create batch once when the module scan throws', async () => {
    const si = makeSafeIntegration({ enabled: true });
    const logsImpl = si.fetchFactoryModuleCreatedLogs.getMockImplementation()!;
    let calls = 0;
    // The pre-create scan is the first two fetches: make it fail (RPC hiccup).
    si.fetchFactoryModuleCreatedLogs = vi.fn(async (factoryAddress: string) => {
      calls += 1;
      if (calls <= 2) throw new Error('rpc hiccup');
      return logsImpl(factoryAddress);
    });

    const { el, complete } = await mountWithListener(si);
    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    const evt = await complete;
    await flush();

    // A failed scan must never block the flow.
    expect(si.createProposals()).toHaveLength(1);
    expect(evt.detail.recordsModule).toBe(RECORDS_MODULE);
  });

  it('does not adopt a lone module — a partial pair still proposes the create batch', async () => {
    const si = makeSafeIntegration({
      enabled: true,
      existing: { recordsModule: RECORDS_MODULE }, // publication never deployed
    });

    const { el, complete } = await mountWithListener(si);
    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    await complete;
    await flush();

    expect(si.createProposals()).toHaveLength(1);
    // Nothing was adopted from the scan: only complete pairs are ever adopted
    // (the runAction session adoption later on always carries both).
    expect(
      si.adoptModules.mock.calls.every(([records, publication]) => records && publication),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scan escalation: a pair deployed days ago is outside the default 10k-block
  // window, so the pre-create scan widens once (250k) before giving up.
  // -------------------------------------------------------------------------

  const HEAD_BLOCK = 12_000_000;
  /** Only answer when the query window reaches at least `depth` blocks back. */
  const logsVisibleAtDepth = (
    si: ReturnType<typeof makeSafeIntegration>,
    depth: number,
    pair: { recordsModule?: string; publicationModule?: string },
  ) => {
    si.fetchFactoryModuleCreatedLogs = vi.fn(
      async (factoryAddress: string, _safe?: string, _topic0?: string, fromBlock?: number) => {
        if ((fromBlock ?? HEAD_BLOCK) > HEAD_BLOCK - depth) return [];
        const addr =
          factoryAddress === RECORDS_FACTORY ? pair.recordsModule : pair.publicationModule;
        return addr ? [{ topics: [TOPIC0, PADDED_SAFE, pad(addr)] }] : [];
      },
    );
  };

  it('does not widen the scan when the default window already has the pair', async () => {
    const si = makeSafeIntegration({
      enabled: false,
      existing: { recordsModule: RECORDS_MODULE, publicationModule: PUB_MODULE },
    });

    const el = await mount({ safeIntegration: si });
    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    await vi.waitFor(() => {
      const raw = window.localStorage.getItem(INIT_SESSION_KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!).phase).toBe('awaiting-finalize');
    });

    // A narrow hit is ONE pass — no second, wider window. That pass reads
    // three factories: the records factory, the publication factory named by
    // the protocol record, and the retired publication factory.
    expect(si.fetchFactoryModuleCreatedLogs).toHaveBeenCalledTimes(3);
    expect(si.createProposals()).toEqual([]);
  });

  it('finds a pair whose logs sit only on the retired factory, and does not create a duplicate', async () => {
    // The state after `publication_factory` moves to the V3 deployment: the
    // record's factory has never seen this Safe, the retired one holds the
    // ModuleCreated logs for the pair that already exists.
    const si = makeSafeIntegration({ enabled: false });
    const legacy = LEGACY_PUBLICATION_FACTORIES[0]!;
    si.fetchFactoryModuleCreatedLogs = vi.fn(async (factoryAddress: string) => {
      const address = factoryAddress.toLowerCase();
      if (address === RECORDS_FACTORY.toLowerCase()) {
        return [{ topics: [TOPIC0, PADDED_SAFE, PADDED_RECORDS] }];
      }
      if (address === legacy.toLowerCase()) {
        return [{ topics: [TOPIC0, PADDED_SAFE, PADDED_PUB] }];
      }
      return []; // the record's publication factory, and anything else
    });

    const el = await mount({ safeIntegration: si });
    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    await vi.waitFor(() => {
      const raw = window.localStorage.getItem(INIT_SESSION_KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!).phase).toBe('awaiting-finalize');
    });

    // No create batch: the pair is adopted from the retired factory's logs.
    expect(si.createProposals()).toEqual([]);
    expect(si.adoptModules).toHaveBeenCalledWith(RECORDS_MODULE, PUB_MODULE);
  });

  it('finds a pair older than the default window by widening the scan', async () => {
    // Deployed long ago: invisible at 10k blocks, visible at 250k.
    const si = makeSafeIntegration({ enabled: false });
    logsVisibleAtDepth(si, 250_000, {
      recordsModule: RECORDS_MODULE,
      publicationModule: PUB_MODULE,
    });

    const el = await mount({ safeIntegration: si });
    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    await vi.waitFor(() => {
      const raw = window.localStorage.getItem(INIT_SESSION_KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!).phase).toBe('awaiting-finalize');
    });

    expect(si.createProposals()).toEqual([]);
    expect(si.adoptModules).toHaveBeenCalledWith(RECORDS_MODULE, PUB_MODULE);
    const persisted = JSON.parse(window.localStorage.getItem(INIT_SESSION_KEY)!);
    expect(persisted.recordsModule).toBe(RECORDS_MODULE);
    expect(persisted.publicationModule).toBe(PUB_MODULE);
  });

  it('still proposes the create batch when the wide scan throws', async () => {
    const si = makeSafeIntegration({ enabled: true });
    const base = si.fetchFactoryModuleCreatedLogs.getMockImplementation()!;
    si.fetchFactoryModuleCreatedLogs = vi.fn(
      async (factoryAddress: string, _safe?: string, _topic0?: string, fromBlock?: number) => {
        // Public RPCs often cap getLogs ranges — the wide window is rejected.
        if ((fromBlock ?? HEAD_BLOCK) <= HEAD_BLOCK - 250_000) {
          throw new Error('getLogs range too large');
        }
        return base(factoryAddress);
      },
    );

    const { el, complete } = await mountWithListener(si);
    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    const evt = await complete;
    await flush();

    expect(si.createProposals()).toHaveLength(1);
    expect(evt.detail.recordsModule).toBe(RECORDS_MODULE);
  });

  it('completes a partial narrow hit with the wide scan instead of re-creating', async () => {
    const si = makeSafeIntegration({ enabled: false });
    si.fetchFactoryModuleCreatedLogs = vi.fn(
      async (factoryAddress: string, _safe?: string, _topic0?: string, fromBlock?: number) => {
        const wide = (fromBlock ?? HEAD_BLOCK) <= HEAD_BLOCK - 250_000;
        if (factoryAddress === RECORDS_FACTORY) {
          // Young records module: found by the narrow pass.
          return [{ topics: [TOPIC0, PADDED_SAFE, PADDED_RECORDS] }];
        }
        // Publication module predates the default window.
        return wide ? [{ topics: [TOPIC0, PADDED_SAFE, PADDED_PUB] }] : [];
      },
    );

    const el = await mount({ safeIntegration: si });
    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    await vi.waitFor(() => {
      const raw = window.localStorage.getItem(INIT_SESSION_KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!).phase).toBe('awaiting-finalize');
    });

    // Narrow records + wide publication are merged into one complete pair.
    expect(si.createProposals()).toEqual([]);
    expect(si.adoptModules).toHaveBeenCalledWith(RECORDS_MODULE, PUB_MODULE);
  });

  // -------------------------------------------------------------------------
  // Chain guard: the module factories come from on-chain protocol state read
  // through the Base provider, so they only have code on Base (8453). On any
  // other chain a createModule call is a no-op to a codeless address: the Safe
  // tx SUCCEEDS, no ModuleCreated log is ever emitted, and detection polls a
  // filter that can never match (the live mainnet-Safe "polls forever" bug).
  // -------------------------------------------------------------------------

  const MAINNET_SAFE_INFO = { ...SAFE_INFO, chainId: 1, network: 'ethereum' };
  const NO_CODE_MESSAGE = (chainId: number, address: string) =>
    `The S2S module factories have no code on this Safe's chain (${chainId}): ${address}. They are deployed on Base (8453) — this Safe must be on chain 8453 for the publication init to work.`;

  it('refuses to propose the create batch when the factories have no code on this chain', async () => {
    const si = makeSafeIntegration({ enabled: true, factoryCode: { records: 0, publication: 0 } });
    const el = await mount({ safeIntegration: si, safeInfo: MAINNET_SAFE_INFO });

    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    await vi.waitFor(() => expect(bodyText(el)).toContain('Initialization failed'));
    expect(bodyText(el)).toContain(NO_CODE_MESSAGE(1, RECORDS_FACTORY));
    // Both factories are checked, and NOTHING was proposed: the no-op tx is never
    // sent, so the Safe queue cannot collect a transaction that does nothing.
    expect(si.contractCodeSize).toHaveBeenCalledWith(RECORDS_FACTORY);
    expect(si.contractCodeSize).toHaveBeenCalledWith(PUB_FACTORY);
    expect(si.proposeBatch).not.toHaveBeenCalled();
  });

  it('names the publication factory when only it has no code', async () => {
    const si = makeSafeIntegration({ enabled: true, factoryCode: { publication: 0 } });
    const el = await mount({ safeIntegration: si, safeInfo: MAINNET_SAFE_INFO });

    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    await vi.waitFor(() => expect(bodyText(el)).toContain('Initialization failed'));
    expect(bodyText(el)).toContain(NO_CODE_MESSAGE(1, PUB_FACTORY));
    expect(si.proposeBatch).not.toHaveBeenCalled();
  });

  it('still proposes the create batch when both factories have code', async () => {
    const si = makeSafeIntegration({
      enabled: true,
      factoryCode: { records: 4000, publication: 5000 },
    });

    const { el, complete } = await mountWithListener(si);
    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    const evt = await complete;
    await flush();

    expect(si.contractCodeSize).toHaveBeenCalledWith(RECORDS_FACTORY);
    expect(si.contractCodeSize).toHaveBeenCalledWith(PUB_FACTORY);
    expect(si.createProposals()).toHaveLength(1);
    expect(evt.detail.recordsModule).toBe(RECORDS_MODULE);
  });

  it('fails detect immediately instead of polling when a factory has no code', async () => {
    seedSession({ chainId: 1, phase: 'detecting', proposals: [QUEUE_URL] });
    const si = makeSafeIntegration({ enabled: true, factoryCode: { records: 0 } });
    const el = await mount({ safeIntegration: si, safeInfo: MAINNET_SAFE_INFO });

    await vi.waitFor(() => expect(bodyText(el)).toContain('Initialization failed'));
    expect(bodyText(el)).toContain(NO_CODE_MESSAGE(1, RECORDS_FACTORY));
    // The guard runs BEFORE the polling loop: not a single log fetch, no wait.
    expect(si.fetchFactoryModuleCreatedLogs).not.toHaveBeenCalled();
    expect(si.proposeBatch).not.toHaveBeenCalled();
  });

  it('names chain, factories, block window and log counts in the detect timeout', async () => {
    seedSession({ phase: 'detecting', proposals: [QUEUE_URL] });
    // Factories have code (a correct chain) but no ModuleCreated log ever shows
    // up — the message must carry enough context to diagnose why.
    const si = makeSafeIntegration({ enabled: true });
    si.fetchFactoryModuleCreatedLogs = vi.fn(async () => []);
    const el = await mount({
      safeIntegration: si,
      detectionTimeoutMs: 30,
      detectionPollIntervalMs: 5,
    });

    await vi.waitFor(() => expect(bodyText(el)).toContain('Initialization failed'));
    const error = el.shadowRoot!.querySelector('.init__error')!.textContent ?? '';
    expect(error).toContain('Timed out after 30ms waiting for module deployment logs');
    expect(error).toContain('missing module: records, publication');
    // chainId, both factories, the scanned window and the last poll's counts.
    expect(error).toContain(
      `(chain 8453, factories ${RECORDS_FACTORY}/${PUB_FACTORY}, blocks 11990000-12000000, last poll: 0/0 logs)`,
    );
  });
});

// ---------------------------------------------------------------------------
// Step 1 — ENS registration (the registry lives on L1 only, so it is its own
// proposal and is never batched with the Base module txs).
// ---------------------------------------------------------------------------

const REGISTER_SUBDOMAIN = new Interface([
  'function registerSubdomain(string label, address owner)',
]);
const MAINNET_SAFE = { ...SAFE_INFO, chainId: 1, network: 'ethereum' };

/** Capture every `s2s-init-progress` detail dispatched from now on. */
function trackProgress(el: S2SPublicationInit): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  el.addEventListener('s2s-init-progress', (e) => {
    events.push((e as CustomEvent).detail as Record<string, unknown>);
  });
  return events;
}

function decodeRegisterSubdomain(call: { to: string; data: string }): {
  label: string;
  owner: string;
} {
  const parsed = REGISTER_SUBDOMAIN.parseTransaction({ data: call.data });
  return { label: String(parsed!.args[0]), owner: String(parsed!.args[1]) };
}

/** Single-transaction batches targeting the L1 registry (the ENS proposal). */
function ensProposals(si: ReturnType<typeof makeSafeIntegration>): MetaTransactionData[][] {
  return si.proposeBatch.mock.calls
    .map(([txs]) => txs as MetaTransactionData[])
    .filter((txs) => txs.length === 1 && txs[0].to.toLowerCase() === ENS_REGISTRY.toLowerCase());
}

describe('s2s-publication-init — ENS step (step 1)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('skips step 1 with no proposal when the name is already owned by this Safe', async () => {
    const si = makeSafeIntegration({ enabled: true });
    const el = await mount({ safeIntegration: si });
    const events = trackProgress(el);

    const complete = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('s2s-init-complete', (e) => resolve(e as CustomEvent), { once: true });
    });
    setInput(el, '#init-name', 'my-publication');
    clickInit(el);
    await complete;
    await flush();

    // The registry was read on chain 1, with the session's label.
    expect(si.evmRead).toHaveBeenCalledWith(
      1,
      ENS_REGISTRY,
      expect.anything(),
      'registeredSubdomains',
      ['my-publication'],
    );
    // Nothing was proposed for the name and the flow went straight to the modules.
    expect(ensProposals(si)).toHaveLength(0);
    expect(events.some((d) => d.phase === 'awaiting-ens')).toBe(false);
    expect(si.createProposals()).toHaveLength(1);
  });

  it('surfaces the L1 call and never proposes it from Base, then continues once the owner is the Safe', async () => {
    const si = makeSafeIntegration({ ens: { owner: ZERO_ADDRESS, registered: false } });
    const el = await mount({ safeIntegration: si, ensPollIntervalMs: 5 });
    const events = trackProgress(el);

    const complete = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('s2s-init-complete', (e) => resolve(e as CustomEvent), { once: true });
    });
    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    await vi.waitFor(() => expect(events.some((d) => d.phase === 'awaiting-ens')).toBe(true));
    const detail = events.find((d) => d.phase === 'awaiting-ens')!;
    const call = detail.ensCall as { to: string; data: string };
    expect(call).toBeTruthy();
    expect(call.to).toBe(ENS_REGISTRY);
    expect(decodeRegisterSubdomain(call)).toEqual({
      label: 'my-publication',
      owner: SAFE_ADDRESS,
    });

    // The Safe is on Base: the registry has no code here, so the batch must
    // never be proposed from this Safe.
    expect(si.proposeBatch).not.toHaveBeenCalled();
    // Step 1 is persisted as "proposed" so a reload resumes the wait instead.
    expect(JSON.parse(window.localStorage.getItem(INIT_SESSION_KEY)!).phase).toBe('awaiting-ens');

    // The human executes registerSubdomain from the L1 twin Safe → the poll
    // sees the subnode owned by this Safe and the flow carries on.
    si.ens.owner = SAFE_ADDRESS;
    si.ens.registered = true;
    await complete;
    await flush();

    expect(si.createProposals()).toHaveLength(1);
    expect(events.at(-1)?.ensCall).toBeUndefined();
  });

  it('proposes exactly one registerSubdomain tx from the L1 Safe (chain 1)', async () => {
    const si = makeSafeIntegration({ ens: { owner: ZERO_ADDRESS, registered: false } });
    const el = await mount({
      safeIntegration: si,
      safeInfo: MAINNET_SAFE,
      ensPollIntervalMs: 5,
    });
    const events = trackProgress(el);

    const complete = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('s2s-init-complete', (e) => resolve(e as CustomEvent), { once: true });
    });
    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    await vi.waitFor(() => expect(ensProposals(si)).toHaveLength(1));
    // The tx is IN the Safe queue now: the manual to/data (and the modal's
    // "execute this from the L1 Safe" block) is redundant and must be gone.
    await vi.waitFor(() =>
      expect(events.some((d) => d.step === 'awaiting-ens' && d.ensCall === undefined)).toBe(true),
    );
    const [batch] = ensProposals(si);
    expect(batch).toHaveLength(1);
    expect(batch[0].value).toBe('0');
    expect(decodeRegisterSubdomain(batch[0])).toEqual({
      label: 'my-publication',
      owner: SAFE_ADDRESS,
    });
    // The selector is derived by encoding, never hardcoded.
    expect(batch[0].data.slice(0, 10)).toBe(
      REGISTER_SUBDOMAIN.getFunction('registerSubdomain')!.selector,
    );

    si.ens.owner = SAFE_ADDRESS;
    si.ens.registered = true;
    await complete;
    await flush();

    // One ENS proposal, then the module flow as usual.
    expect(ensProposals(si)).toHaveLength(1);
    expect(si.createProposals()).toHaveLength(1);
  });

  it('times out with the exact L1 command to run when the name never resolves', async () => {
    const si = makeSafeIntegration({ ens: { owner: ZERO_ADDRESS, registered: false } });
    const el = await mount({ safeIntegration: si, ensTimeoutMs: 40, ensPollIntervalMs: 10 });

    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    await vi.waitFor(() =>
      expect(bodyText(el)).toContain('Timed out waiting for my-publication.soul2soul.eth'),
    );
    expect(bodyText(el)).toContain(
      `Register it from the L1 Safe (${SAFE_ADDRESS}) on chain 1: ${ENS_REGISTRY}.registerSubdomain("my-publication", "${SAFE_ADDRESS}").`,
    );
    expect(si.proposeBatch).not.toHaveBeenCalled();
  });

  it('fails when the name is already owned by a third party, without retrying', async () => {
    const si = makeSafeIntegration({ ens: { owner: OWNER_A } });
    const el = await mount({ safeIntegration: si });

    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    await vi.waitFor(() => expect(bodyText(el)).toContain('Initialization failed'));
    expect(bodyText(el)).toContain(
      `${PUB_NAME} is already owned by ${OWNER_A.toLowerCase()}, not this Safe — the publication cannot use this name.`,
    );
    expect(si.proposeBatch).not.toHaveBeenCalled();
    // No auto-retry: the owner was read exactly once.
    expect(si.evmRead.mock.calls.filter(([, , , method]) => method === 'ownerOf')).toHaveLength(1);
  });

  it('fails on a half-written registration (registry says taken, no owner)', async () => {
    const si = makeSafeIntegration({ ens: { owner: ZERO_ADDRESS, registered: true } });
    const el = await mount({ safeIntegration: si });

    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    await vi.waitFor(() => expect(bodyText(el)).toContain('Initialization failed'));
    expect(bodyText(el)).toContain(
      `The ENS registry reports ${PUB_NAME} as taken but the name has no owner — this half-written state needs fixing on chain 1 before the flow can continue.`,
    );
    expect(si.proposeBatch).not.toHaveBeenCalled();
  });

  it('does not re-show the manual call for a chain-1 Safe whose step-1 tx is queued', async () => {
    // Resumed at awaiting-ens on chain 1: the registerSubdomain tx is IN this
    // Safe's queue. Rebuilding the to/data next to the queue URL invites a
    // second identical registration (or a revert once the first lands).
    seedSession({ chainId: 1, phase: 'awaiting-ens', ensProposed: true, proposals: [QUEUE_URL] });
    const si = makeSafeIntegration({ ens: { owner: ZERO_ADDRESS, registered: false } });
    const el = await mount({
      safeIntegration: si,
      safeInfo: MAINNET_SAFE,
      ensPollIntervalMs: 5,
    });

    // Wait for the resume's first L1 poll (where the call used to be rebuilt).
    await vi.waitFor(() => expect(si.evmRead).toHaveBeenCalled());
    await flush();
    expect((el as unknown as { ensCall?: { to: string } }).ensCall).toBeUndefined();
    expect(si.proposeBatch).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(INIT_SESSION_KEY)!).phase).toBe('awaiting-ens');

    si.ens.owner = SAFE_ADDRESS;
    si.ens.registered = true;
    await vi.waitFor(() => expect(si.createProposals()).toHaveLength(1));
    expect(ensProposals(si)).toHaveLength(0);
  });

  it('re-shows the manual call when the Safe cannot propose it (not on chain 1)', async () => {
    // From another chain the app cannot propose the L1 tx at all, so the human
    // needs the exact to/data even though step 1 was already announced.
    seedSession({
      chainId: 8453,
      phase: 'awaiting-ens',
      ensProposed: true,
      proposals: [QUEUE_URL],
    });
    const si = makeSafeIntegration({ ens: { owner: ZERO_ADDRESS, registered: false } });
    const el = await mount({ safeIntegration: si, ensPollIntervalMs: 5 });

    await vi.waitFor(() =>
      expect((el as unknown as { ensCall?: { to: string } }).ensCall?.to).toBe(ENS_REGISTRY),
    );
    expect(si.proposeBatch).not.toHaveBeenCalled();
    expect(ensProposals(si)).toHaveLength(0);
  });
});

describe('s2s-publication-init — ENS step hardening', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('rejects a label the L1 registry would revert on, before any L1 read or write', async () => {
    const si = makeSafeIntegration({ ens: { owner: ZERO_ADDRESS, registered: false } });
    const el = await mount({ safeIntegration: si, safeInfo: MAINNET_SAFE, ensPollIntervalMs: 5 });

    setInput(el, '#init-name', 'My_Publication');
    clickInit(el);
    await flush();

    // ENSOpenSubdomainRegistry.validSubdomain reverts outside [a-z0-9-]: the
    // form is the only place the human can still fix it, and a reverting Safe
    // tx from the L1 twin costs real gas.
    expect(bodyText(el)).toContain('lowercase letters');
    expect(si.evmRead).not.toHaveBeenCalled();
    expect(si.proposeBatch).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();

    // A hyphen at either end is rejected too (the contract's _isValidLabel).
    setInput(el, '#init-name', '-leading');
    clickInit(el);
    await flush();
    expect(bodyText(el)).toContain('not a hyphen');
    expect(si.proposeBatch).not.toHaveBeenCalled();
  });

  it('re-enters step 1 from a later phase without downgrading it or dropping the queued batch links', async () => {
    // The name was released on L1 (or the registry read disagreed) after the
    // create batch went out: step 1 has to run again, but the session must keep
    // saying "the create batch is queued" (`phase: detecting`), or the next
    // plan proposes a second, non-idempotent create batch.
    seedSession({
      phase: 'detecting',
      proposals: [QUEUE_URL],
      recordsModule: undefined,
      publicationModule: undefined,
    });
    const si = makeSafeIntegration({ ens: { owner: ZERO_ADDRESS, registered: false } });
    const el = await mount({ safeIntegration: si, ensPollIntervalMs: 5 });
    const events = trackProgress(el);

    // Step 1 is surfaced (the Safe is on Base, so the L1 call is shown, not sent).
    await vi.waitFor(() => expect(events.some((d) => d.step === 'awaiting-ens')).toBe(true));
    const persisted = JSON.parse(window.localStorage.getItem(INIT_SESSION_KEY)!);
    expect(persisted.phase).toBe('detecting');
    expect(persisted.ensProposed).toBe(true);
    // The queue link the user is following survives the step-1 write.
    expect(persisted.proposals).toEqual([QUEUE_URL]);
    // ...and the modal still renders step 1 as the current step (the phase in
    // the event detail is a display concern; the PERSISTED one above is the
    // resumed state).
    expect(events.find((d) => d.step === 'awaiting-ens')!.phase).toBe('awaiting-ens');

    // Step 2 is NOT proposed while the name is missing (the modules are
    // unreachable through a 0x0 resolver).
    expect(si.createProposals()).toHaveLength(0);
  });

  it('never touches L1 again once step 1 is verified (a resolver outage must not stop steps 2-4)', async () => {
    // Everything is on-chain (an earlier run finished the flow); the session
    // only says so. `ensResolved` is the memo that makes this possible without
    // a single L1 read — the registry RPC being down must change nothing.
    seedSession({
      phase: 'awaiting-finalize',
      ensResolved: true,
      recordsModule: RECORDS_MODULE,
      publicationModule: PUB_MODULE,
      proposals: [QUEUE_URL],
    });
    const si = makeSafeIntegration({ enabled: true });
    si.getRecord.mockImplementation(async (key: string) => (key === 'name' ? PUB_NAME : ''));
    // Every L1 read fails: the flow must not depend on chain 1 any more.
    si.evmRead.mockImplementation(
      async (_chainId: number, _contract: string, _abi: unknown, method: string) => {
        throw new Error(`L1 is down (${method})`);
      },
    );

    const el = await mount({ safeIntegration: si });
    const done = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('s2s-init-complete', (e) => resolve(e as CustomEvent), { once: true });
    });
    await done;
    await flush();

    expect(si.evmRead).not.toHaveBeenCalled();
    expect(bodyText(el)).not.toContain('Initialization failed');
  });

  it('does not re-propose the step-1 tx by itself when the proposal rejects', async () => {
    // Regression guard: a rejected L1 proposal surfaces the error and stops.
    // Re-proposing is an explicit user action (Retry), so a single run can
    // never queue two identical registerSubdomain transactions.
    const si = makeSafeIntegration({ ens: { owner: ZERO_ADDRESS, registered: false } });
    si.proposeBatch = vi.fn(async () => {
      throw new Error('user rejected');
    });
    const el = await mount({ safeIntegration: si, safeInfo: MAINNET_SAFE, ensPollIntervalMs: 5 });

    setInput(el, '#init-name', 'my-publication');
    clickInit(el);

    await vi.waitFor(() => expect(bodyText(el)).toContain('Initialization failed'));
    expect(si.proposeBatch).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(si.proposeBatch).toHaveBeenCalledTimes(1);
    // Nothing is queued, so the flow must not pretend to be waiting on L1.
    expect(el.shadowRoot!.querySelector('#init-retry')).not.toBeNull();
    expect(window.localStorage.getItem(INIT_SESSION_KEY) ?? '').not.toContain('awaiting-ens');
  });

  it('retry from a failed step-1 wait resumes at that step, not at the module step', async () => {
    // The generic retry used to reset the view to 'creating' (step 2) for every
    // phase: a step-1 timeout then looked like a module-creation failure and
    // the modal's step markers jumped past the L1 registration.
    seedSession({ chainId: 1, phase: 'awaiting-ens', ensProposed: true, proposals: [QUEUE_URL] });
    const si = makeSafeIntegration({ ens: { owner: ZERO_ADDRESS, registered: false } });
    const el = await mount({
      safeIntegration: si,
      safeInfo: MAINNET_SAFE,
      ensPollIntervalMs: 10,
      ensTimeoutMs: 30,
    });

    await vi.waitFor(() => expect(bodyText(el)).toContain('Timed out waiting'));
    el.ensTimeoutMs = 5_000;
    el.ensPollIntervalMs = 5;
    const events = trackProgress(el);
    el.shadowRoot!.querySelector<HTMLElement>('#init-retry')!.click();

    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    expect(events[0].step).toBe('awaiting-ens');

    si.ens.owner = SAFE_ADDRESS;
    si.ens.registered = true;
    await vi.waitFor(() => expect(si.createProposals()).toHaveLength(1));
  });

  it('rides out a resolver outage during the wait instead of failing the flow', async () => {
    // A resumed step-1 wait with the L1 RPC down: a failed read is "the chain
    // has not answered yet", not a dead flow. The wait must keep polling (the
    // human may already have executed registerSubdomain) instead of failing
    // with the raw transport error.
    seedSession({ chainId: 1, phase: 'awaiting-ens', ensProposed: true, proposals: [QUEUE_URL] });
    const si = makeSafeIntegration({ ens: { owner: ZERO_ADDRESS, registered: false } });
    const inner = si.evmRead.getMockImplementation()!;
    let failing = true;
    si.evmRead.mockImplementation(
      async (chainId: number, contract: string, abi: unknown, method: string, args: unknown[]) => {
        if (failing) {
          throw Object.assign(new Error('429 Too Many Requests'), { code: 'SERVER_ERROR' });
        }
        return inner(chainId, contract, abi, method, args);
      },
    );

    const el = await mount({
      safeIntegration: si,
      safeInfo: MAINNET_SAFE,
      ensPollIntervalMs: 10,
      ensTimeoutMs: 5_000,
    });
    const done = new Promise<CustomEvent>((resolve) => {
      el.addEventListener('s2s-init-complete', (e) => resolve(e as CustomEvent), { once: true });
    });

    // The RPC recovers and the human's registration lands.
    await new Promise((r) => setTimeout(r, 60));
    failing = false;
    si.ens.owner = SAFE_ADDRESS;
    si.ens.registered = true;
    await done;
    await flush();

    expect(bodyText(el)).not.toContain('Initialization failed');
  });
});
