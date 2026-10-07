// s2s-website-tree-tab.test.ts — component (browser) tests for the Website Tree
// tab.
//
// Mock strategy (same rules as the sibling tab tests): no Safe iframe, no
// wallet, no network. Heavy modules are mocked at the module level:
//
//   @s2s/soul2soul-shared           -> LitService / renderwithLitActions
//   @/lib/safe-integration          -> SafeIntegration
//   @/lib/evm                       -> evmRead (ENS records reads are stubbed)
//   @/lib/contenthash               -> decodeRootCid (decode is pure, unit-tested)
//   @/state/index.js                -> in-memory store mock
//
// The Kubo DAG walk (listLinks) uses global fetch against the gateway; the
// tests stub global fetch with a per-CID link map (no network). localStorage
// holds the "previous snapshot" used for the add/remove diff.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LitElement } from 'lit';
import { mountLit } from '../helpers/mount';

const SNAPSHOT_KEY = 's2s:website-tree:prev-snapshot';
const ROOT_HASH = '0xROOTHASH';
const CACHE_HASH = '0xCACHEHASH';

const m = vi.hoisted(() => {
  const makeStore = () => {
    let root: string | null = null;
    let records: Record<string, { key: string; value: string; type: string }> | null = null;
    let protocolInfo: unknown = undefined;
    let safeInfo: unknown = undefined;
    let deals: Array<Record<string, unknown>> = [];
    const rootSubs = new Set<() => void>();
    return {
      reset() {
        root = null;
        records = null;
        protocolInfo = undefined;
        safeInfo = undefined;
        deals = [];
        rootSubs.clear();
      },
      subscribeToRoot(fn: () => void) {
        rootSubs.add(fn);
        return () => rootSubs.delete(fn);
      },
      getRoot: () => root,
      setRoot(r: string) {
        root = r;
        rootSubs.forEach((f) => f());
      },
      getRecord: (key: string) => records?.[key]?.value ?? null,
      setRecord(r: { key: string; value: string; type: string }) {
        records = records ?? {};
        records[r.key] = r;
      },
      get protocolInfo() {
        return protocolInfo;
      },
      setProtocolInfo(p: unknown) {
        protocolInfo = p;
      },
      get safeInfo() {
        return safeInfo;
      },
      setSafeInfo(s: unknown) {
        safeInfo = s;
      },
      get deals() {
        return deals;
      },
      setDeals(d: Array<Record<string, unknown>>) {
        deals = d;
      },
    };
  };

  const safeIntegration = {
    signWithSigner: vi.fn(async () => 'sig'),
    getSafeInfo: vi.fn(() => ({ safeAddress: '0xSafe', s2sPublication: '0xPub' })),
  };

  const evmRead = vi.fn();
  const decodeRootCid = vi.fn();
  // Default: a successful reset pipeline that reports a fresh root CID.
  const renderwithLitActions = vi.fn(async () => ({ success: true, cid: 'bafyfresh' }));

  return { makeStore, safeIntegration, evmRead, decodeRootCid, renderwithLitActions };
});

vi.mock('@s2s/soul2soul-shared', () => ({
  LitService: class {},
  renderwithLitActions: m.renderwithLitActions,
}));

vi.mock('@/lib/safe-integration.js', () => ({ SafeIntegration: class {} }));
vi.mock('@/lib/evm.js', () => ({ evmRead: m.evmRead, getRpcUrl: vi.fn() }));
vi.mock('@/lib/contenthash.js', () => ({ decodeRootCid: m.decodeRootCid }));

vi.mock('@/state/index.js', () => ({
  store: m.makeStore(),
  OnChainRecord: {},
}));

// Component under test — registers <s2s-website-tree-tab> (and <copy-hash>).
import '../../src/components/s2s-website-tree-tab';
import { store } from '../../src/state/index';

type TreeTab = LitElement & {
  safeIntegration: unknown;
  lit: unknown;
};

function mountTab(overrides: Partial<TreeTab> = {}) {
  return mountLit<TreeTab>('s2s-website-tree-tab', {
    safeIntegration: m.safeIntegration,
    lit: {},
    ...overrides,
  });
}

/**
 * A deterministic Kubo /api/v0/ls stub. `linksByCid` maps a root CID to its
 * direct children; the `arg` query param of the fetched URL is the CID.
 * Mirrors the gateway response shape the component reads (Objects[0].Links).
 */
function stubKuboLs(linksByCid: Record<string, Array<{ Name: string; Hash: string; Size: number; Type: number }>>) {
  return vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      const arg = u.searchParams.get('arg') ?? '';
      const links = linksByCid[arg] ?? [];
      return { ok: true, json: async () => ({ Objects: [{ Links: links }] }) };
    }),
  );
}

const SITE_LINKS: Record<string, Array<{ Name: string; Hash: string; Size: number; Type: number }>> = {
  bafyroot: [
    { Name: 'index.html', Hash: 'QmHome', Size: 123, Type: 2 },
    { Name: 'about', Hash: 'QmAboutDir', Size: 0, Type: 1 },
  ],
  QmAboutDir: [{ Name: 'index.html', Hash: 'QmAboutPage', Size: 45, Type: 2 }],
};

