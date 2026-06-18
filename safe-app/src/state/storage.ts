import {  LicenseMap, RecordMap } from './types.js';

const RECORDS_STORAGE_KEY = 'records';
const LICENSES_STORAGE_KEY = 'licenses';
const ROOT_STORAGE_KEY = 'root';
const PENDING_STORAGE_KEY = 'PENDING';

export function loadRootFromStorage(): string | null {
  try {
    const stored = localStorage.getItem(ROOT_STORAGE_KEY);
    if (stored) return stored;
  } catch (e) {
    console.warn('Failed to load record from localStorage:', e);
  }
  return null;
}

export function saveRootToStorage(record: string | null): void {
  try {
    if (record === null) {
      localStorage.removeItem(ROOT_STORAGE_KEY);
    } else {
      localStorage.setItem(ROOT_STORAGE_KEY, record);
    }
  } catch (e) {
    console.warn('Failed to save record to localStorage:', e);
  }
}


export function loadRecordFromStorage(): RecordMap | null {
  try {
    const stored = localStorage.getItem(RECORDS_STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch (e) {
    console.warn('Failed to load record from localStorage:', e);
  }
  return null;
}

export function saveRecordToStorage(record: RecordMap | null): void {
  try {
    if (record === null) {
      localStorage.removeItem(RECORDS_STORAGE_KEY);
    } else {
      localStorage.setItem(RECORDS_STORAGE_KEY, JSON.stringify(record));
    }
  } catch (e) {
    console.warn('Failed to save record to localStorage:', e);
  }
}

export function loadLicensesFromStorage(): LicenseMap | null {
  try {
    const stored = localStorage.getItem(LICENSES_STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch (e) {
    console.warn('Failed to load licenses from localStorage:', e);
  }
  return null;
}

export function saveLicensesToStorage(licenses: LicenseMap | null): void {
  try {
    if (licenses === null) {
      localStorage.removeItem(LICENSES_STORAGE_KEY);
    } else {
      localStorage.setItem(LICENSES_STORAGE_KEY, JSON.stringify(licenses));
    }
  } catch (e) {
    console.warn('Failed to save licenses to localStorage:', e);
  }
}

export function loadPendingLicensesFromStorage(): LicenseMap | null {
  try {
    const stored = localStorage.getItem(PENDING_STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch (e) {
    console.warn('Failed to load licenses from localStorage:', e);
  }
  return null;
}

export function savePendingLicensesToStorage(licenses: LicenseMap | null): void {
  try {
    if (licenses === null) {
      localStorage.removeItem(PENDING_STORAGE_KEY);
    } else {
      localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(licenses));
    }
  } catch (e) {
    console.warn('Failed to save licenses to localStorage:', e);
  }
}