import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { S2SApp } from '../../src/components/s2s-app';
import type { S2SConfirmModal } from '../../src/components/s2s-confirm-modal';
import type { S2SInitProgressModal } from '../../src/components/s2s-init-progress-modal';
import type { S2SEnsStep } from '../../src/components/ens-name-step';
import {
  INIT_SESSION_KEY,
  loadInitSession,
  saveInitSession,
  type InitPhase,
  type InitSession,
} from '../../src/lib/init-session';
import { mountLit } from '../helpers/mount';

// ---------------------------------------------------------------------------
// Module-level mocks: the shell pulls in the whole heavy graph (Safe SDK via
// safe-integration, protocol-integration, shared LitService, FilecoinStorage,
// evm/ethers, car-builder) plus all five child tab components. We mock every
// one of them so mounting <s2s-app> never touches an iframe, wallet, network
// or the real child tab modules (owned by another worker's spec).
// ---------------------------------------------------------------------------

const SAFE_INFO = {
  address: '0x1111111111111111111111111111111111111111',
  safeAddress: '0x1111111111111111111111111111111111111111',
  chainId: 8453,
  modules: [
    '0x5555555555555555555555555555555555555555',
    '0x4444444444444444444444444444444444444444',
  ],
  s2sPublication: '0x5555555555555555555555555555555555555555',
  s2sRecords: '0x4444444444444444444444444444444444444444',
};

const safeIntMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  getAllRecords: vi.fn(),
  hasPublicationModule: vi.fn(),
  hasRecordsModule: vi.fn(),
  isConnected: vi.fn(),
  fetchSafeModules: vi.fn(),
  proposeBatch: vi.fn(),
  getSafeInfo: vi.fn(),
  getRecord: vi.fn(),
  readIsModuleEnabled: vi.fn(),
  fetchFactoryModuleCreatedLogs: vi.fn(),
  contractCodeSize: vi.fn(),
  getProvider: vi.fn(),
  adoptModules: vi.fn(),
  evmRead: vi.fn(),
}));

const protocolMocks = vi.hoisted(() => ({ initialize: vi.fn() }));

// The records-tab module is mocked away below, so the host's duck-typed call
// (`tab.updateConfig(undefined, { suppressQueueOpen: true })`) needs a stub
// element that implements the pinned contract and records the call.
const recordsTabMocks = vi.hoisted(() => ({ updateConfig: vi.fn() }));

const filecoinMocks = vi.hoisted(() => ({
  initWithSessionKey: vi.fn(),
  listPublicationStorage: vi.fn(),
  walletAddress: '0xwallet123',
}));

const storeMock = vi.hoisted(() => {
  class MockStore {
    safeInfo: unknown = undefined;
    protocolInfo: unknown = undefined;
    private root: string | null = null;
    private records: Array<{ key: string; value: string; type: string }> = [];
    private pieces: unknown[] = [];
    private listeners: Record<string, Array<() => void>> = {
      safe: [],
      protocol: [],
      root: [],
      records: [],
    };

    getRoot() {
      return this.root;
    }
    setRoot(v: string | null) {
      this.root = v;
      this.notify('root');
    }
    getRecord(key: string) {
      return this.records.find((r) => r.key === key)?.value ?? null;
    }
    setRecord(r: { key: string; value: string; type: string }) {
      const i = this.records.findIndex((x) => x.key === r.key);
      if (i >= 0) this.records[i] = r;
      else this.records.push(r);
      this.notify('records');
    }
    setAllRecords(recs: Array<{ key: string; value: string; type: string }>) {
      this.records = recs;
      this.notify('records');
    }
    setSafeInfo(info: unknown) {
      if (info != undefined) {
        this.safeInfo = info;
        this.notify('safe');
      }
    }
    setProtocolInfo(info: unknown) {
      this.protocolInfo = info;
      this.notify('protocol');
    }
    setPieces(p: unknown[]) {
      this.pieces = p;
    }
    getPieces() {
      return this.pieces;
    }
    setDataSets(_d: unknown[]) {}
    subscribeToSafeInfo(l: () => void) {
      this.listeners.safe.push(l);
      return () => {};
    }
    subscribeToProtocolInfo(l: () => void) {
      this.listeners.protocol.push(l);
      return () => {};
    }
    subscribeToRoot(l: () => void) {
      this.listeners.root.push(l);
      return () => {};
    }
    subscribeToRecords(l: () => void) {
      this.listeners.records.push(l);
      return () => {};
    }
    private notify(k: string) {
      this.listeners[k].forEach((l) => l());
    }
    __reset() {
      this.safeInfo = undefined;
      this.protocolInfo = undefined;
      this.root = null;
      this.records = [];
      this.pieces = [];
      for (const k of Object.keys(this.listeners)) this.listeners[k].length = 0;
    }
  }
  return { store: new MockStore() as any };
});

vi.mock('@/lib/safe-integration.js', () => ({
  SafeIntegration: class {
    initialize = safeIntMocks.initialize;
    getAllRecords = safeIntMocks.getAllRecords;
    hasPublicationModule = safeIntMocks.hasPublicationModule;
    hasRecordsModule = safeIntMocks.hasRecordsModule;
    isConnected = safeIntMocks.isConnected;
    fetchSafeModules = safeIntMocks.fetchSafeModules;
    proposeBatch = safeIntMocks.proposeBatch;
    getSafeInfo = safeIntMocks.getSafeInfo;
    getRecord = safeIntMocks.getRecord;
    readIsModuleEnabled = safeIntMocks.readIsModuleEnabled;
    fetchFactoryModuleCreatedLogs = safeIntMocks.fetchFactoryModuleCreatedLogs;
    contractCodeSize = safeIntMocks.contractCodeSize;
    getProvider = safeIntMocks.getProvider;
    adoptModules = safeIntMocks.adoptModules;
    evmRead = safeIntMocks.evmRead;
  },
}));

vi.mock('@/lib/protocol-integration.js', () => ({
  ProtocolIntegration: class {
    initialize = protocolMocks.initialize;
  },
}));

vi.mock('@s2s/soul2soul-shared', () => ({
  LitService: class {},
}));

vi.mock('@s2s/soul2soul-shared/filecoin', () => ({
  FilecoinStorage: class {
    walletAddress = filecoinMocks.walletAddress;
    initWithSessionKey = filecoinMocks.initWithSessionKey;
    listPublicationStorage = filecoinMocks.listPublicationStorage;
  },
}));

vi.mock('@/lib/evm.js', () => ({ evmRead: vi.fn(), getRpcUrl: vi.fn() }));

vi.mock('@s2s/soul2soul-shared/filecoin/car-builder/browser', () => ({
  browserFilecoinBuilder: {},
}));

vi.mock('@/state/store.js', () => ({ store: storeMock.store }));

// Child tab components: stub the modules so the real (heavy) tabs never load.
// The shell still renders elements with the real tag names, so we can assert
// which child is swapped in.
vi.mock('@/components/s2s-deals-tab.js', () => ({ S2SDealsTab: class {} }));
vi.mock('@/components/s2s-whitelist-tab.js', () => ({ S2SWhitelistTab: class {} }));
vi.mock('@/components/s2s-records-tab.js', () => ({ S2SRecordsTab: class {} }));
vi.mock('@/components/s2s-storage-tab.js', () => ({ S2SStorageTab: class {} }));
vi.mock('@/components/s2s-website-tree-tab.js', () => ({ S2SWebsiteTreeTab: class {} }));

// Register a stub for the mocked-away records tab so the shell's config step
// (step 3) has a real element to call. Without it the tag stays an unknown
// element with no updateConfig and the host would (correctly) fail loudly.
if (!customElements.get('s2s-records-tab')) {
  customElements.define(
    's2s-records-tab',
    class extends HTMLElement {
      updateConfig = (...args: unknown[]) => recordsTabMocks.updateConfig(...args);
    },
  );
}

import '../../src/components/s2s-app';

const NAV_TABS = ['deals-tab', 'whitelist-tab', 'records-tab', 'storage-tab', 'website-tree-tab'];

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const LIVE_NAME = 'polyphony.soul2soul.eth';
const RECORDS_MODULE = '0x3333333333333333333333333333333333333333';
const MODULE_SENTINEL = '0x0000000000000000000000000000000000000001';
const NAME_WRAPPER = '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401';
const ENS_PARENT_NODE = '0x' + '1'.repeat(64);

const Q1 =
  'https://app.safe.global/transactions/queue?safe=8453:0x00000000000000000000000000000000000000A1';
const Q2 =
  'https://app.safe.global/transactions/queue?safe=8453:0x00000000000000000000000000000000000000A2';

/** A synthetic progress event, as the init component dispatches it. */
function initProgress(phase: InitPhase, step: string = phase): CustomEvent {
  return new CustomEvent('s2s-init-progress', {
    detail: { step, phase, proposals: [Q1, Q2], name: 'my-pub.soul2soul.eth' },
    bubbles: true,
    composed: true,
  });
}

/** An s2s-init-complete event, as the init component dispatches it. */
function initComplete(
  detail: {
    recordsModule?: string;
    publicationModule?: string;
    name?: string;
    repo?: string;
    branch?: string;
    authors?: string[];
    proposals?: string[];
  } = {
    name: 'my-pub.soul2soul.eth',
    repo: 'https://github.com/Joera/website-starter',
    branch: 'main',
  },
): CustomEvent {
  return new CustomEvent('s2s-init-complete', { detail, bubbles: true, composed: true });
}

/** Wait for the element's async flow to settle (next microtask flush). */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** Make the publication live with an ENS name that is free on L1.
 *  `modulesThrow` is consulted on every module-list read, so a test can fail
 *  the first read and let the next one succeed. */
function mockLiveUnregisteredEns(
  options: { modulesThrow?: () => boolean; name?: string } = {},
): void {
  const name = options.name ?? LIVE_NAME;
  safeIntMocks.getRecord.mockImplementation(async (key: string) => (key === 'name' ? name : ''));
  safeIntMocks.evmRead.mockImplementation(
    async (_chainId: number, _contract: string, _abi: unknown, method: string) => {
      switch (method) {
        case 'getModulesPaginated':
          if (options.modulesThrow?.()) throw new Error('429 Too Many Requests');
          return [[RECORDS_MODULE], MODULE_SENTINEL];
        case 'NAME':
          return 'S2S Records Module';
        case 'getRecord':
          return name;
        case 'parentNode':
          return ENS_PARENT_NODE;
        case 'isParentWrapped':
          return true;
        case 'nameWrapper':
          return NAME_WRAPPER;
        case 'ens':
          return ENS_REGISTRY;
        case 'registeredSubdomains':
          return false;
        case 'ownerOf':
        case 'owner':
          return '0x0000000000000000000000000000000000000000';
        default:
          throw new Error(`unexpected EVM read: ${method}`);
      }
    },
  );
}

/** Seed an in-flight session into localStorage matching SAFE_INFO's Safe. */
function seedInitSession(overrides: Partial<InitSession> = {}): void {
  saveInitSession(window.localStorage, INIT_SESSION_KEY, {
    version: 3,
    chainId: 8453,
    safeAddress: SAFE_INFO.safeAddress,
    phase: 'awaiting-finalize',
    name: 'my-pub',
    publicationName: 'my-pub.soul2soul.eth',
    repo: 'https://github.com/Joera/website-starter',
    branch: 'main',
    authors: [],
    proposals: [Q1, Q2],
    recordsModule: SAFE_INFO.s2sRecords,
    publicationModule: SAFE_INFO.s2sPublication,
    updatedAt: Date.now(),
    ...overrides,
  });
}

/**
 * Drive <s2s-app> into step 3 with `updateConfig()` rejecting with `err` (the
 * modules are deployed but not installed at mount, then go live around the
 * completion), and return the modal plus the rendered error text.
 */
