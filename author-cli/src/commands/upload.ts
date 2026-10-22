// ============================================================================
// s2s author upload <note> — ipfs + pins only (off-chain).
// Signs the content, uploads it to Kubo, fires the durability legs
// (filebase + pinata + filecoin), and writes genesis/author back to the note.
// No on-chain offer — that is the separate `propose` step.
// ============================================================================

import type { CommandSpec } from '../lib/command';
import { authorWrite } from '../core/author';
import { requireNotePath, resolvePublication } from './helpers';

export const upload: CommandSpec = {
  name: 'upload',
  summary: 'Upload a note to IPFS + pins (no on-chain offer — propose it separately).',
  usage: 's2s author upload <note> [--publication <ens>] [--json]',
  async run(ctx, args) {
    const notePath = requireNotePath(args);
    const publication = await resolvePublication(ctx, args, notePath);

    ctx.out.log(`uploading ${notePath} → ${publication}`);
    const result = await authorWrite(ctx, notePath, publication, {
      render: false,
      publish: true,
      offer: false,
    });

    ctx.out.result(
      {
        action: 'upload',
        note: notePath,
        publication: result.publication,
        subdomain: result.subdomain,
        objectId: result.objectId,
        kuboCid: result.kuboCid,
        frontmatterWritten: result.frontmatterWritten,
      },
      [
        `Uploaded ${notePath}`,
        `  publication : ${result.publication}`,
        `  objectId    : ${result.objectId}`,
        `  kubo cid    : ${result.kuboCid}`,
        `  offer       : not proposed on-chain — run: s2s author propose ${notePath}${result.frontmatterWritten ? '' : ` --cid ${result.kuboCid}`}`,
      ].join('\n'),
    );
  },
};
