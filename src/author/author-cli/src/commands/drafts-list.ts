// ============================================================================
// s2s drafts list — the drafts log on the active author Safe.
//
// A chain read, nothing signed: which module answers for the Safe (the enabled
// list first, the factory index second, never the name), how many genesis ids it
// holds, and one row per draft. The human form is those rows and nothing else:
// `order  genesis  versions  latest`, the order being the position in the log's
// own sequence, the genesis in full because it is the argument `s2s drafts
// append` takes, the latest version's block time in UTC minutes. No module line,
// no count line, no header row. The order is not in the JSON — the array order is
// the order. An empty log prints nothing, and the only stderr line is the
// factory-index warning: provenance belongs on stderr, not in the rows.
//
// `label` is an unsigned V2 field: nothing on this module answers it, so this
// version lists no label and does not invent one.
//
// The order is the log's own: appends only extend, and pagination is stable, so
// the rows come back in insertion order with no sort.
// ============================================================================

import type { Address } from 'viem';

import type { CliContext } from '../core/context';
import type { CommandSpec } from '../lib/command';
import { authorSafeState } from '../core/author-safe';
import {
  defaultDraftsSeam,
  draftsFactory,
  readDrafts,
  resolveDraftsModule,
  type DraftEntry,
  type DraftsModuleSource,
  type DraftsSeam,
  type ResolvedDraftsModule,
} from '../core/drafts';
import { UsageError, CliError } from '../lib/errors';

/** The result the Neovim contract reads. */
export interface DraftsListResult {
  action: 'drafts.list';
  author: string | null;
  safe: Address;
  module: Address;
  source: DraftsModuleSource;
  count: number;
  drafts: DraftEntry[];
}

/** The reads the command makes; a test replaces them whole. */
export interface DraftsListDeps {
  seam: DraftsSeam;
  /** The author id: the Safe, predicted or stored, and whether it has code. */
  safeState(ctx: CliContext): Promise<{ address: Address; deployed: boolean }>;
}

export function draftsListDeps(overrides: Partial<DraftsListDeps> = {}): DraftsListDeps {
  return {
    seam: overrides.seam ?? defaultDraftsSeam,
    safeState: overrides.safeState ?? authorSafeState,
  };
}

/** `0x…` → `YYYY-MM-DD HH:mm` in UTC, no seconds and no `Z`. */
export function utcMinute(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * The human block: one row per draft and nothing else.
 *
 * `order  genesis  versions  latest`, two spaces between columns. The order is
 * the position in the log's own sequence — the order `readDrafts` returns, which
 * is first-append order — so it is the same on every run and numbers the rows a
 * reader can act on. The genesis is never truncated: it is the argument
 * `s2s drafts append` takes, and an elided one cannot be copied. An empty log is
 * the empty string: the list is the output, and a line saying the list is empty
 * is not the list.
 */
export function draftsListLines(result: DraftsListResult): string {
  const orderWidth = String(result.drafts.length).length;
  return result.drafts
    .map(
      (draft, index) =>
        `${String(index + 1).padStart(orderWidth)}  ${draft.genesis}  ${String(draft.versionCount)}  ${utcMinute(draft.timestamp)}`,
    )
    .join('\n');
}

export async function runDraftsList(
  ctx: CliContext,
  overrides: Partial<DraftsListDeps> = {},
): Promise<void> {
  const deps = draftsListDeps(overrides);
  const rpcUrl = ctx.rpcs.L2[0];
  if (!rpcUrl) {
    throw new UsageError('no L2 RPC endpoint configured — set S2S_RPC_L2 (or BASE_RPC_URL)');
  }

  const { address: safe, deployed } = await deps.safeState(ctx);
  // A predicted Safe has no code, so every module read against it answers nothing
  // and viem reports an empty return as a raw error. Nothing can be enabled on a
  // Safe that is not there, and the command that deploys it is the remedy.
  if (!deployed) {
    throw new CliError(
      `the author Safe ${safe} is not deployed yet — run: s2s author init`,
      1,
      'safe_not_deployed',
    );
  }
  const resolved: ResolvedDraftsModule = await resolveDraftsModule(
    { safe, rpcUrl, factory: draftsFactory(ctx.config) },
    deps.seam,
  );
  const drafts = await readDrafts({ address: resolved.address, rpcUrl }, deps.seam);

  const result: DraftsListResult = {
    action: 'drafts.list',
    author: ctx.config.author?.name ?? null,
    safe,
    module: resolved.address,
    source: resolved.source,
    count: drafts.length,
    drafts,
  };

  // The index is permissionless and unwritten by this Safe: anyone can create a
  // proxy for it. A module the Safe enabled is its own adoption and needs no
  // warning; one the index alone names does, once, on stderr.
  if (result.source === 'factory' && !resolved.onEnabledList) {
    ctx.out.warn(
      `drafts module ${result.module} is not on the Safe's enabled list — found it in the factory index, which is permissionless and unwritten by this Safe, so these rows are what the index names rather than what the Safe enabled; run \`s2s author init\` to enable it`,
    );
  }

  const human = draftsListLines(result);
  // The empty log is no stdout line at all, not a blank one. `--json` still
  // prints its envelope.
  if (human !== '' || ctx.out.json) {
    ctx.out.result(result, human);
  }
}

export const draftsList: CommandSpec = {
  name: 'list',
  summary: "List the drafts in the active author Safe's drafts module.",
  flags: {},
  async run(ctx) {
    await runDraftsList(ctx);
  },
};
