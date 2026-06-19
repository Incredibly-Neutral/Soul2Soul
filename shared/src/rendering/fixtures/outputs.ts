import type { ActionResult } from '../../lit/actions/types';
import type { PrepActionOutput, SingleActionOutput, EvmUpdateActionOutput } from '../action-io';
import { sampleTemplateConfig } from './inputs';

// ============================================================================
// Valid prep output — ActionResult with ok:true and jobs array
// ============================================================================

export const validPrepOutput: PrepActionOutput = {
  ok: true,
  action: 'prep',
  data: {
    jobs: [
      {
        id: 'lens-post-1',
        templateConfig: sampleTemplateConfig,
        html: '',
        path: '/hello-world',
      },
    ],
  },
  trace: [],
};

// ============================================================================
// Valid single output — Job is now rendered with html CID
// ============================================================================

export const validSingleOutput: SingleActionOutput = {
  ok: true,
  action: 'single',
  data: {
    job: {
      id: 'lens-post-1',
      templateConfig: sampleTemplateConfig,
      html: 'QmRenderedHtml',
      path: '/hello-world',
    },
    html: 'QmRenderedHtml',
    timestamp: '2026-06-19T12:00:00.000Z',
  },
  trace: [],
};

// ============================================================================
// Valid evm-update output
// ============================================================================

export const validEvmUpdateOutput: EvmUpdateActionOutput = {
  ok: true,
  action: 'evm-update',
  data: {
    cid: 'QmNewSiteRoot',
  },
  trace: [],
};

// ============================================================================
// ok:false envelopes (valid ActionResult shape — failure is not a parse error)
// ============================================================================

export const failedPrepOutput: PrepActionOutput = {
  ok: false,
  action: 'prep',
  error: 'no modules found',
  trace: [{ stage: 'resolve-modules', ok: false }],
};

export const failedSingleOutput: SingleActionOutput = {
  ok: false,
  action: 'single',
  error: 'signer not authorised',
  trace: [{ stage: 'authorisation', ok: false }],
};

export const failedEvmUpdateOutput: EvmUpdateActionOutput = {
  ok: false,
  action: 'evm-update',
  error: 'canPublish returned false',
  trace: [{ stage: 'gate', ok: false }],
};

// ============================================================================
// Malformed output helpers (broken in specific ways)
// ============================================================================

/**
 * Takes a valid PrepActionOutput and removes `data.jobs[0].id` to produce
 * a malformed result.
 */
export function makeMalformedPrepOutput(base?: PrepActionOutput): unknown {
  const src = (base ?? validPrepOutput) as any;
  return {
    ...src,
    data: {
      ...src.data,
      jobs: [{
        ...src.data.jobs[0],
        id: undefined, // id is required — this should fail
      }],
    },
  };
}

/**
 * Takes a valid SingleActionOutput and removes `data.job.html` to produce
 * a malformed result.
 */
export function makeMalformedSingleOutput(base?: SingleActionOutput): unknown {
  const src = (base ?? validSingleOutput) as any;
  return {
    ...src,
    data: {
      ...src.data,
      job: {
        ...src.data.job,
        html: undefined, // html is now required on S2SJob — this should fail
      },
    },
  };
}

/**
 * Takes a valid EvmUpdateActionOutput and removes `data.cid`.
 */
export function makeMalformedEvmUpdateOutput(base?: EvmUpdateActionOutput): unknown {
  const src = base ?? validEvmUpdateOutput;
  return {
    ...src,
    data: {
      // cid deliberately missing
    },
  };
}