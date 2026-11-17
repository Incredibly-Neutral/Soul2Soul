import { z } from 'zod';

// ============================================================================
// Manifest schema — validates the IMPLEMENTATION record (S2SManifest).
// The publication's own shapes live in ../publication/schemas.
// ============================================================================
export const manifestSchema = z.object({
  gateway: z.string(),
  ensRegistry: z.string(),
  ensRecords: z.string(),
  publicationFactory: z.string(),
  recordsFactory: z.string(),
  // The one factory every module of every kind is created through. Required:
  // a record that names no factory cannot be used to find a module at all.
  moduleFactory: z.string(),
  pkp: z.string(),
  litActions: z.object({
    prep: z.string(),
    render: z.string(),
    update: z.string(),
    maintainCache: z.string().optional(),
    repointArchive: z.string().optional(),
    encrypt: z.string().optional(),
    decrypt: z.string().optional(),
  }),
});
