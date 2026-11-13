import { z } from 'zod';

// ============================================================================
// Protocol info schema — validates the IMPLEMENTATION record (S2SProtocolInfo).
// The publication's own shapes live in ../publication/schemas.
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
    encrypt: z.string().optional(),
    decrypt: z.string().optional(),
  }),
});
