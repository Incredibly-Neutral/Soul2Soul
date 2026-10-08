/**
 * Sequence test — drives each Lit action stage through the Bun runner,
 * asserting envelope shape at every seam.
 *
 * CIDs are fetched from the chain at test time via getProtocolInfo().
 * Auth signature is generated from TEST_PRIVATE_KEY.
 * Test data (publication, contentIds) must be supplied via TEST_* env vars.
 *
 * Required env vars:
 *   MAINNET_RPC_URL          L1 RPC (used by getProtocolInfo)
 *   BASE_RPC_URL             L2 RPC (used by getProtocolInfo)
 *   TEST_PUBLICATION         ENS name of a test publication
 *   TEST_PRIVATE_KEY         Private key to sign "lit actions auth"
 *
 * Optional:
 *   TEST_RUNNER_URL          Bun runner (default: https://run.transport-union.dev/run)
 *   TEST_AUTHOR_SAFE         Author Safe address (default: placeholder)
 *   TEST_CONFIG_CID          Config CID override
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { createPublicClient, fallback, http } from 'viem';
import { mainnet, base } from 'viem/chains';
import { Wallet } from 'ethers';

import { buildFallbackRpcs } from '../rpc';
import { getProtocolInfo } from '../protocol';
import type { S2SProtocolInfo } from '../protocol';
import type { LitService } from '../lit';
import { runAction } from './helpers';
import { runRenderActionWithRetry, renderwithLitActions } from './sequence';
import {
  validatePrepOutput,
  validateSingleInput,
  validateSingleOutput,
  validateEvmUpdateInput,
  validateEvmUpdateOutput,
} from './action-io';
import { sampleJob, sampleEndpoints } from './fixtures/inputs';

// RunAction spy: delegates to the real implementation by default (so the
// chain/runner integration tests below keep working when env is present), but
// lets the retry unit tests below drive it deterministically.
vi.mock('./helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./helpers')>();
  return {
    ...actual,
    runAction: vi.fn(actual.runAction),
  };
});

// ============================================================================
// Env-based configuration — TEST_* prefix preferred, S2S_* fallback
// ============================================================================

/** Read an env var with fallback to an alternative name. */
function env(name: string, alt?: string): string | undefined {
  return process.env[name] ?? (alt ? process.env[alt] : undefined);
}

const RUNNER_URL =
  env('TEST_RUNNER_URL', 'S2S_RUNNER_URL') || 'https://run.transport-union.dev/run';
const PUBLICATION = env('TEST_PUBLICATION', 'S2S_PUBLICATION');
const AUTHOR_SAFE = env('TEST_AUTHOR_SAFE', 'S2S_AUTHOR_SAFE') || '0x0000...0001';
const CONFIG_CID = env('TEST_CONFIG_CID', 'S2S_CONFIG_CID');
const TEST_PRIVATE_KEY = env('TEST_PRIVATE_KEY');

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL;
const BASE_RPC_URL = process.env.BASE_RPC_URL;

// ============================================================================
// Per-scenario content IDs — each test defines its own.
// You can add additional fixture sets here as the test suite grows.
// ============================================================================