describe('s2s-website-tree-tab', () => {
  beforeEach(() => {
    (store as unknown as { reset: () => void }).reset();
    vi.clearAllMocks();
    localStorage.clear();
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('walks the DAG from the store root when no ENS name is configured (fallback path)', async () => {
    store.setRoot('bafyroot');
    stubKuboLs(SITE_LINKS);

    const el = await mountTab();
    const root = el.shadowRoot!;

    await vi.waitFor(() => {
      expect(root.textContent).toContain('4 entries');
    });

    expect(root.textContent).toContain('2 pages');
    expect(root.textContent).toContain('index.html');
    expect(root.textContent).toContain('about');
    expect(root.textContent).toContain('page'); // 'page' badge on index.html
    // Fallback path => no ENS reads, no footer CID.
    expect(m.evmRead).not.toHaveBeenCalled();
    expect(root.querySelector('.cid-footer')).toBeNull();
  });

  it('reads the root + content-cache CID from the ENS records contract when configured', async () => {
    store.setRecord({ key: 'name', value: 's3ntiment.eth', type: 'metadata' });
    store.setProtocolInfo({ ensRecords: '0xRecords', gateway: 'https://gw' });
    stubKuboLs(SITE_LINKS);

    m.evmRead.mockImplementation(async (_chainId: number, _addr: string, _abi: unknown, method: string, args: unknown[]) => {
      if (String(args[1]).startsWith('contenthash_wrapped')) return ROOT_HASH;
      if (String(args[1]).startsWith('content_cache_')) return CACHE_HASH;
      return null;
    });
    m.decodeRootCid.mockImplementation((hash: unknown) =>
      hash === ROOT_HASH ? 'bafyroot' : hash === CACHE_HASH ? 'bafycache' : null,
    );

    const el = await mountTab();
    const root = el.shadowRoot!;

    await vi.waitFor(() => {
      expect(root.textContent).toContain('4 entries');
    });

    expect(m.evmRead).toHaveBeenCalledWith(
      8453,
      '0xRecords',
      expect.any(Array),
      'getText',
      expect.arrayContaining([expect.any(String), 'contenthash_wrapped']),
    );
    expect(m.evmRead).toHaveBeenCalledWith(
      8453,
      '0xRecords',
      expect.any(Array),
      'getText',
      expect.arrayContaining([expect.any(String), 'content_cache_s3ntiment.eth']),
    );
    // Footer shows the decoded content-cache CID as a gateway link.
    const footerLink = root.querySelector<HTMLAnchorElement>('.cid-footer a');
    expect(footerLink).not.toBeNull();
    expect(footerLink!.getAttribute('href')).toBe('https://ipfs.io/ipfs/bafycache');
  });

  it('diffs the new tree against the previous localStorage snapshot and lists removals', async () => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(['index.html', 'about/', 'about/index.html', 'old-page.html']));
    store.setRoot('bafyroot');
    stubKuboLs(SITE_LINKS);

    const el = await mountTab();
    const root = el.shadowRoot!;

    await vi.waitFor(() => {
      expect(root.textContent).toContain('−1 removed');
    });

    expect(root.textContent).toContain('Removed since last sync (1)');
    const removed = root.querySelector('.removed-name');
    expect(removed?.textContent).toContain('old-page.html');
  });

  it('opens the reset confirmation dialog and cancels without side effects', async () => {
    store.setRoot('bafyroot');
    stubKuboLs(SITE_LINKS);

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain('4 entries'));

    const resetBtn = [...root.querySelectorAll('button')].find((b) => b.textContent?.includes('Reset tree'))!;
    resetBtn.click();

    const overlay = root.querySelector('.modal-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.textContent).toContain('Reset website tree?');

    const cancelBtn = overlay!.querySelector<HTMLButtonElement>('#reset-cancel-btn')!;
    cancelBtn.click();
    expect(root.querySelector('.modal-overlay')).toBeNull();

    // Cancel never triggers the reset pipeline.
    expect(m.safeIntegration.signWithSigner).not.toHaveBeenCalled();
  });

  it('executes a reset-only through the Lit pipeline and re-syncs to the fresh root', async () => {
    // resetTree requires config + publication + protocolInfo + safeInfo in store.
    store.setRecord({ key: 'config', value: 'bafyconfig', type: 'content' });
    store.setRecord({ key: 'name', value: 's3ntiment.eth', type: 'metadata' });
    store.setProtocolInfo({ ensRecords: '0xRecords', gateway: 'https://gw' });
    store.setSafeInfo({ safeAddress: '0xSafe', s2sPublication: '0xPub' });
    // Seed a store root for the initial sync (evmRead/decodeRootCid return
    // nothing here, so fetchRootCid degrades to the store root).
    store.setRoot('bafyroot');
    // The pipeline reports a fresh root ('bafyfresh'); the re-sync walk must
    // serve that new root, not the old one.
    stubKuboLs({ ...SITE_LINKS, bafyfresh: [{ Name: 'index.html', Hash: 'QmHome', Size: 10, Type: 2 }] });

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain('4 entries'));

    const resetBtn = [...root.querySelectorAll('button')].find((b) => b.textContent?.includes('Reset tree'))!;
    resetBtn.click();
    root.querySelector<HTMLButtonElement>('#reset-only-btn')!.click();

    // signWithSigner -> renderwithLitActions(reset: true) -> fresh root saved.
    await vi.waitFor(() => expect(m.safeIntegration.signWithSigner).toHaveBeenCalledWith('lit actions auth'));
    expect(m.renderwithLitActions).toHaveBeenCalledTimes(1);
    const resetArgs = m.renderwithLitActions.mock.calls[0];
    // 14th positional arg is the reset flag; reset-only passes an empty contentIds list.
    expect(resetArgs[13]).toBe(true);
    expect(resetArgs[8]).toEqual([]);

    await vi.waitFor(() => expect(store.getRoot()).toBe('bafyfresh'));
    // Re-synced from the fresh root -> root + index.html only.
    await vi.waitFor(() => expect(root.textContent).toContain('2 entries'));
    expect(root.textContent).toContain('1 pages');
  });
});
