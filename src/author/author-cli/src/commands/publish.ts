// ============================================================================
// s2s author publish <note> — the all-in-one flow.
// sign → Kubo upload → on-chain offer → prod render (Lit nodes)
// → fire-and-forget 4-way backup (Kubo + Pinata + Filebase + Filecoin).
// Equals upload + offer + render + pins in a single invocation.
// ============================================================================

import type { CommandSpec } from '../lib/command';
import { authorWrite } from '../core/author';
import { requireNotePath, resolvePublication, rootTxLine } from './helpers';
import { flagBool } from '../lib/args';

export const publish: CommandSpec = {
  name: 'publish',
  summary: 'Upload, offer on-chain, render on the production site, and back it up (one-shot).',
  usage: 's2s author publish <note> [--publication <ens>] [--allow-plaintext] [--json]',
  async run(ctx, args) {
    const notePath = requireNotePath(args);
    const publication = await resolvePublication(ctx, args, notePath);

    ctx.out.log(`publishing ${notePath} → ${publication}`);
    const result = await authorWrite(ctx, notePath, publication, {
      render: true,
      publish: true,
      offer: true,
      // Explicit opt-in to republishing a previously-encrypted genesis in the clear.
      allowPlaintext: flagBool(args.flags, 'allow-plaintext'),
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
              rootTx: result.render.rootTx,
              trace: result.render.trace,
            }
          : undefined,
      },
      [
        `Published ${notePath}`,
        `  publication : ${result.publication}`,
        `  objectId    : ${result.objectId}`,
        `  kubo cid    : ${result.kuboCid}`,
        `  tx          : ${result.txHash ?? '(offer step not run)'}`,
        result.render
          ? [
              `  render      : ${result.render.cid}`,
              `  path        : ${result.render.path}`,
              `  live        : ${result.render.prodUrl ?? result.render.previewUrl}`,
              rootTxLine(result.render),
            ].join('\n')
          : '  render      : (none)',
      ].join('\n'),
    );
  },
};
