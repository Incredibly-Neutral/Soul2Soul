// ============================================================================
// Command contract — every `s2s <group> <action>` implements CommandSpec.
// The context is built once in cli.ts and handed to the resolved command.
//
// `flags` is the single declaration: cli.ts parses argv against it (strictly)
// and renders `--help` from it, so neither can drift from the other.
// `params` is the positional signature shown in the usage line (`<note>`).
// ============================================================================

import type { FlagSpecs, ParsedArgs } from './args';
import type { CliContext } from '../core/context';

export interface CommandSpec {
  name: string;
  summary: string;
  /** Positional signature for usage/help, e.g. `<note>`. Omit when there are none. */
  params?: string;
  flags: FlagSpecs;
  run(ctx: CliContext, args: ParsedArgs): Promise<void>;
}
