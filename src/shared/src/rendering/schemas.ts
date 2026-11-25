import { z } from 'zod';
import { templateConfigSchema } from '../publication/schemas';

// ============================================================================
// Job schema — the renderer's input.
// ============================================================================
export const jobSchema = z.object({
  id: z.string(),
  templateConfig: templateConfigSchema,
  path: z.string().optional(),
  templateData: z.any(),
  html: z.string(),
  revoked: z.boolean().optional(),
  // the on-chain item a job renders (a collection member's bundle genesis); absent = id
  sourceId: z.string().optional(),
  // which member of sourceId's collection this job renders
  collectionKey: z.string().optional(),
});
