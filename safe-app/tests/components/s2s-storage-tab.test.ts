import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { S2SStorageTab } from '../../src/components/s2s-storage-tab';
import { mountLit } from '../helpers/mount';
import '../../src/components/s2s-storage-tab';

// ---- hoisted mock state (shared between the component import and this spec) ----
const fcMocks = vi.hoisted(() => ({
  estimateMonthlyCostFromPieces: vi.fn(),
}));

const storeMock = vi.hoisted(() => {
  let pieces: any[] = [];
  let dataSets: any[] = [];
  const piecesListeners: Array<() => void> = [];
  const dataSetsListeners: Array<() => void> = [];
  return {
    get pieces() {
      return pieces;
    },
    get dataSets() {
      return dataSets;
    },
    setPieces(p: any[]) {
      pieces = p;
      piecesListeners.forEach((l) => l());
    },
    setDataSets(d: any[]) {
      dataSets = d;
      dataSetsListeners.forEach((l) => l());
    },
    subscribeToPieces(l: () => void) {
      piecesListeners.push(l);
      return () => {};
    },
    subscribeToDataSets(l: () => void) {
      dataSetsListeners.push(l);
      return () => {};
    },
    __reset() {
      pieces = [];
      dataSets = [];
      piecesListeners.length = 0;
      dataSetsListeners.length = 0;
    },
  };
});

vi.mock('@/state/index.js', () => ({
  store: storeMock,
  StoragePiece: {},
  PublicationDataSet: {},
}));

// The CID-inventory section + adapter (added in stage 4) import the shared
// cid-view entry points. The REAL base barrel loads identity/ethers (v5-style
// `utils` import) which does not bundle in the browser, so stub the shared
// modules the new graph needs: `toBytes32Id` (cid-view adapter) and
// `S2SIPFSMethods` / `buildPublicationCidView` (safe-app adapter + section).
// The storage-tab store mock has no protocolInfo, so the section's ctx is
// empty and buildPublicationCidView simply yields an empty view.
vi.mock('@s2s/soul2soul-shared', () => ({
  toBytes32Id: (id: string) => id,
}));

vi.mock('@s2s/soul2soul-shared/safe-app', async () => {
  // The cid-view section now statically imports parsePublicationCidView from
  // this entry (its cache-load validator); vitest requires the mocked module
  // to provide it. Import the REAL validation (zod only — no ethers/identity
  // graph, so the browser bundle stays light) to keep the fail-closed posture.
  const validation = await import('../../../shared/src/cid-view/validation.ts');
  // T4b: the batch retrievability adapter (src/lib/cid-view.ts) also imports
  // these from the safe-app entry — provide the real (pure, browser-safe)
  // implementations so the named imports resolve.
  const retrievability = await import('../../../shared/src/cid-view/retrievability.ts');
  return {
    S2SIPFSMethods: class {},
    buildPublicationCidView: async () => ({
      publication: '',
      generatedAt: '',
      entries: [],
      sources: { deals: false, config: false, tree: false, archive: false },
      summary: { total: 0, uniqueCids: 0, byCategory: {} },
    }),
    parsePublicationCidView: validation.parsePublicationCidView,
    parseCidRetrievabilityMap: validation.parseCidRetrievabilityMap,
    // The CID-inventory section (s2s-cid-view-section) imports these pure view
    // helpers + source list from the safe-app entry as well.
    cidsFromView: retrievability.cidsFromView,
    orderByCopiesAscending: retrievability.orderByCopiesAscending,
    orderByStaleness: retrievability.orderByStaleness,
    RETRIEVABILITY_SOURCES: retrievability.RETRIEVABILITY_SOURCES,
  };
});

vi.mock('@s2s/soul2soul-shared/filecoin', () => ({
  FilecoinStorage: class {
    static estimateMonthlyCostFromPieces = fcMocks.estimateMonthlyCostFromPieces;
  },
}));

