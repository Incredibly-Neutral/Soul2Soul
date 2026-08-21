import { describe, it, expect } from 'vitest';
import {
  validatePrepInput,
  validatePrepOutput,
  validateSingleInput,
  validateSingleOutput,
  validateEvmUpdateInput,
  validateEvmUpdateOutput,
} from './action-io';

// ============================================================================
// requireFields — tested inline to avoid cross-package module resolution issues
// with nodenext. Mirrors protocol/actions/src/libs/helpers.ts exactly.
// ============================================================================
function requireFields<T extends object>(obj: T, fields: (keyof T)[]): void {
  const missing = fields.filter((f) => obj[f] === undefined || obj[f] === null || obj[f] === '');
  if (missing.length) throw `missing required field(s): ${missing.join(', ')}`;
}

import { validPrepInput, validSingleInput, validEvmUpdateInput } from './fixtures/inputs';
import {
  validPrepOutput,
  validSingleOutput,
  validEvmUpdateOutput,
  failedPrepOutput,
  failedSingleOutput,
  failedEvmUpdateOutput,
  makeMalformedPrepOutput,
  makeMalformedSingleOutput,
  makeMalformedEvmUpdateOutput,
} from './fixtures/outputs';
import {
  prepMissingPublication,
  prepNonArrayContentIds,
  prepEmptyContentIds,
  prepMissingConfigCid,
  singleMissingSignature,
  singleWrongTypeJob,
  singleMissingAuthorSafe,
  singleMissingConfigCid,
  evmMissingSignature,
  evmNonArrayJobs,
  evmEmptyJobs,
  evmEmptyJobsWithRemove,
  evmMissingPreview,
} from './fixtures/broken-inputs';

// ============================================================================
// Helpers
// ============================================================================

/** Assert that calling fn() throws with a message containing the field name. */
function assertFieldNamed(fn: () => unknown, field: string): void {
  expect(fn).toThrow(field);
}

// ============================================================================
// requireFields (pure, no network)
// ============================================================================

describe('requireFields', () => {
  it('throws listing missing fields', () => {
    const obj = { a: 1, b: undefined };
    expect(() => requireFields(obj, ['a', 'b'])).toThrow('b');
  });

  it('passes 0', () => {
    expect(() => requireFields({ a: 0 }, ['a'])).not.toThrow();
  });

  it('passes false', () => {
    expect(() => requireFields({ a: false }, ['a'])).not.toThrow();
  });

  it('passes empty array', () => {
    expect(() => requireFields({ a: [] }, ['a'])).not.toThrow();
  });

  it('throws on undefined', () => {
    expect(() => requireFields({ a: undefined }, ['a'])).toThrow('a');
  });

  it('throws on null', () => {
    expect(() => requireFields({ a: null }, ['a'])).toThrow('a');
  });

  it('throws on empty string', () => {
    expect(() => requireFields({ a: '' }, ['a'])).toThrow('a');
  });

  it('throws a string, not an Error (Lit convention)', () => {
    try {
      requireFields({ a: undefined }, ['a']);
      expect.unreachable('should have thrown');
    } catch (e) {
      // requireFields throws a bare string, not a thrown Error
      expect(typeof e).toBe('string');
    }
  });
});

// ============================================================================
// Prep Action
// ============================================================================

describe('validatePrepInput', () => {
  it('parses a valid prep input', () => {
    const result = validatePrepInput(validPrepInput);
    expect(result.publication).toBe('alice.soul2soul.eth');
    expect(result.contentIds).toEqual(['lens-post-1']);
  });

  it('rejects missing publication', () => {
    assertFieldNamed(() => validatePrepInput(prepMissingPublication()), 'publication');
  });

  it('rejects contentIds as wrong type', () => {
    assertFieldNamed(() => validatePrepInput(prepNonArrayContentIds()), 'contentIds');
  });

  it('rejects empty contentIds array', () => {
    assertFieldNamed(() => validatePrepInput(prepEmptyContentIds()), 'contentIds');
  });

  it('accepts missing configCid (optional)', () => {
    const result = validatePrepInput(prepMissingConfigCid());
    expect(result.contentIds).toEqual(['lens-post-1']);
  });
});

describe('validatePrepOutput', () => {
  it('parses a valid ok:true prep output', () => {
    const result: any = validatePrepOutput(validPrepOutput);
    expect(result.ok).toBe(true);
    expect(result.data.jobs).toHaveLength(1);
  });

  it('parses an ok:false envelope', () => {
    const result: any = validatePrepOutput(failedPrepOutput);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('no modules found');
  });

  it('includes trace on both branches', () => {
    const ok = validatePrepOutput(validPrepOutput);
    expect(ok.trace).toEqual([]);

    const fail = validatePrepOutput(failedPrepOutput);
    expect(fail.trace).toHaveLength(1);
  });

  it('rejects malformed data (missing jobs[0].id)', () => {
    assertFieldNamed(() => validatePrepOutput(makeMalformedPrepOutput()), 'id');
  });
});

// ============================================================================
// Single Action
// ============================================================================

