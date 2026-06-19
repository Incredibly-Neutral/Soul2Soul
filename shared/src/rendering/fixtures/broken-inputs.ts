import type { PrepActionInput, SingleActionInput, EvmUpdateActionInput } from '../action-io';
import { validPrepInput, validSingleInput, validEvmUpdateInput } from './inputs';

// ============================================================================
// Broken-input factories — take a valid input and clobber one field.
// Each returns an `unknown` so the test can assert parse failure.
// ============================================================================

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// ---- Prep broken factories ----

export function prepMissingPublication(): unknown {
  const { publication: _, ...rest } = validPrepInput;
  return rest;
}

export function prepNonArrayContentIds(): unknown {
  return { ...validPrepInput, contentIds: 'not-an-array' };
}

export function prepEmptyContentIds(): unknown {
  return { ...validPrepInput, contentIds: [] };
}

export function prepMissingConfigCid(): unknown {
  const { configCid: _, ...rest } = validPrepInput;
  return rest; // optional — STILL valid
}

// ---- Single broken factories ----

export function singleMissingSignature(): unknown {
  const { signature: _, ...rest } = validSingleInput;
  return rest;
}

export function singleWrongTypeJob(): unknown {
  return { ...validSingleInput, job: 'not-a-job-object' };
}

export function singleMissingAuthorSafe(): unknown {
  const { authorSafeAddress: _, ...rest } = validSingleInput;
  return rest;
}

export function singleMissingConfigCid(): unknown {
  const { configCid: _, ...rest } = validSingleInput;
  return rest; // optional — STILL valid
}

// ---- EvmUpdate broken factories ----

export function evmMissingSignature(): unknown {
  const { signature: _, ...rest } = validEvmUpdateInput;
  return rest;
}

export function evmNonArrayJobs(): unknown {
  return { ...validEvmUpdateInput, jobs: 'not-an-array' };
}

export function evmEmptyJobs(): unknown {
  return { ...validEvmUpdateInput, jobs: [] };
}

export function evmMissingPreview(): unknown {
  const { preview: _, ...rest } = validEvmUpdateInput;
  return rest; // optional — STILL valid
}