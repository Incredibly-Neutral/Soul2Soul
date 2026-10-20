import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { S2SApp } from '../../src/components/s2s-app';
import type { S2SConfirmModal } from '../../src/components/s2s-confirm-modal';
import type { S2SInitProgressModal } from '../../src/components/s2s-init-progress-modal';
import { INIT_SESSION_KEY, saveInitSession, type InitSession } from '../../src/lib/init-session';
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
  getProvider: vi.fn(),
}));

const protocolMocks = vi.hoisted(() => ({ initialize: vi.fn() }));

const filecoinMocks = vi.hoisted(() => ({
  initWithSessionKey: vi.fn(),
  listPublicationStorage: vi.fn(),
  walletAddress: '0xwallet123',
}));

const storeMock = vi.hoisted(() => {
  class MockStore {
    safeInfo: unknown = undefined;
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
    setProtocolInfo(_info: unknown) {}
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
    getProvider = safeIntMocks.getProvider;
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

import '../../src/components/s2s-app';

const NAV_TABS = ['deals-tab', 'whitelist-tab', 'records-tab', 'storage-tab', 'website-tree-tab'];

const Q1 =
  'https://app.safe.global/transactions/queue?safe=8453:0x00000000000000000000000000000000000000A1';
const Q2 =
  'https://app.safe.global/transactions/queue?safe=8453:0x00000000000000000000000000000000000000A2';

/** Seed an in-flight session into localStorage matching SAFE_INFO's Safe. */
function seedInitSession(overrides: Partial<InitSession> = {}): void {
  saveInitSession(window.localStorage, INIT_SESSION_KEY, {
    version: 2,
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
    safeIntMocks.getProvider.mockResolvedValue({ getBlockNumber: vi.fn(async () => 12_000_000) });
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

    // The modules come online as the init flow completes.
    safeIntMocks.hasPublicationModule.mockReturnValue(true);
    safeIntMocks.hasRecordsModule.mockReturnValue(true);

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

    // The auto config-update trigger is duck-type-guarded: the mocked
    // records-tab has no updateConfig, so the handler must not throw.
    await new Promise((r) => setTimeout(r, 0));

    // The progress modal is closed once the init completes.
    const modal = el.shadowRoot?.querySelector(
      's2s-init-progress-modal',
    ) as S2SInitProgressModal | null;
    expect(modal?.open).toBe(false);
  });

  // ---- Init progress modal (primary surface: live flow + reload recovery) ----

  it('live s2s-init-progress events open the progress modal and keep it in sync; done/error close it', async () => {
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

    // Flow reports 'done' → modal closes so the inline result is visible.
    init.dispatchEvent(
      new CustomEvent('s2s-init-progress', {
        detail: { step: 'done', phase: 'done', proposals: [Q1, Q2] },
        bubbles: true,
        composed: true,
      }),
    );
    await el.updateComplete;
    expect(modal.open).toBe(false);

    // An error closes it too.
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
    expect(steps.length).toBe(2);
  });

  it('ignores a persisted session that belongs to a different Safe', async () => {
    seedInitSession({ safeAddress: '0x9999999999999999999999999999999999999999' });

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    expect(modal.open).toBe(false);
  });

  it('drops a legacy half-init session when modules are live but the name record is missing', async () => {
    // Modules live with NO name record is a legacy half-init (modules enabled
    // by an old flow, name never proposed) — the merged flow can't resume it.
    // The stale session is dropped silently: no modal, no banner.
    seedInitSession();
    safeIntMocks.hasRecordsModule.mockReturnValue(true);
    safeIntMocks.getRecord.mockResolvedValue('');

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    expect(modal.open).toBe(false);
    expect(el.shadowRoot?.querySelector('#init-finished')).toBeNull();
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
  });

  it('clears a completed flow on reload silently: modules live + name record set', async () => {
    // The finalize batch enables the modules AND records the name atomically;
    // once it executes and the app reloads, the reload must recognise the flow
    // is finished and clear the session WITHOUT any success banner — the live
    // app UI is the completion signal.
    seedInitSession();
    safeIntMocks.hasRecordsModule.mockReturnValue(true);

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy());

    const modal = el.shadowRoot?.querySelector('s2s-init-progress-modal') as S2SInitProgressModal;
    expect(modal.open).toBe(false);
    expect(el.shadowRoot?.querySelector('#init-finished')).toBeNull();
    expect(window.localStorage.getItem(INIT_SESSION_KEY)).toBeNull();
  });
});