/** Content IDs — from TEST_CONTENT_IDS env var, fall back to real genesis CID. */
const CONTENT_IDS = (
  env('TEST_CONTENT_IDS') || '0x9a1600a648241726b0470d0b0b85df1d166e0aa74b88789b5f569294baa5a063'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Whether the chain-dependent tests (CID fetch + runner) can run. */
const chainReady = !!(MAINNET_RPC_URL && BASE_RPC_URL && PUBLICATION && TEST_PRIVATE_KEY);

// ============================================================================
// Helpers
// ============================================================================

/** Minimal lit mock — never called in preview mode (runAction uses fetch only). */
const mockLit = {} as any;

/** Generate a valid signature by signing "lit actions auth" with TEST_PRIVATE_KEY. */
async function makeSignature(): Promise<string> {
  if (TEST_PRIVATE_KEY) {
    const wallet = new Wallet(TEST_PRIVATE_KEY);
    return wallet.signMessage('lit actions auth');
  }
  return '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
}

async function callAction(cid: string, inputs: Record<string, unknown>): Promise<unknown> {
  return runAction(true, mockLit, cid, inputs);
}

/**
 * Orchestrator-real-shape endpoints (mirrors the `endpoints` object built in
 * sequence.ts renderWithLitActions): the caller-supplied RPC URLs + the
 * protocol gateway. The chain tests hit the LIVE runner, so the rpcs must be
 * the real env RPCs (the `sampleEndpoints` fixture rpcs are placeholder drpc
 * URLs that 403 on real calls).
 *
 * The rpcs come from buildFallbackRpcs() — DRPC → public → Alchemy → Infura —
 * so a single flaky endpoint (e.g. DRPC returning empty `0x`) never fails a
 * live run: evmRead inside the Lit action failsover across the array.
 */
function buildChainEndpoints(ipfsGateway: string): { ipfsGateway: string; rpcs: { L1: string[]; L2: string[] } } {
  return {
    ipfsGateway,
    rpcs: buildFallbackRpcs(),
  };
}

function assertOkShape(result: unknown, action: string): void {
  expect(result).toHaveProperty('ok');
  expect(result).toHaveProperty('action', action);
  expect(result).toHaveProperty('trace');
  expect(Array.isArray((result as any).trace)).toBe(true);
}

// ============================================================================
// Tests that always run (no chain, no runner)
// ============================================================================

describe('sequence — local shape contracts', () => {
  it('a sample job passes validateSingleInput', () => {
    const input = {
      job: sampleJob,
      signature:
        '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
      authorSafeAddress: AUTHOR_SAFE,
      publication: 'test.soul2soul.eth',
      preview: true,
      endpoints: sampleEndpoints,
    };
    expect(() => validateSingleInput(input)).not.toThrow();
  });

  it('validateSingleInput requires signature', () => {
    const input = {
      job: sampleJob,
      authorSafeAddress: AUTHOR_SAFE,
      publication: 'test.soul2soul.eth',
      preview: true,
    };
    expect(() => validateSingleInput(input as any)).toThrow('signature');
  });

  it('validateEvmUpdateOutput rejects missing data.cid', () => {
    const bad = { ok: true, action: 'evm-update', data: {}, trace: [] };
    expect(() => validateEvmUpdateOutput(bad)).toThrow('cid');
  });

  it('validateSingleOutput rejects job without html (html is required)', () => {
    const bad = {
      ok: true,
      action: 'single',
      data: {
        job: { ...sampleJob, html: undefined },
        timestamp: '2026-06-19T12:00:00.000Z',
        trace: [],
      },
      trace: [],
    };
    expect(() => validateSingleOutput(bad as any)).toThrow('html');
  });
});

// ============================================================================
// Tests that fetch CIDs from the chain, then call the Bun runner
// ============================================================================

describe.skipIf(!chainReady)('sequence — full happy path', () => {
  let protocolInfo: S2SProtocolInfo;
  let SIGNATURE: string;
  let prepResult: any;
  let jobs: any[];
  let renderedJobs: any[];

  beforeAll(async () => {
    const rpcs = buildFallbackRpcs();
    const l1 = createPublicClient({
      chain: mainnet as any,
      transport: fallback(rpcs.L1.map((url) => http(url))),
    }) as any;
    const l2 = createPublicClient({
      chain: base as any,
      transport: fallback(rpcs.L2.map((url) => http(url))),
    }) as any;
    protocolInfo = await getProtocolInfo(false, l1, l2);
    SIGNATURE = await makeSignature();
  }, 15_000);

  it('prep returns ok:true with valid jobs', async () => {
    const input: Record<string, unknown> = {
      publication: PUBLICATION,
      contentIds: CONTENT_IDS,
      endpoints: buildChainEndpoints(protocolInfo.gateway),
    };
    if (CONFIG_CID) input.configCid = CONFIG_CID;

    const raw = await callAction(protocolInfo.litActions.prep, input);
    prepResult = validatePrepOutput(raw);

    expect(prepResult.ok).toBe(true);
    expect(prepResult.action).toBe('prep');
    expect(prepResult.data.jobs.length).toBeGreaterThanOrEqual(1);

    for (const job of prepResult.data.jobs) {
      expect(job).toHaveProperty('id');
      expect(job).toHaveProperty('html');
      expect(typeof job.html).toBe('string');
      expect(job).toHaveProperty('templateConfig');
    }

    jobs = prepResult.data.jobs;
  }, 30_000);

  it('single stage renders each job with ok:true', async () => {
    expect(jobs).toBeDefined();
    renderedJobs = [];

    for (const job of jobs) {
      const singleInput: Record<string, unknown> = {
        job,
        signature: SIGNATURE,
        authorSafeAddress: AUTHOR_SAFE,
        publication: PUBLICATION,
        preview: true,
        endpoints: buildChainEndpoints(protocolInfo.gateway),
      };
      if (CONFIG_CID) singleInput.configCid = CONFIG_CID;

      const raw = await callAction(protocolInfo.litActions.render, singleInput);
      const result = validateSingleOutput(raw);

      if (!result.ok) {
        console.error(`[single job ${job.id}] ok:false`);
        console.error(`  error: ${result.error}`);
        console.error(`  trace: ${JSON.stringify(result.trace, null, 2)}`);
      }

      expect(result.ok).toBe(true);
      // Render action success envelope is `action: 'render'` (the `'single'`
      // name is used only on the ok:false error envelope — see render/main.ts).
      expect(result.action).toBe('render');
      const r = result as any;
      expect(r.data.job).toHaveProperty('html');
      expect(r.data.job).toHaveProperty('path');
      expect(r.data.timestamp).toBeTruthy();
      expect(typeof r.data.timestamp).toBe('string');

      renderedJobs.push(r.data.job);
    }

    expect(renderedJobs.length).toBe(jobs.length);
  }, 60_000);

  it('merged returns ok:true with cid', async () => {
    expect(renderedJobs).toBeDefined();
    expect(renderedJobs.length).toBeGreaterThanOrEqual(1);

    const evmInput: Record<string, unknown> = {
      publication: PUBLICATION,
      jobs: renderedJobs,
      signature: SIGNATURE,
      authorSafeAddress: AUTHOR_SAFE,
      preview: true,
      endpoints: buildChainEndpoints(protocolInfo.gateway),
    };

    const raw = await callAction(protocolInfo.litActions.update, evmInput);
    const result = validateEvmUpdateOutput(raw);

    if (!result.ok) {
      console.error(`[merged] ok:false`);
      console.error(`  error: ${result.error}`);
      console.error(`  trace: ${JSON.stringify(result.trace, null, 2)}`);
    }

    expect(result.ok).toBe(true);
    expect(result.action).toBe('evm-update');
    const m = result as any;
    expect(m.data.cid).toBeTruthy();
    expect(typeof m.data.cid).toBe('string');
  }, 30_000);
});

// ============================================================================
// Test 2 — Seam contract: prep output feeds single input
// ============================================================================

describe.skipIf(!chainReady)('sequence — seam contract (prep → single)', () => {
  let protocolInfo: S2SProtocolInfo;
  let SIGNATURE: string;

  beforeAll(async () => {
    const rpcs = buildFallbackRpcs();
    const l1 = createPublicClient({
      chain: mainnet as any,
      transport: fallback(rpcs.L1.map((url) => http(url))),
    }) as any;
    const l2 = createPublicClient({
      chain: base as any,
      transport: fallback(rpcs.L2.map((url) => http(url))),
    }) as any;
    protocolInfo = await getProtocolInfo(false, l1, l2);
    SIGNATURE = await makeSignature();
  }, 15_000);

  it('prep output jobs pass validateSingleInput with orchestrator fields', async () => {
    const input: Record<string, unknown> = {
      publication: PUBLICATION,
      contentIds: CONTENT_IDS,
      endpoints: buildChainEndpoints(protocolInfo.gateway),
    };
    if (CONFIG_CID) input.configCid = CONFIG_CID;

    const raw = await callAction(protocolInfo.litActions.prep, input);
    const prepResult = validatePrepOutput(raw) as any;
    expect(prepResult.ok).toBe(true);

    for (const job of prepResult.data.jobs) {
      const singleInput: Record<string, unknown> = {
        job,
        signature: SIGNATURE,
        authorSafeAddress: AUTHOR_SAFE,
        publication: PUBLICATION,
        preview: true,
        endpoints: buildChainEndpoints(protocolInfo.gateway),
      };
      if (CONFIG_CID) singleInput.configCid = CONFIG_CID;

      expect(() => validateSingleInput(singleInput)).not.toThrow();
    }
  }, 30_000);
});

// ============================================================================
// Test 3 — Non-fatal trace survives (placeholder — requires a fixture that
// induces a non-fatal condition in the action. Not yet authored.)
// ============================================================================

describe.skip('sequence — non-fatal trace', () => {
  it('stage returns ok:true with trace entries for recoverable failures (TODO)');
});

// ============================================================================
// Test 4 — Stage failure returns ok:false envelope, not throw
// ============================================================================

describe.skipIf(!chainReady)('sequence — stage failure envelope', () => {
  let protocolInfo: S2SProtocolInfo;

  beforeAll(async () => {
    const rpcs = buildFallbackRpcs();
    const l1 = createPublicClient({
      chain: mainnet as any,
      transport: fallback(rpcs.L1.map((url) => http(url))),
    }) as any;
    const l2 = createPublicClient({
      chain: base as any,
      transport: fallback(rpcs.L2.map((url) => http(url))),
    }) as any;
    protocolInfo = await getProtocolInfo(false, l1, l2);
  }, 15_000);

  it('a publication that resolves to no modules returns ok:false', async () => {
    const badPublication = 'nonexistent-' + Date.now() + '.soul2soul.eth';
    const input = { publication: badPublication, contentIds: ['lens-post-1'], endpoints: buildChainEndpoints(protocolInfo.gateway) };

    const raw = await callAction(protocolInfo.litActions.prep, input);

    expect(raw).toBeDefined();
    assertOkShape(raw, 'prep');
    expect((raw as any).ok).toBe(false);
    expect((raw as any).error).toBeTruthy();
    expect(typeof (raw as any).error).toBe('string');
  }, 30_000);
});

// ============================================================================
// runRenderActionWithRetry — live-path retry unit tests (no chain, no runner)
//
// These drive the exported wrapper directly, mocking `runAction` (see the
// vi.mock('./helpers') spy at the top of this file). Each case pins the
// single-attempt semantics: success returns immediately, and any non-ok /
// thrown failure surfaces exactly once — retries are DISABLED (2026-10,
// RENDER_RETRY_ATTEMPTS = 1 in sequence.ts) so a live render is never re-fired
// (a retry would re-open a Lit session and re-drain the budget/charge).
// ============================================================================

describe('runRenderActionWithRetry — live-path retry', () => {
  const cid = 'cid-test';
  const okResult = { ok: true, action: 'render', data: { job: { path: '/x' } }, trace: [] };

  beforeEach(() => {
    vi.mocked(runAction).mockReset();
  });

  afterEach(() => {
    vi.mocked(runAction).mockReset();
  });

  afterAll(() => {
    vi.mocked(runAction).mockRestore();
  });

  it('returns immediately on ok (single runAction call, no retry)', async () => {
    vi.mocked(runAction).mockResolvedValue(okResult as any);

    const result = await runRenderActionWithRetry(false, mockLit, cid, { id: 'j1' }, {});

    expect(result).toBe(okResult);
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it('non-ok does NOT retry (single attempt; the failure is thrown)', async () => {
    const fail = { ok: false, action: 'render', error: 'flaky transport', trace: [] };
    vi.mocked(runAction).mockResolvedValueOnce(fail as any);

    let thrown: any;
    try {
      await runRenderActionWithRetry(false, mockLit, cid, { id: 'j1' }, {});
    } catch (e) {
      thrown = e;
    }

    // Retries disabled: one attempt, no re-fire.
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain('flaky transport');
  });

  it('thrown failure does NOT retry (single attempt, re-thrown)', async () => {
    vi.mocked(runAction).mockRejectedValueOnce(new Error('boom'));

    let thrown: any;
    try {
      await runRenderActionWithRetry(false, mockLit, cid, { id: 'j1' }, {});
    } catch (e) {
      thrown = e;
    }

    expect(runAction).toHaveBeenCalledTimes(1);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain('boom');
  });

  it('throws after a single attempt (retries disabled), preserving the real failure detail', async () => {
    const fail = { ok: false, action: 'render', error: 'real failure message', trace: [] };
    vi.mocked(runAction).mockResolvedValue(fail as any);

    let thrown: any;
    try {
      await runRenderActionWithRetry(false, mockLit, cid, { id: 'j1' }, {});
    } catch (e) {
      thrown = e;
    }

    expect(runAction).toHaveBeenCalledTimes(1);
    expect(thrown).toBeInstanceOf(Error);
    // B4 fix: the thrown message carries the unwrapped envelope error, NOT '[object Object]'
    expect(thrown.message).toContain('real failure message');
    expect(thrown.message).not.toContain('[object Object]');
    // B4 fix: the original failure object stays attached for callers/logs
    expect(thrown.failure).toBe(fail);
  });

  it('preview mode: always-failing runAction makes exactly 1 call then throws', async () => {
    vi.mocked(runAction).mockResolvedValue({
      ok: false,
      action: 'render',
      error: 'nope',
      trace: [],
    } as any);

    await expect(runRenderActionWithRetry(true, mockLit, cid, { id: 'j1' }, {})).rejects.toThrow();

    expect(runAction).toHaveBeenCalledTimes(1);
  });

  // --- deterministic session-budget fast-fail (PR-B) ---
  const budgetErr =
    'You may not send more than 50 HTTP requests per session and you have attempted to exceed that limit.';

  it('non-ok result with a session-budget error does NOT retry (1 call) and the throw preserves it', async () => {
    const fail = { ok: false, action: 'render', error: budgetErr, trace: [] };
    vi.mocked(runAction).mockResolvedValue(fail as any);

    let thrown: any;
    try {
      await runRenderActionWithRetry(false, mockLit, cid, { id: 'j1' }, {});
    } catch (e) {
      thrown = e;
    }

    // Deterministic budget error → zero wasted retries, exactly one attempt.
    expect(runAction).toHaveBeenCalledTimes(1);
    // The preserved-failure path still throws the real failure.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain('HTTP requests per session');
    expect(thrown.failure).toBe(fail);
  });

  it('transient non-ok does NOT retry (single attempt, no fast-fail needed)', async () => {
    const fail = {
      ok: false,
      action: 'render',
      error: 'RPC call to https://lb.example failed',
      trace: [],
    };
    vi.mocked(runAction).mockResolvedValue(fail as any);

    try {
      await runRenderActionWithRetry(false, mockLit, cid, { id: 'j1' }, {});
    } catch {
      /* single attempt throws the failure */
    }

    expect(runAction).toHaveBeenCalledTimes(1); // retries disabled (RENDER_RETRY_ATTEMPTS = 1)
  });

  it('thrown budget error (err.message match) also fast-fails with 1 call', async () => {
    vi.mocked(runAction).mockRejectedValueOnce(new Error(budgetErr) as any);

    let thrown: any;
    try {
      await runRenderActionWithRetry(false, mockLit, cid, { id: 'j1' }, {});
    } catch (e) {
      thrown = e;
    }

    expect(runAction).toHaveBeenCalledTimes(1);
    // The original thrown Error is the preserved lastFailure and is re-thrown.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain('HTTP requests per session');
  });

  it('budget message embedded as a Decryption-error suffix still fast-fails (substring match)', async () => {
    const msg = `Decryption error for item abc123: ${budgetErr}`;
    vi.mocked(runAction).mockResolvedValueOnce({
      ok: false,
      action: 'render',
      error: msg,
      trace: [],
    } as any);

    let thrown: any;
    try {
      await runRenderActionWithRetry(false, mockLit, cid, { id: 'j1' }, {});
    } catch (e) {
      thrown = e;
    }

    expect(runAction).toHaveBeenCalledTimes(1);
    expect(thrown.message).toContain('HTTP requests per session');
  });
});

// ============================================================================
// Empty-string swallow regression (?? → || bug fix)
//
// Before the fix, an empty error string ("") would survive through ?? chains
// because "" is non-nullish. The fix converts ?? to || with a final non-empty
// fallback so the user never sees {error:""} or a thrown Error('').
// ============================================================================

describe('runRenderActionWithRetry — empty-string not swallowed', () => {
  const cid = 'cid-test';

  afterEach(() => {
    vi.mocked(runAction).mockReset();
  });

  afterAll(() => {
    vi.mocked(runAction).mockRestore();
  });

  it('a non-ok result with "" error surfaces a non-empty classified message (??→|| fix at error-construction site)', async () => {
    // The render action returns ok:false with error:"" — exactly what the
    // production bug produced before the fix.
    vi.mocked(runAction).mockResolvedValue({
      ok: false,
      action: 'render',
      error: '',
      trace: [],
    } as any);

    let thrown: any;
    try {
      await runRenderActionWithRetry(false, mockLit, cid, { id: 'j1' }, {});
    } catch (e) {
      thrown = e;
    }

    // After 3 attempts (all returning empty ""), the exhaustion path MUST
    // produce a NON-empty error message — never Error('').
    // The "" error falls through the || chain to JSON.stringify(), which
    // produces a human-readable JSON dump of the failure envelope.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBeTruthy();
    expect(thrown.message.length).toBeGreaterThan(0);
    expect(thrown.message).not.toBe('');
    expect(thrown.message).not.toBe('[object Object]'); // B4 regression: never the generic string
  });

  it('a non-ok result with empty error + nullish message fields still gets a fallback', async () => {
    // Edge case: error is "", message is undefined on the failure object.
    vi.mocked(runAction).mockResolvedValue({
      ok: false,
      action: 'render',
      error: '',
      trace: [],
    } as any);

    let thrown: any;
    try {
      await runRenderActionWithRetry(false, mockLit, cid, { id: 'j1' }, {});
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBeTruthy();
    expect(thrown.message).not.toBe('');
  });

  it('a thrown Error with empty message also gets a fallback in the orchestrator return', async () => {
    // Simulate an action throw with empty message — the render action catch
    // block (main.ts:401) now uses || with fallback.
    vi.mocked(runAction).mockRejectedValue(new Error('') as any);

    let thrown: any;
    try {
      await runRenderActionWithRetry(false, mockLit, cid, { id: 'j1' }, {});
    } catch (e) {
      thrown = e;
    }

    // The error construction in the retry loop now detects empty-message
    // Error instances and falls back to JSON.stringify() or the final
    // 'render action failed' sentinel.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBeTruthy();
    expect(thrown.message.length).toBeGreaterThan(0);
    expect(thrown.message).not.toBe('');
    expect(thrown.message).not.toBe('[object Object]');
  });
});

// ============================================================================
// Revoked-job → remove-entry derivation (GAP-10 revoke ripples)
// ============================================================================

describe('renderwithLitActions — validateEvmUpdateInput accepts zero-jobs-with-remove', () => {
  it('accepts empty jobs array when remove entries are present (revoke path)', () => {
    const input = {
      publication: 'test.soul2soul.eth',
      jobs: [],
      signature:
        '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
      authorSafeAddress: '0x0000...0001',
      preview: true,
      remove: [{ path: 'revoked-post-slug' }],
      endpoints: {
        ipfsGateway: 'https://ipfs.transport-union.dev',
        rpcs: { L1: ['https://lb.drpc.live/ethereum/key'], L2: ['https://lb.drpc.live/base/key'] },
      },
    };
    expect(() => validateEvmUpdateInput(input)).not.toThrow();
    const result = validateEvmUpdateInput(input);
    expect(result.jobs).toHaveLength(0);
    expect(result.remove).toHaveLength(1);
  });

  it('still rejects empty jobs when NO remove entries are present', () => {
    const input = {
      publication: 'test.soul2soul.eth',
      jobs: [],
      signature:
        '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
      authorSafeAddress: '0x0000...0001',
      preview: true,
      endpoints: {
        ipfsGateway: 'https://ipfs.transport-union.dev',
        rpcs: { L1: ['https://lb.drpc.live/ethereum/key'], L2: ['https://lb.drpc.live/base/key'] },
      },
    };
    expect(() => validateEvmUpdateInput(input)).toThrow('jobs');
  });

  it('accepts empty jobs when reset is true (reset-only path)', () => {
    const input = {
      publication: 'test.soul2soul.eth',
      jobs: [],
      signature:
        '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
      authorSafeAddress: '0x0000...0001',
      preview: true,
      reset: true,
      endpoints: {
        ipfsGateway: 'https://ipfs.transport-union.dev',
        rpcs: { L1: ['https://lb.drpc.live/ethereum/key'], L2: ['https://lb.drpc.live/base/key'] },
      },
    };
    expect(() => validateEvmUpdateInput(input)).not.toThrow();
    const result = validateEvmUpdateInput(input);
    expect(result.jobs).toHaveLength(0);
    expect(result.reset).toBe(true);
  });
});

// ============================================================================
// Reset-only orchestration (RFC-reset-tree-button.md §2, option A).
//
// When `renderwithLitActions` is called with `reset:true` AND zero contentIds,
// prep + render are SKIPPED (prep rejects empty contentIds) and the update
// action is driven directly with jobs:[] + reset:true so the tree is rebuilt
// fresh. runAction is the vi.mocked spy from the top of this file.
// ============================================================================

describe('renderwithLitActions — reset-only path (zero contentIds, reset:true)', () => {
  const updateCid = 'cid-update';
  const protocolInfo = {
    gateway: 'https://ipfs.transport-union.dev',
    litActions: { prep: 'cid-prep', render: 'cid-render', update: updateCid },
  } as any;

  afterEach(() => {
    vi.mocked(runAction).mockReset();
  });

  afterAll(() => {
    vi.mocked(runAction).mockRestore();
  });

  it('skips prep + render and runs the update action directly with jobs:[] + reset:true', async () => {
    let updateInputs: any;
    vi.mocked(runAction).mockImplementation(
      async (_preview: any, _lit: any, cid: any, inputs: any) => {
        expect(cid).toBe(updateCid); // only the update action may be reached
        updateInputs = inputs;
        return { ok: true, action: 'evm-update', data: { cid: 'QmNewRoot' }, trace: [] };
      },
    );

    const res: any = await renderwithLitActions(
      true, // preview
      mockLit,
      '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
      'usage',
      protocolInfo,
      null, // notice
      '0x0000...0001', // authorSafeAddress
      'test.soul2soul.eth',
      [], // contentIds (zero)
      undefined, // configCid
      sampleEndpoints.rpcs, // _rpcs
      undefined, // _ipfsGateway
      undefined, // remove
      true, // reset
    );

    // Exactly ONE action dispatch — the update. No prep, no render.
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(updateInputs.reset).toBe(true);
    expect(updateInputs.jobs).toEqual([]);
    expect(updateInputs.remove).toBeUndefined();
    expect(res.success).toBe(true);
    expect(res.cid).toBe('QmNewRoot');
    expect(res.path).toBe('');
  });

  it('without reset, zero contentIds still goes through prep which rejects empty contentIds', async () => {
    // validatePrepInput rejects empty contentIds — so a non-reset empty run
    // must NOT silently reach the update action.
    await expect(
      renderwithLitActions(
        true,
        mockLit,
        '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
        'usage',
        protocolInfo,
        null,
        '0x0000...0001',
        'test.soul2soul.eth',
        [], // zero contentIds, NO reset
        undefined,
        sampleEndpoints.rpcs,
      ),
    ).rejects.toThrow();
    expect(runAction).not.toHaveBeenCalled();
  });

  it('reset:true with non-empty contentIds still runs prep+render and threads reset to the update', async () => {
    const renderedJob = { ...sampleJob, html: 'QmRendered', path: '/hello-world' };
    vi.mocked(runAction).mockImplementation(
      async (_preview: any, _lit: any, cid: any, inputs: any) => {
        if (cid === 'cid-prep') {
          return {
            ok: true,
            action: 'prep',
            data: { jobs: [sampleJob], remove: undefined },
            trace: [],
          };
        }
        if (cid === 'cid-render') {
          return { ok: true, action: 'single', data: { job: renderedJob }, trace: [] };
        }
        if (cid === updateCid) {
          expect(inputs.reset).toBe(true); // reset threaded through
          return { ok: true, action: 'evm-update', data: { cid: 'QmNewRoot' }, trace: [] };
        }
        throw new Error('unexpected cid ' + cid);
      },
    );

    const res: any = await renderwithLitActions(
      true,
      mockLit,
      '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
      'usage',
      protocolInfo,
      null,
      '0x0000...0001',
      'test.soul2soul.eth',
      ['0xcontent-id-1'], // non-empty contentIds
      undefined,
      sampleEndpoints.rpcs,
      undefined,
      undefined,
      true, // reset
    );

    // prep + render + update = 3 dispatches
    expect(runAction).toHaveBeenCalledTimes(3);
    expect(res.success).toBe(true);
  });
});

// ============================================================================
// Render-failure guard — when EVERY render job fails (and there is nothing to
// remove and it is not a reset), renderwithLitActions must SKIP the EVM-update
// action entirely and throw the REAL per-job render failures instead of the
// cryptic validateEvmUpdateInput 'jobs must have at least one item…' error.
// runAction is the vi.mocked spy from the top of this file.
// ============================================================================

describe('renderwithLitActions — all render jobs fail (no remove, no reset)', () => {
  const updateCid = 'cid-update';
  const protocolInfo: S2SProtocolInfo = {
    gateway: 'https://ipfs.transport-union.dev',
    ensRegistry: '0x0',
    ensRecords: '0x0',
    publicationFactory: '0x0',
    recordsFactory: '0x0',
    pkp: '0x0',
    litActions: { prep: 'cid-prep', render: 'cid-render', update: updateCid },
  };

  const SIGNATURE =
    '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

  // Minimal lit mock — never called in preview mode (runAction uses fetch only).
  const litStub = {} as LitService;

  // Non-empty contentIds so this is NOT a reset-only run: prep + render run,
  // then the guard must fire before the update stage.
  const call = () =>
    renderwithLitActions(
      true, // preview
      litStub,
      SIGNATURE,
      'usage',
      protocolInfo,
      null, // notice
      '0x0000...0001', // authorSafeAddress
      'test.soul2soul.eth',
      ['0xcontent-id-1'],
      undefined, // configCid
      sampleEndpoints.rpcs,
    );

  afterEach(() => {
    vi.mocked(runAction).mockReset();
  });

  afterAll(() => {
    vi.mocked(runAction).mockRestore();
  });

  it('throws the real per-job render failure and NEVER POSTs the update action (non-ok render envelope)', async () => {
    vi.mocked(runAction).mockImplementation((_preview, _lit, cid): Promise<unknown> => {
      if (cid === 'cid-prep') {
        return Promise.resolve({
          ok: true,
          action: 'prep',
          data: { jobs: [sampleJob], remove: undefined },
          trace: [],
        });
      }
      if (cid === 'cid-render') {
        // non-ok render envelope → runRenderActionWithRetry exhausts (preview = 1
        // attempt) and throws, so the render job is recorded as failed.
        return Promise.resolve({
          ok: false,
          action: 'render',
          error: 'render boom: IPFS gateway timeout',
          trace: [],
        });
      }
      if (cid === updateCid) {
        return Promise.reject(
          new Error('update action must NEVER be reached when all renders failed'),
        );
      }
      return Promise.reject(new Error('unexpected cid ' + cid));
    });

    const err = await call().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    // The REAL render failure, NOT the EvmUpdate validation error.
    expect((err as Error).message).toContain('render jobs failed');
    expect((err as Error).message).toContain('render boom');
    expect((err as Error).message).not.toContain('jobs must have at least one item');
    expect((err as Error).message).not.toContain('EvmUpdate action input validation failed');
    // Update action's CID was never POSTed — only prep + 1 render (preview).
    expect(runAction).toHaveBeenCalledTimes(2);
    const postedCids = vi.mocked(runAction).mock.calls.map((c) => c[2]);
    expect(postedCids).not.toContain(updateCid);
  });

  it('throws the real per-job render failure and NEVER POSTs the update action (render throws)', async () => {
    vi.mocked(runAction).mockImplementation((_preview, _lit, cid): Promise<unknown> => {
      if (cid === 'cid-prep') {
        return Promise.resolve({
          ok: true,
          action: 'prep',
          data: { jobs: [sampleJob], remove: undefined },
          trace: [],
        });
      }
      if (cid === 'cid-render') {
        return Promise.reject(new Error('render threw: boom'));
      }
      if (cid === updateCid) {
        return Promise.reject(
          new Error('update action must NEVER be reached when all renders failed'),
        );
      }
      return Promise.reject(new Error('unexpected cid ' + cid));
    });

    const err = await call().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('render jobs failed');
    expect((err as Error).message).toContain('render threw');
    expect(runAction).toHaveBeenCalledTimes(2);
    const postedCids = vi.mocked(runAction).mock.calls.map((c) => c[2]);
    expect(postedCids).not.toContain(updateCid);
  });
});
