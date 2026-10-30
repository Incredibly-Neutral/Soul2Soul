import { Observable, Listener } from './observable.js';
import { StoragePiece, PublicationDataSet } from './types.js';
import { loadPiecesFromStorage, savePiecesToStorage } from './storage.js';

export class StorageStore {
  private piecesObservable: Observable<StoragePiece[]>;
  private datasetsObservable: Observable<PublicationDataSet[]>;
  private initialized = false;

  constructor() {
    const stored = loadPiecesFromStorage<StoragePiece>();
    const pieces = stored ?? [];
    for (const p of pieces) p.confirmed = false;

    this.piecesObservable = new Observable<StoragePiece[]>(pieces);
    this.datasetsObservable = new Observable<PublicationDataSet[]>([]);

    // Auto-save pieces on changes
    this.piecesObservable.subscribe((p) => {
      if (this.initialized) savePiecesToStorage(p);
    });

    this.initialized = true;
  }

  get allPieces(): StoragePiece[] {
    return this.piecesObservable.get();
  }

  get allDataSets(): PublicationDataSet[] {
    return this.datasetsObservable.get();
  }

  /** Replace all pieces with fresh chain data — marks them confirmed. */
  setPieces(pieces: StoragePiece[]): void {
    for (const p of pieces) p.confirmed = true;
    this.piecesObservable.set(pieces);
  }

  /** Replace all datasets with fresh chain data. */
  setDataSets(datasets: PublicationDataSet[]): void {
    this.datasetsObservable.set(datasets);
  }

  clear(): void {
    this.piecesObservable.set([]);
    this.datasetsObservable.set([]);
  }

  subscribeToPieces(listener: Listener<StoragePiece[]>): () => void {
    return this.piecesObservable.subscribe(listener);
  }

  subscribeToDataSets(listener: Listener<PublicationDataSet[]>): () => void {
    return this.datasetsObservable.subscribe(listener);
  }
}