// s2s-records-tab.test.ts — component (browser) tests for the Records tab.
//
// Mock strategy: this tab has a deep import graph (Safe SDK, ethers/viem,
// shared builders, IPFS factories, Filecoin, the state store). There is NO
// Safe iframe / wallet / network in component tests, so every heavy module is
// mocked at the module level (vi.mock), mirroring the exact shapes the source
// imports. The real domain-validation module is kept so we assert the REAL
// default of DOMAIN_VALIDATION_CONFIG.enforceOwnership === false (the
// "ownership gate OFF" path the task calls out).
//
//   @s2s/soul2soul-shared/safe-app -> ConfigBuilder/AssetsBuilder/S2SIPFSMethods
//                                     (classes, never touch Kubo/Pinata)
//   @s2s/soul2soul-shared           -> renderwithLitActions / pinCidFromRemote
//   @s2s/soul2soul-shared/filecoin  -> FilecoinStorage
//   @/lib/safe-integration          -> SafeIntegration (never talks to Safe)
//   @/lib/protocol-integration      -> ProtocolIntegration
//   @/lib/evm                       -> evmRead (assert it is NOT called when the
//                                      ownership gate is OFF)
//   @/lib/ipfs.factory              -> dagExport (dynamic import in updateConfig)
//   @/filecoin/car-builder          -> browserFilecoinBuilder (unused import)
//   @/state/index.js                -> in-memory store mock
//
// ethers and domain-validation stay real: ethers.namehash is pure, and
// domain-validation is a pure module with the enforcement toggle defaulting OFF.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LitElement } from 'lit';
import { mountLit } from '../helpers/mount';
import {
  DOMAIN_VALIDATION_CONFIG,
} from '../../src/lib/domain-validation';

// ---------------------------------------------------------------------------
// Hoisted mocks — available to vi.mock factories (hoisted above all imports).
// ---------------------------------------------------------------------------
const m = vi.hoisted(() => {
  // In-memory store mock mirroring the slice of src/state used by this tab:
  // records (all/get/set/remove/subscribe) + root + protocol/safe info.
  const makeStore = () => {
    let records: Record<string, { key: string; value: string; type: string }> | null = null;
    let root: string | null = null;
    let protocolInfo: unknown = undefined;
    let safeInfo: unknown = undefined;
    const recSubs = new Set<() => void>();
    const notifyRecs = () => recSubs.forEach((fn) => fn());
    return {
      reset() {
        records = null;
        root = null;
        protocolInfo = undefined;
        safeInfo = undefined;
        recSubs.clear();
      },
      subscribeToRecords(fn: () => void) {
        recSubs.add(fn);
        return () => recSubs.delete(fn);
      },
      getAllRecords: () => records,
      setAllRecords(recs: Array<{ key: string; value: string; type: string }>) {
        records = {};
        for (const r of recs) records[r.key] = r;
        notifyRecs();
      },
      setRecord(r: { key: string; value: string; type: string }) {
        records = records ?? {};
        records[r.key] = r;
        notifyRecs();
      },
      getRecord: (key: string) => records?.[key]?.value ?? null,
      removeRecord(key: string) {
        if (records) delete records[key];
        notifyRecs();
      },
      getRoot: () => root,
      setRoot(r: string) {
        root = r;
      },
      protocolInfo,
      setProtocolInfo(p: unknown) {
        protocolInfo = p;
      },
      safeInfo,
      setSafeInfo(s: unknown) {
        safeInfo = s;
      },
    };
  };

  const safeIntegration = {
    getAllRecords: vi.fn<() => Promise<[string[], string[]]>>(async () => [[], []]),
    getRecord: vi.fn(async (key: string) => {
      const values: Record<string, string> = {
        name: 's3ntiment.eth',
        repo: 'https://github.com/acme/site',
        config: 'bafyconfig-prev',
      };
      return values[key] ?? null;
    }),
    setRecord: vi.fn<() => Promise<string>>(async () => 'https://app.safe.global/tx/0x1'),
    deleteRecord: vi.fn<() => Promise<void>>(async () => {}),
    getSafeInfo: vi.fn(() => ({ safeAddress: '0xSafe', s2sPublication: '0xPub', chainId: 8453 })),
  };

  const protocolIntegration = {
    getInfo: vi.fn(async () => ({ gateway: 'https://ipfs.transport-union.dev' })),
  };

  const storage = {
    uploadJson: vi.fn(async () => ({ rootCid: 'root-cid', pieceCid: 'piece-cid' })),
    uploadTree: vi.fn(async () => ({ rootCid: 'root-cid', pieceCid: 'piece-cid' })),
    listPublicationStorage: vi.fn(async () => []),
  };

  const evmRead = vi.fn();

  return { makeStore, safeIntegration, protocolIntegration, storage, evmRead, buildConfigCalls: [] as any[][] };
});

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted — factories only reference `m`).
// ---------------------------------------------------------------------------
vi.mock('@s2s/soul2soul-shared/safe-app', () => ({
  ConfigBuilder: class {
    constructor() {}
    buildConfig = vi.fn(async (...args: any[]) => {
      m.buildConfigCalls.push(args);
      // Echo the aliases the caller passed (mirrors the real builder, which
      // persists the supplied alias list into config.aliases).
      const aliases = Array.isArray(args[8]) ? args[8].slice() : [];
      return { cid: 'config-cid', config: { aliases } };
    });
  },
  AssetsBuilder: class {
    constructor() {}
    buildAssets = vi.fn(async () => ({ cid: 'assets-cid' }));
  },
  S2SIPFSMethods: class {
    constructor() {}
    fetchFromKubo = vi.fn(async () => ({ aliases: ['s3ntiment.eth'] }));
  },
  LitService: class {},
}));

