import { z } from 'zod';
import { jobSchema } from './schemas';
import type { EvmUpdateInput, MaintainCacheInput, SingleInput } from '../lit/actions/types';

// ============================================================================
// Did:ethr schema
// ============================================================================

export const didEthrSchema = z
  .string()
  .regex(/^did:ethr:0x[0-9a-fA-F]{40}$/, 'Author must be a did:ethr');

// ============================================================================
// S2SPublicContent (signed public metadata)
//
// One union of two shapes, keyed on specVersion. v1 carries the single
// createdAt; v2 carries creationDate (genesis signing time) and modifiedDate
// (this version's signing time). The v2 branch pins specVersion to the literal
// "2", and the v1 branch refuses that literal, so a v2 item cannot fall back
// to the v1 branch when a date is misspelled or missing.
// ============================================================================

export const s2sPublicContentSchemaV1 = z.object({
  specVersion: z
    .string()
    .min(1, 'specVersion is required')
    .refine((v) => v !== '2', 'specVersion "2" requires creationDate and modifiedDate'),
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

export const s2sPublicContentSchemaV2 = z.object({
  specVersion: z.literal('2'),
  author: didEthrSchema,
  postType: z.string().min(1, 'postType is required'),
  mediaType: z.string().min(1, 'mediaType is required'),
  parent: z.string(),
  position: z.string(),
  publication: z.string().min(1, 'publication is required'),
  locale: z.string().min(1, 'locale is required'),
  creationDate: z.number().int('creationDate must be a unix timestamp (integer)'),
  modifiedDate: z.number().int('modifiedDate must be a unix timestamp (integer)'),
  base: z.string().optional(),
  tags: z.array(z.string()),
  attributes: z.record(z.unknown()).optional(),
  plaintextHash: z.string().min(1, 'plaintextHash is required'),
});

export const s2sPublicContentSchema = z.union([
  s2sPublicContentSchemaV2,
  s2sPublicContentSchemaV1,
]);

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
    ipfsGatewayAuth: z.string().optional(),
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
  // The id(s) the caller rendered — the render action scopes its on-chain
  // hasDeal revoke check to these ids ONLY. A cascade/ripple destination is
  // never hasDeal-checked (a destination pinned via query.genesis may never
  // have been a deal; hasDeal=false there must not revoke-and-remove a live
  // page). Optional for backward compatibility with direct callers that do
  // not drive a revoke-triggered render.
  triggeredContentIds: z.array(z.string()).optional(),
  endpoints: z.object({
    ipfsGateway: z.string().optional(),
    ipfsGatewayAuth: z.string().optional(),
    rpcs: z.object({
      L1: z.array(z.string()).min(1, 'L1 rpcs required'),
      L2: z.array(z.string()).min(1, 'L2 rpcs required'),
    }),
  }),
});

export type SingleActionInput = z.infer<typeof SingleActionInputSchema>;

export const DataAvailabilityEntrySchema = z.object({
  kind: z.enum(['config', 'template', 'data']),
  genesis: z.string().optional(),
  cid: z.string().optional(),
  reason: z.string(),
  fatal: z.boolean(),
});

export const SingleActionOutputSchema = ActionResultSchema(
  z.object({
    job: jobSchema,
    html: z.string().optional(),
    timestamp: z.string(),
    // Cache-drift signal (see SingleData.maintainCache): the orchestrator fires
    // the parallel maintain-cache action when true.
    maintainCache: z.boolean().optional(),
    // Structured availability report: every data-fetch failure classified.
    availability: z.array(DataAvailabilityEntrySchema).optional(),
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

export const EvmUpdateActionInputSchema = z
  .object({
    publication: z.string().min(1, 'publication ENS name is required'),
    // `jobs` may be empty ONLY when remove entries are present (a revoke with
    // no matching ripple renders zero active jobs but still removes the revoked
    // path) OR when `reset` is true (a reset-only run skips rendering entirely
    // and rebuilds the tree fresh from assets). The refine below enforces that
    // invariant.
    jobs: z.array(jobSchema),
    signature: z.string().min(1, 'signature is required'),
    authorSafeAddress: z.string().min(1, 'authorSafeAddress is required'),
    preview: z.boolean().optional(),
    // A reset drops the existing MFS tree (including root index.html), keeps
    // assets, and rewrites contenthash_wrapped. See RFC-reset-tree-button.md.
    reset: z.boolean().optional(),
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
      ipfsGatewayAuth: z.string().optional(),
      rpcs: z.object({
        L1: z.array(z.string()).min(1, 'L1 rpcs required'),
        L2: z.array(z.string()).min(1, 'L2 rpcs required'),
      }),
    }),
  })
  .refine(
    (data) =>
      data.jobs.length > 0 ||
      (data.remove != null && data.remove.length > 0) ||
      data.reset === true,
    {
      message:
        'jobs must have at least one item, or remove entries must be provided (revoke path), or reset must be true (reset path)',
      path: ['jobs'],
    },
  );

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

// ============================================================================
// Maintain-Cache Action I/O
// ============================================================================

export const MaintainCacheActionInputSchema = z.object({
  publication: z.string().min(1, 'publication ENS name is required'),
  signature: z.string().min(1, 'signature is required'),
  authorSafeAddress: z.string().min(1, 'authorSafeAddress is required'),
  preview: z.boolean().optional(),
  endpoints: z.object({
    ipfsGateway: z.string().optional(),
    ipfsGatewayAuth: z.string().optional(),
    rpcs: z.object({
      L1: z.array(z.string()).min(1, 'L1 rpcs required'),
      L2: z.array(z.string()).min(1, 'L2 rpcs required'),
    }),
  }),
});

export type MaintainCacheActionInput = z.infer<typeof MaintainCacheActionInputSchema>;

export const MaintainCacheActionOutputSchema = ActionResultSchema(
  z.object({
    // cid may be EMPTY (''): steady state (no drift to merge) returns
    // { cid: '', wrote: false } — zero writes. Required-but-may-be-empty,
    // matching MaintainCacheData.cid: string. "missing" (undefined) still
    // fails validation.
    cid: z.string(),
    wrote: z.boolean().optional(),
  }),
);

export type MaintainCacheActionOutput = z.infer<typeof MaintainCacheActionOutputSchema>;

// ============================================================================
// Compile-time sentinel: interface ↔ schema must match
// ============================================================================

type _AssertMaintainCacheInputMatches = MaintainCacheInput extends MaintainCacheActionInput
  ? true
  : never;

// ============================================================================
// Validation helpers
// ============================================================================

export function validateMaintainCacheInput(input: unknown): MaintainCacheActionInput {
  const result = MaintainCacheActionInputSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`MaintainCache action input validation failed:\n${issues}`);
  }
  return result.data;
}

export function validateMaintainCacheOutput(output: unknown): MaintainCacheActionOutput {
  const result = MaintainCacheActionOutputSchema.safeParse(output);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`MaintainCache action output validation failed:\n${issues}`);
  }
  return result.data;
}
