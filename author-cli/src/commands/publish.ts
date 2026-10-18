// ============================================================================
// s2s author publish <note> — append + prod render + durability.
// The full flow: sign → Kubo upload → on-chain offer → prod render (Lit nodes)
// → fire-and-forget 4-way backup (Kubo + Pinata + Filebase + Filecoin).
// ============================================================================

import type { CommandSpec } from '../lib/command';
import { authorWrite } from '../core/author';
import { requireNotePath, resolvePublication } from './helpers';

export const publish: CommandSpec = {
  name: 'publish',
  summary: 'Append a note, render it on the production site, and back it up.',
  usage: 's2s author publish <note> [--publication <ens>] [--json]',
  async run(ctx, args) {
    const notePath = requireNotePath(args);
    const publication = await resolvePublication(ctx, args, notePath);

    ctx.out.log(`publishing ${notePath} → ${publication}`);
    const result = await authorWrite(ctx, notePath, publication, {
      render: true,
      publish: true,
    });

    ctx.out.result(
      {
        action: 'publish',
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
              prodUrl: result.render.prodUrl,
            }
          : undefined,
      },
      [
        `Published ${notePath}`,
        `  publication : ${result.publication}`,
        `  objectId    : ${result.objectId}`,
        `  kubo cid    : ${result.kuboCid}`,
        `  tx          : ${result.txHash}`,
        result.render
          ? [
              `  render      : ${result.render.cid}`,
              `  path        : ${result.render.path}`,
              `  live        : ${result.render.prodUrl ?? result.render.previewUrl}`,
            ].join('\n')
          : '  render      : (none)',
      ].join('\n'),
    );
  },
};
