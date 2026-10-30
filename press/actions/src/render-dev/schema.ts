import { z } from 'zod';

// ============================================================================
// Dev render action I/O — mirrors validateSingleInput but DEV-SHAPED.
//
// The dev render action takes ALL render inputs as injected values: no
// signature, no publication ENS, no endpoints, no configCid, no job. It only
// needs the plaintext body + local template/partial sources + local config.
// ============================================================================

/**
 * A single collection spec in the injected config's `templateConfig.collections`.
 * Mirrors `S2SCollection` (`{ slug, filters?: any[], sortBy?: ... }`).
 */
export const devCollectionSchema = z.object({
  slug: z.string().min(1, 'collection slug is required'),
  filters: z.array(z.any()).optional(),
  sortBy: z.enum(['position', 'creationDate', 'modifiedDate', 'title']).optional(),
});

/**
 * Dev-shaped template config: which template file renders, the path, and any
 * collections the template iterates. Mirrors `S2STemplateConfig`.
 */
export const devTemplateConfigSchema = z.object({
  reference: z.string().optional(),
  file: z.string(),
  path: z.string().nullable().optional(),
  collections: z.array(devCollectionSchema).optional(),
  filters: z.array(z.any()).optional(),
});

/**
 * Dev-shaped plaintext body. `encryption` MUST be false — the dev action has
 * no decrypt path by construction.
 */
export const devRenderBodySchema = z
  .object({
    id: z.string().optional(),
    author: z.string().optional(),
    locale: z.string().optional(),
    parent: z.string().optional(),
    position: z.string().optional(),
    postType: z.string().optional(),
    creationDate: z.string().optional(),
    modifiedDate: z.string().optional(),
    tags: z.array(z.string()).optional(),
    attributes: z.any().optional(),
    publication: z.string().optional(),
    base: z.string().optional(),
    encryption: z.literal(false, {
      errorMap: () => ({
        message: 'dev render requires a plaintext body (encryption must be false)',
      }),
    }),
    content: z.string().default(''),
    title: z.string().optional(),
    slug: z.string().optional(),
    custom: z.any().optional(),
  })
  .passthrough();

/**
 * Full dev render input.
 */
export const devRenderInputSchema = z.object({
  // Publication config (from local-config-builder etc.) — loose, rendered shape
  config: z.any().optional(),

  // Which template file + collections to render
  templateConfig: devTemplateConfigSchema,

  // Local template source (the .handlebars file content)
  templateSource: z.string().min(0),

  // Local partials: { name -> source }
  partialsSource: z.record(z.string(), z.string()).optional(),

  // Plaintext body (encryption: false)
  body: devRenderBodySchema,

  // Pre-built collections: { slug -> items[] } (preferred)
  collections: z.record(z.string(), z.array(z.any())).optional(),

  // OR injected allDeals -> run the shared pure collection filter
  allDeals: z.array(z.any()).optional(),

  // Optional protocol info (for gateway label on templateData)
  protocolInfo: z.any().optional(),
});

export type DevRenderInput = z.infer<typeof devRenderInputSchema>;

/**
 * Validate a raw `{ cid, inputs }` dev render payload. Throws on invalid input.
 */
export function validateDevRenderInput(input: unknown): DevRenderInput {
  const result = devRenderInputSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Dev render input validation failed:\n${issues}`);
  }
  return result.data;
}
