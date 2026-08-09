
import { Listener } from './observable.js';
import { OnChainRecord, PublicationDataSet, StoragePiece } from './types.js';
import { RecordStore } from './record.store.js'
import { DealStore } from './deal.store.js'
import { StorageStore } from './storage.store.js'
import { Deal, SafeInfo } from "../types/index.js"
import { S2SProtocolInfo } from '@s2s/soul2soul-shared';
import { ProtocolStore } from './protocol.store.js';
import { SafeStore } from './safe.store.js';
import { WebStore } from './web.store.js';


class Store {
    private webStore: WebStore;
    private recordStore: RecordStore;
    private dealStore: DealStore;
    private storageStore: StorageStore;
    private protocolStore: ProtocolStore;
    private safeStore: SafeStore;

  constructor() {
    this.webStore = new WebStore();
    this.recordStore = new RecordStore();
    this.dealStore = new DealStore();
    this.storageStore = new StorageStore();
    this.protocolStore = new ProtocolStore();
    this.safeStore = new SafeStore();
  }

  get observables() {
    return {
      records: this.recordStore,
      deals: this.dealStore,
      protocolInfo: this.protocolStore,
      safeInfo: this.safeStore,
    } as const;
  }

  // ============ Root ============

  getRoot(): string | null {
    return this.webStore.get();
  }

  setRoot(record: string): void {
    this.webStore.set(record);
  }


  // ============ Record ============

  getAllRecords(): Record<string, OnChainRecord> | null {
    return this.recordStore.all() ?? null
  }

  getRecord(key: string): string | null {
    return this.recordStore.get(key)?.value ?? null
  }

  setRecord(record: OnChainRecord): void {
    this.recordStore.set(record);
  }

  setAllRecords(records: OnChainRecord[]): void {
    this.recordStore.setAll(records);
  }

  removeRecord(key: string): void {
    this.recordStore.remove(key);
  }

  clearRecords(): void {
    this.recordStore.clear();
  }

  subscribeToRecords(listener: Listener<Record<string, OnChainRecord> | null>): () => void {
    return this.recordStore.subscribe(listener);
  }

  // ============ Deals ============
  get deals(): Deal[] {
    return this.dealStore.all;
  }

  setDeals(deals: Deal[]): void {
    this.dealStore.set(deals);
  }

  addDeal(deal: Deal): void {
    this.dealStore.add(deal);
  }

  forgetDeal(id: string): void {
    this.dealStore.remove(id);
  }

   subscribeToDeals(listener: Listener<Deal[]>): () => void {
    return this.dealStore.subscribe(listener);
  }

  // ============ Offers ============
  get offers(): Deal[] {
    return this.dealStore.allPending;
  }

  setOffers(deals: Deal[]): void {
    this.dealStore.setPending(deals);
  }

  addOffer(deal: Deal): void {
    this.dealStore.addPending(deal);
  }

  forgetOffer(id: string): void {
    this.dealStore.removePending(id);
  }

  subscribeToOffers(listener: Listener<Deal[]>): () => void {
    return this.dealStore.subscribeToPending(listener);
  }

      // ============ protocolInfo ============
  get protocolInfo(): S2SProtocolInfo | undefined {
    return this.protocolStore.info;
  }

  setProtocolInfo(info: S2SProtocolInfo | undefined): void {
    if (info != undefined) this.protocolStore.set(info);
  }

        // ============ protocolInfo ============
  get safeInfo(): SafeInfo | undefined {
    return this.safeStore.info;
  }

  setSafeInfo(info: SafeInfo | undefined): void {
    if (info != undefined) this.safeStore.set(info);
  }

  // ============ Global ============
  clear(): void {
    this.recordStore.clear();
    this.dealStore.clear();
  }

  // Legacy subscribe method for backwards compatibility
  // subscribe<K extends 'records' | 'licenses' >(
  //   key: K,
  //   listener: Listener<K extends 'records' ? OnChainRecord[] : K extends 'licenses' ? License[] : any[]>
  // ): () => void {
  //   switch (key) {
  //     case 'records':
  //       // return this.recordStore.subscribe(listener as Listener<OnChainRecord>);
  //     case 'licenses':
  //       return this.licenseStore.subscribe(listener as Listener<License[]>);
  //     default:
  //       throw new Error(`Unknown store key: ${key}`);
  //   }
  // }

  subscribeToSafeInfo(listener: Listener<SafeInfo | undefined>): () => void {
    return this.safeStore.subscribe(listener);
  }

  subscribeToProtocolInfo(listener: Listener<S2SProtocolInfo | undefined>): () => void {
    return this.protocolStore.subscribe(listener);
  }

  subscribeToRoot(listener: Listener<string | null>): () => void {
    return this.webStore.subscribe(listener);
  }

  // ============ Storage (Filecoin pieces) ============
  get pieces(): StoragePiece[] {
    return this.storageStore.allPieces;
  }

  setPieces(pieces: StoragePiece[]): void {
    this.storageStore.setPieces(pieces);
  }

  subscribeToPieces(listener: Listener<StoragePiece[]>): () => void {
    return this.storageStore.subscribeToPieces(listener);
  }

  // ============ Data Sets ============
  get dataSets(): PublicationDataSet[] {
    return this.storageStore.allDataSets;
  }

  setDataSets(datasets: PublicationDataSet[]): void {
    this.storageStore.setDataSets(datasets);
  }

  subscribeToDataSets(listener: Listener<PublicationDataSet[]>): () => void {
    return this.storageStore.subscribeToDataSets(listener);
  }
}

export const store = new Store();