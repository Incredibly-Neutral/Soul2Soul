export interface OnChainRecord {
  key: string,
  value: string,
  type: string
}

export interface RecordMap {
  [key: string]: any;
}

export interface LicenseMap {
  [contentId: string]: any;
}

export interface AppState {
  records: OnChainRecord[]
}