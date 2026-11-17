import { z } from 'zod';

// ============================================================================
// Manifest schema — validates the IMPLEMENTATION document (S2SManifest).
// The publication's own shapes live in ../publication/schemas.
//
// The on-chain value is one JSON document under the record keys `manifest`
// and `manifest@<x.y.z>`. Optional action CIDs are absent from the document
// when the action was never written, never present as an empty string.
// ============================================================================
export const manifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
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
    encrypt: z.string().optional(),
    decrypt: z.string().optional(),
  }),
});