describe('validateSingleInput', () => {
  it('parses a valid single input', () => {
    const result = validateSingleInput(validSingleInput);
    expect(result.job.id).toBe(
      '0x9a1600a648241726b0470d0b0b85df1d166e0aa74b88789b5f569294baa5a063',
    );
    expect(result.signature).toBeTruthy();
  });

  it('rejects missing signature', () => {
    assertFieldNamed(() => validateSingleInput(singleMissingSignature()), 'signature');
  });

  it('rejects job as wrong type', () => {
    assertFieldNamed(() => validateSingleInput(singleWrongTypeJob()), 'job');
  });

  it('rejects missing authorSafeAddress', () => {
    assertFieldNamed(() => validateSingleInput(singleMissingAuthorSafe()), 'authorSafeAddress');
  });

  it('accepts missing configCid (optional)', () => {
    const result = validateSingleInput(singleMissingConfigCid());
    expect(result.job.id).toBe(
      '0x9a1600a648241726b0470d0b0b85df1d166e0aa74b88789b5f569294baa5a063',
    );
  });

  it('accepts triggeredContentIds (optional) — scopes the hasDeal revoke check to the triggered content', () => {
    const triggered = ['0x9a1600a648241726b0470d0b0b85df1d166e0aa74b88789b5f569294baa5a063'];
    const result = validateSingleInput({ ...validSingleInput, triggeredContentIds: triggered });
    expect(result.triggeredContentIds).toEqual(triggered);
  });

  it('omits triggeredContentIds when absent (optional)', () => {
    const result = validateSingleInput(validSingleInput);
    expect(result.triggeredContentIds).toBeUndefined();
  });
});

describe('validateSingleOutput', () => {
  it('parses a valid ok:true single output', () => {
    const result: any = validateSingleOutput(validSingleOutput);
    expect(result.ok).toBe(true);
    expect(result.data.job.html).toBe('QmRenderedHtml');
  });

  it('parses an ok:false envelope', () => {
    const result: any = validateSingleOutput(failedSingleOutput);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('signer not authorised');
  });

  it('includes trace on both branches', () => {
    const ok = validateSingleOutput(validSingleOutput);
    expect(Array.isArray(ok.trace)).toBe(true);

    const fail = validateSingleOutput(failedSingleOutput);
    expect(fail.trace).toHaveLength(1);
  });

  it('rejects malformed data (missing data.job.html on S2SJob)', () => {
    assertFieldNamed(() => validateSingleOutput(makeMalformedSingleOutput()), 'html');
  });
});

// ============================================================================
// EvmUpdate Action
// ============================================================================

describe('validateEvmUpdateInput', () => {
  it('parses a valid evm-update input', () => {
    const result = validateEvmUpdateInput(validEvmUpdateInput);
    expect(result.publication).toBe('alice.soul2soul.eth');
    expect(result.jobs).toHaveLength(1);
  });

  it('rejects missing signature', () => {
    assertFieldNamed(() => validateEvmUpdateInput(evmMissingSignature()), 'signature');
  });

  it('rejects jobs as wrong type', () => {
    assertFieldNamed(() => validateEvmUpdateInput(evmNonArrayJobs()), 'jobs');
  });

  it('rejects empty jobs array WITHOUT remove entries', () => {
    assertFieldNamed(() => validateEvmUpdateInput(evmEmptyJobs()), 'jobs');
  });

  it('accepts empty jobs array when remove entries are present (revoke path)', () => {
    const result = validateEvmUpdateInput(evmEmptyJobsWithRemove());
    expect(result.jobs).toHaveLength(0);
    expect(result.remove).toHaveLength(1);
  });

  it('accepts empty jobs array when reset is true (reset-only path)', () => {
    const result = validateEvmUpdateInput({ ...validEvmUpdateInput, jobs: [], reset: true });
    expect(result.jobs).toHaveLength(0);
    expect(result.reset).toBe(true);
  });

  it('threads reset through when present (optional)', () => {
    const result = validateEvmUpdateInput({ ...validEvmUpdateInput, reset: true });
    expect(result.reset).toBe(true);
  });

  it('omits reset when absent (optional)', () => {
    const result = validateEvmUpdateInput(validEvmUpdateInput);
    expect(result.reset).toBeUndefined();
  });

  it('accepts missing preview (optional)', () => {
    const result = validateEvmUpdateInput(evmMissingPreview());
    expect(result.jobs).toHaveLength(1);
  });
});

describe('validateEvmUpdateOutput', () => {
  it('parses a valid ok:true evm-update output', () => {
    const result: any = validateEvmUpdateOutput(validEvmUpdateOutput);
    expect(result.ok).toBe(true);
    expect(result.data.cid).toBe('QmNewSiteRoot');
  });

  it('parses an ok:false envelope', () => {
    const result: any = validateEvmUpdateOutput(failedEvmUpdateOutput);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('canPublish returned false');
  });

  it('includes trace on both branches', () => {
    const ok = validateEvmUpdateOutput(validEvmUpdateOutput);
    expect(Array.isArray(ok.trace)).toBe(true);

    const fail = validateEvmUpdateOutput(failedEvmUpdateOutput);
    expect(fail.trace).toHaveLength(1);
  });

  it('rejects malformed data (missing data.cid)', () => {
    assertFieldNamed(() => validateEvmUpdateOutput(makeMalformedEvmUpdateOutput()), 'cid');
  });
});
