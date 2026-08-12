import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the chain/gateway boundary BEFORE importing main.ts so the module graph
// picks up the mocks. `injectPublicationHelpers` / `resolveTemplateHelpersCid`
// are exported from render/main.ts for exactly this unit coverage.
vi.mock('../libs/evm', () => ({ evmRead: vi.fn() }));
vi.mock('../libs/ipfs.factory', () => ({ catFile: vi.fn(), uploadFile: vi.fn() }));

import { evmRead } from '../libs/evm';
import { catFile } from '../libs/ipfs.factory';
import {
  isMissingRecordError,
  resolveTemplateHelpersCid,
  injectPublicationHelpers,
} from './main';
import {
  evaluateHelpersSource,
  validateHelpersSource,
  mergePublicationHelpers,
  TEMPLATE_HELPERS_RECORD_KEY,
  TEMPLATE_HELPERS_CONFIG_FIELD,
  TEMPLATE_HELPERS_SOURCE_SIZE_CAP,
} from '../renderer/helpers';
import {
  snapshotHelperMap,
  resetHelperMap,
  getBuiltinHelperNames,
} from '../renderer/handlebars.factory';
import { renderHTMLFromSource } from '../renderer/html.ctrlr';

const GW = 'https://gw.test';
const MODULE = '0xConfigModule';
const HELPER_CID = 'bafyHELPERSCID';

// ── Shared-module behavior ───────────────────────────────────────────────────

describe('evaluateHelpersSource (shared)', () => {
  it('evaluates a bare pure-expression helper module (no runner main() contract)', () => {
    const mod = evaluateHelpersSource(
      '({ shout: (s) => String(s).toUpperCase(), double: (n) => n * 2 })',
    );
    expect(typeof mod.shout).toBe('function');
    expect(mod.shout('hi')).toBe('HI');
    expect(mod.double(21)).toBe(42);
  });
});

describe('validateHelpersSource', () => {
  it('accepts a plain object of functions', () => {
    const mod = validateHelpersSource('({ a: () => 1, b: (x) => x })');
    expect(typeof mod.a).toBe('function');
    expect(typeof mod.b).toBe('function');
  });

  it('rejects an empty source', () => {
    expect(() => validateHelpersSource('')).toThrow(/empty/);
  });

  it('rejects a non-object primitive', () => {
    expect(() => validateHelpersSource('42')).toThrow(/plain object/);
    expect(() => validateHelpersSource('null')).toThrow(/plain object/);
  });

  it('rejects an array', () => {
    expect(() => validateHelpersSource('[1,2,3]')).toThrow(/plain object/);
  });

  it('rejects a non-function entry', () => {
    expect(() => validateHelpersSource('({ foo: 42 })')).toThrow(/must be a function/);
  });

  it('rejects a source that exceeds the size cap', () => {
    const big = `({ f: () => '${'x'.repeat(TEMPLATE_HELPERS_SOURCE_SIZE_CAP + 1)}' })`;
    expect(() => validateHelpersSource(big)).toThrow(/size cap/);
  });
});

describe('mergePublicationHelpers (collision policy: built-ins win)', () => {
  let baseline: Map<string, Function>;
  beforeEach(() => {
    baseline = snapshotHelperMap();
  });
  afterEach(() => {
    resetHelperMap(baseline);
  });

  it('merges new (non-colliding) helpers and reports {merged, skipped}', () => {
    const { merged, skipped } = mergePublicationHelpers({ shout: (s: string) => s.toUpperCase() });
    expect(merged).toBe(1);
    expect(skipped).toEqual([]);
    // the merged helper is visible to the production render core
    const html = renderHTMLFromSource(
      '<!DOCTYPE html><html><body><h1>{{shout title}}</h1></body></html>',
      {},
      { title: 'hi', collections: {} },
    );
    expect(html).toContain('<h1>HI</h1>');
  });

  it('skips a publication helper that collides with a built-in (built-in wins)', () => {
    const { merged, skipped } = mergePublicationHelpers({ lowercase: () => 'SHADOWED' });
    expect(skipped).toContain('lowercase');
    expect(merged).toBe(0);
    // the built-in still resolves, not the shadow attempt
    const html = renderHTMLFromSource(
      '<!DOCTYPE html><html><body><p>{{lowercase title}}</p></body></html>',
      {},
      { title: 'ABC', collections: {} },
    );
    expect(html).toContain('<p>abc</p>');
    expect(html).not.toContain('SHADOWED');
  });
});