vi.mock('@s2s/soul2soul-shared', () => ({
  renderwithLitActions: vi.fn(),
  pinCidFromRemote: vi.fn(),
  LitService: class {},
}));

vi.mock('@s2s/soul2soul-shared/filecoin', () => ({
  FilecoinStorage: class {},
}));

vi.mock('@/lib/safe-integration.js', () => ({ SafeIntegration: class {} }));
vi.mock('@/lib/protocol-integration.js', () => ({ ProtocolIntegration: class {} }));
vi.mock('@/lib/evm.js', () => ({ evmRead: m.evmRead, getRpcUrl: vi.fn() }));
// NOTE: @/lib/ipfs.factory is intentionally NOT vi.mock'd — the tab only
// dynamic-imports it (dagExport in tryFilecoinTreeUpload). Serving a mocked
// module via a dynamic import trips the browser provider's route handler
// ("Route is already handled!"). The real module is self-contained (no
// imports) and dagExport just fetches the gateway, which the test stubs.
vi.mock('@/filecoin/car-builder.js', () => ({
  browserFilecoinBuilder: { buildCarFromBytes: vi.fn() },
}));

// Mock the store slice this tab imports.
vi.mock('@/state/index.js', () => ({
  store: m.makeStore(),
  OnChainRecord: {},
}));

// Component under test (registers <s2s-records-tab>).
import '../../src/components/s2s-records-tab';
import { store } from '../../src/state/index';

type RecordsTab = LitElement & {
  safeIntegration: unknown;
  protocolIntegration: unknown;
  lit: unknown;
  storage: unknown;
};

function mountTab(overrides: Partial<RecordsTab> = {}) {
  return mountLit<RecordsTab>('s2s-records-tab', {
    safeIntegration: m.safeIntegration,
    protocolIntegration: m.protocolIntegration,
    lit: {},
    storage: m.storage,
    ...overrides,
  });
}

function seedRecords(records: Array<{ key: string; value: string; type: string }>) {
  store.setAllRecords(records);
}

/** All notifications land in a fixed-position div appended to document.body. */
function notificationTexts(): string[] {
  return [...document.querySelectorAll('body > div')]
    .map((d) => (d as HTMLElement).textContent ?? '')
    .filter((t) => t.length > 0);
}

