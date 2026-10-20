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
//   @s2s/soul2soul-shared/filecoin/car-builder/browser -> browserFilecoinBuilder (unused import)
//   @/state/index.js                -> in-memory store mock
//
// ethers and domain-validation stay real: ethers.namehash is pure, and
// domain-validation is a pure module with the enforcement toggle defaulting OFF.
//
// New DOM (Config tab restructure): the write-target aliases render as pills
// (`.alias-pill`) inside the tab, and adding one drives the slide-open
// `s2s-sliding-add-button` control (click Add -> open input -> set value ->
// Enter submits, dispatching `s2s-sliding-add` with detail.value). The Update
// action now lives on the `config` row in the records table (its own button
// with an arrow-clockwise icon, no delete affordance) — the standalone
// top-of-tab Update button was removed.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LitElement } from 'lit';
import { mountLit } from '../helpers/mount';
import { theme } from '../../src/styles/theme';
import { DOMAIN_VALIDATION_CONFIG } from '../../src/lib/domain-validation';
import { pinCidFromRemote } from '@s2s/soul2soul-shared';

// Adopt the design tokens the way main.ts does so var(--gray-*) resolve in the
// test document exactly like in the real app. Without this the alias-pill's
// `border: 1px solid var(--gray-600)` collapses to 0, so any layout assertion
// that compares the pill's height to the Add button's would measure a
// border-less pill. theme is pure CSS-variable definitions (no layout rules),
// so adopting it is additive and cannot disturb behavioral assertions.
document.adoptedStyleSheets = [...document.adoptedStyleSheets, theme.styleSheet];

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

  // Simulated on-chain record values. Mutable so a test can model "the chain
  // has no `config` record yet" (null) independently of the store — the
  // first-config gate must read the chain, not the possibly-optimistic store.
  const chainRecords: Record<string, string | null> = {
    name: 's3ntiment.eth',
    repo: 'https://github.com/acme/site',
    config: 'bafyconfig-prev',
  };

  const safeIntegration = {
    getAllRecords: vi.fn<() => Promise<[string[], string[]]>>(async () => [[], []]),
    getRecord: vi.fn(async (key: string) => m.chainRecords[key] ?? null),
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

  // templateCid seam: the mocked ConfigBuilder echoes this as the built
  // config's templateCid (mirroring the REAL builder, which sets
  // publicationConfig.templateCid from the templates DAG). Default null =>
  // existing tests keep seeing a config with no templateCid.
  let templateCid: string | null = null;

  // Build-stage failure seam: the mocked builders throw these when set, so a
  // test can fail the build half of updateConfig without touching the proposal.
  let assetsBuildFailure: Error | null = null;
  let configBuildFailure: Error | null = null;

  return {
    makeStore,
    chainRecords,
    safeIntegration,
    protocolIntegration,
    storage,
    evmRead,
    buildConfigCalls: [] as any[][],
    setTemplateCid: (v: string | null) => {
      templateCid = v;
    },
    getTemplateCid: () => templateCid,
    setBuildFailure: (which: 'assets' | 'config', err: Error | null) => {
      if (which === 'assets') assetsBuildFailure = err;
      else configBuildFailure = err;
    },
    getAssetsBuildFailure: () => assetsBuildFailure,
    getConfigBuildFailure: () => configBuildFailure,
  };
});

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted — factories only reference `m`).
// ---------------------------------------------------------------------------
vi.mock('@s2s/soul2soul-shared/safe-app', () => ({
  ConfigBuilder: class {
    constructor() {}
    buildConfig = vi.fn(async (...args: any[]) => {
      // Build-stage failure seam (stage tagging tests).
      const failure = m.getConfigBuildFailure();
      if (failure) throw failure;
      m.buildConfigCalls.push(args);
      // Echo the aliases the caller passed (mirrors the real builder, which
      // persists the supplied alias list into config.aliases).
      const aliases = Array.isArray(args[8]) ? args[8].slice() : [];
      const config: { aliases: string[]; templateCid?: string } = { aliases };
      const tpl = m.getTemplateCid();
      if (tpl) config.templateCid = tpl;
      return { cid: 'config-cid', config };
    });
  },
  AssetsBuilder: class {
    constructor() {}
    buildAssets = vi.fn(async () => {
      const failure = m.getAssetsBuildFailure();
      if (failure) throw failure;
      return { cid: 'assets-cid' };
    });
  },
  S2SIPFSMethods: class {
    constructor() {}
    fetchFromKubo = vi.fn(async () => ({ aliases: ['s3ntiment.eth'] }));
  },
  LitService: class {},
}));

