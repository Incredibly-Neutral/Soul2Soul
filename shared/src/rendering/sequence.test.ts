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

import { describe, it, expect, beforeAll } from 'vitest';
import { createPublicClient, http } from 'viem';
import { mainnet, base } from 'viem/chains';
import { Wallet } from 'ethers';

import { getProtocolInfo } from '../protocol';
import type { S2SProtocolInfo } from '../protocol';
import { runAction } from './helpers';
import {
  validatePrepOutput,
  validateSingleInput,
  validateSingleOutput,
  validateEvmUpdateOutput,
} from './action-io';
import { sampleJob, sampleEndpoints } from './fixtures/inputs';

// ============================================================================
// Env-based configuration — TEST_* prefix preferred, S2S_* fallback
// ============================================================================

/** Read an env var with fallback to an alternative name. */
function env(name: string, alt?: string): string | undefined {
  return process.env[name] ?? (alt ? process.env[alt] : undefined);
}

const RUNNER_URL        = env('TEST_RUNNER_URL', 'S2S_RUNNER_URL')   || 'https://run.transport-union.dev/run';
const PUBLICATION       = env('TEST_PUBLICATION', 'S2S_PUBLICATION');
const AUTHOR_SAFE     = env('TEST_AUTHOR_SAFE', 'S2S_AUTHOR_SAFE')     || '0x0000...0001';
const CONFIG_CID        = env('TEST_CONFIG_CID', 'S2S_CONFIG_CID');
const TEST_PRIVATE_KEY  = env('TEST_PRIVATE_KEY');

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL;
const BASE_RPC_URL    = process.env.BASE_RPC_URL;

// ============================================================================
// Per-scenario content IDs — each test defines its own.
// You can add additional fixture sets here as the test suite grows.
// ============================================================================

/** Content IDs — from TEST_CONTENT_IDS env var, fall back to real genesis CID. */
const CONTENT_IDS = (env('TEST_CONTENT_IDS') || '0x9a1600a648241726b0470d0b0b85df1d166e0aa74b88789b5f569294baa5a063')
  .split(',').map(s => s.trim()).filter(Boolean);

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
    return wallet.signMessage("lit actions auth");
  }
  return '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
}

async function callAction(
  cid: string,
  inputs: Record<string, unknown>,
): Promise<unknown> {
  return runAction(true, mockLit, cid, inputs);
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
      signature: '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
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
    const l1 = createPublicClient({ chain: mainnet as any, transport: http(MAINNET_RPC_URL!) }) as any;
    const l2 = createPublicClient({ chain: base as any, transport: http(BASE_RPC_URL!) }) as any;
    protocolInfo = await getProtocolInfo(false, l1, l2);
    SIGNATURE = await makeSignature();
  }, 15_000);

  it('prep returns ok:true with valid jobs', async () => {
    const input: Record<string, unknown> = {
      publication: PUBLICATION,
      contentIds: CONTENT_IDS,
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
      expect(result.action).toBe('single');
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
    const l1 = createPublicClient({ chain: mainnet as any, transport: http(MAINNET_RPC_URL!) }) as any;
    const l2 = createPublicClient({ chain: base as any, transport: http(BASE_RPC_URL!) }) as any;
    protocolInfo = await getProtocolInfo(false, l1, l2);
    SIGNATURE = await makeSignature();
  }, 15_000);

  it('prep output jobs pass validateSingleInput with orchestrator fields', async () => {
    const input: Record<string, unknown> = {
      publication: PUBLICATION,
      contentIds: CONTENT_IDS,
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
    const l1 = createPublicClient({ chain: mainnet as any, transport: http(MAINNET_RPC_URL!) }) as any;
    const l2 = createPublicClient({ chain: base as any, transport: http(BASE_RPC_URL!) }) as any;
    protocolInfo = await getProtocolInfo(false, l1, l2);
  }, 15_000);

  it('a publication that resolves to no modules returns ok:false', async () => {
    const badPublication = 'nonexistent-' + Date.now() + '.soul2soul.eth';
    const input = { publication: badPublication, contentIds: ['lens-post-1'] };

    const raw = await callAction(protocolInfo.litActions.prep, input);

    expect(raw).toBeDefined();
    assertOkShape(raw, 'prep');
    expect((raw as any).ok).toBe(false);
    expect((raw as any).error).toBeTruthy();
    expect(typeof (raw as any).error).toBe('string');
  }, 30_000);
});