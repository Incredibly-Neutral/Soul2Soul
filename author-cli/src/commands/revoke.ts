// ============================================================================
// s2s author revoke <note> — full withdrawal + site removal.
// On-chain retract FIRST (author-caller path fully withdraws from deals and/or
// offers), then a remove-plumbing re-render so the production site stops
// resolving the content path (SPEC-hosts AD-4).
// ============================================================================

import type { CommandSpec } from '../lib/command';
import { revokeContent } from '../core/author';
import { requireNotePath, resolvePublication } from './helpers';

export const revoke: CommandSpec = {
  name: 'revoke',
  summary: 'Retract a note on-chain and remove it from the rendered site.',
  usage: 's2s author revoke <note> [--publication <ens>] [--json]',
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
            }
          : undefined,
      },
      [
        `Revoked ${notePath}`,
        `  publication : ${result.publication}`,
        `  objectId    : ${result.objectId}`,
        `  tx          : ${result.txHash}`,
        result.render
          ? [
              `  re-render   : ${result.render.cid}`,
              `  removed     : ${result.render.path}`,
            ].join('\n')
          : '  render      : (none)',
      ].join('\n'),
    );
  },
};
