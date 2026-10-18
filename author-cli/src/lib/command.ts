// ============================================================================
// Command contract — every `s2s author <action>` implements CommandSpec.
// The context is built once in cli.ts and handed to the resolved command.
// ============================================================================

import type { ParsedArgs } from './args';
import type { CliContext } from '../core/context';

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  run(ctx: CliContext, args: ParsedArgs): Promise<void>;
}