// ── Per-render isolation (the biggest correctness change) ────────────────────
//
// The isolation property is asserted at the STATE seam — the helper-map
// round-trip via snapshotHelperMap / resetHelperMap / mergePublicationHelpers —
// NOT through rendered HTML. (A bare no-arg mustache like {{helperA}} is a
// variable lookup in this renderer — processHelpers requires >= 1 arg — so it
// cannot observe helper registration through the output string.) These tests
// exercise the exported primitives directly.

describe('per-render helper isolation', () => {
  let baseline: Map<string, Function>;
  beforeEach(() => {
    baseline = snapshotHelperMap();
  });
  afterEach(() => {
    resetHelperMap(baseline);
  });

  it('mergePublicationHelpers merges non-colliding helpers and reports the built-in-win policy', () => {
    const shadow = () => 'SHADOWED';
    const baselineUniqueYears = snapshotHelperMap().get('unique_years');
    const { merged, skipped } = mergePublicationHelpers({
      pubOnly: () => 'P', // no built-in collision → merged
      unique_years: shadow, // collides with a built-in → skipped
    });
    expect(merged).toBe(1);
    expect(skipped).toEqual(['unique_years']);

    // the merged helper is present
    const map = snapshotHelperMap();
    expect(map.has('pubOnly')).toBe(true);
    // the colliding shadow was NOT merged — the built-in keeps its slot
    expect(map.get('unique_years')).toBe(baselineUniqueYears);
    expect(map.get('unique_years')).not.toBe(shadow);
  });

  it('resetHelperMap(baseline) removes a merged-only helper (no process-wide leak)', () => {
    mergePublicationHelpers({ pubOnly: () => 'P' });
    expect(snapshotHelperMap().has('pubOnly')).toBe(true);

    // restore to the pristine pre-merge baseline → the merged-only helper is gone
    resetHelperMap(baseline);
    expect(snapshotHelperMap().has('pubOnly')).toBe(false);
  });

  it('resetHelperMap(baseline) restores the map to exactly the pre-merge state (every built-in survives)', () => {
    mergePublicationHelpers({ pubOnly: () => 'P' });
    expect(snapshotHelperMap().size).toBe(baseline.size + 1);

    resetHelperMap(baseline);
    const restored = snapshotHelperMap();
    // every built-in survives
    for (const name of getBuiltinHelperNames()) {
      expect(restored.has(name)).toBe(true);
    }
    // and the map is identical to the pre-merge baseline
    expect(restored.size).toBe(baseline.size);
    for (const [name, fn] of baseline) {
      expect(restored.get(name)).toBe(fn);
    }
  });
});

// ── Production: missing-key graceful degrade + CID resolution ───────────────

describe('resolveTemplateHelpersCid (configModule getRecord)', () => {
  beforeEach(() => {
    vi.mocked(evmRead).mockReset();
  });

  it('degrades gracefully (returns null) when the record is missing (KeyNotFound)', async () => {
    vi.mocked(evmRead).mockRejectedValue(new Error('execution reverted: KeyNotFound'));
    expect(await resolveTemplateHelpersCid({}, MODULE, ['rpc'])).toBeNull();
    expect(evmRead).toHaveBeenCalledWith(
      'L2',
      MODULE,
      expect.anything(),
      'getRecord',
      [TEMPLATE_HELPERS_RECORD_KEY],
      ['rpc'],
    );
  });

  it('degrades gracefully (returns null) when the record is missing (EmptyKey)', async () => {
    vi.mocked(evmRead).mockRejectedValue(new Error('execution reverted: EmptyKey'));
    expect(await resolveTemplateHelpersCid({}, MODULE, ['rpc'])).toBeNull();
  });

  it('returns the CID when the record is present', async () => {
    vi.mocked(evmRead).mockResolvedValue(HELPER_CID);
    expect(await resolveTemplateHelpersCid({}, MODULE, ['rpc'])).toBe(HELPER_CID);
  });

  it('prefers config.helpersCid when present and does NOT hit the chain', async () => {
    const cid = await resolveTemplateHelpersCid(
      { [TEMPLATE_HELPERS_CONFIG_FIELD]: HELPER_CID },
      MODULE,
      ['rpc'],
    );
    expect(cid).toBe(HELPER_CID);
    expect(evmRead).not.toHaveBeenCalled();
  });

  it('surfaces a NON-missing read failure loudly (throws, does not degrade)', async () => {
    vi.mocked(evmRead).mockRejectedValue(new Error('RPC timeout'));
    await expect(resolveTemplateHelpersCid({}, MODULE, ['rpc'])).rejects.toThrow('RPC timeout');
  });
});

