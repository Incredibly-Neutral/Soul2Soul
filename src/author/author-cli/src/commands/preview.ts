// ============================================================================
// s2s author preview <note> — upload + preview render (Bun runner).
// Off-chain: ipfs upload + a preview render via the Bun runner; no on-chain
// offer and no prod mutation (SPEC-author-hosts AD-4).
// ============================================================================

import type { CommandSpec } from '../lib/command';
import { authorWrite } from '../core/author';
import { requireNotePath, resolvePublication, rootTxLine } from './helpers';
import { flagBool } from '../lib/args';

export const preview: CommandSpec = {
  name: 'preview',
  summary: 'Upload a note and render a preview (Bun runner, no on-chain offer, no prod mutation).',
  usage: 's2s author preview <note> [--publication <ens>] [--allow-plaintext] [--json]',
  async run(ctx, args) {
    const notePath = requireNotePath(args);
    const publication = await resolvePublication(ctx, args, notePath);

    ctx.out.log(`previewing ${notePath} → ${publication}`);
    const result = await authorWrite(ctx, notePath, publication, {
      render: true,
      publish: false,
      offer: false,
      // Explicit opt-in to republishing a previously-encrypted genesis in the clear.
      allowPlaintext: flagBool(args.flags, 'allow-plaintext'),
    });

    ctx.out.result(
      {
        action: 'preview',
        note: notePath,
        publication: result.publication,
        subdomain: result.subdomain,
        objectId: result.objectId,
        cid: result.kuboCid,
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
        `Previewed ${notePath}`,
        `  publication : ${result.publication}`,
        `  objectId    : ${result.objectId}`,
        `  cid         : ${result.kuboCid}`,
        result.render
          ? [
              `  render      : ${result.render.cid}`,
              `  path        : ${result.render.path}`,
              `  preview     : ${result.render.previewUrl}`,
              rootTxLine(result.render),
            ].join('\n')
          : '  render      : (none)',
      ].join('\n'),
    );
  },
};
