import { z } from 'zod';

// ============================================================================
// Manifest schema — validates the IMPLEMENTATION document (S2SManifest).
// The publication's own shapes live in ../publication/schemas.
//
// The on-chain value is one JSON document under the record keys `manifest`
// and `manifest@<version>`. Optional action CIDs are absent from the document
// when the action was never written, never present as an empty string.
//
// Two version shapes: a release, `x.y.z`, and a dev build, `d.x.y`. The dev lane
// is never the live document, so it is only ever read by name (or by a
// publication's pin).
// ============================================================================
export const MANIFEST_VERSION_PATTERN = /^(?:\d+\.\d+\.\d+|d\.\d+\.\d+)$/;

export const manifestSchema = z.object({
  version: z.string().regex(MANIFEST_VERSION_PATTERN),
  gateway: z.string(),
  ensRegistry: z.string(),
  ensRecords: z.string(),
  publicationFactory: z.string(),
  recordsFactory: z.string(),
  pkp: z.string(),
  litActions: z.object({
    prep: z.string().min(1),
    render: z.string().min(1),
    update: z.string().min(1),
    // `.min(1)`: present means deployed. The action reader rejects a key that
    // carries the empty string, and this schema has to answer the same way.
    maintainCache: z.string().min(1).optional(),
    repointArchive: z.string().min(1).optional(),
    encrypt: z.string().min(1).optional(),
    decrypt: z.string().min(1).optional(),
  }),
});
