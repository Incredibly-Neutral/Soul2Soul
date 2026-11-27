// ============================================================================
// `s2s author init` — the one-line headline, for every state it can reach.
//
// The command's own run needs a `CliContext`, a chain and a contracts install;
// the headline is the part that states which of the four things happened, and
// it is pure. The arm for a given Safe that is not deployed is absent on
// purpose: `initAuthorSafe` refuses that state before any output.
// ============================================================================

import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';

import type { AuthorSafeInitResult } from '../src/core/author-safe';
import { initContractsLines, initHeadline, type ContractsReport } from '../src/commands/init';

const ADDRESS: Address = '0x1111111111111111111111111111111111111111';
const EOA: Address = '0x2222222222222222222222222222222222222222';

function result(overrides: Partial<AuthorSafeInitResult>): AuthorSafeInitResult {
  return {
    address: ADDRESS,
    eoa: EOA,
    salt: 's2s_0x2222222222222222222222222222222222222222',
    safeSource: 'derived',
    chain: 'base',
    deployed: true,
    txHash: undefined,
    ...overrides,
  };
}

function report(overrides: Partial<ContractsReport> = {}): ContractsReport {
  return {
    factory: '0xf1',
    drafts: '0xd1',
    ownerHistory: '0xd2',
    guard: '0xd3',
    records: null,
    handle: null,
    state: 'installed',
    txs: [],
    ...overrides,
  };
}

describe('initContractsLines', () => {
  it('reports the records module next to the other modules', () => {
    const lines = initContractsLines(report({ records: '0xd4' }));
    expect(lines).toContain('records     : 0xd4');
  });

  it('prints the records note when there is one', () => {
    const lines = initContractsLines(
      report({ recordsNote: 'the module factory has no approved records implementation' }),
    );
    expect(lines).toContain('records     : (none)');
    expect(lines).toContain(
      'records note: the module factory has no approved records implementation',
    );
  });
});

describe('initHeadline', () => {
  it('reports a derived Safe this run deployed', () => {
    expect(initHeadline(result({ deployed: true, txHash: '0xabc' }))).toBe(
      `author Safe deployed at ${ADDRESS}`,
    );
  });

  it('reports a deployment that is not confirmed yet', () => {
    expect(initHeadline(result({ deployed: false, txHash: '0xabc' }))).toBe(
      `deployment submitted for ${ADDRESS} — not confirmed yet`,
    );
  });

  it('reports a derived Safe that was already live', () => {
    expect(initHeadline(result({ deployed: true, txHash: undefined }))).toBe(
      `author Safe already deployed at ${ADDRESS}`,
    );
  });

  it('names a given Safe as given, from safeSource and not from the salt', () => {
    expect(initHeadline(result({ safeSource: 'given', salt: null, deployed: true }))).toBe(
      `author Safe ${ADDRESS} (given) is deployed`,
    );
  });
});
