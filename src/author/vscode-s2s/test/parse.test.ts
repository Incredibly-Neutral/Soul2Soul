import { describe, expect, it } from 'vitest';

import { MAX_STDOUT_BYTES, parseResult } from '../src/parse';
import {
  contaminatedStdout,
  emptyResult,
  failureEnvelope,
  offerResult,
  publishResult,
  uploadResult,
} from './fixtures';

describe('parseResult — the clean path', () => {
  it('parses a clean document', () => {
    const outcome = parseResult(JSON.stringify(uploadResult));
    expect(outcome.kind).toBe('result');
    if (outcome.kind !== 'result') return;
    expect(outcome.result['action']).toBe('upload');
    expect(outcome.contaminated).toBe(false);
  });

  it('tolerates surrounding whitespace and a trailing newline', () => {
    const outcome = parseResult(`\n  ${JSON.stringify(offerResult)}  \n`);
    expect(outcome.kind).toBe('result');
    if (outcome.kind !== 'result') return;
    expect(outcome.contaminated).toBe(false);
  });

  it('accepts the failure envelope as a document', () => {
    const outcome = parseResult(JSON.stringify(failureEnvelope));
    expect(outcome.kind).toBe('result');
    if (outcome.kind !== 'result') return;
    expect(outcome.result['ok']).toBe(false);
    expect(outcome.contaminated).toBe(false);
  });

  it('accepts a degenerate {} — a clean document is trusted as-is', () => {
    const outcome = parseResult(JSON.stringify(emptyResult));
    expect(outcome.kind).toBe('result');
    if (outcome.kind !== 'result') return;
    expect(outcome.result).toEqual({});
  });
});

describe('parseResult — the locate path', () => {
  it('recovers the result when progress leaked onto stdout', () => {
    const outcome = parseResult(contaminatedStdout);
    expect(outcome.kind).toBe('result');
    if (outcome.kind !== 'result') return;
    expect(outcome.contaminated).toBe(true);
    expect(outcome.result['cid']).toBe(uploadResult.cid);
  });

  it('recovers the result when junk follows the document', () => {
    const outcome = parseResult(`${JSON.stringify(publishResult)}\n✓ done\n`);
    expect(outcome.kind).toBe('result');
    if (outcome.kind !== 'result') return;
    expect(outcome.contaminated).toBe(true);
    expect(outcome.result['action']).toBe('publish');
  });

  it('ignores brace-bearing noise in front of the document', () => {
    const outcome = parseResult(`warning: {not json} here\n${JSON.stringify(offerResult)}`);
    expect(outcome.kind).toBe('result');
    if (outcome.kind !== 'result') return;
    expect(outcome.result['action']).toBe('offer');
  });

  it('handles braces inside strings in the document', () => {
    const tricky = { ...offerResult, noteComment: 'a } b { c' };
    const outcome = parseResult(`progress\n${JSON.stringify(tricky)}`);
    expect(outcome.kind).toBe('result');
    if (outcome.kind !== 'result') return;
    expect(outcome.result['noteComment']).toBe('a } b { c');
  });
});

describe('parseResult — failures', () => {
  it('names an empty stdout rather than guessing', () => {
    const outcome = parseResult('   \n ');
    expect(outcome.kind).toBe('failure');
    if (outcome.kind !== 'failure') return;
    expect(outcome.message).toContain('nothing on stdout');
  });

  it('refuses truncated JSON', () => {
    const outcome = parseResult('{"action":"upload","note":"/a.md"');
    expect(outcome.kind).toBe('failure');
  });

  it('refuses plain human text', () => {
    const outcome = parseResult('uploaded manuscript.md\ncid bafy...\n');
    expect(outcome.kind).toBe('failure');
    if (outcome.kind !== 'failure') return;
    expect(outcome.message).toMatch(/is a JSON result/);
  });

  it('refuses a JSON array — results are objects', () => {
    const outcome = parseResult('["not", "a", "result"]');
    expect(outcome.kind).toBe('failure');
  });

  it('never dumps stdout back at the user', () => {
    const outcome = parseResult('secret-ish output that must not be echoed\n');
    expect(outcome.kind).toBe('failure');
    if (outcome.kind !== 'failure') return;
    expect(outcome.message).not.toContain('secret-ish');
  });

  it('refuses a runaway stdout before parsing it', () => {
    const huge = 'x'.repeat(MAX_STDOUT_BYTES + 1);
    const outcome = parseResult(huge);
    expect(outcome.kind).toBe('failure');
    if (outcome.kind !== 'failure') return;
    expect(outcome.message).toContain('far more than a result');
  });
});
