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
import { mountLit, unmount } from '../helpers/mount';

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
    hasAgreement: vi.fn(async () => true),
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
import { renderwithLitActions } from '@s2s/soul2soul-shared';

type DealsTab = LitElement & {
  safeIntegration: unknown;
  protocolIntegration: unknown;
  lit: unknown;
  offersChips: Record<string, string[]>;
  dealsChips: Record<string, string[]>;
  previewMode: boolean;
};

/**
 * The tab reads these off the store before it will render anything, mirroring
 * a publication that has a config record, a name and both loaded infos.
 * Typed through a cast because the mock only carries the slice this tab uses.
 */
function seedRenderPrerequisites() {
  const s = store as unknown as {
    setRecord(r: { key: string; value: string; type: string }): void;
    setProtocolInfo(p: unknown): void;
    setSafeInfo(si: unknown): void;
  };
  s.setRecord({ key: 'config', value: 'bafyConfig', type: 'string' });
  s.setRecord({ key: 'name', value: 'my-pub.soul2soul.eth', type: 'string' });
  s.setProtocolInfo({ gateway: 'https://ipfs.transport-union.dev' });
  s.setSafeInfo({ safeAddress: '0xSafe', s2sPublication: '0xPub', chainId: 8453 });
}

/**
 * Flush the microtask chain a click starts (proposal → state → render → reload)
 * without advancing any timer, so a poll cannot fire by accident.
 */
async function flushUpdates(el: LitElement) {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await el.updateComplete;
  }
  const children = [...el.shadowRoot!.querySelectorAll<LitElement>('s2s-button')];
  await Promise.all(children.map((c) => c.updateComplete));
}

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
 * The stored item for an encrypted deal/offer: the body is ciphertext (never
 * parsed), and `public.label` is present only when one is asked for. `label`
 * is `unknown` so a fixture can put a blank or a non-string on the item and
 * prove the component ignores it.
 */
