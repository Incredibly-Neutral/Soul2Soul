// ============================================================================
// s2s author upload <note> — append-only.
// Signs the content, uploads it to Kubo, and appends an offer on-chain.
// No render, no site mutation (SPEC-hosts AD-4: upload = append + durability).
// ============================================================================

import type { CommandSpec } from '../lib/command';
import { authorWrite } from '../core/author';
import { requireNotePath, resolvePublication } from './helpers';

export const upload: CommandSpec = {
  name: 'upload',
  summary: 'Append a note to a publication (sign + Kubo upload + on-chain offer).',
  usage: 's2s author upload <note> [--publication <ens>] [--json]',
  async run(ctx, args) {
    const notePath = requireNotePath(args);
    const publication = await resolvePublication(ctx, args, notePath);

    ctx.out.log(`uploading ${notePath} → ${publication}`);
    const result = await authorWrite(ctx, notePath, publication, {
      render: false,
      publish: true,
    });

    ctx.out.result(
      {
        action: 'upload',
        note: notePath,
        publication: result.publication,
        subdomain: result.subdomain,
        objectId: result.objectId,
        kuboCid: result.kuboCid,
        txHash: result.txHash,
        frontmatterWritten: result.frontmatterWritten,
      },
      [
        `Appended ${notePath}`,
        `  publication : ${result.publication}`,
        `  objectId    : ${result.objectId}`,
        `  kubo cid    : ${result.kuboCid}`,
        `  tx          : ${result.txHash}`,
      ].join('\n'),
    );
  },
};
