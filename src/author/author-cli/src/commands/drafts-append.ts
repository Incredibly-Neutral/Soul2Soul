// ============================================================================
// s2s drafts append <genesis> <cid> — record a version in the drafts log
// without uploading one.
//
// This is the retry an upload names when its append failed: the bytes are
// already pinned at <cid>, so nothing is signed, uploaded or pinned again. It is
// the same append every real upload makes (`core/drafts.ts`), which is why the
// two cannot disagree about the module, the id or the version count.
//
// The genesis is spelled the way the note spells it: the append converts it with
// shared's `toBytes32Id`, exactly as `makeOffer` does, so a 0x-string, a bare hex
// hash and a legacy id all land on the same bytes32 the log keys on.
// ============================================================================

import type { Address } from 'viem';

import type { CliContext } from '../core/context';
import type { CommandSpec } from '../lib/command';
import { appendDraft, type AppendDraftDeps } from '../core/drafts';
import { UsageError } from '../lib/errors';

/** The result the Neovim contract reads. */
export interface DraftsAppendResult {
  action: 'drafts.append';
  author: string | null;
  module: Address;
  genesis: string;
  cid: string;
  txHash: string;
  /**
   * Versions the log holds for `genesis`, read back after the append. Absent
   * when that read failed: the append landed, the count is unknown.
   */
  versionCount?: number;
}

/** What the append needs; a test replaces the seam and the Safe read. */
export type DraftsAppendDeps = Partial<AppendDraftDeps>;

export async function runDraftsAppend(
  ctx: CliContext,
  genesis: string,
  cid: string,
  overrides: DraftsAppendDeps = {},
): Promise<DraftsAppendResult> {
  const draft = await appendDraft(ctx, { genesis, cid }, overrides);

  const result: DraftsAppendResult = {
    action: 'drafts.append',
    author: ctx.config.author?.name ?? null,
    module: draft.module,
    genesis: draft.genesis,
    cid: draft.cid,
    txHash: draft.txHash,
    ...(draft.versionCount === undefined ? {} : { versionCount: draft.versionCount }),
  };

  ctx.out.result(
    result,
    [
      `Appended ${draft.cid}`,
      `  genesis  : ${draft.genesis}`,
      `  module   : ${draft.module}`,
      `  versions : ${
        draft.versionCount === undefined
          ? 'not read back — the append landed, so do not append it again'
          : String(draft.versionCount)
      }`,
      `  tx       : ${draft.txHash}`,
    ].join('\n'),
  );
  return result;
}

export const draftsAppend: CommandSpec = {
  name: 'append',
  summary: "Append a version to a genesis in the active author Safe's drafts log.",
  params: '<genesis> <cid>',
  detail:
    'The retry an upload names when its append failed: the bytes are already pinned, so nothing is uploaded again.',
  flags: {},
  async run(ctx, args) {
    const genesis = args.positionals[0];
    const cid = args.positionals[1];
    if (!genesis) {
      throw new UsageError('s2s drafts append <genesis> <cid> — the genesis id is missing');
    }
    if (!cid) {
      throw new UsageError('s2s drafts append <genesis> <cid> — the cid is missing');
    }
    await runDraftsAppend(ctx, genesis, cid);
  },
};
