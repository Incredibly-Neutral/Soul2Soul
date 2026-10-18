// ============================================================================
// s2s author preview <note> — append + preview render (Bun runner).
// Same on-chain append as upload, plus a preview render via the Bun runner;
// never touches the production site (SPEC-hosts AD-4).
// ============================================================================

import type { CommandSpec } from '../lib/command';
import { authorWrite } from '../core/author';
import { requireNotePath, resolvePublication } from './helpers';

export const preview: CommandSpec = {
  name: 'preview',
  summary: 'Append a note and render a preview (Bun runner, no prod mutation).',
  usage: 's2s author preview <note> [--publication <ens>] [--json]',
  async run(ctx, args) {
    const notePath = requireNotePath(args);
    const publication = await resolvePublication(ctx, args, notePath);

    ctx.out.log(`previewing ${notePath} → ${publication}`);
    const result = await authorWrite(ctx, notePath, publication, {
      render: true,
      publish: false,
    });

    ctx.out.result(
      {
        action: 'preview',
        note: notePath,
        publication: result.publication,
        subdomain: result.subdomain,
        objectId: result.objectId,
        kuboCid: result.kuboCid,
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
        `Previewed ${notePath}`,
        `  publication : ${result.publication}`,
        `  objectId    : ${result.objectId}`,
        `  kubo cid    : ${result.kuboCid}`,
        `  tx          : ${result.txHash}`,
        result.render
          ? [
              `  render      : ${result.render.cid}`,
              `  path        : ${result.render.path}`,
              `  preview     : ${result.render.previewUrl}`,
            ].join('\n')
          : '  render      : (none)',
      ].join('\n'),
    );
  },
};
