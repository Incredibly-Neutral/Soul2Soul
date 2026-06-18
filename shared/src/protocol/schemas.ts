import { z } from 'zod';

// ============================================================================
// PKP
// ============================================================================
export const pkpSchema = z.object({
  ethAddress: z.string(),
  publicKey: z.string(),
  tokenId: z.string(),
});

// ============================================================================
// Protocol Info
// ============================================================================
export const protocolSchema = z.object({
  addr: z.string(),
  recordsModule: z.string(),
  dataGateway: z.string(),
  assetsGateway: z.string(),
  lensApp: z.string(),
  ensRecords: z.string(),
  pkp: pkpSchema,
  litActionPrep: z.string(),
  litActionSingle: z.string(),
  litActionCbor: z.string(),
  litActionRootUpdate: z.string(),
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
  filters: z.array(z.any()),
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
});