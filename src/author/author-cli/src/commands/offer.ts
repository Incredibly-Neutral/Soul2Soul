// ============================================================================
// s2s author offer <note> [--cid <kuboCid>] — the on-chain offer step.
// The split-out on-chain half of the old combined upload: the content must
// already be on IPFS (run `s2s author upload` first — it writes `genesis` and
// `kubo_cid` back to the note). Without `--cid`, the CID stored by the last
// upload is used, so `offer` needs no flags after an `upload`.
// No re-upload, no render, no pins.
// ============================================================================

import type { CommandSpec } from '../lib/command';
import { offerContent } from '../core/author';
import { requireNotePath, resolvePublication } from './helpers';
import { flagBool, flagString } from '../lib/args';

export const offer: CommandSpec = {
  name: 'offer',
  summary: 'Offer already-uploaded content on-chain (makeOffer; run upload first).',
  usage:
    's2s author offer <note> [--cid <kuboCid>] [--publication <ens>] [--allow-plaintext] [--json]',
  async run(ctx, args) {
    const notePath = requireNotePath(args);
    const kuboCid = flagString(args.flags, 'cid');
    const publication = await resolvePublication(ctx, args, notePath);

    ctx.out.log(`offering ${notePath} (${kuboCid ?? 'cid from frontmatter'}) → ${publication}`);
    const result = await offerContent(ctx, notePath, publication, kuboCid, {
      // Same escape hatch as upload/preview/publish: accept a plaintext
      // revision of a previously-encrypted genesis.
      allowPlaintext: flagBool(args.flags, 'allow-plaintext'),
    });

    ctx.out.result(
      {
        action: 'offer',
        note: notePath,
        publication: result.publication,
        subdomain: result.subdomain,
        objectId: result.objectId,
        kuboCid: result.kuboCid,
        txHash: result.txHash,
      },
      [
        `Offered ${notePath}`,
        `  publication : ${result.publication}`,
        `  objectId    : ${result.objectId}`,
        `  kubo cid    : ${result.kuboCid}`,
        `  tx          : ${result.txHash}`,
      ].join('\n'),
    );
  },
};
