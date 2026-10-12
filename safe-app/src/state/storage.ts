import {  DealMap, RecordMap } from './types.js';
import type { PetNameMap } from './pet-name.store.js';

const RECORDS_STORAGE_KEY = 'records';
const DEALS_STORAGE_KEY = 'deals';
const ROOT_STORAGE_KEY = 'root';
const OFFERS_STORAGE_KEY = 'offers';
const PIECES_STORAGE_KEY = 'pieces';
const PET_NAMES_STORAGE_KEY = 'pet-names';

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

export function loadDealsFromStorage(): DealMap | null {
  try {
    const stored = localStorage.getItem(DEALS_STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch (e) {
    console.warn('Failed to load deals from localStorage:', e);
  }
  return null;
}

export function saveDealsToStorage(deals: DealMap | null): void {
  try {
    if (deals === null) {
      localStorage.removeItem(DEALS_STORAGE_KEY);
    } else {
      localStorage.setItem(DEALS_STORAGE_KEY, JSON.stringify(deals));
    }
  } catch (e) {
    console.warn('Failed to save deals to localStorage:', e);
  }
}

export function loadOffersFromStorage(): DealMap | null {
  try {
    const stored = localStorage.getItem(OFFERS_STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch (e) {
    console.warn('Failed to load offers from localStorage:', e);
  }
  return null;
}

export function saveOffersToStorage(deals: DealMap | null): void {
  try {
    if (deals === null) {
      localStorage.removeItem(OFFERS_STORAGE_KEY);
    } else {
      localStorage.setItem(OFFERS_STORAGE_KEY, JSON.stringify(deals));
    }
  } catch (e) {
    console.warn('Failed to save offers to localStorage:', e);
  }
}

export function loadPiecesFromStorage<T>(): T[] | null {
  try {
    const stored = localStorage.getItem(PIECES_STORAGE_KEY);
    if (stored) return JSON.parse(stored, (_k, v) =>
      typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v
    );
  } catch (e) {
    console.warn('Failed to load pieces from localStorage:', e);
  }
  return null;
}

export function loadPetNamesFromStorage(): PetNameMap | null {
  try {
    const stored = localStorage.getItem(PET_NAMES_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Defensive: only accept a plain object of string values.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as PetNameMap;
    }
  } catch (e) {
    console.warn('Failed to load pet names from localStorage:', e);
  }
  return null;
}

export function savePetNamesToStorage(names: PetNameMap | null): void {
  try {
    if (names === null) {
      localStorage.removeItem(PET_NAMES_STORAGE_KEY);
    } else {
      localStorage.setItem(PET_NAMES_STORAGE_KEY, JSON.stringify(names));
    }
  } catch (e) {
    console.warn('Failed to save pet names to localStorage:', e);
  }
}

export function savePiecesToStorage<T>(pieces: T[] | null): void {
  try {
    if (pieces === null) {
      localStorage.removeItem(PIECES_STORAGE_KEY);
    } else {
      localStorage.setItem(PIECES_STORAGE_KEY, JSON.stringify(pieces, (_k, v) =>
        typeof v === 'bigint' ? v.toString() + 'n' : v
      ));
    }
  } catch (e) {
    console.warn('Failed to save pieces to localStorage:', e);
  }
}