vi.mock('@s2s/soul2soul-shared', () => ({
  renderwithLitActions: vi.fn(),
  // Mirrors the real shape (Promise<boolean>) so the component's
  // `void pinCidFromRemote(...).then(...)` never trips on a non-thenable.
  pinCidFromRemote: vi.fn(async () => true),
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
vi.mock('@s2s/soul2soul-shared/filecoin/car-builder/browser', () => ({
  browserFilecoinBuilder: { buildCarFromBytes: vi.fn() },
}));

// Mock the store slice this tab imports.
vi.mock('@/state/index.js', () => ({
  store: m.makeStore(),
  OnChainRecord: {},
}));

// Component under test (registers <s2s-records-tab> and, transitively,
// <s2s-sliding-add-button>).
import '../../src/components/s2s-records-tab';
import { configFailureStage } from '../../src/components/s2s-records-tab';
import { store } from '../../src/state/index';

type RecordsTab = LitElement & {
  safeIntegration: unknown;
  protocolIntegration: unknown;
  lit: unknown;
  storage: unknown;
  updateConfig: (
    aliasesOverride?: string[],
    opts?: { suppressQueueOpen?: boolean },
  ) => Promise<string>;
  /** Private entry point — exercised directly to prove the re-entrancy guard
   *  is not merely the DOM `disabled` attribute. */
  buildInitialConfig: () => Promise<void>;
  /** Private state/entry points the assertions need to read or drive directly:
   *  the chain half of the first-config gate, and refreshChainConfig so a
   *  "subsequent chain read" can be simulated on the same instance. */
  chainConfigCid: string | null;
  configRecordKnown: boolean;
  refreshChainConfig: () => Promise<void>;
};

/** The `#build-config` action in the Records section, or null when absent. */
function buildConfigButton(el: LitElement): HTMLButtonElement | null {
  return el.shadowRoot!.getElementById('build-config') as HTMLButtonElement | null;
}

/** Wait for the mount-time on-chain config read to settle. */
async function waitForChainConfigKnown(el: RecordsTab): Promise<void> {
  await vi.waitFor(() => expect(el.configRecordKnown).toBe(true), { timeout: 5000 });
  await el.updateComplete;
}

/** What the simulated chain reports for a record key (null = no such record). */
function setChainRecord(key: string, value: string | null) {
  m.chainRecords[key] = value;
}

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

// ---------------------------------------------------------------------------
// Alias DOM helpers — the alias list is now a pill row inside the tab, and the
// add control is the slide-open <s2s-sliding-add-button> (its input lives in a
// nested shadow root).
// ---------------------------------------------------------------------------

/** The alias names currently rendered as pills. */
function renderedAliasNames(el: LitElement): string[] {
  return [...el.shadowRoot!.querySelectorAll<HTMLElement>('.alias-pill')].map(
    (p) => p.textContent?.trim() ?? '',
  );
}

/** The <s2s-sliding-add-button> host inside the tab's shadow root. */
function addButtonHost(el: LitElement): HTMLElement & { open: boolean } {
  const host = el.shadowRoot!.querySelector('s2s-sliding-add-button');
  if (!host) throw new Error('s2s-sliding-add-button not found');
  return host as HTMLElement & { open: boolean };
}

/** The Add button inside the sliding-add-button's shadow root. */
function addButton(el: LitElement): HTMLButtonElement {
  const btn = addButtonHost(el).shadowRoot!.querySelector<HTMLButtonElement>('#add-btn');
  if (!btn) throw new Error('Add button not found');
  return btn;
}

/** The slide-open input inside the sliding-add-button's shadow root. */
function addInput(el: LitElement): HTMLInputElement {
  const input = addButtonHost(el).shadowRoot!.querySelector<HTMLInputElement>('.add__input');
  if (!input) throw new Error('add input not found');
  return input;
}

/** Open the slide-open input (first click on Add). No-op if already open. */
function openAddInput(el: LitElement): void {
  if (!addButtonHost(el).open) addButton(el).click();
}

/** Open the add input and set its value (replaces the old #alias-input setter). */
function setAliasInput(el: LitElement, value: string): void {
  openAddInput(el);
  addInput(el).value = value;
}

/** Submit the open add input (Enter — the slide-open submit path). */
function submitAddInput(el: LitElement): void {
  addInput(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

/** Click a pill's remove affordance by its alias name. */
function clickPillRemove(el: LitElement, alias: string): void {
  const pill = [...el.shadowRoot!.querySelectorAll<HTMLElement>('.alias-pill')].find(
    (p) => p.textContent?.trim() === alias,
  );
  const btn = pill?.querySelector<HTMLButtonElement>('.alias-pill__remove');
  if (!btn) throw new Error(`remove button for alias "${alias}" not found`);
  btn.click();
}

/** Freshly query and click a button in the tab's shadow whose label includes `text`. */
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
    m.setTemplateCid(null);
    m.setBuildFailure('assets', null);
    m.setBuildFailure('config', null);
    m.chainRecords = {
      name: 's3ntiment.eth',
      repo: 'https://github.com/acme/site',
      config: 'bafyconfig-prev',
    };
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

  it('Add alias is NOT blocked by ownership when DOMAIN_VALIDATION_CONFIG.enforceOwnership is OFF (default)', async () => {
    // The real default must stay OFF (the product decision the task calls out).
    expect(DOMAIN_VALIDATION_CONFIG.enforceOwnership).toBe(false);

    seedRecords([{ key: 'name', value: 's3ntiment.eth', type: 'metadata' }]);
    const el = await mountTab();

    // Slide-open add flow: click Add to open, set the value, Enter submits.
    setAliasInput(el, 'example.eth');
    submitAddInput(el);

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
        expect(notificationTexts().join(' | ')).toContain(
          'Alias "example.eth" saved as write-target',
        );
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

    // Populated store => the tab still preloads the write-target aliases on
    // mount (bugfix). Wait for that read to settle first so the accumulation
    // below is deterministic (no in-flight loadCurrentAliases overwriting the
    // list), then each add accumulates on top of the preloaded alias.
    await vi.waitFor(() => expect(renderedAliasNames(el)).toEqual(['s3ntiment.eth']), {
      timeout: 5000,
    });

    // First add: the list grows from ['s3ntiment.eth'] to
    // ['s3ntiment.eth','first.eth'].
    setAliasInput(el, 'first.eth');
    submitAddInput(el);
    await vi.waitFor(() => expect(renderedAliasNames(el)).toEqual(['s3ntiment.eth', 'first.eth']), {
      timeout: 5000,
    });
    // buildConfig(owner, repo, branch, pub, addr, assetsCid, existingCid, domain, aliases)
    await vi.waitFor(() => expect(m.buildConfigCalls.length).toBe(1));
    expect(m.buildConfigCalls[0][8]).toEqual(['s3ntiment.eth', 'first.eth']);

    // Second add: the FULL list ['s3ntiment.eth','first.eth','second.eth']
    // flows through. (The rendered list above guarantees the echoed alias list
    // has landed back in component state, so the second add accumulates on top
    // of it.)
    setAliasInput(el, 'second.eth');
    submitAddInput(el);
    await vi.waitFor(
      () => expect(renderedAliasNames(el)).toEqual(['s3ntiment.eth', 'first.eth', 'second.eth']),
      { timeout: 5000 },
    );
    await vi.waitFor(() => expect(m.buildConfigCalls.length).toBe(2));
    expect(m.buildConfigCalls[1][8]).toEqual(['s3ntiment.eth', 'first.eth', 'second.eth']);
  });

  it('renders the current write-target aliases as pills, one remove affordance each', async () => {
    // Empty store => connectedCallback runs loadRecords => loadCurrentAliases
    // reads the config via the (mocked) IPFS client and populates the list.
    const el = await mountTab();

    await vi.waitFor(
      () => {
        expect(renderedAliasNames(el)).toEqual(['s3ntiment.eth']);
        expect(el.shadowRoot!.textContent).toContain('Aliases');
      },
      { timeout: 5000 },
    );
    const removeBtns = [...el.shadowRoot!.querySelectorAll('.alias-pill__remove')];
    expect(removeBtns.length).toBe(1);
  });

  it('loads the current write-target aliases on mount when the store is already populated (fresh tab per switch)', async () => {
    // Pre-populated store mirrors app-boot fetchFreshData() before a tab
    // switch recreates <s2s-records-tab>. The config record CID points at a
    // config JSON that has aliases; loadCurrentAliases must still run on
    // mount (bugfix) so the alias list renders instead of the empty state.
    seedRecords([
      { key: 'name', value: 's3ntiment.eth', type: 'metadata' },
      { key: 'config', value: 'bafyconfig-aliases', type: 'content' },
    ]);

    const el = await mountTab();

    await vi.waitFor(() => expect(renderedAliasNames(el)).toEqual(['s3ntiment.eth']), {
      timeout: 5000,
    });
    // The alias pills (not the empty state) are shown.
    expect(el.shadowRoot!.textContent).toContain('Aliases');
    expect(el.shadowRoot!.textContent).not.toContain('No custom write-targets set');
    // Store was populated => loadRecords (chain read) is skipped; the alias
    // read comes from the cached config CID in the store. The single chain
    // read is the config-record gate for the first-config action (the store
    // value may be optimistic, so the gate cannot trust it).
    expect(m.safeIntegration.getAllRecords).not.toHaveBeenCalled();
    expect(m.safeIntegration.getRecord).toHaveBeenCalledTimes(1);
    expect(m.safeIntegration.getRecord).toHaveBeenCalledWith('config');
  });

  it('removing an alias flows the REDUCED list through buildConfig (clear-on-removal source)', async () => {
    const el = await mountTab();

    // Wait for the alias pills to render from the (mocked) config read.
    await vi.waitFor(() => expect(renderedAliasNames(el)).toEqual(['s3ntiment.eth']), {
      timeout: 5000,
    });
    clickPillRemove(el, 's3ntiment.eth');

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

  it('pins templateCid to Filebase after the build flow (provider filebase, recursive)', async () => {
    // Seed name + config records so the config row's Update button renders.
    seedRecords([
      { key: 'name', value: 's3ntiment.eth', type: 'metadata' },
      { key: 'config', value: 'bafyconfig123', type: 'content' },
    ]);
    const el = await mountTab();

    // Make dagExport (the only real network call in the Filecoin paths) fail
    // fast so the non-fatal Filecoin uploads degrade gracefully instead of
    // hitting the gateway.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: 'stubbed',
        text: async () => 'stubbed',
      })),
    );

    // The builder returns a templateCid (the templates DAG) — mirror the real
    // ConfigBuilder shape for this run.
    m.setTemplateCid('bafytemplates-1');

    // Wait for the config row's Update button to render, then trigger the build.
    await vi.waitFor(
      () =>
        expect(
          [...el.shadowRoot!.querySelectorAll('button')].some((b) =>
            b.textContent?.includes('Update'),
          ),
        ).toBe(true),
      { timeout: 5000 },
    );
    clickButton(el, 'Update');

    // Wait for the FULL build flow to settle (terminal optimistic store write).
    await vi.waitFor(
      () => {
        expect(store.getRecord('config')).toBe('config-cid');
        expect(m.buildConfigCalls.length).toBe(1);
      },
      { timeout: 5000 },
    );

    // After the build, templateCid is pinned to Filebase (recursive remote
    // pin) — the same pinCidFromRemote path neutralpress uses for the assets
    // tree. Provider is 'filebase' only (no pinata pin).
    expect(vi.mocked(pinCidFromRemote)).toHaveBeenCalledWith(
      'bafytemplates-1',
      'https://ipfs.transport-union.dev',
      expect.any(String), // VITE_FILEBASE_TOKEN, '' when unset
      'filebase',
    );
  });

  // ── init flow step 3: queue-popup suppression + first-config entry point ──

  /** Fail dagExport (the only real network call in the build) fast. */
  function stubFailingFetch() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: 'stubbed',
        text: async () => 'stubbed',
      })),
    );
  }

  it('updateConfig() with no opts opens the Safe queue popup and resolves to the config CID (default behaviour)', async () => {
    seedRecords([{ key: 'name', value: 's3ntiment.eth', type: 'metadata' }]);
    const el = await mountTab();
    stubFailingFetch();

    const cid = await el.updateConfig();

    expect(cid).toBe('config-cid');
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(window.open).toHaveBeenCalledWith('https://app.safe.global/tx/0x1', '_blank');
    expect(m.safeIntegration.setRecord).toHaveBeenCalledWith('config', 'config-cid');
  });

  it('updateConfig(undefined, { suppressQueueOpen: true }) skips window.open and still resolves to the config CID', async () => {
    seedRecords([{ key: 'name', value: 's3ntiment.eth', type: 'metadata' }]);
    const el = await mountTab();
    stubFailingFetch();

    const cid = await el.updateConfig(undefined, { suppressQueueOpen: true });

    expect(cid).toBe('config-cid');
    expect(window.open).not.toHaveBeenCalled();
    // Everything else in the method is unchanged: the config record is still
    // proposed and optimistically written to the store.
    expect(m.safeIntegration.setRecord).toHaveBeenCalledWith('config', 'config-cid');
    expect(store.getRecord('config')).toBe('config-cid');
  });

  // ── stage tagging: updateConfig builds AND proposes, so say which failed ──

  it('tags a BUILD failure with stage "build" and preserves the message', async () => {
    seedRecords([{ key: 'name', value: 's3ntiment.eth', type: 'metadata' }]);
    const el = await mountTab();
    stubFailingFetch();

    const boom = new Error('pinata: buildAssets failed (401)');
    m.setBuildFailure('assets', boom);

    const err = await el.updateConfig(undefined, { suppressQueueOpen: true }).then(
      () => null,
      (e: unknown) => e as Error & { stage?: string; cause?: unknown },
    );

    expect(err).not.toBeNull();
    expect(err!.stage).toBe('build');
    expect(configFailureStage(err)).toBe('build');
    // Message preserved, original kept as cause.
    expect(err!.message).toBe('pinata: buildAssets failed (401)');
    expect(err!.cause).toBe(boom);
    // Nothing was proposed.
    expect(m.safeIntegration.setRecord).not.toHaveBeenCalled();
  });

  it('tags a CONFIG-BUILDER failure with stage "build" too (both DAG builds are the build half)', async () => {
    seedRecords([{ key: 'name', value: 's3ntiment.eth', type: 'metadata' }]);
    const el = await mountTab();
    stubFailingFetch();

    const boom = new Error('config builder exploded');
    m.setBuildFailure('config', boom);

    const err = await el.updateConfig(undefined, { suppressQueueOpen: true }).catch(
      (e: unknown) => e as Error & { stage?: string },
    );

    expect(err.stage).toBe('build');
    expect(err.message).toBe('config builder exploded');
    expect(m.safeIntegration.setRecord).not.toHaveBeenCalled();
  });

  it('tags a PROPOSAL failure with stage "propose" and preserves the message', async () => {
    seedRecords([{ key: 'name', value: 's3ntiment.eth', type: 'metadata' }]);
    const el = await mountTab();
    stubFailingFetch();

    // The live step-3 shape: the build succeeded, the Safe SDK rejected the tx.
    const boom = new Error(
      'invalid address (argument="address", value="")',
    );
    m.safeIntegration.setRecord.mockRejectedValueOnce(boom);

    const err = await el.updateConfig(undefined, { suppressQueueOpen: true }).then(
      () => null,
      (e: unknown) => e as Error & { stage?: string; cause?: unknown },
    );

    expect(err).not.toBeNull();
    expect(err!.stage).toBe('propose');
    expect(configFailureStage(err)).toBe('propose');
    expect(err!.message).toBe('invalid address (argument="address", value="")');
    expect(err!.cause).toBe(boom);

    // The build really did run (it is the half that succeeded) and the
    // optimistic store write did not happen.
    expect(m.buildConfigCalls).toHaveLength(1);
    expect(window.open).not.toHaveBeenCalled();
    expect(store.getRecord('config')).toBeNull();
  });

  it('the first-config action reports the failing stage, not a hedged message', async () => {
    seedRecords([{ key: 'name', value: 's3ntiment.eth', type: 'metadata' }]);
    setChainRecord('config', null);
    const el = await mountTab();
    await waitForChainConfigKnown(el);
    stubFailingFetch();

    // Proposal failure -> "built, but the proposal failed" (build did succeed).
    m.safeIntegration.setRecord.mockRejectedValueOnce(new Error('nope'));
    await el.buildInitialConfig();
    expect(
      notificationTexts().some((t) => t.includes('Safe proposal failed')),
    ).toBe(true);
    expect(
      notificationTexts().some((t) => t.includes('Failed to build configuration')),
    ).toBe(false);

    // Build failure -> the build message.
    document.body.replaceChildren();
    m.setBuildFailure('assets', new Error('nope'));
    await el.buildInitialConfig();
    expect(
      notificationTexts().some((t) => t.includes('Failed to build configuration')),
    ).toBe(true);
  });

  it('leaves untagged errors untagged (configFailureStage returns null)', () => {
    expect(configFailureStage(new Error('plain'))).toBeNull();
    expect(configFailureStage('plain')).toBeNull();
    expect(configFailureStage(null)).toBeNull();
  });

  it('a FRESH tab instance (tab switch) with the chain returning \'\' and the proposed CID in the store keeps the action hidden', async () => {
    // The realistic duplicate-proposal path: the tab is destroyed and recreated
    // on every tab switch, so an instance-scoped marker would be gone — but the
    // STORE ("chain ∪ proposed") survives, and a queued-but-unexecuted proposal
    // is still invisible on chain ('').
    seedRecords([{ key: 'name', value: 's3ntiment.eth', type: 'metadata' }]);
    setChainRecord('config', null);

    // First instance proposes.
    const first = await mountTab();
    stubFailingFetch();
    await waitForChainConfigKnown(first);
    expect(buildConfigButton(first)).not.toBeNull();
    await first.updateConfig(undefined, { suppressQueueOpen: true });
    await first.updateComplete;
    expect(store.getRecord('config')).toBe('config-cid');
    expect(buildConfigButton(first)).toBeNull();
    first.remove(); // leaving the Config tab destroys the element

    // The proposal is still queued (not executed) — the chain answers ''.
    setChainRecord('config', '');
    const second = await mountTab();
    await waitForChainConfigKnown(second);

    expect(buildConfigButton(second)).toBeNull();
    // The pending explanation was removed from the UI — the protection is the
    // hidden action, not the sentence.
    expect(second.shadowRoot!.getElementById('config-pending')).toBeNull();
    // No second proposal was queued by the remount.
    expect(m.safeIntegration.setRecord).toHaveBeenCalledTimes(1);
  });

  it('hides the action when the store gains a config CID, without a remount (records subscription)', async () => {
    seedRecords([{ key: 'name', value: 's3ntiment.eth', type: 'metadata' }]);
    setChainRecord('config', null);

    const el = await mountTab();
    setChainRecord('config', '');
    await el.refreshChainConfig();
    await el.updateComplete;
    expect(buildConfigButton(el)).not.toBeNull();
    expect(el.shadowRoot!.getElementById('config-pending')).toBeNull();

    // Someone else (the host's step 3, via this tab) proposed a config: the
    // store gets the CID, and the same instance must re-render off the store
    // subscription — no remount, no manual refresh.
    store.setRecord({ key: 'config', value: 'bafyconfig-seam', type: 'content' });

    await vi.waitFor(
      () => {
        expect(buildConfigButton(el)).toBeNull();
        expect(el.shadowRoot!.getElementById('config-pending')).toBeNull();
      },
      { timeout: 5000 },
    );
  });

  it('hides the Initialize configuration action when the CHAIN has a config record', async () => {
    seedRecords([{ key: 'name', value: 's3ntiment.eth', type: 'metadata' }]);
    setChainRecord('config', 'bafyconfig-onchain');

    const el = await mountTab();
    await waitForChainConfigKnown(el);

    expect(el.chainConfigCid).toBe('bafyconfig-onchain');
    expect(buildConfigButton(el)).toBeNull();
    expect(el.shadowRoot!.getElementById('config-pending')).toBeNull();
  });

  it('offers the Initialize configuration action when neither store nor chain has a config record, and it builds on click', async () => {
    seedRecords([{ key: 'name', value: 's3ntiment.eth', type: 'metadata' }]);
    setChainRecord('config', null);

    const el = await mountTab();
    await waitForChainConfigKnown(el);

    const btn = buildConfigButton(el);
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain('Initialize configuration');
    expect(el.shadowRoot!.getElementById('config-pending')).toBeNull();

    stubFailingFetch();
    const spy = vi.spyOn(el, 'updateConfig');
    btn!.click();

    await vi.waitFor(
      () => {
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith();
        expect(store.getRecord('config')).toBe('config-cid');
      },
      { timeout: 5000 },
    );
    // User-initiated, so the Safe queue popup is kept.
    expect(window.open).toHaveBeenCalledTimes(1);
  });

  it('a chain read returning an EMPTY config after a proposal keeps the action hidden', async () => {
    // The queued proposal is invisible on chain (getRecord returns '') until the
    // Safe tx executes. A chain read (e.g. the tab re-mounting on a tab switch)
    // must not re-arm the action and offer a duplicate proposal.
    seedRecords([{ key: 'name', value: 's3ntiment.eth', type: 'metadata' }]);
    setChainRecord('config', null);

    const el = await mountTab();
    stubFailingFetch();
    await waitForChainConfigKnown(el);
    expect(buildConfigButton(el)).not.toBeNull();

    await el.updateConfig(undefined, { suppressQueueOpen: true });
    await el.updateComplete;
    // The optimistic store write still shows the CID on the config row.
    expect(store.getRecord('config')).toBe('config-cid');

    setChainRecord('config', '');
    await el.refreshChainConfig();
    await el.updateComplete;

    expect(el.chainConfigCid).toBeNull();
    expect(buildConfigButton(el)).toBeNull();
    expect(el.shadowRoot!.getElementById('config-pending')).toBeNull();
  });

  it('keeps the action hidden once a chain read returns the executed config CID', async () => {
    seedRecords([{ key: 'name', value: 's3ntiment.eth', type: 'metadata' }]);
    setChainRecord('config', null);

    const el = await mountTab();
    stubFailingFetch();
    await waitForChainConfigKnown(el);

    await el.updateConfig(undefined, { suppressQueueOpen: true });
    await el.updateComplete;
    expect(buildConfigButton(el)).toBeNull();

    // The Safe tx executed — the chain now carries the record.
    setChainRecord('config', 'bafyconfig-executed');
    await el.refreshChainConfig();
    await el.updateComplete;

    expect(el.chainConfigCid).toBe('bafyconfig-executed');
    expect(buildConfigButton(el)).toBeNull();
  });

  it('a second click while a first-config build is in flight does not queue a second setRecord(config, …)', async () => {
    seedRecords([{ key: 'name', value: 's3ntiment.eth', type: 'metadata' }]);
    setChainRecord('config', null);

    const el = await mountTab();
    stubFailingFetch();
    await waitForChainConfigKnown(el);

    const btn = buildConfigButton(el)!;
    expect(btn).not.toBeNull();

    // Hold the build at its Safe proposal so the in-flight window stays open.
    let release!: (value: string) => void;
    const proposal = new Promise<string>((resolve) => {
      release = resolve;
    });
    m.safeIntegration.setRecord.mockImplementationOnce(() => proposal);

    btn.click();
    await vi.waitFor(() => expect(m.safeIntegration.setRecord).toHaveBeenCalledTimes(1));

    // The action is disabled + relabelled while the build runs…
    await el.updateComplete;
    expect(buildConfigButton(el)!.disabled).toBe(true);
    expect(buildConfigButton(el)!.textContent).toContain('Building configuration');

    // …and the entry point itself is re-entrancy guarded, not just the DOM
    // (a programmatic second submit must be a no-op too).
    btn.click();
    await el.buildInitialConfig();
    expect(m.safeIntegration.setRecord).toHaveBeenCalledTimes(1);

    release('https://app.safe.global/tx/0x1');

    // Success feedback (pending approval) and the action gone — a proposal is
    // queued but not executed, so a duplicate proposal is not offered.
    await vi.waitFor(
      () => {
        expect(notificationTexts().join(' | ')).toContain(
          'Configuration built! Transaction pending approval.',
        );
        expect(buildConfigButton(el)).toBeNull();
        expect(el.shadowRoot!.getElementById('config-pending')).toBeNull();
      },
      { timeout: 5000 },
    );
    expect(m.safeIntegration.setRecord).toHaveBeenCalledTimes(1);
    expect(m.safeIntegration.setRecord).toHaveBeenCalledWith('config', 'config-cid');
  });

  it('builds the config from the repo + branch records in the store (immediate post-init update)', async () => {
    // The init flow wrote the (pending) repo/branch optimistically into the
    // store; updateConfig must prefer those over the chain + the old
    // hardcoded 'main' so the very first build uses the starter template.
    seedRecords([
      { key: 'name', value: 's3ntiment.eth', type: 'metadata' },
      { key: 'config', value: 'bafyconfig123', type: 'content' },
      { key: 'repo', value: 'https://github.com/Joera/website-starter', type: 'metadata' },
      { key: 'branch', value: 'dev', type: 'metadata' },
    ]);
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

    await vi.waitFor(
      () =>
        expect(
          [...el.shadowRoot!.querySelectorAll('button')].some((b) =>
            b.textContent?.includes('Update'),
          ),
        ).toBe(true),
      { timeout: 5000 },
    );
    clickButton(el, 'Update');

    await vi.waitFor(
      () => {
        expect(m.buildConfigCalls.length).toBe(1);
        expect(store.getRecord('config')).toBe('config-cid');
      },
      { timeout: 5000 },
    );
    // buildConfig(owner, repoName, branch, publicationUrl, pub, assetsCid, ...)
    expect(m.buildConfigCalls[0][0]).toBe('Joera');
    expect(m.buildConfigCalls[0][1]).toBe('website-starter');
    expect(m.buildConfigCalls[0][2]).toBe('dev');
  });
});

