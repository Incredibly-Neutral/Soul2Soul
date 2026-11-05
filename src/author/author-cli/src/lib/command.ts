// ============================================================================
// Command contract — every `s2s author <action>` implements CommandSpec.
// The context is built once in cli.ts and handed to the resolved command.
// ============================================================================

import type { ParsedArgs } from './args';
import type { CliOut } from './out';
import type { CliContext } from '../core/context';

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  run(ctx: CliContext, args: ParsedArgs): Promise<void>;
}

/**
 * A command that runs WITHOUT a `CliContext`: no private key, no RPC, no
 * bundler, no Lit. `cli.ts` dispatches these before `buildContext` (the same
 * contract the `config` group uses), which is what lets `author new` / `switch`
 * / `list` / `rm` work on a machine where nothing is configured yet.
 */
export interface StoreCommandSpec {
  name: string;
  summary: string;
  usage: string;
  run(out: CliOut, args: ParsedArgs): Promise<void> | void;
}
