import { z } from 'zod';
import { jobSchema } from '../protocol/schemas';

// ============================================================================
// Shared ActionResult shape — used by every Lit action
// ============================================================================
const ActionResultSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), action: z.string(), data: dataSchema }),
    z.object({ ok: z.literal(false), action: z.string(), error: z.string() }),
  ]);

// ============================================================================
// Prep Action I/O
// ============================================================================

export const PrepActionInputSchema = z.object({
  publication: z.string().min(1, 'publication ENS name is required'),
  contentIds: z.array(z.string()).min(1, 'contentIds must have at least one item'),
  configCid: z.string().optional(),
});

export type PrepActionInput = z.infer<typeof PrepActionInputSchema>;

export const PrepActionOutputSchema = ActionResultSchema(
  z.object({
    jobs: z.array(jobSchema),
  })
);

export type PrepActionOutput = z.infer<typeof PrepActionOutputSchema>;

// ============================================================================
// Validation helpers
// ============================================================================

export function validatePrepInput(input: unknown): PrepActionInput {
  const result = PrepActionInputSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Prep action input validation failed:\n${issues}`);
  }
  return result.data;
}

export function validatePrepOutput(output: unknown): PrepActionOutput {
  const result = PrepActionOutputSchema.safeParse(output);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Prep action output validation failed:\n${issues}`);
  }
  return result.data;
}