/**
 * lastmile state directory + rollback bookkeeping.
 *
 * Persists, per magazine, the currently-served CID plus a bounded history of
 * previous CIDs (so the sync loop can roll back / keep a safety net pinned),
 * and mirrors it to the legacy `s2s.json` file. Every write is atomic
 * (write "<file>.tmp" then rename) so a crash mid-write can never leave a
 * half-written state that would make lastmile serve the wrong content.
 *
 * Fails closed: any unreadable or corrupt state file loads as an empty
 * state (which the caller reconciles from config + fresh resolution) rather
 * than throwing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface MagazineState {
  /** .com domain this magazine serves (e.g. "s3ntiment.com"). */
  domain: string;
  /** ENS name the domain is bound to (e.g. "s3ntiment.eth"). */
  ensName: string;
  /** Currently served CID; null = never successfully resolved yet. */
  cid: string | null;
  /** Older CIDs, most-recent-first, bounded by rollbackDepth - 1. */
  previousCids: string[];
  /** Decimal string of the block the cid was resolved at. */
  blockNumber: string | null;
  /** RPCs used for that resolution. */
  rpcs: string[];
  /** ISO timestamp of when the current cid was applied. */
  updatedAt: string;
}

export interface S2sJson {
  name: string;
  cid: string | null;
  blockNumber: string | null;
  timestamp: string;
  rpcs: string[];
}

/** ISO timestamp used as the "never updated" sentinel. */
const EPOCH_ISO = new Date(0).toISOString();

export function emptyState(domain: string, ensName: string): MagazineState {
  return {
    domain,
    ensName,
    cid: null,
    previousCids: [],
    blockNumber: null,
    rpcs: [],
    updatedAt: EPOCH_ISO,
  };
}

/**
 * Load <stateDir>/state.json. A missing file, invalid JSON, or a value of
 * the wrong shape all fall back to an empty state — never throw. On fallback
 * the domain/ensName come back as "" and the caller (which knows them from
 * config) reconciles.
 */
export function loadState(stateDir: string): MagazineState {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8');
  } catch {
    return emptyState('', '');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyState('', '');
  }
  return normalizeState(parsed);
}

/** Field-by-field coercion so a structurally-off JSON never crashes us. */
function normalizeState(value: unknown): MagazineState {
  if (typeof value !== 'object' || value === null) return emptyState('', '');
  const s = value as Record<string, unknown>;
  return {
    domain: typeof s.domain === 'string' ? s.domain : '',
    ensName: typeof s.ensName === 'string' ? s.ensName : '',
    cid: typeof s.cid === 'string' ? s.cid : null,
    previousCids: Array.isArray(s.previousCids)
      ? s.previousCids.filter((c): c is string => typeof c === 'string')
      : [],
    blockNumber: typeof s.blockNumber === 'string' ? s.blockNumber : null,
    rpcs: Array.isArray(s.rpcs) ? s.rpcs.filter((r): r is string => typeof r === 'string') : [],
    updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : EPOCH_ISO,
  };
}

/** mkdir -p the state dir, then atomically persist a MagazineState. */
export function writeState(stateDir: string, state: MagazineState): void {
  fs.mkdirSync(stateDir, { recursive: true });
  atomicWrite(path.join(stateDir, 'state.json'), JSON.stringify(state, null, 2));
}

/** Atomically write the legacy <stateDir>/s2s.json mirror. */
export function writeS2sJson(stateDir: string, json: S2sJson): void {
  fs.mkdirSync(stateDir, { recursive: true });
  atomicWrite(path.join(stateDir, 's2s.json'), JSON.stringify(json, null, 2));
}

/**
 * Atomic write: write to "<file>.tmp" then rename over "<file>". rename is
 * atomic on POSIX, so readers never observe a partial file.
 */
function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

export interface ApplyNewCidInput {
  cid: string;
  blockNumber: string | null;
  rpcs: string[];
  /** How many old CIDs are kept pinned for rollback (incl. the head). */
  rollbackDepth: number;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

/**
 * Advance the state to a newly resolved CID, pushing the old current CID to
 * the head of previousCids and trimming the history to at most
 * rollbackDepth - 1 entries. Returns the trimmed-out CIDs as `unpin` so the
 * caller can release them from the Kubo node (the caller owns the actual
 * pin/unpin calls).
 */
export function applyNewCid(
  prev: MagazineState,
  next: ApplyNewCidInput,
): { state: MagazineState; unpin: string[] } {
  const now = (next.now ?? new Date()).toISOString();

  const maxPrevious = Math.max(0, next.rollbackDepth - 1);
  const previousCids: string[] = [];
  if (prev.cid) previousCids.push(prev.cid);
  for (const c of prev.previousCids) {
    if (previousCids.length >= maxPrevious) break;
    previousCids.push(c);
  }

  const kept = new Set(previousCids);
  const unpin = prev.previousCids.filter((c) => !kept.has(c));

  const state: MagazineState = {
    domain: prev.domain,
    ensName: prev.ensName,
    cid: next.cid,
    previousCids,
    blockNumber: next.blockNumber,
    rpcs: [...next.rpcs],
    updatedAt: now,
  };
  return { state, unpin };
}
