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
});