// ---- fixtures ----
const PIECES = [
  {
    pieceCid: 'bafybeiaaa',
    pieceId: '1',
    rootCid: 'bafyroot1',
    dataSetId: '1',
    provider: 'f0101',
    size: 100,
    metadata: { kind: 'file' },
    pdpEndEpoch: null,
    scheduledForRemoval: false,
    confirmed: true,
  },
  {
    pieceCid: 'bafybeibbb',
    pieceId: '2',
    rootCid: null,
    dataSetId: '2',
    provider: 'f0102',
    size: 10,
    metadata: { kind: 'folder' },
    pdpEndEpoch: 1000n,
    scheduledForRemoval: true,
    confirmed: true,
  },
];

const DATASETS = [
  { dataSetId: '1', provider: 'f0101', pieceCount: 1, pdpEndEpoch: null, isLive: true, metadata: {} },
  { dataSetId: '2', provider: 'f0102', pieceCount: 1, pdpEndEpoch: 1000n, isLive: true, metadata: {} },
];

const COST = { storage: 2.5, proving: 1.0, datasetCount: 2, total: 3.5, totalBytes: 2048 };

function makeStorageProp() {
  return {
    deletePiece: vi.fn(async () => {}),
    terminateDataSet: vi.fn(async () => ({ serviceTerminationEpoch: 123 })),
  };
}

function notificationTexts(): string {
  return document.body.textContent ?? '';
}

// Storage-tab now delegates both tables to <s2s-table>, which renders into
// LIGHT DOM (createRenderRoot() => this — see s2s-table.ts:98). The table
// headers, filter toolbar and host-supplied rows are direct light-DOM children
// of the <s2s-table> elements inside the tab's shadow root (no nested shadow
// root for the table itself; only copy-hash / table-filter / ph-* icons have
// their own shadow roots).
function piecesTable(el: S2SStorageTab): HTMLElement {
  return el.shadowRoot?.querySelector('s2s-table') as HTMLElement;
}

function datasetsTable(el: S2SStorageTab): HTMLElement {
  return el.shadowRoot?.querySelectorAll('s2s-table')[1] as HTMLElement;
}

function pieceRowCids(el: S2SStorageTab): string[] {
  const rows = piecesTable(el).querySelectorAll('.table-row');
  return [...rows].map((r) => (r.querySelector('copy-hash') as any).value);
}

