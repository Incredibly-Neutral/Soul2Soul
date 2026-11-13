// ============================================================================
// s2s drafts list — the drafts log on the active author Safe.
//
// A chain read, nothing signed: which module answers for the Safe (the enabled
// list first, the factory index second, never the name), how many genesis ids it
// holds, and one row per draft. The row identifier is the genesis id — the same
// value the note carries and `makeOffer` would use — then the version count and
// the latest version's block time.
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

/** `0x…` → the ISO instant of that many seconds since the epoch. */
export function isoDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** How the module was found, in the words the human line uses. */
function sourceText(source: DraftsModuleSource): string {
  return source === 'enabled'
    ? 'enabled on the Safe'
    : 'from the factory index (not enabled on the Safe)';
}

/**
 * The empty-log line, which must not claim more than the source proves. An
 * enabled module is the Safe's own adoption, so the log is the Safe's. A module
 * from the factory index is a proxy the Safe may never have used: the index is
 * permissionless, so the line says what the index said and no more.
 */
export function emptyLogLine(result: DraftsListResult): string {
  const what =
    result.source === 'enabled'
      ? "nothing has been appended to this Safe's log"
      : 'the factory index names it for this Safe, and it holds no entries';
  return `no drafts in module ${result.module} (author Safe ${result.safe}) — ${what}`;
}

/**
 * The human block: the module and how it was found, then one row per draft.
 * An empty log is one line and nothing else — a header over no rows would make
 * the reader look for a table that is not there.
 */
export function draftsListLines(result: DraftsListResult): string {
  if (result.count === 0) {
    return emptyLogLine(result);
  }

  const genesisWidth = Math.max(...result.drafts.map((draft) => draft.genesis.length));
  const versionWidth = Math.max(...result.drafts.map((draft) => String(draft.versionCount).length));
  const rows = result.drafts.map(
    (draft) =>
      `${draft.genesis.padEnd(genesisWidth)}  ${String(draft.versionCount).padStart(versionWidth)}  ${isoDate(draft.timestamp)}`,
  );

  return [
    `module ${result.module} — ${sourceText(result.source)} — author Safe ${result.safe}`,
    `drafts ${String(result.count)}`,
    '',
    `${'genesis'.padEnd(genesisWidth)}  ${'versions'.padStart(versionWidth)}  latest`,
    ...rows,
  ].join('\n');
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

  if (result.source === 'factory') {
    ctx.out.warn(
      `drafts module ${result.module} is not on the Safe's enabled list — found it in the factory index; run \`s2s author init\` to enable it`,
    );
  }
  ctx.out.result(result, draftsListLines(result));
}

export const draftsList: CommandSpec = {
  name: 'list',
  summary: "List the drafts in the active author Safe's drafts module.",
  flags: {},
  async run(ctx) {
    await runDraftsList(ctx);
  },
};