describe('isMissingRecordError', () => {
  it('matches KeyNotFound / EmptyKey messages', () => {
    expect(isMissingRecordError(new Error('execution reverted: KeyNotFound'))).toBe(true);
    expect(isMissingRecordError(new Error('execution reverted: EmptyKey'))).toBe(true);
    expect(isMissingRecordError('execution reverted: KeyNotFound()')).toBe(true);
  });
  it('rejects other errors', () => {
    expect(isMissingRecordError(new Error('RPC timeout'))).toBe(false);
    expect(isMissingRecordError('boom')).toBe(false);
  });
});

// ── Production: injectPublicationHelpers end-to-end ─────────────────────────

describe('injectPublicationHelpers (production step)', () => {
  let baseline: Map<string, Function>;
  beforeEach(() => {
    baseline = snapshotHelperMap();
    vi.mocked(evmRead).mockReset();
    vi.mocked(catFile).mockReset();
  });
  afterEach(() => {
    resetHelperMap(baseline);
  });

  it('no helper record → returns null (graceful), trace marks not-injected', async () => {
    vi.mocked(evmRead).mockRejectedValue(new Error('execution reverted: KeyNotFound'));
    const trace: any[] = [];
    const err = await injectPublicationHelpers({}, MODULE, ['rpc'], GW, trace);
    expect(err).toBeNull();
    expect(trace).toContainEqual({ action: 'helpers', injected: false, reason: 'no helper record' });
  });

  it('merges a fetched helper module into a production render', async () => {
    vi.mocked(evmRead).mockResolvedValue(HELPER_CID);
    vi.mocked(catFile).mockResolvedValue('({ shout: (s) => String(s).toUpperCase() })');
    const trace: any[] = [];
    const err = await injectPublicationHelpers({}, MODULE, ['rpc'], GW, trace);
    expect(err).toBeNull();
    expect(trace).toContainEqual(
      expect.objectContaining({ action: 'helpers', injected: true, cid: HELPER_CID, merged: 1 }),
    );
    // the merged helper is live in the production render core for this render
    const html = renderHTMLFromSource(
      '<!DOCTYPE html><html><body><h1>{{shout title}}</h1></body></html>',
      {},
      { title: 'hi', collections: {} },
    );
    expect(html).toContain('<h1>HI</h1>');
  });

  it('a broken helper fails loudly (returns an error string, never silent "")', async () => {
    vi.mocked(evmRead).mockResolvedValue(HELPER_CID);
    vi.mocked(catFile).mockResolvedValue('({ notAFunction: 42 })');
    const trace: any[] = [];
    const err = await injectPublicationHelpers({}, MODULE, ['rpc'], GW, trace);
    expect(err).toBeTruthy();
    expect(String(err)).toMatch(/must be a function/);
    expect(trace).toEqual([]); // never recorded as injected
  });

  it('audit-logs the CID that ran', async () => {
    vi.mocked(evmRead).mockResolvedValue(HELPER_CID);
    vi.mocked(catFile).mockResolvedValue('({ pubHelper: () => 1 })');
    const trace: any[] = [];
    await injectPublicationHelpers({}, MODULE, ['rpc'], GW, trace);
    const helperEvent = trace.find((t) => t.action === 'helpers');
    expect(helperEvent.cid).toBe(HELPER_CID);
    expect(helperEvent.injected).toBe(true);
  });
});
