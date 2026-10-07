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

  it('renders pieces and data sets tables with cost summary', async () => {
    storeMock.setPieces(PIECES);
    storeMock.setDataSets(DATASETS);

    const el = await mountLit<S2SStorageTab>('s2s-storage-tab', { storage });
    expect(el.shadowRoot?.textContent).toContain('Filecoin Storage (2 pieces)');
    expect(el.shadowRoot?.textContent).toContain('Data Sets (2)');

    // Cost summary (confirmed piece present)
    expect(el.shadowRoot?.textContent).toContain('$2.5000/mo');
    expect(el.shadowRoot?.textContent).toContain('$3.5000/mo');
    expect(fcMocks.estimateMonthlyCostFromPieces).toHaveBeenCalled();

    // Piece rows: gateway link for p1 (rootCid), '-' for p2 (no rootCid)
    const pieceCells = [...(el.shadowRoot?.querySelectorAll('.table-pieces .table-row') ?? [])];
    expect(pieceCells).toHaveLength(2);
    expect(el.shadowRoot?.querySelector('.gateway-link')).toBeTruthy();

    // Dataset rows: Active vs Terminated badges
    const dsRows = [...(el.shadowRoot?.querySelectorAll('.table-datasets .table-row') ?? [])];
    expect(dsRows).toHaveLength(2);
    expect(el.shadowRoot?.textContent).toContain('Terminated');
  });

  it('filters pieces by Kind via the table-filter dropdown', async () => {
    storeMock.setPieces(PIECES);
    storeMock.setDataSets(DATASETS);

    const el = await mountLit<S2SStorageTab>('s2s-storage-tab', { storage });
    const filter = el.shadowRoot?.querySelector('.pieces-filters table-filter') as any;
    const select = filter.shadowRoot.querySelector('select');
    expect([...select.options].map((o: HTMLOptionElement) => o.value)).toEqual([
      '',
      'file',
      'folder',
    ]);

    // table-filter's contract: it emits a composed, bubbling change CustomEvent
    // with detail.value. (Dispatching on the native select also re-emits the raw
    // change through the host, which storage-tab's handler rejects — see report.)
    filter.dispatchEvent(
      new CustomEvent('change', { detail: { value: 'file' }, bubbles: true, composed: true }),
    );

    await vi.waitFor(() => {
      expect(el.shadowRoot?.textContent).toContain('Filecoin Storage (1 pieces)');
    });
    const rows = [...(el.shadowRoot?.querySelectorAll('.table-pieces .table-row') ?? [])];
    expect(rows).toHaveLength(1);
    // Piece CID lives in the nested copy-hash shadow DOM → read its value property.
    expect((rows[0].querySelector('copy-hash') as any).value).toBe('bafybeiaaa');
  });

  it('sorts pieces by Size ascending on header click', async () => {
    storeMock.setPieces(PIECES);
    storeMock.setDataSets(DATASETS);

    const el = await mountLit<S2SStorageTab>('s2s-storage-tab', { storage });
    const sizeHeader = el.shadowRoot?.querySelector(
      '.table-pieces button[data-sort="size"]',
    ) as HTMLButtonElement;
    sizeHeader.click();
    await el.updateComplete;

    const rows = [...(el.shadowRoot?.querySelectorAll('.table-pieces .table-row') ?? [])];
    const cids = rows.map((r) => (r.querySelector('copy-hash') as any).value);
    expect(cids).toEqual(['bafybeibbb', 'bafybeiaaa']); // 10 first, 100 second
    expect(sizeHeader.textContent).toContain('▲');
  });

  it('deletes a piece through the storage prop and notifies', async () => {
    storeMock.setPieces(PIECES);
    storeMock.setDataSets(DATASETS);

    const el = await mountLit<S2SStorageTab>('s2s-storage-tab', { storage });
    const firstDelete = el.shadowRoot?.querySelector('.table-pieces .btn-delete') as HTMLButtonElement;
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
    const firstTerminate = el.shadowRoot?.querySelector(
      '.table-datasets .btn-terminate',
    ) as HTMLButtonElement;
    firstTerminate.click();

    await vi.waitFor(() =>
      expect(storage.terminateDataSet).toHaveBeenCalledWith(BigInt('1')),
    );
    await vi.waitFor(() =>
      expect(notificationTexts()).toContain('dataset 1 terminated (epoch 123)'),
    );
  });
});
