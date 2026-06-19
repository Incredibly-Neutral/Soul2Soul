import { z } from 'zod';
import { jobSchema } from '../protocol/schemas';
import type { EvmUpdateInput, SingleInput } from '../lit/actions/types';

// ============================================================================
// Shared ActionResult shape — used by every Lit action
// ============================================================================
const ActionResultSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), action: z.string(), data: dataSchema, trace: z.array(z.any()) }),
    z.object({ ok: z.literal(false), action: z.string(), error: z.string(), trace: z.array(z.any()) }),
  ]);

// ============================================================================
// Prep Action I/O
// ============================================================================

export const PrepActionInputSchema = z.object({
  publication: z.string().min(1, 'publication ENS name is required'),
  contentIds: z.array(z.string()).min(1, 'contentIds must have at least one item'),
  configCid: z.string().optional(),
});

export type PrepActionInput = z.infer<typeof PrepActionInputSchema>;

export const PrepActionOutputSchema = ActionResultSchema(
  z.object({
    jobs: z.array(jobSchema),
  })
);

export type PrepActionOutput = z.infer<typeof PrepActionOutputSchema>;

// ============================================================================
// Validation helpers
// ============================================================================

export function validatePrepInput(input: unknown): PrepActionInput {
  const result = PrepActionInputSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Prep action input validation failed:\n${issues}`);
  }
  return result.data;
}

export function validatePrepOutput(output: unknown): PrepActionOutput {
  const result = PrepActionOutputSchema.safeParse(output);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Prep action output validation failed:\n${issues}`);
  }
  return result.data;
}

// ============================================================================
// Single Action I/O
// ============================================================================

export const SingleActionInputSchema = z.object({
  job: jobSchema,
  signature: z.string().min(1, 'signature is required'),
  authorSafeAddress: z.string().min(1, 'authorSafeAddress is required'),
  publication: z.string().min(1, 'publication ENS name is required'),
  configCid: z.string().optional(),
  preview: z.boolean().optional(),
});

export type SingleActionInput = z.infer<typeof SingleActionInputSchema>;

export const SingleActionOutputSchema = ActionResultSchema(
  z.object({
    job: jobSchema,
    html: z.string().optional(),
    timestamp: z.string(),
    trace: z.array(z.any()),
  })
);

export type SingleActionOutput = z.infer<typeof SingleActionOutputSchema>;

// ============================================================================
// Compile-time sentinel: interface ↔ schema must match
// ============================================================================

type _AssertSingleInputMatches = SingleInput extends SingleActionInput ? true : never;

// ============================================================================
// Validation helpers
// ============================================================================

export function validateSingleInput(input: unknown): SingleActionInput {
  const result = SingleActionInputSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Single action input validation failed:\n${issues}`);
  }
  return result.data;
}

export function validateSingleOutput(output: unknown): SingleActionOutput {
  const result = SingleActionOutputSchema.safeParse(output);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Single action output validation failed:\n${issues}`);
  }
  return result.data;
}

// ============================================================================
// EvmUpdate Action I/O
// ============================================================================

export const EvmUpdateActionInputSchema = z.object({
  publication: z.string().min(1, 'publication ENS name is required'),
  jobs: z.array(jobSchema).min(1, 'jobs must have at least one item'),
  signature: z.string().min(1, 'signature is required'),
  authorSafeAddress: z.string().min(1, 'authorSafeAddress is required'),
  preview: z.boolean().optional(),
});

export type EvmUpdateActionInput = z.infer<typeof EvmUpdateActionInputSchema>;

export const EvmUpdateActionOutputSchema = ActionResultSchema(
  z.object({
    cid: z.string().min(1, 'cid is required')
  })
);

export type EvmUpdateActionOutput = z.infer<typeof EvmUpdateActionOutputSchema>;

// ============================================================================
// Compile-time sentinel: interface ↔ schema must match
// ============================================================================

type _AssertEvmUpdateInputMatches = EvmUpdateInput extends EvmUpdateActionInput ? true : never;

// ============================================================================
// Validation helpers
// ============================================================================

export function validateEvmUpdateInput(input: unknown): EvmUpdateActionInput {
  const result = EvmUpdateActionInputSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`EvmUpdate action input validation failed:\n${issues}`);
  }
  return result.data;
}

export function validateEvmUpdateOutput(output: unknown): EvmUpdateActionOutput {
  const result = EvmUpdateActionOutputSchema.safeParse(output);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`EvmUpdate action output validation failed:\n${issues}`);
  }
  return result.data;
}