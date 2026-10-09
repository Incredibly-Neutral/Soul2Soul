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

// Component under test (registers <s2s-records-tab> and, transitively,
// <s2s-sliding-add-button>).
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

  it('moves the Update action onto the config row: no top-of-tab Update button, config row shows an icon update action and no delete', async () => {
    seedRecords([
      { key: 'name', value: 's3ntiment.eth', type: 'metadata' },
      { key: 'config', value: 'bafyconfig123', type: 'content' },
    ]);
    const el = await mountTab();
    const root = el.shadowRoot!;
    const section = root.querySelector('.section')!;

    // The standalone top-of-tab Update button is gone — the first element in
    // the section is the alias section, not a button.
    expect(section.firstElementChild?.classList.contains('alias-section')).toBe(true);
    expect(section.firstElementChild?.tagName.toLowerCase()).toBe('div');
    expect(root.textContent).not.toContain('Update Config');

    // The config row carries the update action, with an icon…
    const configRow = [...root.querySelectorAll<HTMLElement>('.table-row')].find(
      (row) => row.querySelector('.table-cell')?.textContent?.trim() === 'config',
    );
    expect(configRow).toBeTruthy();
    const updateBtn = [...configRow!.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Update',
    );
    expect(updateBtn).toBeTruthy();
    expect(updateBtn!.querySelector('ph-arrow-clockwise')).not.toBeNull();

    // …and no edit or delete affordance on the config row.
    expect(configRow!.textContent).not.toContain('Edit');
    expect(configRow!.textContent).not.toContain('Delete');
    expect(configRow!.querySelector('.button-danger')).toBeNull();
  });

  it('config row Update runs the same updateConfig flow the top button used to', async () => {
    seedRecords([
      { key: 'name', value: 's3ntiment.eth', type: 'metadata' },
      { key: 'config', value: 'bafyconfig-prev', type: 'content' },
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

    const configRow = [...el.shadowRoot!.querySelectorAll<HTMLElement>('.table-row')].find(
      (row) => row.querySelector('.table-cell')?.textContent?.trim() === 'config',
    );
    const updateBtn = [...configRow!.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Update',
    );
    expect(updateBtn).toBeTruthy();
    updateBtn!.click();

    // The full updateConfig flow settles with the optimistic store write of
    // the new config CID (the same terminal step the old top button reached).
    await vi.waitFor(
      () => {
        expect(m.safeIntegration.setRecord).toHaveBeenCalledWith('config', 'config-cid');
        expect(store.getRecord('config')).toBe('config-cid');
      },
      { timeout: 5000 },
    );
    // Ownership gate stays OFF — no EVM reads during a plain update.
    expect(m.evmRead).not.toHaveBeenCalled();
    expect(window.open).toHaveBeenCalled();
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

    // Populated store => the tab still preloads the write-target aliases on
    // mount (bugfix). Wait for that read to settle first so the accumulation
    // below is deterministic (no in-flight loadCurrentAliases overwriting the
    // list), then each add accumulates on top of the preloaded alias.
    await vi.waitFor(
      () => expect(renderedAliasNames(el)).toEqual(['s3ntiment.eth']),
      { timeout: 5000 },
    );

    // First add: the list grows from ['s3ntiment.eth'] to
    // ['s3ntiment.eth','first.eth'].
    setAliasInput(el, 'first.eth');
    submitAddInput(el);
    await vi.waitFor(
      () => expect(renderedAliasNames(el)).toEqual(['s3ntiment.eth', 'first.eth']),
      { timeout: 5000 },
    );
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

    await vi.waitFor(
      () => expect(renderedAliasNames(el)).toEqual(['s3ntiment.eth']),
      { timeout: 5000 },
    );
    // The alias pills (not the empty state) are shown.
    expect(el.shadowRoot!.textContent).toContain('Aliases');
    expect(el.shadowRoot!.textContent).not.toContain('No custom write-targets set');
    // Store was populated => loadRecords (chain read) is skipped; only the
    // alias read runs. loadCurrentAliases reads the cached config CID from
    // the store, so no chain read happens either.
    expect(m.safeIntegration.getAllRecords).not.toHaveBeenCalled();
    expect(m.safeIntegration.getRecord).not.toHaveBeenCalled();
  });

  it('removing an alias flows the REDUCED list through buildConfig (clear-on-removal source)', async () => {
    const el = await mountTab();

    // Wait for the alias pills to render from the (mocked) config read.
    await vi.waitFor(
      () => expect(renderedAliasNames(el)).toEqual(['s3ntiment.eth']),
      { timeout: 5000 },
    );
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
});

describe('s2s-sliding-add-button', () => {
  it('renders a + icon before the Add label in the closed (pill) state', async () => {
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
