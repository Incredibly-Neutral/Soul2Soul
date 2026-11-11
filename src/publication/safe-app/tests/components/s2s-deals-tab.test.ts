// s2s-deals-tab.test.ts — component (browser) tests for the Deals tab.
//
// Mock strategy (same rules as s2s-records-tab.test.ts): no Safe iframe, no
// wallet, no network. The heavy modules are mocked at the module level,
// mirroring the exact shapes the source imports:
//
//   @s2s/soul2soul-shared           -> LitService / renderwithLitActions
//   @/lib/safe-integration          -> SafeIntegration
//   @/lib/protocol-integration      -> ProtocolIntegration
//   @/lib/ipfs.factory              -> fetchFromIPFS (static import, used to
//                                       augment deal/offer rows from IPFS)
//   @/state/index.js                -> in-memory store mock
//
// Child components (toggle-button, table-filter, copy-content-id) are real and
// lightweight (styles only) — they load and register normally.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LitElement } from 'lit';
import type { S2SCheck } from '../../src/components/s2s-check';
import { mountLit } from '../helpers/mount';

const m = vi.hoisted(() => {
  // In-memory store mock mirroring the slice of src/state used by this tab.
  const makeStore = () => {
    let deals: Array<Record<string, unknown>> = [];
    let offers: Array<Record<string, unknown>> = [];
    let records: Record<string, { key: string; value: string; type: string }> | null = null;
    let protocolInfo: unknown = undefined;
    let safeInfo: unknown = undefined;
    const dealSubs = new Set<() => void>();
    const notifyDeals = () => dealSubs.forEach((fn) => fn());
    return {
      reset() {
        deals = [];
        offers = [];
        records = null;
        protocolInfo = undefined;
        safeInfo = undefined;
        dealSubs.clear();
      },
      subscribeToDeals(fn: () => void) {
        dealSubs.add(fn);
        return () => dealSubs.delete(fn);
      },
      get deals() {
        return deals;
      },
      setDeals(d: Array<Record<string, unknown>>) {
        deals = d;
        notifyDeals();
      },
      get offers() {
        return offers;
      },
      setOffers(o: Array<Record<string, unknown>>) {
        offers = o;
        notifyDeals();
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
    };
  };

  // IPFS content returned by fetchFromIPFS for a deal/offer cid.
  const contentFor = (title: string, extra: Record<string, unknown> = {}) => ({
    public: {
      createdAt: '1700000000',
      author: '0xAuthor1',
      postType: 'post',
      position: '1',
      tags: ['s2s'],
      ...(extra.public as Record<string, unknown> | undefined),
    },
    body: JSON.stringify({ title }),
    encryption: false,
    ...extra,
  });

  const safeIntegration = {
    getAllDealsAndOffers: vi.fn<() => Promise<{ deals: unknown[]; offers: unknown[] }>>(
      async () => ({ deals: [], offers: [] }),
    ),
    hasDeal: vi.fn(async () => true),
    admit: vi.fn(async () => {}),
    reject: vi.fn(async () => {}),
    signWithSigner: vi.fn(async () => 'sig'),
    getSafeInfo: vi.fn(() => ({ safeAddress: '0xSafe', s2sPublication: '0xPub', chainId: 8453 })),
  };

  const fetchFromIPFS = vi.fn();

  // Mirrors shared/src/identity/contract-id.ts (pass-through for 0x + 64 hex,
  // otherwise a synthetic hash) so runDealCheck's normalisation is testable
  // without a real keccak256.
  const toBytes32Id = vi.fn((ref: string) =>
    /^0x[0-9a-fA-F]{64}$/.test(ref.trim()) ? ref.trim().toLowerCase() : `0xhash-${ref}`,
  );

  const protocolIntegration = {
    getInfo: vi.fn(async () => ({ gateway: 'https://ipfs.transport-union.dev' })),
  };

  return {
    makeStore,
    contentFor,
    safeIntegration,
    fetchFromIPFS,
    toBytes32Id,
    protocolIntegration,
  };
});

vi.mock('@s2s/soul2soul-shared', async () => {
  // pet-name reads an author through the shared helper; provide the real one
  // rather than a stub, so the mock does not have to know the form.
  const { authorAddress } = await import(
    '../../../../shared/src/manuscript/identity/author-address.js'
  );
  return {
    LitService: class {},
    renderwithLitActions: vi.fn(),
    toBytes32Id: m.toBytes32Id,
    authorAddress,
  };
});

vi.mock('@/lib/safe-integration.js', () => ({ SafeIntegration: class {} }));
vi.mock('@/lib/protocol-integration.js', () => ({ ProtocolIntegration: class {} }));
vi.mock('@/lib/ipfs.factory.js', () => ({
  fetchFromIPFS: m.fetchFromIPFS,
  dagExport: vi.fn(),
}));

vi.mock('@/state/index.js', () => ({
  store: m.makeStore(),
  OnChainRecord: {},
}));

// Component under test — registers <s2s-deals-tab> and its children
// (toggle-button, table-filter, copy-content-id).
import '../../src/components/s2s-deals-tab';
import '../../src/components/s2s-button';
import { store } from '../../src/state/index';

type DealsTab = LitElement & {
  safeIntegration: unknown;
  protocolIntegration: unknown;
  lit: unknown;
  offersChips: Record<string, string[]>;
  dealsChips: Record<string, string[]>;
};

function mountTab(overrides: Partial<DealsTab> = {}) {
  return mountLit<DealsTab>('s2s-deals-tab', {
    safeIntegration: m.safeIntegration,
    protocolIntegration: m.protocolIntegration,
    lit: {},
    ...overrides,
  });
}

function notificationTexts(): string[] {
  return [...document.querySelectorAll('body > div')]
    .map((d) => (d as HTMLElement).textContent ?? '')
    .filter((t) => t.length > 0);
}

/** A fully-shaped deal as returned by getAllDealsAndOffers. */
function rawDeal(genesis: string, author: string) {
  return { genesis, author, cid: `cid-${genesis}`, timestamp: '1700000000' };
}

/**
 * Finds a row-action <button> that may live inside an <s2s-button> shadow
 * root (s2s-button renders the real button in its own shadow DOM and
 * forwards data-action/data-genesis/data-status onto it). Queries the
 * deals-tab shadow root and descends one level into each s2s-button.
 */
function findRowButton(root: ShadowRoot, selector: string): HTMLButtonElement | null {
  const direct = root.querySelector<HTMLButtonElement>(selector);
  if (direct) return direct;
  for (const host of root.querySelectorAll('s2s-button')) {
    const found = host.shadowRoot?.querySelector<HTMLButtonElement>(selector);
    if (found) return found;
  }
  return null;
}

describe('s2s-deals-tab', () => {
  beforeEach(() => {
    (store as unknown as { reset: () => void }).reset();
    vi.clearAllMocks();
    document.body.replaceChildren();
  });

  it('shows the loading state while fetching, then the empty state', async () => {
    let resolveFetch!: (v: { deals: unknown[]; offers: unknown[] }) => void;
    m.safeIntegration.getAllDealsAndOffers.mockImplementation(
      () => new Promise((res) => (resolveFetch = res)),
    );

    const el = await mountTab();
    expect(el.shadowRoot!.textContent).toContain('Loading deals...');

    resolveFetch({ deals: [], offers: [] });
    await vi.waitFor(() => {
      expect(el.shadowRoot!.textContent).toContain('No active deals yet');
    });
  });

  it('renders deals and pending offers after the async load, augmented by IPFS', async () => {
    m.safeIntegration.getAllDealsAndOffers.mockResolvedValue({
      deals: [rawDeal('0xDeal1', '0xAuthorDeal')],
      offers: [rawDeal('0xOffer1', '0xAuthorOffer')],
    });
    m.fetchFromIPFS.mockImplementation((_gw: string, cid: string) =>
      Promise.resolve(m.contentFor(cid === 'cid-0xDeal1' ? 'My First Deal' : 'Pending Offer Title')),
    );

    const el = await mountTab();
    const root = el.shadowRoot!;

    // Deal/offer titles render inside the nested <copy-content-id> custom
    // element's own shadow root, so assert on the `display` attribute instead
    // of tab-level textContent. Everything else (headers, authors, statuses)
    // renders directly in the tab's shadow root.
    await vi.waitFor(() => {
      expect(root.textContent).toContain('Active Deals (1)');
      expect(root.textContent).toContain('Pending Offers (1)');
    });

    const displays = [...root.querySelectorAll('copy-content-id')].map(
      (el) => el.getAttribute('display') ?? '',
    );
    expect(displays).toContain('My First Deal');
    expect(displays).toContain('Pending Offer Title');

    // Store was populated (loadDeals -> store.setDeals/setOffers).
    expect(store.deals).toHaveLength(1);
    expect(store.offers).toHaveLength(1);


    // Both rows carry a data-action="reject" button now (Refuse an offer,
    // Revoke a deal), so a bare selector would be satisfied by either and
    // would not prove the deal row was rendered. Qualify by data-status and
    // assert the genesis each button targets.
    const acceptBtn = findRowButton(root, 'button[data-action="accept"][data-status="offer"]');
    expect(acceptBtn).not.toBeNull();
    expect(acceptBtn!.getAttribute('data-genesis')).toBe('0xOffer1');

    const refuseBtn = findRowButton(root, 'button[data-action="reject"][data-status="offer"]');
    expect(refuseBtn).not.toBeNull();
    expect(refuseBtn!.getAttribute('data-genesis')).toBe('0xOffer1');

    const revokeBtn = findRowButton(root, 'button[data-action="reject"][data-status="deal"]');
    expect(revokeBtn).not.toBeNull();
    expect(revokeBtn!.getAttribute('data-genesis')).toBe('0xDeal1');
  });

  it('checks deal status via the s2s-check flow and reports an active deal', async () => {
    m.safeIntegration.getAllDealsAndOffers.mockResolvedValue({ deals: [], offers: [] });
    m.safeIntegration.hasDeal.mockResolvedValue(true);

    const el = await mountTab();
    await vi.waitFor(() => {
      expect(el.shadowRoot!.textContent).toContain('No active deals yet');
    });

    const check = el.shadowRoot!.querySelector('s2s-check') as unknown as S2SCheck;
    const input = check.shadowRoot!.querySelector('input') as HTMLInputElement;
    input.value = '0xGenesis1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (check.shadowRoot!.querySelector('button') as HTMLButtonElement).click();

    // hasDeal is called with the toBytes32Id-normalised genesis id.
    await vi.waitFor(() =>
      expect(m.safeIntegration.hasDeal).toHaveBeenCalledWith('0xhash-0xGenesis1'),
    );
    await vi.waitFor(() => expect(check.result).toBe('pass'));
    expect(check.message).toBe('has a deal');
  });

  it('reports no deal via the s2s-check flow when hasDeal is false', async () => {
    m.safeIntegration.getAllDealsAndOffers.mockResolvedValue({ deals: [], offers: [] });
    m.safeIntegration.hasDeal.mockResolvedValue(false);

    const el = await mountTab();
    await vi.waitFor(() => {
      expect(el.shadowRoot!.textContent).toContain('No active deals yet');
    });

    const check = el.shadowRoot!.querySelector('s2s-check') as unknown as S2SCheck;
    const input = check.shadowRoot!.querySelector('input') as HTMLInputElement;
    input.value = '0xGenesis2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (check.shadowRoot!.querySelector('button') as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(m.safeIntegration.hasDeal).toHaveBeenCalledWith('0xhash-0xGenesis2'),
    );
    await vi.waitFor(() => expect(check.result).toBe('fail'));
    expect(check.message).toBe('no deal');
  });

  it('filters Active Deals by postType chips (chip-filter event + row filtering)', async () => {
    // Two deals with distinct postTypes so the chips row has a value to pick.
    m.safeIntegration.getAllDealsAndOffers.mockResolvedValue({
      deals: [rawDeal('0xDeal1', '0xAuthorDeal'), rawDeal('0xDeal2', '0xAuthorDeal')],
      offers: [],
    });
    // contentFor's trailing `...extra` replaces `public` wholesale, so set the
    // postType AFTER building the content to keep author/createdAt/tags intact.
    m.fetchFromIPFS.mockImplementation((_gw: string, cid: string) => {
      const content = m.contentFor(cid === 'cid-0xDeal1' ? 'Article Deal' : 'Note Deal');
      content.public.postType = cid === 'cid-0xDeal1' ? 'article' : 'note';
      return Promise.resolve(content);
    });

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => {
      expect(root.textContent).toContain('Active Deals (2)');
    });

    // Both chips groups render (author, then postType), keyed by their group key.
    const groups = [...root.querySelectorAll('.chips-group')].map(
      (g) => g.getAttribute('data-group'),
    );
    expect(groups).toContain('author');
    expect(groups).toContain('postType');

    // Clicking the 'article' postType chip emits a composed chip-filter event.
    const articleChip = root.querySelector<HTMLButtonElement>(
      '.chips-group[data-group="postType"] button.chip[data-value="article"]',
    );
    expect(articleChip).not.toBeNull();
    expect(articleChip!.querySelector('.chip-value')!.textContent).toBe('1');

    const reported = new Promise<CustomEvent<{ key: string; values: string[] }>>(
      (resolve) =>
        el.addEventListener(
          'chip-filter',
          (e) => resolve(e as CustomEvent<{ key: string; values: string[] }>),
          { once: true },
        ),
    );
    articleChip!.click();
    const evt = await reported;
    expect(evt.detail).toEqual({ key: 'postType', values: ['article'] });

    // The host owns the chips state: mirror the reported value and re-render.
    el.dealsChips = { ...el.dealsChips, [evt.detail.key]: evt.detail.values };
    await el.updateComplete;

    // Only the matching row remains in the table.
    await vi.waitFor(() => {
      const rows = [...root.querySelectorAll('.deal-card.table-row')].map(
        (r) => r.getAttribute('data-genesis'),
      );
      expect(rows).toEqual(['0xDeal1']);
    });
  });

  it('admits an offer and shows the pending-approval notification', async () => {
    m.safeIntegration.getAllDealsAndOffers.mockResolvedValue({
      deals: [],
      offers: [rawDeal('0xOffer1', '0xAuthorOffer')],
    });
    m.fetchFromIPFS.mockResolvedValue(m.contentFor('Offer Title'));
    m.safeIntegration.admit.mockResolvedValue(undefined);

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => {
      expect(root.textContent).toContain('Pending Offers (1)');
    });
    const displays = [...root.querySelectorAll('copy-content-id')].map(
      (el) => el.getAttribute('display') ?? '',
    );
    expect(displays).toContain('Offer Title');

    const acceptBtn = findRowButton(root, 'button[data-action="accept"]')!;
    acceptBtn.click();

    await vi.waitFor(() => {
      expect(notificationTexts().join(' | ')).toContain('Offer admitted!');
    });
    expect(m.safeIntegration.admit).toHaveBeenCalledWith('0xOffer1');
  });
});
