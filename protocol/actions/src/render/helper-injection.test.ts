import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the chain/gateway boundary BEFORE importing main.ts so the module graph
// picks up the mocks. `injectPublicationHelpers` / `resolveTemplateHelpersCid`
// are exported from render/main.ts for exactly this unit coverage. The evm
// mock is kept solely to ASSERT the helper path performs zero RPCs now that
// config.helpersCid is the sole resolution source.
vi.mock('../libs/evm', () => ({ evmRead: vi.fn() }));
vi.mock('../libs/ipfs.factory', () => ({ catFile: vi.fn(), uploadFile: vi.fn() }));

import { evmRead } from '../libs/evm';
import { catFile } from '../libs/ipfs.factory';
import {
  resolveTemplateHelpersCid,
  injectPublicationHelpers,
} from './main';
import {
  evaluateHelpersSource,
  validateHelpersSource,
  mergePublicationHelpers,
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

// ── Production: config.helpersCid is the SOLE resolution source ─────────────

describe('resolveTemplateHelpersCid (config.helpersCid is the sole source)', () => {
  beforeEach(() => {
    vi.mocked(evmRead).mockReset();
  });

  it('returns config.helpersCid when present and does NOT hit the chain', async () => {
    const cid = await resolveTemplateHelpersCid({
      [TEMPLATE_HELPERS_CONFIG_FIELD]: HELPER_CID,
    });
    expect(cid).toBe(HELPER_CID);
    expect(evmRead).not.toHaveBeenCalled();
  });

  it('returns null when the config carries no helpersCid (graceful no-op)', async () => {
    expect(await resolveTemplateHelpersCid({})).toBeNull();
    expect(evmRead).not.toHaveBeenCalled();
  });

  it('returns null for an empty/non-string helpersCid (graceful no-op)', async () => {
    expect(await resolveTemplateHelpersCid({ [TEMPLATE_HELPERS_CONFIG_FIELD]: '' })).toBeNull();
    expect(await resolveTemplateHelpersCid({ [TEMPLATE_HELPERS_CONFIG_FIELD]: 42 })).toBeNull();
    expect(evmRead).not.toHaveBeenCalled();
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

  it('no helpersCid in config → returns null (graceful no-op), no RPC, no fetch', async () => {
    const trace: any[] = [];
    const err = await injectPublicationHelpers({}, GW, trace);
    expect(err).toBeNull();
    expect(catFile).not.toHaveBeenCalled();
    expect(evmRead).not.toHaveBeenCalled();
    expect(trace).toContainEqual({ action: 'helpers', injected: false, reason: 'no helper in config' });
  });

  it('merges a fetched helper module into a production render', async () => {
    vi.mocked(catFile).mockResolvedValue('({ shout: (s) => String(s).toUpperCase() })');
    const trace: any[] = [];
    const err = await injectPublicationHelpers(
      { [TEMPLATE_HELPERS_CONFIG_FIELD]: HELPER_CID },
      GW,
      trace,
    );
    expect(err).toBeNull();
    expect(catFile).toHaveBeenCalledWith(GW, HELPER_CID);
    expect(evmRead).not.toHaveBeenCalled();
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
    vi.mocked(catFile).mockResolvedValue('({ notAFunction: 42 })');
    const trace: any[] = [];
    const err = await injectPublicationHelpers(
      { [TEMPLATE_HELPERS_CONFIG_FIELD]: HELPER_CID },
      GW,
      trace,
    );
    expect(err).toBeTruthy();
    expect(String(err)).toMatch(/must be a function/);
    expect(trace).toEqual([]); // never recorded as injected
  });

  it('audit-logs the CID that ran', async () => {
    vi.mocked(catFile).mockResolvedValue('({ pubHelper: () => 1 })');
    const trace: any[] = [];
    await injectPublicationHelpers({ [TEMPLATE_HELPERS_CONFIG_FIELD]: HELPER_CID }, GW, trace);
    const helperEvent = trace.find((t) => t.action === 'helpers');
    expect(helperEvent.cid).toBe(HELPER_CID);
    expect(helperEvent.injected).toBe(true);
    expect(evmRead).not.toHaveBeenCalled();
  });
});
