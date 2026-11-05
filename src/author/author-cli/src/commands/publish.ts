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
import { NOTE_FLAGS } from './flags';

export const publish: CommandSpec = {
  name: 'publish',
  summary: 'Upload, offer on-chain, render on the production site, and back it up (one-shot).',
  params: '<note>',
  flags: NOTE_FLAGS,
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

    // The human block drops `tx` (the offer — recorded on-chain but never what
    // the site serves) and names the object CID `manuscript`, so the two CIDs
    // read as what they are: the pinned note JSON, and the site-tree root the
    // ENS write points at. `render`/`path` stay in the --json payload only.
    const rootCid = result.render?.cid;
    const sameCid = rootCid !== undefined && rootCid === result.kuboCid;
    const lines = [
      `Published ${notePath}`,
      `  publication : ${result.publication}`,
      `  objectId    : ${result.objectId}`,
      sameCid
        ? `  manuscript  : ${result.kuboCid} (= root cid)`
        : `  manuscript  : ${result.kuboCid}`,
    ];
    if (!result.render) {
      lines.push('  root cid    : (not rendered)');
    } else {
      if (!sameCid) lines.push(`  root cid    : ${result.render.cid}`);
      // `.link` is the gateway readers actually hit; the bare ENS name is not
      // an HTTP origin. `path` is already root-absolute (`/manuscript/`).
      lines.push(`  live        : https://${result.publication}.link${result.render.path}`);
      lines.push(rootTxLine(result.render));
    }

    ctx.out.result(
      {
        action: 'publish',
        note: notePath,
        publication: result.publication,
        subdomain: result.subdomain,
        objectId: result.objectId,
        cid: result.kuboCid,
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
      lines.join('\n'),
    );
  },
};
