// ============================================================================
// s2s author revoke <note> — full withdrawal + site removal.
// On-chain retract FIRST, then a remove-plumbing re-render so the production
// site stops resolving the content path (SPEC-author-hosts AD-4).
// `retract` is the author's terminal verb: it ends the genesis and tombstones
// the latest version, so the note id cannot be offered again. Republishing
// means a new note; the summary and the result block both say so.
// ============================================================================

import type { CommandSpec } from '../lib/command';
import { revokeContent } from '../core/author';
import { requireNotePath, resolvePublication, rootTxLine } from './helpers';
import { PUBLICATION_FLAG } from './flags';

export const revoke: CommandSpec = {
  name: 'revoke',
  summary:
    'Retract a note on-chain (terminal: the note id is spent) and remove it from the rendered site.',
  params: '<note>',
  flags: { publication: PUBLICATION_FLAG },
  async run(ctx, args) {
    const notePath = requireNotePath(args);
    const publication = await resolvePublication(ctx, args, notePath);

    ctx.out.log(`revoking ${notePath} from ${publication}`);
    const result = await revokeContent(ctx, notePath, publication);

    ctx.out.result(
      {
        action: 'revoke',
        note: notePath,
        publication: result.publication,
        subdomain: result.subdomain,
        objectId: result.objectId,
        txHash: result.txHash,
        render: result.render
          ? {
              cid: result.render.cid,
              path: result.render.path,
              previewUrl: result.render.previewUrl,
              rootTx: result.render.rootTx,
              trace: result.render.trace,
            }
          : undefined,
      },
      [
        `Revoked ${notePath}`,
        '  genesis     : ENDED — this note id cannot be published again; republishing needs a new note',
        `  publication : ${result.publication}`,
        `  objectId    : ${result.objectId}`,
        `  tx          : ${result.txHash}`,
        result.render
          ? [
              `  re-render   : ${result.render.cid}`,
              `  removed     : ${result.render.path}`,
              rootTxLine(result.render),
            ].join('\n')
          : '  render      : (none)',
      ].join('\n'),
    );
  },
};
