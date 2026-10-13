import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyNewCid,
  emptyState,
  loadState,
  writeS2sJson,
  writeState,
  type MagazineState,
  type S2sJson,
} from '../src/state';

const DOMAIN = 's3ntiment.com';
const ENS = 's3ntiment.eth';
const NOW = new Date('2026-10-13T00:00:00.000Z');

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lastmile-state-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('emptyState', () => {
  it('has sensible defaults', () => {
    const s = emptyState(DOMAIN, ENS);
    expect(s).toEqual({
      domain: DOMAIN,
      ensName: ENS,
      cid: null,
      previousCids: [],
      blockNumber: null,
      rpcs: [],
      updatedAt: '1970-01-01T00:00:00.000Z',
    });
  });
});

describe('loadState', () => {
  it('returns emptyState when the file is missing', () => {
    const s = loadState(dir);
    expect(s.domain).toBe('');
    expect(s.ensName).toBe('');
    expect(s.cid).toBeNull();
    expect(s.previousCids).toEqual([]);
  });

  it('returns emptyState for corrupt JSON', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), '{ not valid json', 'utf8');
    expect(loadState(dir)).toEqual(emptyState('', ''));
  });

  it('returns emptyState for valid but non-object JSON', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), '"just a string"', 'utf8');
    expect(loadState(dir)).toEqual(emptyState('', ''));
  });

  it('round-trips a written state', () => {
    const state: MagazineState = {
      domain: DOMAIN,
      ensName: ENS,
      cid: 'QmCurrent',
      previousCids: ['QmOld1', 'QmOld2'],
      blockNumber: '22123456',
      rpcs: ['https://rpc-a.example', 'https://rpc-b.example'],
      updatedAt: NOW.toISOString(),
    };
    writeState(dir, state);
    expect(loadState(dir)).toEqual(state);
  });

  it('does not leave a .tmp file behind after write', () => {
    writeState(dir, emptyState(DOMAIN, ENS));
    expect(fs.existsSync(path.join(dir, 'state.json.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(true);
  });
});

describe('applyNewCid', () => {
  it('moves the current cid to the head of previousCids and updates fields', () => {
    const prev: MagazineState = {
      domain: DOMAIN,
      ensName: ENS,
      cid: 'QmA',
      previousCids: ['QmB'],
      blockNumber: '111',
      rpcs: ['https://rpc-old.example'],
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const { state, unpin } = applyNewCid(prev, {
      cid: 'QmE',
      blockNumber: '222',
      rpcs: ['https://rpc-new.example'],
      rollbackDepth: 5,
      now: NOW,
    });

    expect(state.cid).toBe('QmE');
    expect(state.previousCids).toEqual(['QmA', 'QmB']);
    expect(state.blockNumber).toBe('222');
    expect(state.rpcs).toEqual(['https://rpc-new.example']);
    expect(state.updatedAt).toBe(NOW.toISOString());
    expect(state.domain).toBe(DOMAIN);
    expect(state.ensName).toBe(ENS);
    expect(unpin).toEqual([]);
  });

  it('works from a fresh empty state', () => {
    const { state, unpin } = applyNewCid(emptyState(DOMAIN, ENS), {
      cid: 'QmA',
      blockNumber: '100',
      rpcs: ['https://rpc.example'],
      rollbackDepth: 3,
      now: NOW,
    });
    expect(state.cid).toBe('QmA');
    expect(state.previousCids).toEqual([]);
    expect(unpin).toEqual([]);
  });

  it('truncates previousCids to rollbackDepth - 1 and returns dropped cids as unpin', () => {
    const prev: MagazineState = {
      domain: DOMAIN,
      ensName: ENS,
      cid: 'QmA',
      previousCids: ['QmB', 'QmC', 'QmD'],
      blockNumber: '1',
      rpcs: [],
      updatedAt: 'x',
    };
    // depth 3 -> previousCids keeps at most 2 entries: QmA, QmB. QmC/QmD drop.
    const { state, unpin } = applyNewCid(prev, {
      cid: 'QmE',
      blockNumber: '2',
      rpcs: [],
      rollbackDepth: 3,
      now: NOW,
    });
    expect(state.previousCids).toEqual(['QmA', 'QmB']);
    expect(unpin).toEqual(['QmC', 'QmD']);
    expect(state.cid).toBe('QmE');
  });

  it('keeps the full history when rollbackDepth is large enough', () => {
    const prev: MagazineState = {
      domain: DOMAIN,
      ensName: ENS,
      cid: 'QmA',
      previousCids: ['QmB', 'QmC'],
      blockNumber: '1',
      rpcs: [],
      updatedAt: 'x',
    };
    const { state, unpin } = applyNewCid(prev, {
      cid: 'QmD',
      blockNumber: '2',
      rpcs: [],
      rollbackDepth: 10,
      now: NOW,
    });
    expect(state.previousCids).toEqual(['QmA', 'QmB', 'QmC']);
    expect(unpin).toEqual([]);
  });
});

describe('writeS2sJson', () => {
  it('writes a readable s2s.json and leaves no .tmp', () => {
    const json: S2sJson = {
      name: ENS,
      cid: 'QmS2s',
      blockNumber: '12345',
      timestamp: NOW.toISOString(),
      rpcs: ['https://rpc.example'],
    };
    writeS2sJson(dir, json);

    const file = path.join(dir, 's2s.json');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(json);
  });
});
