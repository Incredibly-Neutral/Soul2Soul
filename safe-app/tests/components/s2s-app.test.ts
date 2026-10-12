import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { S2SApp } from '../../src/components/s2s-app';
import { mountLit } from '../helpers/mount';

// ---------------------------------------------------------------------------
// Module-level mocks: the shell pulls in the whole heavy graph (Safe SDK via
// safe-integration, protocol-integration, shared LitService, FilecoinStorage,
// evm/ethers, car-builder) plus all five child tab components. We mock every
// one of them so mounting <s2s-app> never touches an iframe, wallet, network
// or the real child tab modules (owned by another worker's spec).
// ---------------------------------------------------------------------------

const SAFE_INFO = {
  address: '0x00000000000000000000000000000000000000A1',
  chainId: 8453,
  s2sPublication: '0xPublicationModule1111111111111111111111111111111',
  s2sRecords: '0xRecordsModule2222222222222222222222222222222',
};

const safeIntMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  getAllRecords: vi.fn(),
  hasPublicationModule: vi.fn(),
  hasRecordsModule: vi.fn(),
  isConnected: vi.fn(),
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
    setPieces(_p: unknown[]) {}
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

vi.mock('@s2s/soul2soul-shared/filecoin/car-builder/browser', () => ({ browserFilecoinBuilder: {} }));

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

describe('s2s-app (shell)', () => {
  beforeEach(() => {
    storeMock.store.__reset();
    safeIntMocks.initialize.mockReset();
    safeIntMocks.getAllRecords.mockReset();
    safeIntMocks.hasPublicationModule.mockReset();
    safeIntMocks.hasRecordsModule.mockReset();
    safeIntMocks.isConnected.mockReset();
    protocolMocks.initialize.mockReset();
    filecoinMocks.initWithSessionKey.mockReset();
    filecoinMocks.listPublicationStorage.mockReset();

    // Default deterministic "connected app" state.
    safeIntMocks.initialize.mockResolvedValue(SAFE_INFO);
    safeIntMocks.getAllRecords.mockResolvedValue([[], []]);
    safeIntMocks.hasPublicationModule.mockReturnValue(true);
    safeIntMocks.hasRecordsModule.mockReturnValue(true);
    safeIntMocks.isConnected.mockReturnValue(true);
    protocolMocks.initialize.mockResolvedValue(undefined);
    filecoinMocks.initWithSessionKey.mockResolvedValue(undefined);
    filecoinMocks.listPublicationStorage.mockResolvedValue([]);

    // initFC() (fired in the constructor) fetches /session-key.json.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
  });

  it('renders the loading screen first, then the full shell once connect resolves', async () => {
    let resolveInit!: (v: unknown) => void;
    safeIntMocks.initialize.mockReturnValue(new Promise((r) => (resolveInit = r)));

    const el = await mountLit<S2SApp>('s2s-app', {});
    // Phase 1: no cache + still fetching → loading.
    expect(el.shadowRoot?.textContent).toContain('Loading Soul2Soul Safe App...');

    // Phase 2: the SDK connect resolves deterministically.
    resolveInit(SAFE_INFO);
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy(),
    );

    expect(el.shadowRoot?.textContent).not.toContain('Loading Soul2Soul Safe App...');
    for (const id of NAV_TABS) {
      expect(el.shadowRoot?.querySelector(`#${id}`)).toBeTruthy();
    }
  });

  it('renders the five nav tabs and keeps the default deals tab active', async () => {
    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy(),
    );

    for (const id of NAV_TABS) {
      const btn = el.shadowRoot?.querySelector(`#${id}`) as HTMLButtonElement;
      expect(btn).toBeTruthy();
      expect(btn.textContent?.trim()).toBeTruthy();
    }
    expect(el.shadowRoot?.querySelector('#deals-tab')?.classList.contains('active')).toBe(true);
  });

  it('switches the active tab and swaps the rendered child component', async () => {
    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy(),
    );

    // Default: deals tab active, deals child mounted, no records child.
    expect(el.shadowRoot?.querySelector('s2s-deals-tab')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('s2s-records-tab')).toBeNull();

    // Click Records → child swaps, active class moves.
    (el.shadowRoot?.querySelector('#records-tab') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-records-tab')).toBeTruthy(),
    );
    expect(el.shadowRoot?.querySelector('s2s-deals-tab')).toBeNull();
    expect(el.shadowRoot?.querySelector('#records-tab')?.classList.contains('active')).toBe(true);
    expect(el.shadowRoot?.querySelector('#deals-tab')?.classList.contains('active')).toBe(false);

    // Storage is always enabled → child appears.
    (el.shadowRoot?.querySelector('#storage-tab') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-storage-tab')).toBeTruthy(),
    );
    expect(el.shadowRoot?.querySelector('s2s-records-tab')).toBeNull();

    // Whitelist is gated by the publication module (on by default).
    (el.shadowRoot?.querySelector('#whitelist-tab') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('s2s-whitelist-tab')).toBeTruthy(),
    );
  });

  it('disables gated tabs and shows the error banner when no modules are installed', async () => {
    safeIntMocks.hasPublicationModule.mockReturnValue(false);
    safeIntMocks.hasRecordsModule.mockReturnValue(false);

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('.error-message')).toBeTruthy(),
    );
    expect(el.shadowRoot?.textContent).toContain('No S2S modules found');

    for (const id of ['deals-tab', 'whitelist-tab', 'records-tab', 'website-tree-tab']) {
      expect((el.shadowRoot?.querySelector(`#${id}`) as HTMLButtonElement).disabled).toBe(true);
    }
    expect((el.shadowRoot?.querySelector('#storage-tab') as HTMLButtonElement).disabled).toBe(
      false,
    );

    // Clicking a gated tab renders no child.
    (el.shadowRoot?.querySelector('#deals-tab') as HTMLButtonElement).click();
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('s2s-deals-tab')).toBeNull();
  });

  it('renders the module status pills and the root CID from the store', async () => {
    storeMock.store.setRoot('bafyroot123');

    const el = await mountLit<S2SApp>('s2s-app', {});
    await vi.waitFor(() =>
      expect(el.shadowRoot?.querySelector('#deals-tab')).toBeTruthy(),
    );

    expect(el.shadowRoot?.textContent).toContain('Connected to Safe');

    const rootHash = el.shadowRoot?.querySelector('copy-hash') as any;
    expect(rootHash.value).toBe('bafyroot123');
  });
});
