import { describe, expect, it } from 'vitest';

import { basename, detailRows, formatDuration, formatFailure, formatResult } from '../src/format';
import {
  NOTE,
  authorAddressResult,
  configPathResult,
  emptyResult,
  failureEnvelope,
  futureResult,
  newPublicationResult,
  offerResult,
  previewResult,
  publishResult,
  revokeResult,
  uploadResult,
} from './fixtures';

describe('basename / duration', () => {
  it('takes the last path segment', () => {
    expect(basename(NOTE)).toBe('manuscript.md');
    expect(basename('/a')).toBe('a');
  });

  it('formats sub-second and second durations', () => {
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(420)).toBe(' · 420ms');
    expect(formatDuration(12_340)).toBe(' · 12.3s');
  });
});

describe('formatResult — one per action', () => {
  it('upload: verb + basename, cid, copyable, nothing to open', () => {
    const summary = formatResult(uploadResult, { durationMs: 1500 });
    expect(summary.action).toBe('upload');
    expect(summary.title).toBe('uploaded manuscript.md · 1.5s');
    expect(summary.lines.join('\n')).toContain(uploadResult.kuboCid);
    expect(summary.copy).toBe(uploadResult.kuboCid);
    expect(summary.url).toBeUndefined();
  });

  it('offer: cid and offer tx, nothing to open', () => {
    const summary = formatResult(offerResult);
    expect(summary.title).toBe('offered manuscript.md');
    expect(summary.lines.join('\n')).toContain(offerResult.txHash);
    expect(summary.url).toBeUndefined();
    expect(summary.copy).toBeUndefined();
  });

  it('preview: opens the preview url', () => {
    const summary = formatResult(previewResult);
    expect(summary.url).toBe(previewResult.render.previewUrl);
    expect(summary.lines.join('\n')).toContain(previewResult.render.previewUrl);
  });

  it('publish: prefers prodUrl', () => {
    const summary = formatResult(publishResult);
    expect(summary.url).toBe(publishResult.render.prodUrl);
  });

  it('publish without a prodUrl falls back to previewUrl', () => {
    const render = {
      cid: publishResult.render.cid,
      path: publishResult.render.path,
      previewUrl: publishResult.render.previewUrl,
    };
    const summary = formatResult({ ...publishResult, render });
    expect(summary.url).toBe(publishResult.render.previewUrl);
  });

  it('revoke: tx only, nothing to open', () => {
    const summary = formatResult(revokeResult);
    expect(summary.title).toBe('revoked manuscript.md');
    expect(summary.lines.join('\n')).toContain(revokeResult.txHash);
    expect(summary.url).toBeUndefined();
  });

  it('publication new: safe + config cid, null configCid omitted', () => {
    const summary = formatResult(newPublicationResult);
    expect(summary.title).toBe('created publication polyphony');
    expect(summary.lines.join('\n')).toContain(newPublicationResult.safeAddress);
    expect(summary.lines.join('\n')).not.toContain('config cid');
  });

  it('author address: safe line', () => {
    const summary = formatResult(authorAddressResult);
    expect(summary.title).toBe('author address');
    expect(summary.lines[0]).toContain(authorAddressResult.address);
  });

  it('config path: no note, shows the path', () => {
    const summary = formatResult({ action: 'config.path', path: configPathResult.path });
    expect(summary.title).toBe('config path');
    expect(summary.lines.join('\n')).toContain(configPathResult.path);
  });

  it('falls back to the raw action for an unknown verb', () => {
    const summary = formatResult({ action: 'future.action', note: '/a/b.md' });
    expect(summary.title).toBe('future.action b.md');
  });

  it('does not invent a subject when the binary named none', () => {
    const summary = formatResult({ action: 'upload' });
    expect(summary.title).toBe('uploaded');
    expect(summary.lines).toEqual([]);
  });
});

describe('formatResult — failure and degenerate shapes', () => {
  it('surfaces the envelope error verbatim as the title', () => {
    const summary = formatResult(failureEnvelope);
    expect(summary.title).toBe(failureEnvelope.error);
    expect(summary.lines).toEqual([]);
  });

  it('names a missing error message rather than printing nothing', () => {
    expect(formatFailure({ ok: false })).toContain('without an error message');
  });

  it('does not throw on {}', () => {
    const summary = formatResult(emptyResult);
    expect(summary.title).toBe('s2s result');
    expect(summary.lines).toEqual([]);
    expect(detailRows(emptyResult)).toEqual([]);
  });

  it('passes unknown scalars through and drops unknown nesting', () => {
    const summary = formatResult(futureResult);
    expect(summary.title).toContain('manuscript.md');

    const rows = detailRows(futureResult);
    expect(rows.join('\n')).toContain('authorContract: 0x5555');
    expect(rows.join('\n')).toContain('durabilityLegs: 3');
    expect(rows.join('\n')).toContain('degraded: false');
    expect(rows.join('\n')).not.toContain('tel');
    expect(rows.join('\n')).not.toContain('spans');
  });
});

describe('detailRows', () => {
  it('orders known fields and flattens render.*', () => {
    const rows = detailRows(publishResult);
    const indexOf = (needle: string): number => rows.findIndex((row) => row.startsWith(needle));

    expect(indexOf('action:')).toBeLessThan(indexOf('objectId:'));
    expect(indexOf('objectId:')).toBeLessThan(indexOf('kuboCid:'));
    expect(indexOf('kuboCid:')).toBeLessThan(indexOf('txHash:'));
    expect(rows).toContain(`render.prodUrl: ${publishResult.render.prodUrl}`);
    expect(rows).toContain(`render.cid: ${publishResult.render.cid}`);
  });

  it('sorts extras alphabetically after the known set', () => {
    const rows = detailRows({ action: 'upload', zeta: 'z', alpha: 'a' });
    expect(rows.indexOf('zeta: z')).toBeGreaterThan(rows.indexOf('alpha: a'));
  });

  it('renders array fields readably and skips empty ones', () => {
    expect(detailRows({ action: 'new', owners: ['0xa', '0xb'] })).toContain('owners: 0xa, 0xb');
    expect(detailRows({ action: 'new', owners: [] })).toEqual(['action: new']);
  });
});