async function mountAndFailConfigStep(err: unknown): Promise<{
  modal: S2SInitProgressModal;
  errorText: string;
}> {
  safeIntMocks.hasPublicationModule.mockReturnValue(false);
  safeIntMocks.hasRecordsModule.mockReturnValue(false);
  safeIntMocks.getRecord.mockResolvedValue('');
  recordsTabMocks.updateConfig.mockRejectedValueOnce(err);

  const el = await mountLit<S2SApp>('s2s-app', {});
  await vi.waitFor(() => expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBeTruthy());
  const init = el.shadowRoot?.querySelector('s2s-publication-init') as HTMLElement;
  // The create batch executed and was adopted → the Config tab renders and the
  // step reaches updateConfig — which throws.
  safeIntMocks.hasPublicationModule.mockReturnValue(true);
  safeIntMocks.hasRecordsModule.mockReturnValue(true);
  init.dispatchEvent(initComplete());

  const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
  await vi.waitFor(() =>
    expect(modal.shadowRoot?.querySelector('#init-progress-error')).toBeTruthy(),
  );
  const errorText = modal.shadowRoot?.querySelector('#init-progress-error')?.textContent ?? '';
  return { modal, errorText };
}

describe('s2s-app (shell)', () => {
  beforeEach(() => {
    storeMock.store.__reset();
    safeIntMocks.initialize.mockReset();
    safeIntMocks.getAllRecords.mockReset();
    safeIntMocks.hasPublicationModule.mockReset();
    safeIntMocks.hasRecordsModule.mockReset();
    safeIntMocks.isConnected.mockReset();
    safeIntMocks.fetchSafeModules.mockReset();
    safeIntMocks.proposeBatch.mockReset();
    safeIntMocks.getSafeInfo.mockReset();
    protocolMocks.initialize.mockReset();
    filecoinMocks.initWithSessionKey.mockReset();
    filecoinMocks.listPublicationStorage.mockReset();

    // Default deterministic "connected app" state.
    safeIntMocks.initialize.mockResolvedValue(SAFE_INFO);
    safeIntMocks.getAllRecords.mockResolvedValue([[], []]);
    safeIntMocks.hasPublicationModule.mockReturnValue(true);
    safeIntMocks.hasRecordsModule.mockReturnValue(true);
    safeIntMocks.isConnected.mockReturnValue(true);
    safeIntMocks.fetchSafeModules.mockResolvedValue(SAFE_INFO.modules);
    safeIntMocks.getSafeInfo.mockReturnValue(SAFE_INFO);
    safeIntMocks.proposeBatch.mockResolvedValue(
      'https://app.safe.global/transactions/queue?safe=8453:0x00000000000000000000000000000000000000A1',
    );
    safeIntMocks.getRecord.mockResolvedValue('');
    safeIntMocks.readIsModuleEnabled.mockResolvedValue(false);
    safeIntMocks.fetchFactoryModuleCreatedLogs.mockResolvedValue([]);
    // The factories have code on the Safe's chain: the create/detect paths reach
    // their own logic instead of failing the "factory has no code" guard (which
    // would hide a duplicate create batch behind an unrelated error).
    safeIntMocks.contractCodeSize.mockReset();
    safeIntMocks.contractCodeSize.mockResolvedValue(4321);
    safeIntMocks.getProvider.mockResolvedValue({ getBlockNumber: vi.fn(async () => 12_000_000) });
    safeIntMocks.adoptModules.mockReset();
    safeIntMocks.adoptModules.mockResolvedValue(undefined);
    // L1 ENS reads: default = the subnode is registered to THIS Safe, i.e. the
    // publication's ENS step is already done (the repair path stays quiet).
    safeIntMocks.evmRead.mockReset();
    safeIntMocks.evmRead.mockImplementation(
      async (_chainId: number, _contract: string, _abi: unknown, method: string) => {
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
            return true;
          case 'ownerOf':
          case 'owner':
            return SAFE_INFO.safeAddress;
          default:
            throw new Error(`unexpected EVM read: ${method}`);
        }
      },
    );
    recordsTabMocks.updateConfig.mockReset();
    recordsTabMocks.updateConfig.mockResolvedValue('bafyconfig');
    protocolMocks.initialize.mockResolvedValue(undefined);
    filecoinMocks.initWithSessionKey.mockResolvedValue(undefined);
    filecoinMocks.listPublicationStorage.mockResolvedValue([]);

    // initFC() (fired in the constructor) fetches /session-key.json.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );

    // A persisted init session from a previous test must never bleed in.
    window.localStorage.clear();
  });

  it('renders the loading screen first, then the full shell once connect resolves', async () => {
    let resolveInit!: (v: unknown) => void;
    safeIntMocks.initialize.mockReturnValue(new Promise((r) => (resolveInit = r)));

    const el = await mountLit<S2SApp>('s2s-app', {});
    // Phase 1: no cache + still fetching → loading.
    expect(el.shadowRoot?.textContent).toContain('Loading Soul2Soul Safe App...');

    // Phase 2: the SDK connect resolves deterministically.
    resolveInit(SAFE_INFO);
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());

    expect(el.shadowRoot?.textContent).not.toContain('Loading Soul2Soul Safe App...');
    for (const id of NAV_TABS) {
      expect(el.shadowRoot?.querySelector(`#${id}`)).toBeTruthy();
    }
  });

  it('renders the five nav tabs and keeps the default deals tab active', async () => {
    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());

    for (const id of NAV_TABS) {
      const btn = el.shadowRoot?.querySelector(`#${id}`) as HTMLButtonElement;
      expect(btn).toBeTruthy();
      expect(btn.textContent?.trim()).toBeTruthy();
    }
    expect(el.shadowRoot?.querySelector('#deals-tab')?.classList.contains('active')).toBe(true);
  });

  it('switches the active tab and swaps the rendered child component', async () => {
    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());

    // Default: deals tab active, deals child mounted, no records child.
    expect(el.shadowRoot?.querySelector('s2s-deals-tab')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('s2s-records-tab')).toBeNull();

    // Click Records → child swaps, active class moves.
    (el.shadowRoot?.querySelector('#records-tab') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('s2s-records-tab')).toBeTruthy());
    expect(el.shadowRoot?.querySelector('s2s-deals-tab')).toBeNull();
    expect(el.shadowRoot?.querySelector('#records-tab')?.classList.contains('active')).toBe(true);
    expect(el.shadowRoot?.querySelector('#deals-tab')?.classList.contains('active')).toBe(false);

    // Storage is always enabled → child appears.
    (el.shadowRoot?.querySelector('#storage-tab') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('s2s-storage-tab')).toBeTruthy());
    expect(el.shadowRoot?.querySelector('s2s-records-tab')).toBeNull();

    // Whitelist is gated by the publication module (on by default).
    (el.shadowRoot?.querySelector('#whitelist-tab') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('s2s-whitelist-tab')).toBeTruthy());
  });

  it('renders the publication init as the whole screen when no modules are installed', async () => {
    safeIntMocks.hasPublicationModule.mockReturnValue(false);
    safeIntMocks.hasRecordsModule.mockReturnValue(false);

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBeTruthy(),
    );
    // The old error banner is replaced by the AD-3 init component.
    expect(el.shadowRoot?.querySelector('.error-message')).toBeNull();
    // The heading lives in the child component's own shadow root.
    const init = el.shadowRoot?.querySelector('s2s-publication-init') as any;
    await vi.waitFor(() => expect(init.shadowRoot?.textContent).toContain('New publication'));

    // With no modules the shell chrome (web-status + tabs) is hidden — the
    // init flow owns the whole screen.
    expect(el.shadowRoot?.querySelector('.web-status')).toBeNull();
    expect(el.shadowRoot?.querySelector('.tabs')).toBeNull();
    expect(el.shadowRoot?.querySelector('.tab-content')).toBeNull();
    for (const id of ['deals-tab', 'storage-tab']) {
      expect(el.shadowRoot?.querySelector(`#${id}`)).toBeNull();
    }
  });

  it('renders the module status pills and the root CID from the store', async () => {
    storeMock.store.setRoot('bafyroot123');

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());

    expect(el.shadowRoot?.textContent).toContain('Connected to Safe');

    const rootHash = el.shadowRoot?.querySelector('copy-hash') as any;
    expect(rootHash.value).toBe('bafyroot123');
  });

  it('renders the reset button behind the module pills when modules exist', async () => {
    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());

    const btn = el.shadowRoot?.querySelector('#reset-publication') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.textContent?.trim()).toBe('Reset');
    // It sits in the same module-status row as the pills.
    expect(el.shadowRoot?.querySelector('.module-status')?.contains(btn)).toBe(true);
  });

  it('hides the reset button when no modules are installed', async () => {
    safeIntMocks.hasPublicationModule.mockReturnValue(false);
    safeIntMocks.hasRecordsModule.mockReturnValue(false);

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBeTruthy(),
    );
    expect(el.shadowRoot?.querySelector('#reset-publication')).toBeNull();
  });

  it('reset: opens a confirmation modal, confirm proposes the teardown batch and shows the queue link', async () => {
    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#reset-publication')).toBeTruthy());

    const modal = el.shadowRoot?.querySelector('s2s-confirm-modal') as S2SConfirmModal;
    expect(modal).toBeTruthy();
    expect(modal.open).toBe(false);

    // Click Reset → the confirmation modal opens over the (blurred) page.
    (el.shadowRoot?.querySelector('#reset-publication') as HTMLElement).click();
    await el.updateComplete;
    expect(modal.open).toBe(true);
    expect(modal.shadowRoot?.querySelector('.overlay')).toBeTruthy();
    expect(modal.shadowRoot?.querySelector('.dialog')?.textContent).toContain('Reset publication?');
    expect(safeIntMocks.proposeBatch).not.toHaveBeenCalled();

    // Confirm in the modal → proposes the teardown batch (disables + name deletion).
    const confirmBtn = modal.shadowRoot?.querySelector('#confirm-ok') as HTMLElement;
    confirmBtn.click();
    await vi.waitFor(() => expect(safeIntMocks.proposeBatch).toHaveBeenCalledTimes(1));
    expect(safeIntMocks.getRecord).toHaveBeenCalledWith('name');
    const batch = safeIntMocks.proposeBatch.mock.calls[0][0] as Array<{
      to: string;
      value: string;
      data: string;
    }>;
    // The name record is NOT on-chain (mock getRecord → ''), so the teardown
    // skips deleteRecord('name') — otherwise the atomic MultiSend reverts
    // KeyNotFound() and the whole reset fails to estimate (GS013).
    expect(batch.length).toBe(2); // 2 disables, no name deletion
    expect(batch.every((tx) => tx.to.toLowerCase() === SAFE_INFO.safeAddress.toLowerCase())).toBe(
      true,
    );

    // The modal stays open while we wait for the owner to execute the teardown
    // in the Safe queue; once executed the app reloads for a fresh init. No
    // success label and no error are rendered in the meantime.
    await el.updateComplete;
    expect(modal.open).toBe(true);
    expect(el.shadowRoot?.querySelector('#reset-status')).toBeNull();
    expect(el.shadowRoot?.querySelector('#reset-error')).toBeNull();
  });

  it('reset: reloads the app once the teardown batch executes (fresh re-init)', async () => {
    // The batch-build call sees the full module list; the execution poll then
    // sees the modules gone → reloadApp runs so the app re-initializes and the
    // 2-proposal init flow comes back.
    safeIntMocks.fetchSafeModules.mockResolvedValueOnce(SAFE_INFO.modules).mockResolvedValue([]);

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#reset-publication')).toBeTruthy());

    const reloadSpy = vi.spyOn(el as unknown as { reloadApp: () => void }, 'reloadApp');
    reloadSpy.mockImplementation(() => {});

    const modal = el.shadowRoot?.querySelector('s2s-confirm-modal') as S2SConfirmModal;
    (el.shadowRoot?.querySelector('#reset-publication') as HTMLElement).click();
    await el.updateComplete;
    const confirmBtn = modal.shadowRoot?.querySelector('#confirm-ok') as HTMLElement;
    confirmBtn.click();
    await vi.waitFor(() => expect(safeIntMocks.proposeBatch).toHaveBeenCalledTimes(1));

    // Teardown built from the fresh module list (2 disables, no name delete).
    const batch = safeIntMocks.proposeBatch.mock.calls[0][0] as Array<{ to: string }>;
    expect(batch.length).toBe(2);

    // The execution poll checks immediately → modules gone → reload scheduled.
    await vi.waitFor(() => expect(reloadSpy).toHaveBeenCalledTimes(1));
  });

  it('reset: includes the deleteRecord op when the name record is on-chain', async () => {
    safeIntMocks.getRecord.mockResolvedValue('my-pub.soul2soul.eth');
    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#reset-publication')).toBeTruthy());

    const modal = el.shadowRoot?.querySelector('s2s-confirm-modal') as S2SConfirmModal;
    (el.shadowRoot?.querySelector('#reset-publication') as HTMLElement).click();
    await el.updateComplete;
    expect(modal.open).toBe(true);

    const confirmBtn = modal.shadowRoot?.querySelector('#confirm-ok') as HTMLElement;
    confirmBtn.click();
    await vi.waitFor(() => expect(safeIntMocks.proposeBatch).toHaveBeenCalledTimes(1));
    const batch = safeIntMocks.proposeBatch.mock.calls[0][0] as Array<{
      to: string;
      value: string;
      data: string;
    }>;
    // Record exists → the full teardown: 2 disables + records.deleteRecord('name').
    expect(batch.length).toBe(3);
    expect(batch[2].to).toBe(SAFE_INFO.s2sRecords);
  });

  it('scopes the Storage pieces to the current publication module only', async () => {
    const pubAddr = SAFE_INFO.s2sPublication.toLowerCase();
    const otherAddr = '0x9999999999999999999999999999999999999999';
    const base = {
      pieceId: 'pid',
      rootCid: 'bafy',
      dataSetId: 'ds1',
      provider: 'filecoin',
      attributed: true,
      size: 10,
      pdpEndEpoch: null,
      isLive: true,
      dataSetMetadata: {},
      scheduledForRemoval: false,
    };
    const attributed = {
      ...base,
      pieceCid: 'baga1',
      metadata: { attributedTo: JSON.stringify([pubAddr]) },
    };
    const foreign = {
      ...base,
      pieceCid: 'baga2',
      metadata: { attributedTo: JSON.stringify([otherAddr]) },
    };
    const unattributed = {
      ...base,
      pieceCid: 'baga3',
      metadata: {},
    };
    filecoinMocks.listPublicationStorage.mockResolvedValue([attributed, foreign, unattributed]);

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());

    // Only the piece attributed to the current publication survives the filter.
    await vi.waitFor(() => expect(storeMock.store.getPieces()).toHaveLength(1));
    expect((storeMock.store.getPieces() as Array<{ pieceCid: string }>)[0].pieceCid).toBe('baga1');
  });

  it('omits the root + preview links when no root CID is available yet', async () => {
    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());

    // No root seeded => no copy-hash, no preview link — only the .limo link.
    expect(el.shadowRoot?.querySelector('copy-hash')).toBeNull();
    expect(el.shadowRoot?.textContent).not.toContain('preview');
    expect(el.shadowRoot?.textContent).toContain('.limo');
  });

  it('keeps the init element mounted after the module addresses are adopted (init phase still pending)', async () => {
    // P0 regression: adoptModules() flips hasRecordsModule()/hasPublicationModule()
    // to true as soon as the create batch executed — the modules are DEPLOYED,
    // not enabled. The shell must not swap the init element out for the tabs
    // then: the enable+name proposal is still pending and step 3 would never run.
    safeIntMocks.hasPublicationModule.mockReturnValue(false);
    safeIntMocks.hasRecordsModule.mockReturnValue(false);

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBeTruthy(),
    );
    const init = el.shadowRoot?.querySelector('s2s-publication-init') as HTMLElement;

    // The addresses are adopted right before the 'finalizing' dispatch, so the
    // very next render already sees hasRecordsModule() === true.
    safeIntMocks.hasPublicationModule.mockReturnValue(true);
    safeIntMocks.hasRecordsModule.mockReturnValue(true);
    init.dispatchEvent(initProgress('finalizing'));
    await el.updateComplete;

    expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBe(init);
    expect(el.shadowRoot?.querySelector('.tabs')).toBeNull();
    expect(el.shadowRoot?.querySelector('s2s-records-tab')).toBeNull();
    // The header must not claim the modules are active while the enable
    // proposal is still pending, and Reset must stay hidden.
    expect(el.shadowRoot?.querySelector('.module-badge.module-active')).toBeNull();
    expect(el.shadowRoot?.querySelector('#reset-publication')).toBeNull();

    // Still mounted while the merged batch waits for execution.
    init.dispatchEvent(initProgress('awaiting-finalize'));
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBe(init);
    expect(el.shadowRoot?.querySelector('.tabs')).toBeNull();
  });

  it('on init-complete: writes the proposed records optimistically, clears the stale root, switches to the Config tab', async () => {
    safeIntMocks.hasPublicationModule.mockReturnValue(false);
    safeIntMocks.hasRecordsModule.mockReturnValue(false);

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBeTruthy(),
    );
    const init = el.shadowRoot?.querySelector('s2s-publication-init') as HTMLElement;

    // A stale root from a previous publication lingers in the store.
    storeMock.store.setRoot('bafystale');

    // The module addresses are adopted mid-flow (deployed, not yet enabled).
    safeIntMocks.hasPublicationModule.mockReturnValue(true);
    safeIntMocks.hasRecordsModule.mockReturnValue(true);
    init.dispatchEvent(initProgress('awaiting-finalize'));
    await el.updateComplete;

    // Step 3 (config): the config record is a THIRD Safe execution. The stub
    // records tab implements the pinned contract, and this mock reports the
    // config record on-chain once the step proposed it → the step completes,
    // the modal closes. (Not before: onInitComplete checks for an EXISTING
    // record first and would otherwise complete a publication with no config.)
    safeIntMocks.getRecord.mockImplementation(async (key: string) =>
      key === 'config' && recordsTabMocks.updateConfig.mock.calls.length > 0 ? 'bafyconfig' : '',
    );
    safeIntMocks.getAllRecords.mockResolvedValue([
      ['name', 'repo', 'branch', 'config'],
      ['my-pub.soul2soul.eth', 'https://github.com/Joera/website-starter', 'main', 'bafyconfig'],
    ]);

    init.dispatchEvent(
      new CustomEvent('s2s-init-complete', {
        detail: {
          recordsModule: SAFE_INFO.s2sRecords,
          publicationModule: SAFE_INFO.s2sPublication,
          proposals: ['https://app.safe.global/transactions/queue?safe=1:0x1'],
          name: 'my-pub.soul2soul.eth',
          repo: 'https://github.com/Joera/website-starter',
          branch: 'main',
        },
        bubbles: true,
        composed: true,
      }),
    );

    // The proposed (not-yet-executed) records land in the store immediately,
    // so the title + web-status populate without a reload.
    await vi.waitFor(() => expect(storeMock.store.getRecord('name')).toBe('my-pub.soul2soul.eth'));
    expect(storeMock.store.getRecord('repo')).toBe('https://github.com/Joera/website-starter');
    expect(storeMock.store.getRecord('branch')).toBe('main');
    // The stale previous-publication root is dropped.
    expect(storeMock.store.getRoot()).toBe('');

    // The shell switched to the Config tab so the automatic build is visible.
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('s2s-records-tab')).toBeTruthy());
    expect(el.shadowRoot?.querySelector('#records-tab')?.classList.contains('active')).toBe(true);

    // Step 3 ran through the host with the pinned tab contract: the tab builds +
    // proposes the config record but does NOT open the queue itself (the modal
    // is the status surface while the step is host-driven).
    await vi.waitFor(() => expect(recordsTabMocks.updateConfig).toHaveBeenCalledTimes(1));
    expect(recordsTabMocks.updateConfig).toHaveBeenCalledWith(undefined, {
      suppressQueueOpen: true,
    });

    // The config record is on-chain → the modal closed and the session cleared.
    const modal = el.shadowRoot?.querySelector(
      's2s-init-progress-modal',
    ) as S2SInitProgressModal | null;
    await vi.waitFor(() => expect(modal?.open).toBe(false));
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
    expect(storeMock.store.getRecord('config')).toBe('bafyconfig');
  });

  it('keeps the modal open until the config record is on-chain AND in the store, then closes it', async () => {
    // User requirement: "only close modal when tx is in and config record is
    // populated". finishConfigStep used to clear the modal FIRST and refresh
    // afterwards, so the Config tab was visible without the record for a beat.
    safeIntMocks.hasPublicationModule.mockReturnValue(false);
    safeIntMocks.hasRecordsModule.mockReturnValue(false);
    safeIntMocks.getAllRecords.mockResolvedValue([[], []]);
    safeIntMocks.getRecord.mockResolvedValue('');

    // The 3rd execution lands when the tab resolves; from that moment on the
    // refresh that must populate the Config tab is parked, so the test can
    // observe the modal while the record is on-chain but not yet in the store.
    let releaseRefresh: ((recs: [string[], string[]]) => void) | undefined;
    recordsTabMocks.updateConfig.mockImplementationOnce(async () => {
      safeIntMocks.getAllRecords.mockReturnValueOnce(
        new Promise<[string[], string[]]>((resolve) => {
          releaseRefresh = resolve;
        }),
      );
      return 'bafyconfig';
    });
    safeIntMocks.getRecord.mockImplementation(async (key: string) =>
      key === 'config' && recordsTabMocks.updateConfig.mock.calls.length > 0 ? 'bafyconfig' : '',
    );

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBeTruthy(),
    );
    const init = el.shadowRoot?.querySelector('s2s-publication-init') as HTMLElement;
    safeIntMocks.hasPublicationModule.mockReturnValue(true);
    safeIntMocks.hasRecordsModule.mockReturnValue(true);
    init.dispatchEvent(initComplete());

    // The record is on-chain, the refresh is still pending: the modal must stay.
    await vi.waitFor(() => expect(releaseRefresh).toBeTruthy());
    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    await el.updateComplete;
    expect(modal.open).toBe(true);
    expect(modal.shadowRoot?.querySelector('#init-progress')).toBeTruthy();
    expect(storeMock.store.getRecord('config')).not.toBe('bafyconfig');
    expect(recordsTabMocks.updateConfig).toHaveBeenCalledTimes(1);

    // The fresh read lands the record in the store → and only then does the
    // modal close (and the finished session stay cleared).
    releaseRefresh?.([
      ['name', 'repo', 'branch', 'config'],
      ['my-pub.soul2soul.eth', 'https://github.com/Joera/website-starter', 'main', 'bafyconfig'],
    ]);
    await vi.waitFor(() => expect(modal.open).toBe(false));
    expect(modal.shadowRoot?.querySelector('#init-progress')).toBeNull();
    expect(storeMock.store.getRecord('config')).toBe('bafyconfig');
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
  });

  // ---- Init progress modal (primary surface: live flow + reload recovery) ----

  it('live s2s-init-progress events open the progress modal and keep it in sync; idle/error close it', async () => {
    safeIntMocks.hasPublicationModule.mockReturnValue(false);
    safeIntMocks.hasRecordsModule.mockReturnValue(false);

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBeTruthy(),
    );

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    expect(modal).toBeTruthy();
    expect(modal.open).toBe(false);

    // Live happy path: the init component reports an in-flight proposal. The
    // modal is the primary progress surface — it opens for the live flow too.
    const init = el.shadowRoot?.querySelector('s2s-publication-init') as HTMLElement;
    init.dispatchEvent(
      new CustomEvent('s2s-init-progress', {
        detail: {
          step: 'awaiting-finalize',
          phase: 'awaiting-finalize',
          proposals: [Q1, Q2],
          name: 'my-pub.soul2soul.eth',
        },
        bubbles: true,
        composed: true,
      }),
    );
    await el.updateComplete;
    expect(modal.open).toBe(true);
    expect(modal.phase).toBe('awaiting-finalize');

    // The element's reset/cancel signal ('idle') closes the overlay: nothing is
    // running, so there is nothing to show over the form.
    init.dispatchEvent(
      new CustomEvent('s2s-init-progress', {
        detail: { step: 'idle', phase: 'creating', proposals: [Q1, Q2] },
        bubbles: true,
        composed: true,
      }),
    );
    await el.updateComplete;
    expect(modal.open).toBe(false);

    // An error closes it too (the element's inline error is the surface).
    init.dispatchEvent(
      new CustomEvent('s2s-init-progress', {
        detail: { step: 'error', phase: 'awaiting-finalize', proposals: [Q1, Q2] },
        bubbles: true,
        composed: true,
      }),
    );
    await el.updateComplete;
    expect(modal.open).toBe(false);
  });

  it('restores a persisted mid-flow session on load and opens the progress modal (recovery fallback)', async () => {
    seedInitSession({
      phase: 'detecting',
      proposals: [Q1],
      recordsModule: undefined,
      publicationModule: undefined,
    });
    safeIntMocks.hasPublicationModule.mockReturnValue(false);
    safeIntMocks.hasRecordsModule.mockReturnValue(false);

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => {
      const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
      expect(modal.open).toBe(true);
    });

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    expect(modal.phase).toBe('detecting');
    const steps = modal.shadowRoot?.querySelectorAll('.step') ?? [];
    expect(steps.length).toBe(4);
  });

  it('shows the standalone ENS step for a live publication whose L1 subnode is unregistered', async () => {
    protocolMocks.initialize.mockResolvedValue({ ensRegistry: ENS_REGISTRY });
    const recordsModule = RECORDS_MODULE;
    const moduleSentinel = MODULE_SENTINEL;
    safeIntMocks.getRecord.mockImplementation(async (key: string) =>
      key === 'name' ? 'polyphony.soul2soul.eth' : '',
    );
    safeIntMocks.evmRead.mockImplementation(
      async (chainId: number, contract: string, _abi: unknown, method: string) => {
        switch (method) {
          // Publication lookup: the name record lives on the Base modules, even
          // when this page's Safe is on chain 1.
          case 'getModulesPaginated':
            expect(chainId).toBe(8453);
            expect(contract).toBe(SAFE_INFO.safeAddress);
            return [[recordsModule], moduleSentinel];
          case 'NAME':
            return 'S2S Records Module';
          case 'getRecord':
            return 'polyphony.soul2soul.eth';
          // L1 registration read: free subnode.
          case 'parentNode':
            return ENS_PARENT_NODE;
          case 'isParentWrapped':
            return true;
          case 'nameWrapper':
            return NAME_WRAPPER;
          case 'ens':
            return ENS_REGISTRY;
          case 'registeredSubdomains':
            return false;
          case 'ownerOf':
          case 'owner':
            return '0x0000000000000000000000000000000000000000';
          default:
            throw new Error(`unexpected EVM read: ${method}`);
        }
      },
    );

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());

    const step = el.shadowRoot?.querySelector('s2s-ens-step') as S2SEnsStep;
    await vi.waitFor(() => expect(step?.shadowRoot?.querySelector('#ens-step')).toBeTruthy());
    expect(step.shadowRoot?.querySelector('#ens-name')?.textContent).toBe(
      'polyphony.soul2soul.eth',
    );
    // Live publication: the card, not the old step-1 repair modal.
    expect(
      (el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal | null)
        ?.open,
    ).toBe(false);
  });

  it('clears the standalone step when the card reports done', async () => {
    protocolMocks.initialize.mockResolvedValue({ ensRegistry: ENS_REGISTRY });
    mockLiveUnregisteredEns();

    const el = await mountLit<S2SApp>('s2s-app', {});
    const step = el.shadowRoot?.querySelector('s2s-ens-step') as S2SEnsStep;
    await vi.waitFor(() => expect(step?.shadowRoot?.querySelector('#ens-step')).toBeTruthy());

    step.dispatchEvent(new CustomEvent('s2s-ens-done', { bubbles: true, composed: true }));
    await vi.waitFor(() => expect(step.shadowRoot?.querySelector('#ens-step')).toBeNull());
  });

  it('keeps the step dismissed after a publication-scope change', async () => {
    protocolMocks.initialize.mockResolvedValue({ ensRegistry: ENS_REGISTRY });
    mockLiveUnregisteredEns();

    const el = await mountLit<S2SApp>('s2s-app', {});
    const step = el.shadowRoot?.querySelector('s2s-ens-step') as S2SEnsStep;
    await vi.waitFor(() => expect(step?.shadowRoot?.querySelector('#ens-step')).toBeTruthy());
    (step.shadowRoot?.querySelector('#ens-dismiss') as HTMLElement).click();
    await vi.waitFor(() => expect(step.shadowRoot?.querySelector('#ens-step')).toBeNull());
    await vi.waitFor(() => expect((el as unknown as { fetching: boolean }).fetching).toBe(false));

    const RENAMED = 'renamed.soul2soul.eth';
    mockLiveUnregisteredEns({ name: RENAMED });
    // A later pass for a scope that WOULD be checked (new publication name)
    // must still be suppressed by the dismiss. Without ensStepDismissed this
    // call sets a fresh state for the renamed publication.
    await (
      el as unknown as {
        maybeCheckEnsStep: (safe: typeof SAFE_INFO, name: string) => Promise<void>;
      }
    ).maybeCheckEnsStep(SAFE_INFO, RENAMED);
    expect((el as unknown as { ensStepState: unknown }).ensStepState).toBeNull();
    expect(step.shadowRoot?.querySelector('#ens-step')).toBeNull();
  });

  it('proposes the ENS registration from a chain-1 Safe', async () => {
    protocolMocks.initialize.mockResolvedValue({ ensRegistry: ENS_REGISTRY });
    safeIntMocks.initialize.mockResolvedValue({ ...SAFE_INFO, chainId: 1 });
    mockLiveUnregisteredEns();

    const el = await mountLit<S2SApp>('s2s-app', {});
    const step = el.shadowRoot?.querySelector('s2s-ens-step') as S2SEnsStep;
    await vi.waitFor(() => expect(step?.shadowRoot?.querySelector('#ens-propose')).toBeTruthy());

    (step.shadowRoot?.querySelector('#ens-propose') as HTMLElement).click();
    await vi.waitFor(() => expect(safeIntMocks.proposeBatch).toHaveBeenCalledTimes(1));

    const batch = safeIntMocks.proposeBatch.mock.calls[0][0] as Array<{
      to: string;
      value: string;
      data: string;
    }>;
    expect(batch).toHaveLength(1);
    expect(batch[0].to).toBe(ENS_REGISTRY);
    expect(batch[0].value).toBe('0');
    expect(batch[0].data).toMatch(/^0x[0-9a-f]+$/i);
  });

  it('does not cache a failed name read as "no publication"', async () => {
    protocolMocks.initialize.mockResolvedValue({ ensRegistry: ENS_REGISTRY });
    let throwOnce = true;
    mockLiveUnregisteredEns({
      modulesThrow: () => {
        if (!throwOnce) return false;
        throwOnce = false;
        return true;
      },
    });
    // Keep the LEGACY repair path quiet (it reads this separate method) so the
    // assertion is about the card's own retry, not about step 1 taking over.
    safeIntMocks.getRecord.mockResolvedValue('');

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());
    expect(el.shadowRoot?.querySelector('s2s-ens-step #ens-step')).toBeNull();
    // Let the FAILED pass settle; a concurrent fetch would join it (single-flight).
    await vi.waitFor(() => expect((el as unknown as { fetching: boolean }).fetching).toBe(false));

    // A later refresh (records event / manual) makes a clean read and shows it.
    await (el as unknown as { fetchFreshData: () => Promise<void> }).fetchFreshData();
    await vi.waitFor(() => {
      const host = el.shadowRoot?.querySelector('s2s-ens-step') as S2SEnsStep | null;
      expect(host?.shadowRoot?.querySelector('#ens-step')).toBeTruthy();
    });
  });

  it('does not show the standalone card when the protocol registry is unknown', async () => {
    // No fallback to the hardcoded registry for a REAL transaction: the legacy
    // repair path may still explain the state, but this card stays out of it.
    protocolMocks.initialize.mockResolvedValue(undefined);
    mockLiveUnregisteredEns();

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());
    // Let the post-records check settle: asserting before it runs would pass
    // even with the hardcoded fallback restored.
    await vi.waitFor(() => expect((el as unknown as { fetching: boolean }).fetching).toBe(false));

    const step = el.shadowRoot?.querySelector('s2s-ens-step') as S2SEnsStep | null;
    expect(step?.shadowRoot?.querySelector('#ens-step') ?? null).toBeNull();
    expect((el as unknown as { ensStepState: unknown }).ensStepState).toBeNull();
  });

  it('loads the publication records without waiting for the ENS lookup', async () => {
    protocolMocks.initialize.mockResolvedValue({ ensRegistry: ENS_REGISTRY });
    mockLiveUnregisteredEns();
    safeIntMocks.getAllRecords.mockResolvedValue([['name'], [LIVE_NAME]]);
    // Never answer the module list: the optional ENS step must not hold paint.
    safeIntMocks.evmRead.mockImplementation(
      async (_chainId: number, _contract: string, _abi: unknown, method: string) => {
        if (method === 'getModulesPaginated') return new Promise<never>(() => {});
        throw new Error(`unexpected EVM read: ${method}`);
      },
    );

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());
    // The records must be in the store before the hung lookup can finish; the
    // title is what proves getAllRecords ran, not merely that the tab exists.
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('.title')?.textContent?.trim()).toBe(LIVE_NAME),
    );
    expect(el.shadowRoot?.querySelector('s2s-ens-step #ens-step')).toBeNull();
  });

  it('seeds step 1 for a publication whose ENS name was never registered', async () => {
    // The pre-ENS publication: both modules installed, name record on-chain,
    // but no `polyphony.soul2soul.eth` subnode — the name resolves to 0x0 and
    // nothing would ever notice (no session, modules live).
    safeIntMocks.getRecord.mockImplementation(async (key: string) =>
      key === 'name' ? 'polyphony.soul2soul.eth' : '',
    );
    safeIntMocks.evmRead.mockImplementation(
      async (_chainId: number, _contract: string, _abi: unknown, method: string) => {
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
            return false;
          case 'ownerOf':
          case 'owner':
            return '0x0000000000000000000000000000000000000000';
          default:
            throw new Error(`unexpected EVM read: ${method}`);
        }
      },
    );

    const el = await mountLit<S2SApp>('s2s-app', {});
    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    await vi.waitFor(() => expect(modal.open).toBe(true));

    // The flow is seeded at step 1, for THIS Safe, with the label from the name
    // record and the full name kept for the records steps.
    expect(modal.phase).toBe('ens');
    expect(
      modal.shadowRoot?.querySelector('[data-step="1"]')?.classList.contains('step--current'),
    ).toBe(true);
    const session = loadInitSession(window.localStorage, INIT_SESSION_KEY);
    expect(session).toMatchObject({
      version: 3,
      phase: 'ens',
      chainId: 8453,
      safeAddress: SAFE_INFO.safeAddress,
      name: 'polyphony',
      publicationName: 'polyphony.soul2soul.eth',
    });
    // The repair only seeds the flow — it proposes nothing itself.
    expect(safeIntMocks.proposeBatch).not.toHaveBeenCalled();

    // The element's step-1 call is forwarded to the modal, which renders it.
    const init = el.shadowRoot?.querySelector('s2s-publication-init') as HTMLElement;
    init.dispatchEvent(
      new CustomEvent('s2s-init-progress', {
        detail: {
          step: 'awaiting-ens',
          phase: 'awaiting-ens',
          proposals: [],
          ensCall: { to: ENS_REGISTRY, data: '0xdeadbeef' },
        },
        bubbles: true,
        composed: true,
      }),
    );
    await el.updateComplete;
    await modal.updateComplete;
    expect(modal.ensCall).toEqual({ to: ENS_REGISTRY, data: '0xdeadbeef' });
    expect(modal.shadowRoot?.querySelector('#init-ens-call')?.textContent).toContain(ENS_REGISTRY);
  });

  it('leaves a publication alone when its ENS name already resolves to this Safe', async () => {
    safeIntMocks.getRecord.mockImplementation(async (key: string) =>
      key === 'name' ? 'polyphony.soul2soul.eth' : '',
    );
    // beforeEach's evmRead default: registered + ownedBySafe.

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    expect(modal.open).toBe(false);
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
    expect(safeIntMocks.getRecord).toHaveBeenCalledWith('name');
  });

  it('seeds the repair session with the installed module addresses, so the resumed flow cannot re-create the pair', async () => {
    safeIntMocks.getRecord.mockImplementation(async (key: string) =>
      key === 'name' ? 'polyphony.soul2soul.eth' : '',
    );
    // A resolvable protocol info: the resumed flow needs it to run.
    protocolMocks.initialize.mockResolvedValue({
      ensRegistry: ENS_REGISTRY,
      ensRecords: '0x00000000000000000000000000000000000000ee',
      recordsFactory: '0x00000000000000000000000000000000000000f1',
      publicationFactory: '0x00000000000000000000000000000000000000f2',
    });
    let ownerReads = 0;
    safeIntMocks.evmRead.mockImplementation(
      async (_chainId: number, _contract: string, _abi: unknown, method: string) => {
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
            return ownerReads > 0;
          case 'ownerOf':
          case 'owner':
            // First read = the repair (no subnode yet); every later read = the
            // human registered it from the L1 Safe in between.
            ownerReads += 1;
            return ownerReads > 1
              ? SAFE_INFO.safeAddress
              : '0x0000000000000000000000000000000000000000';
          default:
            throw new Error(`unexpected EVM read: ${method}`);
        }
      },
    );

    const el = await mountLit<S2SApp>('s2s-app', {});

    // THE property, asserted before anything else can fail: whatever the flow
    // does, it must never propose the 2-tx create batch to the module factories.
    // The modules are DEPLOYED but not enabled — invisible to
    // hasRecordsModule() and (deep history) to the ModuleCreated scan, while the
    // factories use plain CREATE, so a seeded session without their addresses
    // would plan step 2 and deploy a SECOND pair over the live publication.
    await vi.waitFor(() => expect(safeIntMocks.proposeBatch).toHaveBeenCalled(), {
      timeout: 5_000,
    });
    await flush();
    const batches = () =>
      safeIntMocks.proposeBatch.mock.calls.map(([txs]) => txs as Array<{ to: string }>);
    expect(batches().filter((txs) => txs.length === 2)).toEqual([]);

    // …and it is the merged enable+record batch: 2 Safe self-calls + the name
    // record, all from the modules the session was seeded with.
    expect(batches()).toHaveLength(1);
    expect(
      batches()[0]
        .slice(0, 2)
        .every((tx) => tx.to === SAFE_INFO.safeAddress),
    ).toBe(true);
    expect(
      batches()[0]
        .slice(2)
        .every((tx) => tx.to === SAFE_INFO.s2sRecords),
    ).toBe(true);

    // The seed is what makes that possible.
    const seeded = loadInitSession(window.localStorage, INIT_SESSION_KEY)!;
    expect(seeded.recordsModule).toBe(SAFE_INFO.s2sRecords);
    expect(seeded.publicationModule).toBe(SAFE_INFO.s2sPublication);
    await vi.waitFor(
      () =>
        expect(loadInitSession(window.localStorage, INIT_SESSION_KEY)!.phase).toBe(
          'awaiting-finalize',
        ),
      { timeout: 5_000 },
    );
  });

  it('reads the ENS registry from the protocol info instead of a hardcoded address', async () => {
    // The registry address is deployment-specific; the repair must read the one
    // the protocol integration just resolved (it runs BEFORE the repair for
    // exactly this reason).
    const CUSTOM_REGISTRY = '0x2222222222222222222222222222222222222222';
    protocolMocks.initialize.mockResolvedValue({
      ensRegistry: CUSTOM_REGISTRY,
      ensRecords: '0x00000000000000000000000000000000000000ee',
      recordsFactory: '0x00000000000000000000000000000000000000f1',
      publicationFactory: '0x00000000000000000000000000000000000000f2',
    });
    safeIntMocks.getRecord.mockImplementation(async (key: string) =>
      key === 'name' ? 'polyphony.soul2soul.eth' : '',
    );
    safeIntMocks.evmRead.mockImplementation(
      async (_chainId: number, _contract: string, _abi: unknown, method: string) => {
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
            return false;
          case 'ownerOf':
          case 'owner':
            return '0x0000000000000000000000000000000000000000';
          default:
            throw new Error(`unexpected EVM read: ${method}`);
        }
      },
    );

    const el = await mountLit<S2SApp>('s2s-app', {});
    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    await vi.waitFor(() => expect(modal.open).toBe(true));

    expect(safeIntMocks.evmRead).toHaveBeenCalledWith(
      1,
      CUSTOM_REGISTRY,
      expect.anything(),
      'registeredSubdomains',
      ['polyphony'],
    );
  });

  it('does not seed step 1 over a config-phase session (that step owns the modal)', async () => {
    // Reload after the finalize batch executed but before the config record: the
    // host resumes step 3. The name is not registered on L1 in this fixture, so
    // a repair that runs in the window before `initPhase` is set would overwrite
    // the session with a step-1 flow and strand the config step.
    seedInitSession({ phase: 'awaiting-config' });
    safeIntMocks.getRecord.mockImplementation(async (key: string) =>
      key === 'name' ? 'polyphony.soul2soul.eth' : '',
    );
    safeIntMocks.evmRead.mockImplementation(
      async (_chainId: number, _contract: string, _abi: unknown, method: string) => {
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
            return false;
          case 'ownerOf':
          case 'owner':
            return '0x0000000000000000000000000000000000000000';
          default:
            throw new Error(`unexpected EVM read: ${method}`);
        }
      },
    );

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());
    await vi.waitFor(() =>
      expect(loadInitSession(window.localStorage, INIT_SESSION_KEY)!.phase).toBe('awaiting-config'),
    );

    // The session is untouched: same flow, same publication, same step.
    expect(loadInitSession(window.localStorage, INIT_SESSION_KEY)).toMatchObject({
      phase: 'awaiting-config',
      name: 'my-pub',
      publicationName: 'my-pub.soul2soul.eth',
    });
    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    expect(modal.phase).not.toBe('ens');
    expect(safeIntMocks.evmRead).not.toHaveBeenCalled();
  });

  it('retries the repair after the config step finishes in the same page load', async () => {
    // Ordering: the config step owns the session and the modal on load, so the
    // repair must stand down — but only for THAT pass. A repair skipped (or a
    // registry read rate-limited) once must not poison the rest of the page
    // load, or a legacy publication whose config step finishes later never gets
    // its step 1 until a reload.
    seedInitSession({ phase: 'awaiting-config' });
    safeIntMocks.hasRecordsModule.mockReturnValue(true);
    safeIntMocks.hasPublicationModule.mockReturnValue(true);
    // The config record lands AFTER the first refresh pass: that is the real
    // ordering (the resume polls the queue while the pass finishes), and it keeps
    // finishConfigStep outside the pass so its refresh can start a new one.
    let configOnChain = false;
    safeIntMocks.getRecord.mockImplementation(async (key: string) => {
      if (key === 'config') return configOnChain ? 'bafyconfig' : '';
      if (key === 'name') return 'polyphony.soul2soul.eth';
      return '';
    });
    safeIntMocks.evmRead.mockImplementation(
      async (_chainId: number, _contract: string, _abi: unknown, method: string) => {
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
            return false;
          case 'ownerOf':
          case 'owner':
            return '0x0000000000000000000000000000000000000000';
          default:
            throw new Error(`unexpected EVM read: ${method}`);
        }
      },
    );

    const el = await mountLit<S2SApp>('s2s-app', {});
    // First pass: the config step owns the session, so the repair stands down.
    await vi.waitFor(() => expect(safeIntMocks.getAllRecords).toHaveBeenCalled());
    expect(loadInitSession(window.localStorage, INIT_SESSION_KEY)?.phase).toBe('awaiting-config');
    expect(safeIntMocks.evmRead).not.toHaveBeenCalled();

    // The queued config tx is executed on Base → the step finishes and its
    // refresh must give the earlier skipped repair a second chance.
    configOnChain = true;
    await vi.waitFor(
      () => expect(loadInitSession(window.localStorage, INIT_SESSION_KEY)?.phase).toBe('ens'),
      { timeout: 10_000 },
    );
    const seeded = loadInitSession(window.localStorage, INIT_SESSION_KEY)!;
    expect(seeded.name).toBe('polyphony');
    expect(seeded.recordsModule).toBe(SAFE_INFO.s2sRecords);
    expect(seeded.publicationModule).toBe(SAFE_INFO.s2sPublication);

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    await vi.waitFor(() => expect(modal.open).toBe(true));
    expect(modal.phase).toBe('ens');
  });

  it('the repair stands down on both config flags even with no session on disk', async () => {
    // Discriminates the flags from the "any session on disk" guard: here there is
    // none, so only `configResumePending` / `configWaitActive` can save the page
    // from a step-1 modal.
    safeIntMocks.getRecord.mockImplementation(async (key: string) =>
      key === 'name' ? 'polyphony.soul2soul.eth' : '',
    );
    safeIntMocks.evmRead.mockImplementation(
      async (_chainId: number, _contract: string, _abi: unknown, method: string) => {
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
            return false;
          case 'ownerOf':
          case 'owner':
            return '0x0000000000000000000000000000000000000000';
          default:
            throw new Error(`unexpected EVM read: ${method}`);
        }
      },
    );

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());

    const probe = el as unknown as {
      initPhase: InitPhase | null;
      configResumePending: boolean;
      configWaitActive: boolean;
      ensRepairSuppressed: boolean;
      ensRepairDone: Set<string>;
      maybeRepairEnsRegistration: (i: typeof SAFE_INFO) => Promise<void>;
    };
    // Back to the moment before the pass: no flow of our own, no verdict, no
    // session. Everything a repair needs to seed except the config flags.
    const run = async (): Promise<void> => {
      probe.initPhase = null;
      probe.initModalOpen = false;
      probe.ensRepairSuppressed = false;
      probe.ensRepairDone.clear();
      window.localStorage.clear();
      safeIntMocks.evmRead.mockClear();
      await probe.maybeRepairEnsRegistration(SAFE_INFO);
    };

    // Sanity: with no flag set and no session, this fixture DOES seed.
    await run();
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).not.toBeNull();

    probe.configResumePending = true;
    await run();
    expect(safeIntMocks.evmRead).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
    probe.configResumePending = false;

    probe.configWaitActive = true;
    await run();
    expect(safeIntMocks.evmRead).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
    probe.configWaitActive = false;

    // Both flags down again: the repair is retried, not written off.
    await run();
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).not.toBeNull();
  });

  it('retries the repair on a later pass after a failed registry read', async () => {
    // A 429 during the repair's L1 batch is not a verdict about the name: the
    // pass must not be written off for the rest of the page load.
    safeIntMocks.getRecord.mockImplementation(async (key: string) =>
      key === 'name' ? 'polyphony.soul2soul.eth' : '',
    );
    let failReads = true;
    safeIntMocks.evmRead.mockImplementation(
      async (_chainId: number, _contract: string, _abi: unknown, method: string) => {
        if (failReads) throw new Error('429 Too Many Requests');
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
            return false;
          case 'ownerOf':
          case 'owner':
            return '0x0000000000000000000000000000000000000000';
          default:
            throw new Error(`unexpected EVM read: ${method}`);
        }
      },
    );

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(safeIntMocks.evmRead).toHaveBeenCalled());
    // No verdict: no step-1 modal, no session, and the key is not burnt.
    expect(loadInitSession(window.localStorage, INIT_SESSION_KEY)).toBeNull();
    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    expect(modal.open).toBeFalsy();
    const probe = el as unknown as { ensRepairDone: Set<string> };
    expect([...probe.ensRepairDone]).toEqual([]);

    // The registry recovers: any later refresh (a tab action, a config retry —
    // in the test: one more pass) seeds step 1.
    failReads = false;
    await (el as unknown as { fetchFreshData: () => Promise<void> }).fetchFreshData();
    await vi.waitFor(
      () => expect(loadInitSession(window.localStorage, INIT_SESSION_KEY)?.phase).toBe('ens'),
      { timeout: 5_000 },
    );
  });

  it('the host writer moves the phase BACK on a failure (the documented exception)', async () => {
    // Monotonicity belongs to the init component. This writer records failures,
    // where going back is the point: 'configuring' says "nothing is queued, the
    // Retry rebuilds", while a forward-only 'awaiting-config' would claim a
    // proposal exists and make Retry wait 10 minutes for a tx that never was.
    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());

    seedInitSession({ phase: 'awaiting-config' });
    (
      el as unknown as { persistInitPhase: (p: InitPhase, e?: Partial<InitSession>) => void }
    ).persistInitPhase('configuring', { proposals: [] });

    const after = loadInitSession(window.localStorage, INIT_SESSION_KEY)!;
    expect(after.phase).toBe('configuring');
    // …without losing what the earlier phase had written.
    expect(after.name).toBe('my-pub');
    expect(after.recordsModule).toBe(SAFE_INFO.s2sRecords);
    expect(after.proposals).toEqual([]);
  });

  it('leaves a name owned by a third party alone (no step-1 modal, no session)', async () => {
    const THIRD_PARTY = '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc';
    safeIntMocks.getRecord.mockImplementation(async (key: string) =>
      key === 'name' ? 'polyphony.soul2soul.eth' : '',
    );
    safeIntMocks.evmRead.mockImplementation(
      async (_chainId: number, _contract: string, _abi: unknown, method: string) => {
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
            return true;
          case 'ownerOf':
          case 'owner':
            return THIRD_PARTY;
          default:
            throw new Error(`unexpected EVM read: ${method}`);
        }
      },
    );

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());
    // Wait for the repair to actually read L1 (otherwise the assertions below
    // would pass before it ever ran).
    await vi.waitFor(() => expect(safeIntMocks.evmRead).toHaveBeenCalled());
    await flush();

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    expect(modal.open).toBe(false);
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
  });

  it('leaves a half-written (desynced) registration alone instead of opening a dead step 1', async () => {
    safeIntMocks.getRecord.mockImplementation(async (key: string) =>
      key === 'name' ? 'polyphony.soul2soul.eth' : '',
    );
    safeIntMocks.evmRead.mockImplementation(
      async (_chainId: number, _contract: string, _abi: unknown, method: string) => {
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
            return true; // the registry flag says registered…
          case 'ownerOf':
          case 'owner':
            return '0x0000000000000000000000000000000000000000'; // …but nobody owns it
          default:
            throw new Error(`unexpected EVM read: ${method}`);
        }
      },
    );

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());
    await vi.waitFor(() => expect(safeIntMocks.evmRead).toHaveBeenCalled());
    await flush();

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    expect(modal.open).toBe(false);
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
  });

  it('treats an unreadable ENS registry as "unknown" and leaves the publication alone', async () => {
    // A 429 on the L1 read used to surface as "registered, no owner" → a fatal
    // desync verdict for a page that is perfectly fine.
    safeIntMocks.getRecord.mockImplementation(async (key: string) =>
      key === 'name' ? 'polyphony.soul2soul.eth' : '',
    );
    safeIntMocks.evmRead.mockImplementation(
      async (_chainId: number, _contract: string, _abi: unknown, method: string) => {
        if (method === 'nameWrapper') {
          throw Object.assign(new Error('429 Too Many Requests'), { code: 'SERVER_ERROR' });
        }
        switch (method) {
          case 'parentNode':
            return ENS_PARENT_NODE;
          case 'isParentWrapped':
            return true;
          case 'ens':
            return ENS_REGISTRY;
          case 'registeredSubdomains':
            return true;
          case 'ownerOf':
          case 'owner':
            return SAFE_INFO.safeAddress;
          default:
            throw new Error(`unexpected EVM read: ${method}`);
        }
      },
    );

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());
    await vi.waitFor(() => expect(safeIntMocks.evmRead).toHaveBeenCalled());
    await flush();

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    expect(modal.open).toBe(false);
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
  });

  it('resumes a config-phase session and finishes when the config record is already on-chain', async () => {
    // Reload happened while the host's step 3 (config) was pending, but the
    // config record already made it on-chain → do not re-propose, just finish:
    // clear the session + close the modal, with the Config tab showing it.
    seedInitSession({ phase: 'awaiting-config' });
    safeIntMocks.hasRecordsModule.mockReturnValue(true);
    safeIntMocks.getRecord.mockResolvedValue('bafyconfig');

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    await vi.waitFor(() => expect(modal.open).toBe(false));
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
  });

  it('drops a stale config-phase session when the modules are gone (post-reset)', async () => {
    // A config-phase session with no live modules is stale — a reset
    // disabled the modules, so nothing can drive step 3. The recovered flow
    // must not wedge the modal on it: drop the session silently.
    seedInitSession({ phase: 'configuring' });
    safeIntMocks.hasRecordsModule.mockReturnValue(false);
    safeIntMocks.getRecord.mockResolvedValue('');

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    expect(modal.open).toBe(false);
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
  });

  it('ignores a persisted session that belongs to a different Safe', async () => {
    seedInitSession({ safeAddress: '0x9999999999999999999999999999999999999999' });

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    expect(modal.open).toBe(false);
  });

  it('keeps an init-phase session that has installed module addresses (modules deployed ≠ flow done)', async () => {
    // The module addresses are learned mid-flow and adopted, so hasRecordsModule()
    // is true while the ENABLE proposal may still be pending. That is not
    // "finished": the session must survive, the modal must stay open at its
    // phase, and the init element stays mounted to plan the next action.
    seedInitSession({ phase: 'awaiting-finalize' });
    safeIntMocks.hasRecordsModule.mockReturnValue(true);

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBeTruthy(),
    );

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    await vi.waitFor(() => expect(modal.open).toBe(true));
    expect(modal.phase).toBe('awaiting-finalize');
    // Session kept verbatim — it drives the resumed flow.
    expect(loadInitSession(window.localStorage, INIT_SESSION_KEY)?.phase).toBe('awaiting-finalize');
    // The live UI (tabs, module badges, Reset) stays hidden while a phase runs.
    expect(el.shadowRoot?.querySelector('.tabs')).toBeNull();
    expect(el.shadowRoot?.querySelector('.module-badge.module-active')).toBeNull();
  });

  it('keeps a finalizing session with installed modules and opens the modal at that phase', async () => {
    seedInitSession({ phase: 'finalizing' });
    safeIntMocks.hasRecordsModule.mockReturnValue(true);

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBeTruthy(),
    );

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    await vi.waitFor(() => expect(modal.open).toBe(true));
    expect(modal.phase).toBe('finalizing');
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).not.toBeNull();
  });

  it('resumeConfigStep selects the Config tab and calls updateConfig with the pinned contract', async () => {
    // Regression: resumeConfigStep never set currentTab, so the records tab was
    // never rendered, updateConfig was silently skipped and the host waited 10
    // minutes for a config record that was never proposed.
    seedInitSession({ phase: 'configuring' });
    safeIntMocks.hasRecordsModule.mockReturnValue(true);
    safeIntMocks.getRecord.mockResolvedValue('');

    const el = await mountLit<S2SApp>('s2s-app', {});
    // The default tab is 'deals'; the config step must switch to Config.
    await vi.waitFor(() => expect(recordsTabMocks.updateConfig).toHaveBeenCalledTimes(1));
    expect(recordsTabMocks.updateConfig).toHaveBeenCalledWith(undefined, {
      suppressQueueOpen: true,
    });
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('#records-tab')?.classList.contains('active')).toBe(true);
    expect(el.shadowRoot?.querySelector('s2s-records-tab')).toBeTruthy();

    // The step is now waiting on the 3rd Safe execution — modal open with step 3
    // current (the only progress surface now), session at 'awaiting-config'.
    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    await vi.waitFor(() => expect(modal.phase).toBe('awaiting-config'));
    expect(modal.open).toBe(true);
    await vi.waitFor(() =>
      expect(
        modal.shadowRoot?.querySelector('[data-step="4"]')?.classList.contains('step--current'),
      ).toBe(true),
    );
    expect(modal.shadowRoot?.querySelector('[data-step="4"] .step__marker--spinner')).toBeTruthy();
    expect(loadInitSession(window.localStorage, INIT_SESSION_KEY)?.phase).toBe('awaiting-config');
  });

  it('fails loudly when the records tab is missing during the config step (no silent skip, no long wait)', async () => {
    // No modules installed → the Config tab never renders, so the host has no
    // way to propose the config record. It must keep the modal open with an
    // error and keep the session at 'configuring' — not wait 10 minutes and
    // then wipe the flow.
    safeIntMocks.hasPublicationModule.mockReturnValue(false);
    safeIntMocks.hasRecordsModule.mockReturnValue(false);

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBeTruthy(),
    );
    const init = el.shadowRoot?.querySelector('s2s-publication-init') as HTMLElement;

    init.dispatchEvent(
      new CustomEvent('s2s-init-complete', {
        detail: {
          recordsModule: SAFE_INFO.s2sRecords,
          publicationModule: SAFE_INFO.s2sPublication,
          proposals: [Q1, Q2],
          name: 'my-pub.soul2soul.eth',
          repo: 'https://github.com/Joera/website-starter',
          branch: 'main',
        },
        bubbles: true,
        composed: true,
      }),
    );

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    await vi.waitFor(() =>
      expect(modal.shadowRoot?.querySelector('#init-progress-error')).toBeTruthy(),
    );
    expect(modal.open).toBe(true);
    const errorText = modal.shadowRoot?.querySelector('#init-progress-error')?.textContent ?? '';
    expect(errorText).toContain('Config tab is not available');
    // It must name a recovery that exists in THIS state and must not send the
    // user to the Records table — it is not rendered without the records module.
    expect(errorText).toContain('start the initialization again');
    expect(errorText).not.toContain('Records table');
    // The reason is surfaced with a Retry action, never as a URL.
    expect(modal.shadowRoot?.querySelector('#init-retry')).toBeTruthy();
    expect(modal.shadowRoot?.querySelector('.dialog')?.textContent).not.toContain('http');
    // updateConfig was never called (there was no tab to call) ...
    expect(recordsTabMocks.updateConfig).not.toHaveBeenCalled();
    // ... and the session is still at 'configuring' — nothing was wiped.
    expect(loadInitSession(window.localStorage, INIT_SESSION_KEY)?.phase).toBe('configuring');

    // Nothing was queued, so this failure is dismissible — and the recovery the
    // message names is real: the init form comes back (no tabs, `live` is false
    // because no module is installed), never a blank Config tab.
    expect(modal.canDismiss).toBe(true);
    (modal.shadowRoot?.querySelector('#init-dismiss') as HTMLElement).click();
    await el.updateComplete;
    expect(modal.open).toBe(false);
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
    expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('s2s-records-tab')).toBeNull();
    expect(el.shadowRoot?.querySelector('#records-tab')).toBeNull();
  });

  it('retry from the modal re-runs the config step once the tab is available', async () => {
    safeIntMocks.hasPublicationModule.mockReturnValue(false);
    safeIntMocks.hasRecordsModule.mockReturnValue(false);

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBeTruthy(),
    );
    const init = el.shadowRoot?.querySelector('s2s-publication-init') as HTMLElement;
    init.dispatchEvent(
      new CustomEvent('s2s-init-complete', {
        detail: {
          name: 'my-pub.soul2soul.eth',
          repo: 'https://github.com/Joera/website-starter',
          branch: 'main',
        },
        bubbles: true,
        composed: true,
      }),
    );

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    await vi.waitFor(() =>
      expect(modal.shadowRoot?.querySelector('#init-progress-error')).toBeTruthy(),
    );
    expect(recordsTabMocks.updateConfig).not.toHaveBeenCalled();

    // The modules become live (e.g. the enable proposal executed) → the Config
    // tab can render, so Retry can actually drive the step.
    safeIntMocks.hasPublicationModule.mockReturnValue(true);
    safeIntMocks.hasRecordsModule.mockReturnValue(true);
    safeIntMocks.getRecord.mockResolvedValue('');

    (modal.shadowRoot?.querySelector('#init-retry') as HTMLElement).click();
    await vi.waitFor(() => expect(recordsTabMocks.updateConfig).toHaveBeenCalledTimes(1));
    await el.updateComplete;
    expect(modal.shadowRoot?.querySelector('#init-progress-error')).toBeNull();
  });

  it('keeps the modal open with the reason when updateConfig rejects, and Retry proposes again', async () => {
    safeIntMocks.hasPublicationModule.mockReturnValue(false);
    safeIntMocks.hasRecordsModule.mockReturnValue(false);
    safeIntMocks.getRecord.mockResolvedValue('');
    recordsTabMocks.updateConfig.mockRejectedValueOnce(
      new Error('no assets/ directory in the base repo'),
    );

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBeTruthy(),
    );
    const init = el.shadowRoot?.querySelector('s2s-publication-init') as HTMLElement;

    // The modules go live (the create batch executed and was adopted), so the
    // Config tab renders and the step reaches updateConfig — which throws.
    safeIntMocks.hasPublicationModule.mockReturnValue(true);
    safeIntMocks.hasRecordsModule.mockReturnValue(true);
    init.dispatchEvent(initComplete());

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    await vi.waitFor(() =>
      expect(modal.shadowRoot?.querySelector('#init-progress-error')).toBeTruthy(),
    );
    const errorText = modal.shadowRoot?.querySelector('#init-progress-error')?.textContent ?? '';
    // Untagged rejection (an older tab, or a throwable from somewhere else): the
    // message must not claim a stage it does not know.
    expect(errorText).toContain('Building or proposing the configuration record failed');
    expect(errorText).not.toContain('Building the configuration failed');
    expect(errorText).not.toContain('Proposing the configuration record failed');
    // The underlying reason is surfaced, not swallowed into a bare spinner.
    expect(errorText).toContain('no assets/ directory in the base repo');
    // Modal stays open (the step is not done) and the session is retryable.
    expect(modal.open).toBe(true);
    expect(modal.shadowRoot?.querySelector('#init-retry')).toBeTruthy();
    // A build/propose failure queued nothing, so the overlay also offers an exit:
    // Retry re-runs the same failing build forever otherwise.
    expect(modal.canDismiss).toBe(true);
    expect(modal.shadowRoot?.querySelector('#init-dismiss')).toBeTruthy();
    expect(loadInitSession(window.localStorage, INIT_SESSION_KEY)?.phase).toBe('configuring');
    expect(recordsTabMocks.updateConfig).toHaveBeenCalledTimes(1);

    // Retry rebuilds + proposes again (the failed attempt proposed nothing).
    (modal.shadowRoot?.querySelector('#init-retry') as HTMLElement).click();
    await vi.waitFor(() => expect(recordsTabMocks.updateConfig).toHaveBeenCalledTimes(2));
    expect(recordsTabMocks.updateConfig).toHaveBeenLastCalledWith(undefined, {
      suppressQueueOpen: true,
    });
    await vi.waitFor(() => expect(modal.phase).toBe('awaiting-config'));
  });

  it('names the build stage when the rejection is tagged build (and says what to check)', async () => {
    // updateConfig() tags its rethrow with the stage it failed at. Untagged is
    // handled above; here the source knows it was the build.
    const err = Object.assign(new Error('no assets/ directory in the base repo'), {
      stage: 'build',
      cause: new Error('404'),
    });
    const { modal, errorText } = await mountAndFailConfigStep(err);

    expect(errorText).toContain('Building the configuration failed');
    expect(errorText).toContain('no assets/ directory in the base repo');
    // The hint names the whole stage (the reason is the authority), not just the
    // repo — build also covers chain reads and IPFS uploads.
    expect(errorText).toContain('repo/branch/assets');
    expect(errorText).toContain('chain reads');
    expect(errorText).toContain('IPFS uploads');
    expect(errorText).toContain('fix what the reason says');
    // Not the proposal wording: nothing was sent.
    expect(errorText).not.toContain('Proposing the configuration record failed');
    expect(errorText).not.toContain('queued transaction');
    // Still a retryable, dismissible failure at 'configuring'.
    expect(modal.open).toBe(true);
    expect(modal.phase).toBe('configuring');
    expect(modal.canDismiss).toBe(true);
    expect(loadInitSession(window.localStorage, INIT_SESSION_KEY)?.phase).toBe('configuring');
    expect(recordsTabMocks.updateConfig).toHaveBeenCalledTimes(1);
  });

  it('names the proposal stage when the rejection is tagged propose (and does not over-claim)', async () => {
    const err = Object.assign(new Error('Request failed'), {
      stage: 'propose',
      cause: new Error('invalid address'),
    });
    const { modal, errorText } = await mountAndFailConfigStep(err);

    expect(errorText).toContain('Proposing the configuration record failed');
    expect(errorText).toContain('Request failed');
    // The Safe app may have accepted the proposal before the promise rejected,
    // so the message must not promise that nothing is queued.
    expect(errorText).toContain('If the Safe app shows no queued transaction, Retry re-sends it.');
    expect(errorText).not.toContain('Nothing is queued');
    expect(errorText).not.toContain('Building the configuration failed');
    // Retry must not duplicate a proposal that never happened.
    expect(modal.open).toBe(true);
    expect(modal.phase).toBe('configuring');
    expect(modal.canDismiss).toBe(true);
    expect(loadInitSession(window.localStorage, INIT_SESSION_KEY)?.phase).toBe('configuring');
    expect(recordsTabMocks.updateConfig).toHaveBeenCalledTimes(1);
  });

  it('stays neutral for a rejection tagged with an unknown stage', async () => {
    const err = Object.assign(new Error('unexpected'), { stage: 'detect' });
    const { modal, errorText } = await mountAndFailConfigStep(err);

    expect(errorText).toContain('Building or proposing the configuration record failed');
    expect(errorText).toContain('unexpected');
    expect(errorText).not.toContain('Building the configuration failed');
    expect(errorText).not.toContain('Proposing the configuration record failed');
    expect(modal.open).toBe(true);
    expect(modal.canDismiss).toBe(true);
  });

  it('lets the user dismiss a deterministic build failure and lands on the Config tab', async () => {
    // A bad repo URL / missing assets/ / wrong branch fails the build the same way
    // every time, so Retry alone is a trap: the scrim covers the Config tab where
    // repo/branch are fixed and the Reset button. Dismiss must clear the session
    // (nothing was queued) and hand the app back.
    safeIntMocks.hasPublicationModule.mockReturnValue(false);
    safeIntMocks.hasRecordsModule.mockReturnValue(false);
    safeIntMocks.getRecord.mockResolvedValue('');
    recordsTabMocks.updateConfig.mockRejectedValue(new Error('missing assets/ directory'));

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBeTruthy(),
    );
    const init = el.shadowRoot?.querySelector('s2s-publication-init') as HTMLElement;
    safeIntMocks.hasPublicationModule.mockReturnValue(true);
    safeIntMocks.hasRecordsModule.mockReturnValue(true);
    init.dispatchEvent(initComplete());

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    await vi.waitFor(() => expect(modal.shadowRoot?.querySelector('#init-dismiss')).toBeTruthy());

    (modal.shadowRoot?.querySelector('#init-dismiss') as HTMLElement).click();
    await el.updateComplete;

    // Overlay gone, session gone (a reload must not re-arm the failing build).
    expect(modal.open).toBe(false);
    expect(el.shadowRoot?.querySelector('.overlay')).toBeNull();
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
    expect(recordsTabMocks.updateConfig).toHaveBeenCalledTimes(1);

    // Dropped on the Config tab: fix repo/branch in the Records table, then use
    // the tab's own "Initialize configuration" action.
    expect(el.shadowRoot?.querySelector('#records-tab')?.classList.contains('active')).toBe(true);
    expect(el.shadowRoot?.querySelector('s2s-records-tab')).toBeTruthy();
    // And the rest of the app (incl. Reset) is reachable again.
    expect(el.shadowRoot?.querySelector('#reset-publication')).toBeTruthy();
  });

  it('ignores a dismiss that arrives while the config build is in flight', async () => {
    // The dismiss button is only rendered once the run has failed, but a queued
    // click (or a stale event) must not clear the session of a build that is
    // still running — that would orphan the proposal it is about to send.
    safeIntMocks.hasPublicationModule.mockReturnValue(false);
    safeIntMocks.hasRecordsModule.mockReturnValue(false);
    safeIntMocks.getRecord.mockResolvedValue('');
    recordsTabMocks.updateConfig.mockReturnValue(new Promise<string>(() => {}));

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBeTruthy(),
    );
    const init = el.shadowRoot?.querySelector('s2s-publication-init') as HTMLElement;
    safeIntMocks.hasPublicationModule.mockReturnValue(true);
    safeIntMocks.hasRecordsModule.mockReturnValue(true);
    init.dispatchEvent(initComplete());

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    await vi.waitFor(() => expect(recordsTabMocks.updateConfig).toHaveBeenCalledTimes(1));
    expect(modal.canDismiss).toBe(false);
    expect(modal.shadowRoot?.querySelector('#init-dismiss')).toBeNull();

    modal.dispatchEvent(new CustomEvent('s2s-init-dismiss', { bubbles: true, composed: true }));
    await el.updateComplete;

    // Still configuring, still open, session still there.
    expect(modal.phase).toBe('configuring');
    expect(modal.open).toBe(true);
    expect(loadInitSession(window.localStorage, INIT_SESSION_KEY)?.phase).toBe('configuring');
  });

  it('never builds the config on top of an in-flight refresh: the completion joins it', async () => {
    // Live bug: the init element's complete() fired from INSIDE the first
    // fetchFreshData (its maybeResume runs off the setProtocolInfo store
    // update), so onInitComplete started step 3 while that refresh was still
    // reading. Its own fetchFreshData() then ran initialize() a SECOND time,
    // which transiently blanks safeInfo.s2sRecords — the config
    // setRecord('config', …) in flight got `to: ''` and the Safe SDK rejected
    // it ("invalid address"). Single-flight: the completion must join the
    // running refresh and only build once it has settled.
    safeIntMocks.hasPublicationModule.mockReturnValue(false);
    safeIntMocks.hasRecordsModule.mockReturnValue(false);
    safeIntMocks.getRecord.mockResolvedValue('');

    // A refresh we control: the mount's pass gets past initialize() (so the
    // form renders) and parks inside the records read.
    let releaseRefresh!: (recs: [string[], string[]]) => void;
    const hanging = new Promise<[string[], string[]]>((resolve) => {
      releaseRefresh = resolve;
    });
    safeIntMocks.getAllRecords.mockReturnValueOnce(hanging);

    const el = await mountLit<S2SApp>('s2s-app', {});
    // The mount's refresh is parked inside getAllRecords().
    await vi.waitFor(() => expect(safeIntMocks.getAllRecords).toHaveBeenCalledTimes(1));
    await el.updateComplete;
    const init = el.shadowRoot?.querySelector('s2s-publication-init') as HTMLElement;
    expect(init).toBeTruthy();

    // Complete the flow while that refresh is still running.
    safeIntMocks.hasPublicationModule.mockReturnValue(true);
    safeIntMocks.hasRecordsModule.mockReturnValue(true);
    init.dispatchEvent(initComplete());

    // Give the completion every chance to run: it must not start a second
    // pass and must not build while the first refresh is parked.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(safeIntMocks.initialize).toHaveBeenCalledTimes(1);
    expect(safeIntMocks.getAllRecords).toHaveBeenCalledTimes(1);
    expect(recordsTabMocks.updateConfig).not.toHaveBeenCalled();
    // The session is already persisted (step 3 is claimed), so a reload here
    // still resumes — the step just has not built anything yet.
    expect(loadInitSession(window.localStorage, INIT_SESSION_KEY)?.phase).toBe('configuring');

    // Release the refresh: the completion's own fetch joins it, and only then
    // does the config step build.
    releaseRefresh([[], []]);
    await vi.waitFor(() => expect(recordsTabMocks.updateConfig).toHaveBeenCalledTimes(1));
    expect(recordsTabMocks.updateConfig).toHaveBeenLastCalledWith(undefined, {
      suppressQueueOpen: true,
    });
    // Exactly one refresh pass for the whole overlap — no second initialize()
    // and no second read pass.
    expect(safeIntMocks.initialize).toHaveBeenCalledTimes(1);
    expect(safeIntMocks.getAllRecords).toHaveBeenCalledTimes(1);
  });

  it('says what it is waiting for and proceeds after the bounded join (stalled refresh)', async () => {
    // The join is a courtesy now that initialize() is atomic, and the refresh
    // ends with the Filecoin init/list calls which can STALL rather than fail.
    // Step 3 must never sit behind that forever (the modal would show a spinner
    // that never advances, and a reload re-enters the same wait).
    safeIntMocks.hasPublicationModule.mockReturnValue(false);
    safeIntMocks.hasRecordsModule.mockReturnValue(false);
    safeIntMocks.getRecord.mockResolvedValue('');
    // A refresh that never settles — it is parked inside getAllRecords forever.
    safeIntMocks.getAllRecords.mockReturnValueOnce(new Promise<[string[], string[]]>(() => {}));

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(safeIntMocks.getAllRecords).toHaveBeenCalledTimes(1));
    await el.updateComplete;
    // Shorten the bound so the test does not wait 20 s.
    (el as unknown as { configRefreshJoinMs: number }).configRefreshJoinMs = 50;

    const init = el.shadowRoot?.querySelector('s2s-publication-init') as HTMLElement;
    safeIntMocks.hasPublicationModule.mockReturnValue(true);
    safeIntMocks.hasRecordsModule.mockReturnValue(true);
    init.dispatchEvent(initComplete());

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    // Step 3 is already the current marker while it waits, and there is no error
    // block (nothing has failed yet).
    await vi.waitFor(() => expect(modal.open).toBe(true));
    await vi.waitFor(() =>
      expect(
        modal.shadowRoot?.querySelector('[data-step="4"]')?.classList.contains('step--current'),
      ).toBe(true),
    );
    expect(modal.shadowRoot?.querySelector('#init-progress-error')).toBeNull();
    expect(recordsTabMocks.updateConfig).not.toHaveBeenCalled();

    // …and it proceeds anyway instead of hanging forever.
    await vi.waitFor(() => expect(recordsTabMocks.updateConfig).toHaveBeenCalledTimes(1), {
      timeout: 5000,
    });
    expect(safeIntMocks.initialize).toHaveBeenCalledTimes(1);
    expect(loadInitSession(window.localStorage, INIT_SESSION_KEY)?.phase).toBe('awaiting-config');
  });

  it('treats an empty config CID as "nothing was proposed": fails at configuring and Retry rebuilds', async () => {
    safeIntMocks.hasPublicationModule.mockReturnValue(false);
    safeIntMocks.hasRecordsModule.mockReturnValue(false);
    safeIntMocks.getRecord.mockResolvedValue('');
    // The tab resolves without proposing anything — '' per the pinned contract.
    recordsTabMocks.updateConfig.mockResolvedValueOnce('');

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBeTruthy(),
    );
    const init = el.shadowRoot?.querySelector('s2s-publication-init') as HTMLElement;
    safeIntMocks.hasPublicationModule.mockReturnValue(true);
    safeIntMocks.hasRecordsModule.mockReturnValue(true);
    init.dispatchEvent(initComplete());

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    await vi.waitFor(() =>
      expect(modal.shadowRoot?.querySelector('#init-progress-error')).toBeTruthy(),
    );
    // Never 'awaiting-config': there is no queued transaction to wait for, and a
    // persisted awaiting-config would stop a reload from re-proposing.
    expect(loadInitSession(window.localStorage, INIT_SESSION_KEY)?.phase).toBe('configuring');
    expect(modal.shadowRoot?.querySelector('#init-progress-error')?.textContent).toContain(
      'did not propose a configuration record',
    );
  });

  it('keeps the session at awaiting-config when the wait times out, and Retry re-waits instead of re-proposing', async () => {
    safeIntMocks.hasPublicationModule.mockReturnValue(true);
    safeIntMocks.hasRecordsModule.mockReturnValue(true);
    // The proposal is queued but never executed.
    safeIntMocks.getRecord.mockResolvedValue('');
    seedInitSession({ phase: 'awaiting-config' });

    // Fast-forward the 10-minute wait: every Date.now() call jumps 11 minutes
    // ahead of the previous one, so the first post-poll check times out. (The
    // test's own waiting uses timers, not Date.now.)
    const t0 = 1_700_000_000_000;
    let ticks = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => t0 + ticks++ * 11 * 60_000);
    try {
      const el = await mountLit<S2SApp>('s2s-app', {});
      const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;

      await vi.waitFor(() =>
        expect(modal.shadowRoot?.querySelector('#init-progress-error')).toBeTruthy(),
      );
      expect(modal.open).toBe(true);
      expect(modal.shadowRoot?.querySelector('#init-progress-error')?.textContent).toContain(
        'still pending in the Safe queue',
      );
      // Timeout must NOT wipe the flow.
      expect(loadInitSession(window.localStorage, INIT_SESSION_KEY)?.phase).toBe('awaiting-config');
      expect(recordsTabMocks.updateConfig).not.toHaveBeenCalled();
      // …and must NOT be dismissible: a Safe transaction may be queued for this
      // record, so closing the modal would hide a pending proposal.
      expect(modal.canDismiss).toBe(false);
      expect(modal.shadowRoot?.querySelector('#init-dismiss')).toBeNull();

      // Retry only re-waits: re-proposing would queue a duplicate Safe tx.
      // (Restore real time first so the re-wait keeps running instead of
      // instantly timing out again.)
      nowSpy.mockRestore();
      (modal.shadowRoot?.querySelector('#init-retry') as HTMLElement).click();
      // Back to a healthy wait: the error block is gone and step 3 is current
      // again — with no second proposal.
      await vi.waitFor(() =>
        expect(modal.shadowRoot?.querySelector('#init-progress-error')).toBeNull(),
      );
      await vi.waitFor(() =>
        expect(
          modal.shadowRoot?.querySelector('[data-step="4"]')?.classList.contains('step--current'),
        ).toBe(true),
      );
      expect(recordsTabMocks.updateConfig).not.toHaveBeenCalled();
      expect(loadInitSession(window.localStorage, INIT_SESSION_KEY)?.phase).toBe('awaiting-config');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps the init element mounted and closes the modal on an init-flow error', async () => {
    // P0: an error inside the init element (waitForEnabled / waitForNameRecord
    // or a proposeBatch throw) is the only place the inline error + Try again /
    // Start over exists. The module addresses are already adopted at that point,
    // so nulling initPhase would unmount the element and hide the error
    // entirely — in exactly the window this branch fixes.
    safeIntMocks.hasPublicationModule.mockReturnValue(false);
    safeIntMocks.hasRecordsModule.mockReturnValue(false);

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBeTruthy(),
    );
    const init = el.shadowRoot?.querySelector('s2s-publication-init') as HTMLElement;

    safeIntMocks.hasPublicationModule.mockReturnValue(true);
    safeIntMocks.hasRecordsModule.mockReturnValue(true);
    init.dispatchEvent(initProgress('finalizing'));
    await el.updateComplete;

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    expect(modal.open).toBe(true);

    init.dispatchEvent(initProgress('finalizing', 'error'));
    await el.updateComplete;

    // The overlay must not cover (or replace) the inline error.
    expect(modal.open).toBe(false);
    expect(el.shadowRoot?.querySelector('.overlay')).toBeNull();
    // Same instance, still on screen: it owns the error message + retry actions.
    expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBe(init);
    expect(el.shadowRoot?.querySelector('.tabs')).toBeNull();
    expect(el.shadowRoot?.querySelector('s2s-records-tab')).toBeNull();
    // Not a 'live' app either: the enable proposal never executed.
    expect(el.shadowRoot?.querySelector('.module-badge.module-active')).toBeNull();
    expect(el.shadowRoot?.querySelector('#reset-publication')).toBeNull();
  });

  it("treats the init element's 'idle' (reset/cancel) signal as nothing running: no overlay", async () => {
    safeIntMocks.hasPublicationModule.mockReturnValue(false);
    safeIntMocks.hasRecordsModule.mockReturnValue(false);

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBeTruthy(),
    );
    const init = el.shadowRoot?.querySelector('s2s-publication-init') as HTMLElement;
    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;

    init.dispatchEvent(initProgress('awaiting-finalize'));
    await el.updateComplete;
    expect(modal.open).toBe(true);

    // "Start over" clears the session and dispatches 'idle' — a full-screen
    // overlay with no running flow and no action would make the form behind it
    // unreachable (reload to escape).
    init.dispatchEvent(initProgress('creating', 'idle'));
    await el.updateComplete;

    expect(modal.open).toBe(false);
    expect(el.shadowRoot?.querySelector('.overlay')).toBeNull();
    expect(modal.shadowRoot?.querySelector('#init-progress')).toBeNull();
    expect(modal.error).toBe('');
    // The form is back in the user's hands.
    expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBe(init);
  });

  it('takes the config-phase session identity from the completion event, not from storage', async () => {
    // Cross-branch contract: the init element clears its OWN session around the
    // dispatch, so there is nothing to merge from when the host persists step 3.
    // Everything (identity + module addresses) must come from the event detail,
    // and it must be on disk synchronously — before the refresh that follows.
    safeIntMocks.hasPublicationModule.mockReturnValue(false);
    safeIntMocks.hasRecordsModule.mockReturnValue(false);

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBeTruthy(),
    );
    const init = el.shadowRoot?.querySelector('s2s-publication-init') as HTMLElement;

    // The element dropped its session before dispatching (contract): storage is
    // empty at the moment the host sees the event.
    window.localStorage.removeItem(INIT_SESSION_KEY);
    expect(loadInitSession(window.localStorage, INIT_SESSION_KEY)).toBeNull();

    safeIntMocks.hasPublicationModule.mockReturnValue(true);
    safeIntMocks.hasRecordsModule.mockReturnValue(true);
    init.dispatchEvent(
      initComplete({
        recordsModule: '0x9999999999999999999999999999999999999999',
        publicationModule: '0x8888888888888888888888888888888888888888',
        name: 'my-pub.soul2soul.eth',
        repo: 'https://github.com/Joera/website-starter',
        branch: 'main',
        authors: ['0x2222222222222222222222222222222222222222'],
        proposals: [Q1, Q2],
      }),
    );

    // Synchronous persist: no await between the dispatch and the session being
    // readable, so a reload here resumes instead of losing step 3.
    const persisted = loadInitSession(window.localStorage, INIT_SESSION_KEY);
    expect(persisted?.phase).toBe('configuring');
    expect(persisted?.name).toBe('my-pub.soul2soul.eth');
    expect(persisted?.publicationName).toBe('my-pub.soul2soul.eth');
    expect(persisted?.repo).toBe('https://github.com/Joera/website-starter');
    expect(persisted?.branch).toBe('main');
    expect(persisted?.authors).toEqual(['0x2222222222222222222222222222222222222222']);
    expect(persisted?.proposals).toEqual([Q1, Q2]);
    // The module addresses come from the detail too (they may not be adopted yet).
    expect(persisted?.recordsModule).toBe('0x9999999999999999999999999999999999999999');
    expect(persisted?.publicationModule).toBe('0x8888888888888888888888888888888888888888');

    // …and the step still runs: the host drives the tab exactly once.
    await vi.waitFor(() => expect(recordsTabMocks.updateConfig).toHaveBeenCalledTimes(1));
    expect(recordsTabMocks.updateConfig).toHaveBeenCalledWith(undefined, {
      suppressQueueOpen: true,
    });
  });

  it('keeps the session the host is driving when the modules are not installed (no identity wipe)', async () => {
    // The synchronous persist is followed by the step's own fetchFreshData().
    // With no modules installed (the create batch never adopted its addresses),
    // syncInitProgress used to take the "stale config session" branch and clear
    // the session it had just been given — identity and all — so the error said
    // "reopen and retry" while a reopen had nothing left to resume.
    safeIntMocks.hasPublicationModule.mockReturnValue(false);
    safeIntMocks.hasRecordsModule.mockReturnValue(false);

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-publication-init')).toBeTruthy(),
    );
    const init = el.shadowRoot?.querySelector('s2s-publication-init') as HTMLElement;

    init.dispatchEvent(initComplete());

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    await vi.waitFor(() =>
      expect(modal.shadowRoot?.querySelector('#init-progress-error')).toBeTruthy(),
    );
    expect(modal.shadowRoot?.querySelector('#init-progress-error')?.textContent).toContain(
      'Config tab is not available',
    );
    // The flow is still resumable: phase kept AND the identity with it.
    const persisted = loadInitSession(window.localStorage, INIT_SESSION_KEY);
    expect(persisted?.phase).toBe('configuring');
    expect(persisted?.name).toBe('my-pub.soul2soul.eth');
    expect(persisted?.repo).toBe('https://github.com/Joera/website-starter');
  });
});
