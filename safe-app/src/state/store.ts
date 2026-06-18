
import { Listener } from './observable.js';
import { OnChainRecord } from './types.js';
import { RecordStore } from './record.store.js'
import { LicenseStore } from './license.store.js'
import { License, SafeInfo } from "../types/index.js"
import { S2SProtocolInfo } from '@s2s/soul2soul-shared';
import { ProtocolStore } from './protocol.store.js';
import { SafeStore } from './safe.store.js';
import { WebStore } from './web.store.js';


class Store {
    private webStore: WebStore;
    private recordStore: RecordStore;
    private licenseStore: LicenseStore;
    private protocolStore: ProtocolStore;
    private safeStore: SafeStore;

  constructor() {
    this.webStore = new WebStore();
    this.recordStore = new RecordStore();
    this.licenseStore = new LicenseStore();
    this.protocolStore = new ProtocolStore();
    this.safeStore = new SafeStore();
  }

  get observables() {
    return {
      records: this.recordStore,
      licenses: this.licenseStore,
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

  // ============ Licenses ============
  get licenses(): License[] {
    return this.licenseStore.all;
  }

  setLicenses(licenses: License[]): void {
    this.licenseStore.set(licenses);
  }

  addLicense(license: License): void {
    this.licenseStore.add(license);
  }

  forgetLicense(id: string): void {
    this.licenseStore.remove(id);
  }

   subscribeToLicenses(listener: Listener<License[]>): () => void {
    return this.licenseStore.subscribe(listener);
  }

  // ============ pending licenses ============
  get pending(): License[] {
    return this.licenseStore.allPending;
  }

  setPending(licenses: License[]): void {
    this.licenseStore.setPending(licenses);
  }

  addPending(license: License): void {
    this.licenseStore.addPending(license);
  }

  forgetPending(id: string): void {
    this.licenseStore.removePending(id);
  }

  subscribeToPending(listener: Listener<License[]>): () => void {
    return this.licenseStore.subscribeToPending(listener);
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
    this.licenseStore.clear();
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
}

export const store = new Store();