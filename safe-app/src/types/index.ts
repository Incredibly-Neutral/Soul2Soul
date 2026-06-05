export interface S2SRecord {
  key: string;
  value: string;
  type: 'metadata' | 'content';
}

export interface SafeInfo {
  safeAddress: string;
  chainId: number;
  network: string;
  modules: string[];
  owners: string[];
  threshold: number;
  s2sRecords?: string;
  s2sPublication?: string; 
}

export interface SafeAppsSDK {
  safe: {
    getInfo(): Promise<{ safeAddress: string; chainId: number; network: string }>;
    getModules(): Promise<string[]>;
  };
  txs: {
    send(params: { txs: Array<{ to: string; value: string; data: string }> }): Promise<any>;
  };
  eth: any;
}

export interface ContractInterface {
  encodeFunctionData(functionName: string, params: any[]): string;
}

export interface EthersContract {
  interface: ContractInterface;
  getAllRecords(): Promise<[string[], string[]]>;
  setRecord(key: string, value: string): Promise<any>;
  setRecords(keys: string[], values: string[]): Promise<any>;
  deleteRecord(key: string): Promise<any>;
  getRecord(key: string): Promise<string>;
  recordExists(key: string): Promise<boolean>;
  NAME(): Promise<string>;
  VERSION(): Promise<string>;
  getRecordCount(): Promise<number>;
}

// Custom events for web components
export interface EditRecordEvent extends CustomEvent {
  detail: { key: string };
}

export interface SaveRecordEvent extends CustomEvent {
  detail: { key: string; value: string };
}

export interface CancelEditEvent extends CustomEvent {
  detail: {};
}
