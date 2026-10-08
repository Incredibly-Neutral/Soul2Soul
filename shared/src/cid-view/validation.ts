// cid-view zod schemas — runtime validation for the composed PublicationCidView.
//
// House style (see ../rendering/action-io.ts): exported z.object schemas +
// z.infer types, plus a safeParse-based parse helper that throws a ZodError on
// structural violation. The coordinator validates its own output through
// parsePublicationCidView before returning — an invariant check that catches a
// real composition bug, never a missing source (collectors are fail-open).
//
// zod v3.24. The schemas below mirror types.ts EXACTLY (same 13 category
// values, same entry fields, same summary shape) so a structurally-invalid view
// fails loudly instead of silently propagating.
import { z } from 'zod';
import type { PublicationCidView } from './types';

// 13 categories in the exact order of types.ts.
export const cidCategorySchema = z.enum([
  'deal',
  'deal-version',
  'offer',
  'offer-version',
  'config',
  'template-dag',
  'template',
  'assets-root',
  'asset',
  'site-root',
  'site-file',
  'archive',
  'archive-item',
]);

export const cidEntrySchema = z.object({
  cid: z.string(),
  category: cidCategorySchema,
  source: z.enum(['deals', 'config', 'tree', 'archive']),
  role: z.string().optional(),
  genesis: z.string().optional(),
  author: z.string().optional(),
  timestamp: z.number().optional(),
  tombstoned: z.boolean().optional(),
  size: z.number().optional(),
  path: z.string().optional(),
  note: z.string().optional(),
});

export const publicationCidViewSchema = z.object({
  publication: z.string(),
  generatedAt: z.string(),
  entries: z.array(cidEntrySchema),
  sources: z.object({
    deals: z.boolean(),
    config: z.boolean(),
    tree: z.boolean(),
    archive: z.boolean(),
  }),
  summary: z.object({
    total: z.number(),
    uniqueCids: z.number(),
    byCategory: z.record(cidCategorySchema, z.number()),
  }),
});

export type CidEntryValidated = z.infer<typeof cidEntrySchema>;
export type PublicationCidViewValidated = z.infer<typeof publicationCidViewSchema>;

/**
 * Parse and validate an unknown value as a PublicationCidView.
 * Throws a ZodError on any structural violation.
 */
export function parsePublicationCidView(v: unknown): PublicationCidView {
  const result = publicationCidViewSchema.safeParse(v);
  if (!result.success) {
    throw result.error; // ZodError, mirroring the house parse pattern in action-io.ts
  }
  return result.data;
}
