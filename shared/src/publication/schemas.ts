import { z } from 'zod';

// ============================================================================
// Publication schemas — the shapes a publication designs for itself.
//
// A publication is a name, a look, and a line: this file validates the "look".
// Kept out of ../protocol/schemas because a publication config is not part of
// the implementation record, and out of the Lit Action bundle because zod is
// not available there (INV-7).
// ============================================================================

export const collectionSchema = z.object({
  slug: z.string(),
  filters: z.array(z.any()).optional(),
  sortBy: z.enum(['position', 'creationDate', 'modifiedDate', 'title']).optional(),
});

export const templateConfigSchema = z.object({
  reference: z.string(),
  file: z.string().nullable(),
  path: z.string().nullable(),
  collections: z.array(collectionSchema).optional(),
  filters: z.array(z.any()).optional(),
});

export const rippleSchema = z.object({
  origins: z.array(z.string()),
  destination: z.string(),
  reference: z.string(),
  filters: z.array(z.any()).optional(),
  query: z.any().optional(),
  trigger_filters: z.array(z.record(z.string(), z.string())).optional(),
});
