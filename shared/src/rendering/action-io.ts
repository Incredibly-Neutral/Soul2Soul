import { z } from 'zod';
import { jobSchema } from '../protocol/schemas';
import type { EvmUpdateInput, SingleInput } from '../lit/actions/types';

// ============================================================================
// Did:ethr schema
// ============================================================================

export const didEthrSchema = z
  .string()
  .regex(/^did:ethr:0x[0-9a-fA-F]{40}$/, 'Author must be a did:ethr');

// ============================================================================
// S2SPublicContent (signed public metadata)
// ============================================================================

export const s2sPublicContentSchema = z.object({
  specVersion: z.string().min(1, 'specVersion is required'),
  author: didEthrSchema,
  postType: z.string().min(1, 'postType is required'),
  mediaType: z.string().min(1, 'mediaType is required'),
  parent: z.string(),
  position: z.string(),
  publication: z.string().min(1, 'publication is required'),
  locale: z.string().min(1, 'locale is required'),
  createdAt: z.number().int('createdAt must be a unix timestamp (integer)'),
  base: z.string().optional(),
  tags: z.array(z.string()),
  attributes: z.record(z.unknown()).optional(),
  plaintextHash: z.string().min(1, 'plaintextHash is required'),
});

// ============================================================================
// S2SProof (EIP-712 author signature)
// ============================================================================

export const s2sProofSchema = z.object({
  type: z.literal('eip712'),
  signer: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'signer must be a 0x address'),
  signature: z.string().min(1, 'signature is required'),
});

// ============================================================================
// S2SContentItem (flat — no discriminated union)
// ============================================================================

export const s2sContentItemSchema = z.object({
  public: s2sPublicContentSchema,
  objectId: z.string().min(1, 'objectId is required'),
  proof: s2sProofSchema,
  encryption: z.boolean(),
  body: z.string(),
});

// ============================================================================
// S2SContentBody (what goes into .body)
// ============================================================================

export const s2sContentBodySchema = z.object({
  title: z.string().min(1, 'title is required'),
  slug: z.string().min(1, 'slug is required'),
  content: z.string().min(1, 'content is required'),
  custom: z.record(z.unknown()).optional(),
});

// ============================================================================
// Shared ActionResult shape — used by every Lit action
// ============================================================================
const ActionResultSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      action: z.string(),
      data: dataSchema,
      trace: z.array(z.any()),
    }),
    z.object({
      ok: z.literal(false),
      action: z.string(),
      error: z.string(),
      trace: z.array(z.any()),
    }),
  ]);

// ============================================================================
// Prep Action I/O
// ============================================================================

export const PrepActionInputSchema = z.object({
  publication: z.string().min(1, 'publication ENS name is required'),
  contentIds: z.array(z.string()).min(1, 'contentIds must have at least one item'),
  configCid: z.string().optional(),
  prevRootCid: z.string().optional(),
  endpoints: z.object({
    ipfsGateway: z.string().optional(),
    rpcs: z.object({
      L1: z.array(z.string()).min(1, 'L1 rpcs required'),
      L2: z.array(z.string()).min(1, 'L2 rpcs required'),
    }),
  }),
});

export type PrepActionInput = z.infer<typeof PrepActionInputSchema>;

export const PrepActionOutputSchema = ActionResultSchema(
  z.object({
    jobs: z.array(jobSchema),
    remove: z
      .array(
        z.object({
          path: z.string(),
          replacedBy: z.string().optional(),
        }),
      )
      .optional(),
  }),
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
  maintainCache: z.boolean().optional(),
  endpoints: z.object({
    ipfsGateway: z.string().optional(),
    rpcs: z.object({
      L1: z.array(z.string()).min(1, 'L1 rpcs required'),
      L2: z.array(z.string()).min(1, 'L2 rpcs required'),
    }),
  }),
});

export type SingleActionInput = z.infer<typeof SingleActionInputSchema>;

export const SingleActionOutputSchema = ActionResultSchema(
  z.object({
    job: jobSchema,
    html: z.string().optional(),
    timestamp: z.string(),
  }),
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
  remove: z
    .array(
      z.object({
        path: z.string(),
        replacedBy: z.string().optional(),
      }),
    )
    .optional(),
  endpoints: z.object({
    ipfsGateway: z.string().optional(),
    rpcs: z.object({
      L1: z.array(z.string()).min(1, 'L1 rpcs required'),
      L2: z.array(z.string()).min(1, 'L2 rpcs required'),
    }),
  }),
});

export type EvmUpdateActionInput = z.infer<typeof EvmUpdateActionInputSchema>;

export const EvmUpdateActionOutputSchema = ActionResultSchema(
  z.object({
    cid: z.string().min(1, 'cid is required'),
  }),
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
