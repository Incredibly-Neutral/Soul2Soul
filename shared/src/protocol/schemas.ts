import { z } from 'zod';

// ============================================================================
// Protocol Info
// ============================================================================
export const protocolSchema = z.object({
  gateway: z.string(),
  ensRegistry: z.string(),
  ensRecords: z.string(),
  publicationFactory: z.string(),
  recordsFactory: z.string(),
  pkp: z.string(),
  litActions: z.object({
    prep: z.string(),
    render: z.string(),
    update: z.string(),
    maintainCache: z.string().optional(),
    repointArchive: z.string().optional(),
  }),
});

// ============================================================================
// Template Config
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

// ============================================================================
// Ripple
// ============================================================================
export const rippleSchema = z.object({
  origins: z.array(z.string()),
  destination: z.string(),
  reference: z.string(),
  filters: z.array(z.any()).optional(),
  query: z.any().optional(),
  trigger_filters: z.array(z.record(z.string(), z.string())).optional(),
});

// ============================================================================
// Job
// ============================================================================
export const jobSchema = z.object({
  id: z.string(),
  templateConfig: templateConfigSchema,
  path: z.string().optional(),
  templateData: z.any(),
  html: z.string(),
  revoked: z.boolean().optional(),
});
