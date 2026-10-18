// ============================================================================
// s2s author propose <note> --cid <kuboCid> — the on-chain offer step.
// The split-out on-chain half of the old combined upload: the content must
// already be on IPFS (run `s2s author upload` first — it writes `genesis`
// back to the note and reports `kuboCid`). No re-upload, no render, no pins.
// ============================================================================

import type { CommandSpec } from '../lib/command';
import { proposeContent } from '../core/author';
import { requireNotePath, resolvePublication } from './helpers';
import { flagString } from '../lib/args';
import { UsageError } from '../lib/errors';

export const propose: CommandSpec = {
  name: 'propose',
  summary: 'Offer already-uploaded content on-chain (makeOffer; run upload first).',
  usage: 's2s author propose <note> --cid <kuboCid> [--publication <ens>] [--json]',
  async run(ctx, args) {
    const notePath = requireNotePath(args);
    const kuboCid = flagString(args.flags, 'cid');
    if (!kuboCid) {
      throw new UsageError(
        'missing required flag: --cid <kuboCid> (the CID reported by `s2s author upload`)',
      );
    }
    const publication = await resolvePublication(ctx, args, notePath);

    ctx.out.log(`proposing ${notePath} (${kuboCid}) → ${publication}`);
    const result = await proposeContent(ctx, notePath, publication, kuboCid);

    ctx.out.result(
      {
        action: 'propose',
        note: notePath,
        publication: result.publication,
        subdomain: result.subdomain,
        objectId: result.objectId,
        kuboCid: result.kuboCid,
        txHash: result.txHash,
      },
      [
        `Proposed ${notePath}`,
        `  publication : ${result.publication}`,
        `  objectId    : ${result.objectId}`,
        `  kubo cid    : ${result.kuboCid}`,
        `  tx          : ${result.txHash}`,
      ].join('\n'),
    );
  },
};