describe('s2s-storage-tab', () => {
  let storage: ReturnType<typeof makeStorageProp>;

  beforeEach(() => {
    storeMock.__reset();
    fcMocks.estimateMonthlyCostFromPieces.mockReset();
    fcMocks.estimateMonthlyCostFromPieces.mockReturnValue(COST);
    storage = makeStorageProp();
  });

  it('shows the loading state when the store has no pieces', async () => {
    const el = await mountLit<S2SStorageTab>('s2s-storage-tab', { storage });
    expect(el.shadowRoot?.textContent).toContain('Loading storage data...');
  });

  it('delegates to <s2s-table> and renders both tables with counts, rows and cost summary', async () => {
    storeMock.setPieces(PIECES);
    storeMock.setDataSets(DATASETS);

    const el = await mountLit<S2SStorageTab>('s2s-storage-tab', { storage });

    // Counts converge from the <s2s-table> @count events.
    await vi.waitFor(() => {
      expect(el.shadowRoot?.textContent).toContain('Filecoin Storage (2 pieces)');
      expect(el.shadowRoot?.textContent).toContain('Data Sets (2)');
    });

    // Two <s2s-table> instances: [0] pieces, [1] data sets.
    expect(el.shadowRoot?.querySelectorAll('s2s-table')).toHaveLength(2);

    // Cost summary (seeded with at least one confirmed piece) in the tab's own
    // shadow root, driven by the mocked estimate.
    const cost = el.shadowRoot?.querySelector('.cost-summary');
    expect(cost?.textContent).toContain('$2.5000/mo'); // storage
    expect(cost?.textContent).toContain('$1.0000/mo'); // proving
    expect(cost?.textContent).toContain('$3.5000/mo'); // total
    expect(cost?.textContent).toContain('2 KB'); // formatBytes(totalBytes)
    expect(fcMocks.estimateMonthlyCostFromPieces).toHaveBeenCalledWith(PIECES);

    // Piece rows: 2 rows; gateway link only for the piece with a rootCid.
    expect(piecesTable(el).querySelectorAll('.table-row')).toHaveLength(2);
    expect(piecesTable(el).querySelector('.gateway-link')).toBeTruthy();

    // Dataset rows with Active vs Terminated badges.
    expect(datasetsTable(el).querySelectorAll('.table-row')).toHaveLength(2);
    expect(datasetsTable(el).textContent).toContain('Terminated');
    expect(datasetsTable(el).textContent).toContain('Active');
  });

  it('renders a sortable header (with .sort-indicator) for every column key', async () => {
    storeMock.setPieces(PIECES);
    storeMock.setDataSets(DATASETS);

    const el = await mountLit<S2SStorageTab>('s2s-storage-tab', { storage });

    // Pieces columns (PIECE_COLUMNS) + trailing Actions header.
    const pieceKeys = ['pieceCid', 'rootCid', 'kind', 'size', 'dataSetId', 'provider', 'state'];
    for (const key of pieceKeys) {
      const hdr = piecesTable(el).querySelector(
        `.table-header.sortable[data-sort="${key}"]`,
      );
      expect(hdr, `pieces sortable header [${key}]`).toBeTruthy();
      expect(hdr?.querySelector('.sort-indicator')).toBeTruthy();
    }
    expect(piecesTable(el).querySelectorAll('.table-header.sortable')).toHaveLength(
      pieceKeys.length,
    );

    // Data set columns (DATASET_COLUMNS) + trailing Actions header.
    const dsKeys = ['dataSetId', 'provider', 'pieces', 'state', 'endEpoch'];
    for (const key of dsKeys) {
      expect(
        datasetsTable(el).querySelector(`.table-header.sortable[data-sort="${key}"]`),
        `datasets sortable header [${key}]`,
      ).toBeTruthy();
    }
    expect(datasetsTable(el).querySelectorAll('.table-header.sortable')).toHaveLength(dsKeys.length);

    // Trailing Actions header cell is present on both tables (non-sortable).
    const piecesActions = piecesTable(el).querySelector('.table-header:not(.sortable)');
    const dsActions = datasetsTable(el).querySelector('.table-header:not(.sortable)');
    expect(piecesActions?.textContent).toContain('Actions');
    expect(dsActions?.textContent).toContain('Actions');

    // REAL reordering: clicking a sortable header must actually reorder rows,
    // not just render structural wiring. Seed order follows the PIECES array
    // with distinct sizes (100, 10), so the order is deterministic.
    expect(pieceRowCids(el)).toEqual(['bafybeiaaa', 'bafybeibbb']);
    const sizeHeader = piecesTable(el).querySelector(
      'button.table-header.sortable[data-sort="size"]',
    ) as HTMLButtonElement;
    sizeHeader.click();
    // First click on a column toggles it to asc; s2s-table sorts (after
    // filtering) by ascending size — the smaller piece moves to the front.
    await vi.waitFor(() => {
      expect(pieceRowCids(el)).toEqual(['bafybeibbb', 'bafybeiaaa']);
    });
    // The active column renders the ascending caret (bug fix: static tag).
    expect(
      piecesTable(el).querySelector(
        'button.table-header.sortable[data-sort="size"] .sort-indicator ph-caret-up',
      ),
    ).toBeTruthy();
  });

  it('filters pieces by Kind and data sets by State through the table-filter -> s2s-table chain', async () => {
    storeMock.setPieces(PIECES);
    storeMock.setDataSets(DATASETS);

    const el = await mountLit<S2SStorageTab>('s2s-storage-tab', { storage });

    // s2s-table renders a <table-filter data-key="kind"> with the unique kinds.
    const piecesFilter = piecesTable(el).querySelector('.table-filters table-filter') as any;
    expect(piecesFilter.getAttribute('data-key')).toBe('kind');
    const options = piecesFilter.shadowRoot.querySelector('select').options;
    expect([...options].map((o: HTMLOptionElement) => o.value)).toEqual(['', 'file', 'folder']);

    // Drive table-filter's documented contract: a composed 'change' CustomEvent
    // with detail.value (dispatching on the native select would also re-emit the
    // raw change through the host — see report on the double-fire bug).
    piecesFilter.dispatchEvent(
      new CustomEvent('change', { detail: { value: 'file' }, bubbles: true, composed: true }),
    );
    await vi.waitFor(() => {
      expect(el.shadowRoot?.textContent).toContain('Filecoin Storage (1 pieces)');
    });
    expect(piecesTable(el).querySelectorAll('.table-row')).toHaveLength(1);
    expect(pieceRowCids(el)).toEqual(['bafybeiaaa']);

    // A value matching nothing shows the table's empty state.
    piecesFilter.dispatchEvent(
      new CustomEvent('change', { detail: { value: 'archive' }, bubbles: true, composed: true }),
    );
    await vi.waitFor(() => {
      expect(piecesTable(el).querySelector('.empty-state')).toBeTruthy();
    });
    expect(piecesTable(el).textContent).toContain('No pieces match the current filters');
    expect(el.shadowRoot?.textContent).toContain('Filecoin Storage (0 pieces)');

    // Data set table: filter by State → only the Active data set remains.
    const dsFilter = datasetsTable(el).querySelector('.table-filters table-filter') as any;
    expect(dsFilter.getAttribute('data-key')).toBe('state');
    const dsOptions = dsFilter.shadowRoot.querySelector('select').options;
    expect([...dsOptions].map((o: HTMLOptionElement) => o.value)).toEqual(['', 'Active', 'Terminated']);

    dsFilter.dispatchEvent(
      new CustomEvent('change', { detail: { value: 'Active' }, bubbles: true, composed: true }),
    );
    await vi.waitFor(() => {
      expect(el.shadowRoot?.textContent).toContain('Data Sets (1)');
    });
    expect(datasetsTable(el).querySelectorAll('.table-row')).toHaveLength(1);
    // Only the Active data set remains; the Terminated one is filtered out.
    expect(datasetsTable(el).textContent).toContain('Active');
    expect(datasetsTable(el).textContent).not.toContain('Terminated');
  });

  it('deletes a piece through the storage prop and notifies', async () => {
    storeMock.setPieces(PIECES);
    storeMock.setDataSets(DATASETS);

    const el = await mountLit<S2SStorageTab>('s2s-storage-tab', { storage });
    const firstDelete = piecesTable(el).querySelector('.btn-delete') as HTMLButtonElement;
    firstDelete.click();

    await vi.waitFor(() =>
      expect(storage.deletePiece).toHaveBeenCalledWith(BigInt('1'), BigInt('1')),
    );
    await vi.waitFor(() =>
      expect(notificationTexts()).toContain('scheduled piece bafybeiaaa for removal'),
    );
  });

  it('terminates a dataset through the storage prop and notifies with the epoch', async () => {
    storeMock.setPieces(PIECES);
    storeMock.setDataSets(DATASETS);

    const el = await mountLit<S2SStorageTab>('s2s-storage-tab', { storage });
    const firstTerminate = datasetsTable(el).querySelector('.btn-terminate') as HTMLButtonElement;
    firstTerminate.click();

    await vi.waitFor(() =>
      expect(storage.terminateDataSet).toHaveBeenCalledWith(BigInt('1')),
    );
    await vi.waitFor(() =>
      expect(notificationTexts()).toContain('dataset 1 terminated (epoch 123)'),
    );
  });
});