function encryptedItem(label?: unknown) {
  const content = m.contentFor('') as unknown as {
    public: Record<string, unknown>;
    body: string;
    encryption: boolean;
  };
  content.encryption = true;
  content.body = 'ciphertext';
  if (label !== undefined) content.public.label = label;
  return content;
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

/** The render/render-action button for one genesis, wherever it sits. */
function rowRenderButton(root: ShadowRoot, genesis: string): HTMLButtonElement | null {
  for (const host of root.querySelectorAll('s2s-button')) {
    const btn = host.shadowRoot?.querySelector<HTMLButtonElement>('button[data-action="render"]');
    if (btn?.getAttribute('data-genesis') === genesis) return btn;
  }
  return null;
}

/** The render envelope renderwithLitActions resolves with (success shape). */
function renderResult(cid: string, trace?: unknown[]) {
  return {
    success: true,
    cid,
    path: `/ipfs/${cid}`,
    trace,
    error: undefined,
    maintainCache: undefined,
  };
}

/** The last renderwithLitActions call's positional arguments. */
function lastRenderCall(): unknown[] {
  const calls = vi.mocked(renderwithLitActions).mock.calls;
  return calls[calls.length - 1] as unknown[];
}

/** A render that ran and wrote nothing: the envelope the orchestrator returns. */
function renderFailure(error?: string) {
  return {
    success: false,
    cid: null,
    path: '',
    trace: ['update action failed'],
    error,
    maintainCache: undefined,
  };
}

/**
 * Run a body with fake timers, then always hand the tab its timers back: the
 * element is detached (disconnectedCallback clears the poll interval) before
 * real timers return, so nothing fires into the next test.
 */
async function withFakeTimers<T>(el: LitElement, body: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    return await body();
  } finally {
    unmount(el);
    vi.useRealTimers();
  }
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
    expect(el.shadowRoot!.textContent).toContain('Loading agreements...');

    resolveFetch({ deals: [], offers: [] });
    await vi.waitFor(() => {
      expect(el.shadowRoot!.textContent).toContain('No active agreements yet');
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
      expect(root.textContent).toContain('Active Agreements (1)');
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

  it('names each row by title, label, or the full genesis id, and titles the section Active Agreements', async () => {
    m.safeIntegration.getAllDealsAndOffers.mockResolvedValue({
      deals: [
        rawDeal('0x48656c6c6f', '0xAuthorDeal'),
        rawDeal('0xLabelled', '0xAuthorDeal'),
        rawDeal('0xBare', '0xAuthorDeal'),
        rawDeal('0xBlankLabel', '0xAuthorDeal'),
        rawDeal('0xWhitespaceLabel', '0xAuthorDeal'),
        rawDeal('0xNumericLabel', '0xAuthorDeal'),
      ],
      offers: [rawDeal('0xOfferLabelled', '0xAuthorOffer'), rawDeal('0xOfferBare', '0xAuthorOffer')],
    });
    m.fetchFromIPFS.mockImplementation((_gw: string, cid: string) => {
      switch (cid) {
        case 'cid-0xLabelled':
          return Promise.resolve(encryptedItem('Sealed field notes'));
        case 'cid-0xBare':
          return Promise.resolve(encryptedItem());
        // A blank label, a whitespace-only label and a non-string are all "no
        // label": none of them may reach the cell as the row's name.
        case 'cid-0xBlankLabel':
          return Promise.resolve(encryptedItem(''));
        case 'cid-0xWhitespaceLabel':
          return Promise.resolve(encryptedItem('   '));
        case 'cid-0xNumericLabel':
          return Promise.resolve(encryptedItem(42));
        case 'cid-0xOfferLabelled':
          return Promise.resolve(encryptedItem('Offer label'));
        case 'cid-0xOfferBare':
          return Promise.resolve(encryptedItem());
        default:
          return Promise.resolve(m.contentFor('Open draft'));
      }
    });

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => {
      expect(root.textContent).toContain('Active Agreements (6)');
      expect(root.textContent).toContain('Pending Offers (2)');
    });
    expect(root.textContent).not.toContain('Active Deals');

    const displayOf = (genesis: string) =>
      root.querySelector(`[data-genesis="${genesis}"] copy-content-id`)?.getAttribute('display');

    // Unencrypted: the title.
    expect(displayOf('0x48656c6c6f')).toBe('Open draft');
    // Encrypted with a public label: the label (the '-' title placeholder is ignored).
    expect(displayOf('0xLabelled')).toBe('Sealed field notes');
    expect(displayOf('0xOfferLabelled')).toBe('Offer label');
    // Encrypted without one: the genesis id, in full — not a shortened address.
    expect(displayOf('0xBare')).toBe('0xBare');
    expect(displayOf('0xOfferBare')).toBe('0xOfferBare');
    // Blank, whitespace-only and non-string labels are no label at all, and
    // still never a blank cell.
    expect(displayOf('0xBlankLabel')).toBe('0xBlankLabel');
    expect(displayOf('0xWhitespaceLabel')).toBe('0xWhitespaceLabel');
    expect(displayOf('0xNumericLabel')).toBe('0xNumericLabel');

    // The stored items keep what the fixture put there: the guard is the
    // component's, not the fixture's.
    const labels = (store.deals as unknown as Array<{ genesis: string; label?: unknown }>).map((d) => [
      d.genesis,
      d.label,
    ]);
    expect(labels).toEqual([
      ['0x48656c6c6f', undefined],
      ['0xLabelled', 'Sealed field notes'],
      ['0xBare', undefined],
      ['0xBlankLabel', undefined],
      ['0xWhitespaceLabel', undefined],
      ['0xNumericLabel', undefined],
    ]);
  });

  it('sorts the ID / Title column by the name the row shows', async () => {
    // One labelled encrypted row among the plaintext ones: a getter that
    // agreed on titles but sorted an encrypted row by its genesis id (or its
    // '-' placeholder) lands in a different order.
    m.safeIntegration.getAllDealsAndOffers.mockResolvedValue({
      deals: [
        rawDeal('0xaaa', '0xAuthorDeal'),
        rawDeal('0xbbb', '0xAuthorDeal'),
        rawDeal('0xccc', '0xAuthorDeal'),
      ],
      offers: [],
    });
    m.fetchFromIPFS.mockImplementation((_gw: string, cid: string) => {
      if (cid === 'cid-0xccc') return Promise.resolve(encryptedItem('Mango'));
      return Promise.resolve(m.contentFor(cid === 'cid-0xaaa' ? 'Zulu' : 'Alpha'));
    });

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain('Active Agreements (3)'));

    const header = root.querySelector<HTMLButtonElement>('button[data-sort="title"]');
    expect(header).not.toBeNull();
    header!.click();

    // Genesis order is 0xaaa, 0xbbb, 0xccc; the shown names sort Alpha (0xbbb),
    // Mango (0xccc), Zulu (0xaaa).
    await vi.waitFor(() => {
      expect(
        [...root.querySelectorAll('.deal-card.table-row')].map((r) => r.getAttribute('data-genesis')),
      ).toEqual(['0xbbb', '0xccc', '0xaaa']);
    });
  });

  it('checks deal status via the s2s-check flow and reports an active deal', async () => {
    m.safeIntegration.getAllDealsAndOffers.mockResolvedValue({ deals: [], offers: [] });
    m.safeIntegration.hasAgreement.mockResolvedValue(true);

    const el = await mountTab();
    await vi.waitFor(() => {
      expect(el.shadowRoot!.textContent).toContain('No active agreements yet');
    });

    const check = el.shadowRoot!.querySelector('s2s-check') as unknown as S2SCheck;
    const input = check.shadowRoot!.querySelector('input') as HTMLInputElement;
    input.value = '0xGenesis1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (check.shadowRoot!.querySelector('button') as HTMLButtonElement).click();

    // hasAgreement is called with the toBytes32Id-normalised genesis id.
    await vi.waitFor(() =>
      expect(m.safeIntegration.hasAgreement).toHaveBeenCalledWith('0xhash-0xGenesis1'),
    );
    await vi.waitFor(() => expect(check.result).toBe('pass'));
    expect(check.message).toBe('has an agreement');
  });

  it('reports no agreement via the s2s-check flow when hasAgreement is false', async () => {
    m.safeIntegration.getAllDealsAndOffers.mockResolvedValue({ deals: [], offers: [] });
    m.safeIntegration.hasAgreement.mockResolvedValue(false);

    const el = await mountTab();
    await vi.waitFor(() => {
      expect(el.shadowRoot!.textContent).toContain('No active agreements yet');
    });

    const check = el.shadowRoot!.querySelector('s2s-check') as unknown as S2SCheck;
    const input = check.shadowRoot!.querySelector('input') as HTMLInputElement;
    input.value = '0xGenesis2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (check.shadowRoot!.querySelector('button') as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(m.safeIntegration.hasAgreement).toHaveBeenCalledWith('0xhash-0xGenesis2'),
    );
    await vi.waitFor(() => expect(check.result).toBe('fail'));
    expect(check.message).toBe('no agreement');
  });

  it('filters Active Agreements by postType chips (chip-filter event + row filtering)', async () => {
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
      expect(root.textContent).toContain('Active Agreements (2)');
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

  it('renders nothing at click time on Accept, waits for the signers, then offers Publish', async () => {
    m.safeIntegration.getAllDealsAndOffers.mockResolvedValue({
      deals: [],
      offers: [rawDeal('0xOffer1', '0xAuthorOffer')],
    });
    m.fetchFromIPFS.mockResolvedValue(m.contentFor('Offer Title'));
    m.safeIntegration.hasAgreement.mockResolvedValue(true);
    vi.mocked(renderwithLitActions).mockResolvedValue(renderResult('bafyNew'));
    seedRenderPrerequisites();

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain('Pending Offers (1)'));

    await withFakeTimers(el, async () => {
      findRowButton(root, 'button[data-action="accept"]')!.click();
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);

      // The proposal is queued, not executed: no render, and the row says so.
      expect(m.safeIntegration.admit).toHaveBeenCalledWith('0xOffer1');
      expect(renderwithLitActions).not.toHaveBeenCalled();
      expect(m.safeIntegration.hasAgreement).not.toHaveBeenCalled();
      expect(root.textContent).toContain('Waiting for signers');
      expect(rowRenderButton(root, '0xOffer1')!.disabled).toBe(true);

      // The chain reports the agreement on the poll's beat…
      await vi.advanceTimersByTimeAsync(6_000);
      await flushUpdates(el);
      expect(m.safeIntegration.hasAgreement).toHaveBeenCalledWith('0xOffer1');
      expect(root.textContent).toContain('Publish');
      expect(root.textContent).not.toContain('Waiting for signers');

      const publish = rowRenderButton(root, '0xOffer1')!;
      expect(publish.disabled).toBe(false);
      publish.click();
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);

      // One render for that genesis only, not a sweep, and not a preview.
      expect(renderwithLitActions).toHaveBeenCalledTimes(1);
      const args = lastRenderCall();
      expect(args[0]).toBe(false);
      expect(args[6]).toBe('0xSafe');
      expect(args[8]).toEqual(['0xOffer1']);
      expect(root.textContent).toContain('Published');
    });
  });

  it('polls for the demotion after refusing a deal, and offers Remove page', async () => {
    let loads = 0;
    m.safeIntegration.getAllDealsAndOffers.mockImplementation(async () => {
      loads += 1;
      const row = rawDeal('0xDeal1', '0xAuthorDeal');
      // First load: an agreement. After the refusal it is back to an offer.
      return loads === 1 ? { deals: [row], offers: [] } : { deals: [], offers: [row] };
    });
    m.fetchFromIPFS.mockResolvedValue(m.contentFor('My Deal'));
    m.safeIntegration.hasAgreement.mockResolvedValue(false);
    vi.mocked(renderwithLitActions).mockResolvedValue(renderResult('bafyRemoved'));
    seedRenderPrerequisites();

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain('Active Agreements (1)'));

    await withFakeTimers(el, async () => {
      findRowButton(root, 'button[data-action="reject"][data-status="deal"]')!.click();
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);

      expect(m.safeIntegration.reject).toHaveBeenCalledWith('0xDeal1');
      expect(renderwithLitActions).not.toHaveBeenCalled();
      expect(root.textContent).toContain('Waiting for signers');

      await vi.advanceTimersByTimeAsync(6_000);
      await flushUpdates(el);
      expect(root.textContent).toContain('Remove page');

      rowRenderButton(root, '0xDeal1')!.click();
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);

      // The render decides removal itself; the tab passes no remove entry.
      const args = lastRenderCall();
      expect(args[0]).toBe(false);
      expect(args[8]).toEqual(['0xDeal1']);
      expect(args[12]).toBeUndefined();
      // A completed removal says Removed, never Published: the page is gone.
      expect(root.textContent).toContain('Removed');
      expect(root.textContent).not.toContain('Published');
    });
  });

  it('keeps a refused offer on the table and offers its removal once the chain agrees', async () => {
    let loads = 0;
    m.safeIntegration.getAllDealsAndOffers.mockImplementation(async () => {
      loads += 1;
      const row = rawDeal('0xOffer1', '0xAuthorOffer');
      // An offer whose page is still live: after the refusal the chain lists
      // it in neither set, so only the tab's own row can carry the removal.
      return loads === 1 ? { deals: [], offers: [row] } : { deals: [], offers: [] };
    });
    m.fetchFromIPFS.mockResolvedValue(m.contentFor('Offer Title'));
    m.safeIntegration.hasAgreement.mockResolvedValue(false);
    vi.mocked(renderwithLitActions).mockResolvedValue(renderResult('bafyRemovedOffer'));
    seedRenderPrerequisites();

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain('Pending Offers (1)'));

    await withFakeTimers(el, async () => {
      findRowButton(root, 'button[data-action="reject"][data-status="offer"]')!.click();
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);

      expect(m.safeIntegration.reject).toHaveBeenCalledWith('0xOffer1');
      // No render at click time, and the row survives an empty refetch.
      expect(renderwithLitActions).not.toHaveBeenCalled();
      expect(root.textContent).toContain('Waiting for signers');
      expect(root.querySelector('[data-genesis="0xOffer1"]')).not.toBeNull();

      await vi.advanceTimersByTimeAsync(6_000);
      await flushUpdates(el);
      expect(m.safeIntegration.hasAgreement).toHaveBeenCalledWith('0xOffer1');
      expect(root.textContent).toContain('Remove page');

      rowRenderButton(root, '0xOffer1')!.click();
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);

      expect(renderwithLitActions).toHaveBeenCalledTimes(1);
      expect(lastRenderCall()[8]).toEqual(['0xOffer1']);
      // Once its removal is rendered the row has nothing left to say.
      await flushUpdates(el);
      expect(root.querySelector('[data-genesis="0xOffer1"]')).toBeNull();
    });
  });

  it('does not treat a refused offer as removable without a wait', async () => {
    m.safeIntegration.getAllDealsAndOffers.mockResolvedValue({
      deals: [],
      offers: [rawDeal('0xOffer1', '0xAuthorOffer')],
    });
    m.fetchFromIPFS.mockResolvedValue(m.contentFor('Offer Title'));
    seedRenderPrerequisites();

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain('Pending Offers (1)'));

    await withFakeTimers(el, async () => {
      findRowButton(root, 'button[data-action="reject"][data-status="offer"]')!.click();
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);

      // Same wait either way. An offer the chain lists again is shown as
      // listed; the render action decides whether a page is removed.
      expect(root.textContent).toContain('Waiting for signers');
      expect(m.safeIntegration.hasAgreement).not.toHaveBeenCalled();
    });
  });

  it('gives up on the poll after ten minutes and says the proposal has not executed', async () => {
    m.safeIntegration.getAllDealsAndOffers.mockResolvedValue({
      deals: [],
      offers: [rawDeal('0xOffer1', '0xAuthorOffer')],
    });
    m.fetchFromIPFS.mockResolvedValue(m.contentFor('Offer Title'));
    // The proposal never executes: the chain keeps reporting no agreement.
    m.safeIntegration.hasAgreement.mockResolvedValue(false);
    seedRenderPrerequisites();

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain('Pending Offers (1)'));

    await withFakeTimers(el, async () => {
      findRowButton(root, 'button[data-action="accept"]')!.click();
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);
      expect(root.textContent).toContain('Waiting for signers');

      const readsBeforeCap = m.safeIntegration.hasAgreement.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
      await flushUpdates(el);

      // One last read at the cap, then the row stops claiming to wait.
      expect(m.safeIntegration.hasAgreement.mock.calls.length).toBeGreaterThan(readsBeforeCap);
      expect(root.textContent).not.toContain('Waiting for signers');
      expect(rowRenderButton(root, '0xOffer1')).toBeNull();
      expect(notificationTexts().join(' | ')).toContain(
        'Offer Title: the proposal has not executed. Sync site will reconcile it.',
      );

      // The poll stopped with the row: no more reads on the next beats.
      const reads = m.safeIntegration.hasAgreement.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(m.safeIntegration.hasAgreement.mock.calls.length).toBe(reads);
    });
  });

  it('offers the render at the cap when the last read finally agrees', async () => {
    m.safeIntegration.getAllDealsAndOffers.mockResolvedValue({
      deals: [],
      offers: [rawDeal('0xOffer1', '0xAuthorOffer')],
    });
    m.fetchFromIPFS.mockResolvedValue(m.contentFor('Offer Title'));
    seedRenderPrerequisites();

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain('Pending Offers (1)'));

    await withFakeTimers(el, async () => {
      // Still an offer the whole way; the signers execute at the very end.
      m.safeIntegration.hasAgreement.mockResolvedValue(false);
      findRowButton(root, 'button[data-action="accept"]')!.click();
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);
      expect(root.textContent).toContain('Waiting for signers');

      m.safeIntegration.hasAgreement.mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
      await flushUpdates(el);

      expect(root.textContent).toContain('Publish');
      expect(notificationTexts().join(' | ')).not.toContain('has not executed');
    });
  });

  it('polls only while the tab is visible', async () => {
    m.safeIntegration.getAllDealsAndOffers.mockResolvedValue({
      deals: [],
      offers: [rawDeal('0xOffer1', '0xAuthorOffer')],
    });
    m.fetchFromIPFS.mockResolvedValue(m.contentFor('Offer Title'));
    m.safeIntegration.hasAgreement.mockResolvedValue(true);
    seedRenderPrerequisites();

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain('Pending Offers (1)'));

    const setVisibility = (state: 'visible' | 'hidden') => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    };

    try {
      await withFakeTimers(el, async () => {
        findRowButton(root, 'button[data-action="accept"]')!.click();
        await vi.advanceTimersByTimeAsync(0);
        await flushUpdates(el);

        setVisibility('hidden');
        await vi.advanceTimersByTimeAsync(30_000);
        expect(m.safeIntegration.hasAgreement).not.toHaveBeenCalled();

        setVisibility('visible');
        await vi.advanceTimersByTimeAsync(6_000);
        await flushUpdates(el);
        expect(m.safeIntegration.hasAgreement).toHaveBeenCalledWith('0xOffer1');
        expect(root.textContent).toContain('Publish');
      });
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });

  it('keeps the row on the render step when the render throws', async () => {
    m.safeIntegration.getAllDealsAndOffers.mockResolvedValue({
      deals: [],
      offers: [rawDeal('0xOffer1', '0xAuthorOffer')],
    });
    m.fetchFromIPFS.mockResolvedValue(m.contentFor('Offer Title'));
    m.safeIntegration.hasAgreement.mockResolvedValue(true);
    vi.mocked(renderwithLitActions).mockRejectedValue(new Error('lit action exploded'));
    seedRenderPrerequisites();

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain('Pending Offers (1)'));

    await withFakeTimers(el, async () => {
      findRowButton(root, 'button[data-action="accept"]')!.click();
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);
      await vi.advanceTimersByTimeAsync(6_000);
      await flushUpdates(el);

      rowRenderButton(root, '0xOffer1')!.click();
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);

      expect(notificationTexts().join(' | ')).toContain('Render failed: lit action exploded');
      // Not done: the page was never written, so the action is still live.
      const again = rowRenderButton(root, '0xOffer1');
      expect(again).not.toBeNull();
      expect(again!.hasAttribute('disabled')).toBe(false);
      expect(root.textContent).not.toContain('Published');
    });
  });

  it('keeps the row on the render step when the render reports success:false', async () => {
    m.safeIntegration.getAllDealsAndOffers.mockResolvedValue({
      deals: [],
      offers: [rawDeal('0xOffer1', '0xAuthorOffer')],
    });
    m.fetchFromIPFS.mockResolvedValue(m.contentFor('Offer Title'));
    m.safeIntegration.hasAgreement.mockResolvedValue(true);
    vi.mocked(renderwithLitActions).mockResolvedValue(
      renderFailure('contenthash write failed: boom'),
    );
    seedRenderPrerequisites();

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain('Pending Offers (1)'));

    await withFakeTimers(el, async () => {
      findRowButton(root, 'button[data-action="accept"]')!.click();
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);
      await vi.advanceTimersByTimeAsync(6_000);
      await flushUpdates(el);

      rowRenderButton(root, '0xOffer1')!.click();
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);

      // The write did not land: claiming Published would be a lie.
      expect(root.textContent).not.toContain('Published');
      const again = rowRenderButton(root, '0xOffer1');
      expect(again).not.toBeNull();
      expect(again!.hasAttribute('disabled')).toBe(false);
      expect(notificationTexts().join(' | ')).toContain(
        'Render failed: contenthash write failed: boom',
      );
    });
  });

  it('resumes the poll when a waiting tab is reattached', async () => {
    m.safeIntegration.getAllDealsAndOffers.mockResolvedValue({
      deals: [],
      offers: [rawDeal('0xOffer1', '0xAuthorOffer')],
    });
    m.fetchFromIPFS.mockResolvedValue(m.contentFor('Offer Title'));
    m.safeIntegration.hasAgreement.mockResolvedValue(true);
    seedRenderPrerequisites();

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain('Pending Offers (1)'));

    vi.useFakeTimers();
    try {
      findRowButton(root, 'button[data-action="accept"]')!.click();
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);
      expect(root.textContent).toContain('Waiting for signers');

      const reads = m.safeIntegration.hasAgreement.mock.calls.length;
      el.remove();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(m.safeIntegration.hasAgreement.mock.calls.length).toBe(reads);

      document.body.appendChild(el);
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);

      // Reattached: the phase survived, so the poll and one read come back.
      expect(m.safeIntegration.hasAgreement.mock.calls.length).toBeGreaterThan(reads);
      expect(root.textContent).toContain('Publish');
    } finally {
      unmount(el);
      vi.useRealTimers();
    }
  });

  it('does not call a removal done when the trace records a failed rm', async () => {
    let loads = 0;
    m.safeIntegration.getAllDealsAndOffers.mockImplementation(async () => {
      loads += 1;
      const row = rawDeal('0xDeal1', '0xAuthorDeal');
      return loads === 1 ? { deals: [row], offers: [] } : { deals: [], offers: [row] };
    });
    m.fetchFromIPFS.mockResolvedValue(m.contentFor('My Deal'));
    m.safeIntegration.hasAgreement.mockResolvedValue(false);
    // The update action catches a failed files/rm into a warn line and records
    // `removed:` anyway, so the envelope is ok:true over a page still in place.
    vi.mocked(renderwithLitActions).mockResolvedValue(
      renderResult('bafyStillThere', [
        'rm 1 paths',
        'warn: rm failed posts/gone.md: files/rm timed out',
        'removed: posts/gone.md',
      ]),
    );
    seedRenderPrerequisites();

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain('Active Agreements (1)'));

    await withFakeTimers(el, async () => {
      findRowButton(root, 'button[data-action="reject"][data-status="deal"]')!.click();
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);
      await vi.advanceTimersByTimeAsync(6_000);
      await flushUpdates(el);

      rowRenderButton(root, '0xDeal1')!.click();
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);

      // Not Removed: the page is still there. The row keeps the action and the
      // notice carries the trace line that says why.
      expect(root.textContent).not.toContain('Removed');
      const again = rowRenderButton(root, '0xDeal1');
      expect(again).not.toBeNull();
      expect(again!.hasAttribute('disabled')).toBe(false);
      expect(notificationTexts().join(' | ')).toContain(
        'Removal failed: warn: rm failed posts/gone.md: files/rm timed out',
      );
    });
  });

  it('keeps a refused offer when the chain lists it as a deal again', async () => {
    let loads = 0;
    m.safeIntegration.getAllDealsAndOffers.mockImplementation(async () => {
      loads += 1;
      const row = rawDeal('0xOffer1', '0xAuthorOffer');
      // Two loads as an offer (the refetch after the refusal included), then
      // the chain agrees it after all: it is a deal now.
      return loads <= 2 ? { deals: [], offers: [row] } : { deals: [row], offers: [] };
    });
    m.fetchFromIPFS.mockResolvedValue(m.contentFor('Offer Title'));
    m.safeIntegration.hasAgreement.mockResolvedValue(false);
    seedRenderPrerequisites();

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain('Pending Offers (1)'));

    await withFakeTimers(el, async () => {
      findRowButton(root, 'button[data-action="reject"][data-status="offer"]')!.click();
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);
      expect(root.textContent).toContain('Waiting for signers');

      // The table's own Sync button binds its listener to the table element,
      // not the tab (a pre-existing bug), so the reload goes through the tab's
      // method directly.
      await (el as unknown as { loadDeals: () => Promise<void> }).loadDeals();
      await flushUpdates(el);

      // A deal row owes no removal: the removal it was carrying is dropped.
      expect(root.textContent).toContain('Active Agreements (1)');
      expect(rowRenderButton(root, '0xOffer1')).toBeNull();
      expect(root.textContent).not.toContain('Remove page');

      // And nothing is left waiting, so no read fires on the next beat.
      const reads = m.safeIntegration.hasAgreement.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(m.safeIntegration.hasAgreement.mock.calls.length).toBe(reads);
    });
  });

  it('names a refused-offer row by its title in the timeout notice', async () => {
    let loads = 0;
    m.safeIntegration.getAllDealsAndOffers.mockImplementation(async () => {
      loads += 1;
      const row = rawDeal('0xOffer1', '0xAuthorOffer');
      return loads === 1 ? { deals: [], offers: [row] } : { deals: [], offers: [] };
    });
    m.fetchFromIPFS.mockResolvedValue(m.contentFor('Offer Title'));
    // The chain reports an agreement, so the removal never becomes the next
    // step and the row runs to the cap.
    m.safeIntegration.hasAgreement.mockResolvedValue(true);
    seedRenderPrerequisites();

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain('Pending Offers (1)'));

    await withFakeTimers(el, async () => {
      findRowButton(root, 'button[data-action="reject"][data-status="offer"]')!.click();
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);
      expect(root.textContent).toContain('Waiting for signers');

      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
      await flushUpdates(el);

      // The row is released by the same step that announces it: the name has
      // to be read off it first, or the notice falls back to the id.
      const notices = notificationTexts().join(' | ');
      expect(notices).toContain('Offer Title: the proposal has not executed');
      expect(notices).not.toContain('0xOffer1: the proposal has not executed');
    });
  });

  it('clears the row at the cap even when every hasAgreement read rejects', async () => {
    m.safeIntegration.getAllDealsAndOffers.mockResolvedValue({
      deals: [],
      offers: [rawDeal('0xOffer1', '0xAuthorOffer')],
    });
    m.fetchFromIPFS.mockResolvedValue(m.contentFor('Offer Title'));
    m.safeIntegration.hasAgreement.mockRejectedValue(new Error('rpc down'));
    seedRenderPrerequisites();

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain('Pending Offers (1)'));

    await withFakeTimers(el, async () => {
      findRowButton(root, 'button[data-action="accept"]')!.click();
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);
      expect(root.textContent).toContain('Waiting for signers');

      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
      await flushUpdates(el);

      // A read that always throws is not an answer, and the cap still holds.
      expect(root.textContent).not.toContain('Waiting for signers');
      expect(rowRenderButton(root, '0xOffer1')).toBeNull();
      expect(notificationTexts().join(' | ')).toContain(
        'Offer Title: the proposal could not be confirmed. Sync site will reconcile it.',
      );

      const reads = m.safeIntegration.hasAgreement.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(m.safeIntegration.hasAgreement.mock.calls.length).toBe(reads);
    });
  });

  it('sweeps deals and offers together, deduped, from the Sync site button', async () => {
    m.safeIntegration.getAllDealsAndOffers.mockResolvedValue({
      // The same genesis in both sets: a deal whose offer is still listed.
      deals: [rawDeal('0xDeal1', '0xAuthorDeal'), rawDeal('0xShared', '0xAuthorDeal')],
      offers: [rawDeal('0xShared', '0xAuthorOffer'), rawDeal('0xOffer1', '0xAuthorOffer')],
    });
    m.fetchFromIPFS.mockResolvedValue(m.contentFor('A page'));
    vi.mocked(renderwithLitActions).mockResolvedValue(renderResult('bafySite'));
    seedRenderPrerequisites();

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain('Active Agreements (2)'));

    expect(root.textContent).toContain('Sync site');
    expect(root.textContent).not.toContain('Bulk Render');

    const sweep = findRowButton(root, 'button[data-action="bulkrender"]');
    expect(sweep).not.toBeNull();
    sweep!.click();
    await flushUpdates(el);

    expect(renderwithLitActions).toHaveBeenCalledTimes(1);
    const args = lastRenderCall();
    expect(args[0]).toBe(false);
    expect(args[8]).toEqual(['0xDeal1', '0xShared', '0xOffer1']);
  });

  it('drops encrypted ids in preview and hides the row render action', async () => {
    m.safeIntegration.getAllDealsAndOffers.mockResolvedValue({
      deals: [rawDeal('0xPlain', '0xAuthorDeal'), rawDeal('0xSealed', '0xAuthorDeal')],
      offers: [rawDeal('0xOfferPlain', '0xAuthorOffer')],
    });
    m.fetchFromIPFS.mockImplementation((_gw: string, cid: string) =>
      cid === 'cid-0xSealed'
        ? Promise.resolve(encryptedItem('Sealed field notes'))
        : Promise.resolve(m.contentFor('Open draft')),
    );
    m.safeIntegration.hasAgreement.mockResolvedValue(true);
    vi.mocked(renderwithLitActions).mockResolvedValue(renderResult('bafyPreview'));
    seedRenderPrerequisites();

    const el = await mountTab();
    const root = el.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain('Active Agreements (2)'));

    await withFakeTimers(el, async () => {
      // Put a row in the render phase, so preview has something to hide.
      findRowButton(root, 'button[data-action="accept"]')!.click();
      await vi.advanceTimersByTimeAsync(6_000);
      await flushUpdates(el);
      expect(root.textContent).toContain('Publish');

      el.previewMode = true;
      await flushUpdates(el);
      expect(rowRenderButton(root, '0xOfferPlain')).toBeNull();
      expect(root.textContent).not.toContain('Publish');

      findRowButton(root, 'button[data-action="bulkrender"]')!.click();
      await vi.advanceTimersByTimeAsync(0);
      await flushUpdates(el);

      const args = lastRenderCall();
      expect(args[0]).toBe(true);
      expect(args[8]).toEqual(['0xPlain', '0xOfferPlain']);
    });
  });
});
