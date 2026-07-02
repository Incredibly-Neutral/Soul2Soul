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
  }),
});

// ============================================================================
// Template Config
// ============================================================================
export const querySchema = z.object({
  method: z.string(),
  args: z.any(),
});

export const collectionSchema = z.object({
  source: z.string(),
  query: querySchema,
  filters: z.array(z.any()).optional(),
  key: z.string(),
  value: z.string(),
  slug: z.string(),
});

export const templateConfigSchema = z.object({
  reference: z.string(),
  file: z.string(),
  path: z.string(),
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
  query: querySchema,
  filters: z.array(z.any()).optional(),
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