/** The alias names currently rendered in the ENS write-target list. */
function renderedAliasNames(el: LitElement): string[] {
  return [...el.shadowRoot!.querySelectorAll('.domain-section li code')].map(
    (c) => c.textContent?.trim() ?? '',
  );
}

/** Freshly query the #alias-input (never reuse a possibly-stale node) and set it. */
function setAliasInput(el: LitElement, value: string): void {
  const input = el.shadowRoot!.querySelector<HTMLInputElement>('#alias-input')!;
  input.value = value;
}

/** Freshly query and click a button whose label includes `text`. */
function clickButton(el: LitElement, text: string): void {
  const btn = [...el.shadowRoot!.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text),
  );
  if (!btn) throw new Error(`button "${text}" not found`);
  btn.click();
}

describe('s2s-records-tab', () => {
  beforeEach(() => {
    (store as unknown as { reset: () => void }).reset();
    vi.clearAllMocks();
    m.buildConfigCalls = [];
    vi.spyOn(window, 'open').mockImplementation(() => null);
    document.body.replaceChildren();
  });

  it('renders records already present in the store without hitting the chain', async () => {
    seedRecords([
      { key: 'name', value: 's3ntiment.eth', type: 'metadata' },
      { key: 'ipfs-root', value: 'bafyroot', type: 'content' },
    ]);

    const el = await mountTab();
    const root = el.shadowRoot!;
    expect(root.textContent).toContain('Records (2)');
    expect(root.textContent).toContain('s3ntiment.eth');
    expect(root.textContent).toContain('bafyroot');

    // Seeded store => connectedCallback skips loadRecords => no chain reads.
    expect(m.safeIntegration.getAllRecords).not.toHaveBeenCalled();
  });

  it('renders the empty state when the store holds no records', async () => {
    store.setAllRecords([]); // {} is truthy => skip loadRecords => deterministic
    const el = await mountTab();
    const root = el.shadowRoot!;
    expect(root.textContent).toContain('Records (0)');
    expect(root.textContent).toContain('No records yet');
  });

  it('treats the config record value as an IPFS gateway link', async () => {
    seedRecords([{ key: 'config', value: 'bafyconfig123', type: 'content' }]);
    const el = await mountTab();
    const link = el.shadowRoot!.querySelector<HTMLAnchorElement>('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('https://ipfs.io/ipfs/bafyconfig123');
  });

  it('hides the unused feed record from the records table', async () => {
    seedRecords([
      { key: 'name', value: 's3ntiment.eth', type: 'metadata' },
      { key: 'feed', value: '0xfeedfeed', type: 'metadata' },
      { key: 'config', value: 'bafyconfig123', type: 'content' },
    ]);
    const el = await mountTab();
    const root = el.shadowRoot!;
    // The hidden record is excluded from both the count and the rendered rows.
    expect(root.textContent).toContain('Records (2)');
    expect(root.textContent).not.toContain('0xfeedfeed');
    const rowKeys = [...root.querySelectorAll('.table-row')].map((row) =>
      row.querySelector('.table-cell')?.textContent?.trim(),
    );
    expect(rowKeys).toEqual(['name', 'config']);
  });

  it('Add alias is NOT blocked by ownership when DOMAIN_VALIDATION_CONFIG.enforceOwnership is OFF (default)', async () => {
    // The real default must stay OFF (the product decision the task calls out).
    expect(DOMAIN_VALIDATION_CONFIG.enforceOwnership).toBe(false);

    seedRecords([{ key: 'name', value: 's3ntiment.eth', type: 'metadata' }]);
    const el = await mountTab();

    setAliasInput(el, 'example.eth');
    clickButton(el, 'Add alias');

    // Gate OFF => maybeVerifyDomainOwnership returns {ok:true} without any EVM
    // read, then the config update runs and the success notification appears.
    // dagExport (the only real network call in updateConfig) is made to fail via
    // a stubbed fetch so the component's non-fatal Filecoin upload path degrades
    // gracefully (console.warn) instead of hitting the network.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: 'stubbed',
        text: async () => 'stubbed',
      })),
    );
    // Wait for the FULL updateConfig to settle (the terminal optimistic store
    // write is the last step) so no in-flight work bleeds into the next test.
    await vi.waitFor(
      () => {
        expect(store.getRecord('config')).toBe('config-cid');
        expect(notificationTexts().join(' | ')).toContain('Alias "example.eth" saved as write-target');
      },
      { timeout: 5000 },
    );

    expect(m.evmRead).not.toHaveBeenCalled();
    expect(m.safeIntegration.setRecord).toHaveBeenCalledWith('config', 'config-cid');
    // Optimistic store update so the new value shows immediately.
    expect(window.open).toHaveBeenCalled();
  });

  it('adds multiple aliases: each add flows the FULL alias list through buildConfig -> config.aliases', async () => {
    seedRecords([{ key: 'name', value: 's3ntiment.eth', type: 'metadata' }]);
    const el = await mountTab();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: 'stubbed',
        text: async () => 'stubbed',
      })),
    );

    // First add: the list grows from [] to ['first.eth'].
    setAliasInput(el, 'first.eth');
    clickButton(el, 'Add alias');
    await vi.waitFor(
      () => expect(renderedAliasNames(el)).toEqual(['first.eth']),
      { timeout: 5000 },
    );
    // buildConfig(owner, repo, branch, pub, addr, assetsCid, existingCid, domain, aliases)
    await vi.waitFor(() => expect(m.buildConfigCalls.length).toBe(1));
    expect(m.buildConfigCalls[0][8]).toEqual(['first.eth']);

    // Second add: the FULL list ['first.eth','second.eth'] flows through.
    // (The rendered list above guarantees the echoed alias list has landed back
    // in component state, so the second add accumulates on top of it.)
    setAliasInput(el, 'second.eth');
    clickButton(el, 'Add alias');
    await vi.waitFor(
      () => expect(renderedAliasNames(el)).toEqual(['first.eth', 'second.eth']),
      { timeout: 5000 },
    );
    await vi.waitFor(() => expect(m.buildConfigCalls.length).toBe(2));
    expect(m.buildConfigCalls[1][8]).toEqual(['first.eth', 'second.eth']);
  });

  it('renders the current write-target aliases with a Remove button each', async () => {
    // Empty store => connectedCallback runs loadRecords => loadCurrentAliases
    // reads the config via the (mocked) IPFS client and populates the list.
    const el = await mountTab();

    await vi.waitFor(
      () => {
        expect(renderedAliasNames(el)).toEqual(['s3ntiment.eth']);
        expect(el.shadowRoot!.textContent).toContain('ENS write-target aliases');
      },
      { timeout: 5000 },
    );
    const removeBtns = [...el.shadowRoot!.querySelectorAll('button')].filter(
      (b) => b.textContent?.includes('Remove'),
    );
    expect(removeBtns.length).toBe(1);
  });

  it('removing an alias flows the REDUCED list through buildConfig (clear-on-removal source)', async () => {
    const el = await mountTab();

    // Wait for the alias list to render from the (mocked) config read.
    await vi.waitFor(
      () => expect(renderedAliasNames(el)).toEqual(['s3ntiment.eth']),
      { timeout: 5000 },
    );
    clickButton(el, 'Remove');

    // buildConfig is reached asynchronously after the optimistic notification;
    // wait for BOTH the terminal store write and the build call.
    await vi.waitFor(
      () => {
        expect(m.buildConfigCalls.length).toBe(1);
        expect(store.getRecord('config')).toBe('config-cid');
        expect(notificationTexts().join(' | ')).toContain('Alias "s3ntiment.eth" removed');
      },
      { timeout: 5000 },
    );
    // Empty aliases array clears the write targets.
    expect(m.buildConfigCalls[0][8]).toEqual([]);
    // The list is now empty (all write-targets cleared).
    expect(renderedAliasNames(el)).toEqual([]);
  });
});