describe('s2s-sliding-add-button', () => {
  it('renders a + icon before the Add label in the closed state', async () => {
    const host = await mountLit<LitElement & { open: boolean }>('s2s-sliding-add-button', {
      buttonLabel: 'Add',
    });
    const btn = host.shadowRoot!.querySelector<HTMLButtonElement>('#add-btn')!;
    expect(host.open).toBe(false);
    // A ph-plus icon is rendered inside the button…
    const plus = btn.querySelector('ph-plus');
    expect(plus).not.toBeNull();
    // …and it sits before the Add label text.
    expect(btn.children[0]?.tagName.toLowerCase()).toBe('ph-plus');
    const labelNode = [...btn.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
    expect(labelNode?.textContent?.trim()).toBe('Add');
  });

  it('slides open on first click, submits on Enter, clears + closes on Escape, submits on second click', async () => {
    const host = await mountLit<
      LitElement & { open: boolean; placeholder: string; buttonLabel: string }
    >('s2s-sliding-add-button', {
      placeholder: 'e.g. s3ntiment.eth',
      buttonLabel: 'Add',
    });
    const root = host.shadowRoot!;
    const btn = root.querySelector<HTMLButtonElement>('#add-btn')!;
    const input = root.querySelector<HTMLInputElement>('.add__input')!;
    const dispatched: string[] = [];
    host.addEventListener('s2s-sliding-add', (e: Event) => {
      dispatched.push((e as CustomEvent).detail.value as string);
    });

    // Closed by default: input collapsed + not focusable, no `open` attribute.
    expect(host.open).toBe(false);
    expect(host.hasAttribute('open')).toBe(false);
    expect(input.tabIndex).toBe(-1);

    // First click opens + focuses.
    btn.click();
    await vi.waitFor(() => {
      expect(host.open).toBe(true);
      expect(host.hasAttribute('open')).toBe(true);
    });
    // Focus retargets through the shadow root — assert via the host's
    // shadowRoot.activeElement, not document.activeElement (which is the host).
    await vi.waitFor(() => expect(host.shadowRoot!.activeElement).toBe(input), { timeout: 5000 });
    expect(input.tabIndex).toBe(0);

    // Enter submits the trimmed value, clears the input, stays open.
    input.value = '  example.eth  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(dispatched).toEqual(['example.eth']);
    expect(input.value).toBe('');

    // Escape clears + closes.
    input.value = 'stale.eth';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // The property flips synchronously; the reflected attribute is removed on
    // the next update cycle, so await it before asserting the attribute.
    await host.updateComplete;
    expect(host.open).toBe(false);
    expect(host.hasAttribute('open')).toBe(false);
    expect(input.value).toBe('');

    // Second click (while open) submits the current value.
    btn.click(); // reopen (open was false after Escape)
    await vi.waitFor(() => expect(host.open).toBe(true));
    input.value = 'second.eth';
    btn.click(); // now open => second click submits
    expect(dispatched).toEqual(['example.eth', 'second.eth']);
  });
});
