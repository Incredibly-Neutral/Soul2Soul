// ============================================================================
// s2s author offer <note> [--cid <kuboCid>] — the on-chain offer step.
//
// Default: sign + upload the note (Kubo + pins, frontmatter write-back) and then
// append it on-chain with `makeOffer` — i.e. `upload` and `offer` in one pass.
// This is what "offer this note" means: the bytes the chain anchors are the
// bytes in the note right now, never a stale `cid` left by an earlier
// upload.
//
// `--cid <kuboCid>` keeps the split-out half: anchor an ALREADY-uploaded CID
// (re-offer after a failed chain write, backfill an older revision) with no
// re-upload, no pins, no render, no frontmatter write.
// ============================================================================

import type { CommandSpec } from '../lib/command';
import { authorWrite, offerContent } from '../core/author';
import { requireNotePath, resolvePublication } from './helpers';
import { flagBool, flagString } from '../lib/args';
import { ipfsGatewayUrl, ipfsUri } from '../lib/ipfs-link';

export const offer: CommandSpec = {
  name: 'offer',
  summary: 'Upload a note (IPFS + pins) and append it on-chain (makeOffer).',
  usage:
    's2s author offer <note> [--publication <ens>] [--cid <kuboCid>] [--allow-plaintext] [--json]',
  async run(ctx, args) {
    const notePath = requireNotePath(args);
    const kuboCidFlag = flagString(args.flags, 'cid');
    const publication = await resolvePublication(ctx, args, notePath);
    // Same escape hatch as upload/preview/publish: accept a plaintext revision
    // of a previously-encrypted genesis.
    const allowPlaintext = flagBool(args.flags, 'allow-plaintext');

    // --cid: anchor that CID as-is (the content is already on IPFS).
    if (kuboCidFlag) {
      ctx.out.log(`offering ${notePath} (${kuboCidFlag}) → ${publication}`);
      const result = await offerContent(ctx, notePath, publication, kuboCidFlag, {
        allowPlaintext,
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
          ipfsUrl: ipfsUri(result.kuboCid),
          gatewayUrl: ipfsGatewayUrl(result.kuboCid),
        },
        [
          `Offered ${notePath}`,
          `  publication : ${result.publication}`,
          `  objectId    : ${result.objectId}`,
          `  kubo cid    : ${result.kuboCid} (reused — not re-uploaded)`,
          `  tx          : ${result.txHash}`,
        ].join('\n'),
      );
      return;
    }

    // Default: upload now, then offer exactly what was uploaded.
    ctx.out.log(`offering ${notePath} → ${publication}`);
    const result = await authorWrite(ctx, notePath, publication, {
      render: false,
      publish: true,
      offer: true,
      allowPlaintext,
    });

    if (!result.txHash) {
      // `offer: true` always resolves the service and appends; a missing hash
      // means the core changed under this command.
      throw new Error('internal: on-chain offer requested but no transaction hash was returned');
    }

    ctx.out.result(
      {
        action: 'offer',
        note: notePath,
        publication: result.publication,
        subdomain: result.subdomain,
        objectId: result.objectId,
        kuboCid: result.kuboCid,
        txHash: result.txHash,
        ipfsUrl: ipfsUri(result.kuboCid),
        gatewayUrl: ipfsGatewayUrl(result.kuboCid),
        frontmatterWritten: result.frontmatterWritten,
      },
      [
        `Offered ${notePath}`,
        `  publication : ${result.publication}`,
        `  objectId    : ${result.objectId}`,
        `  kubo cid    : ${result.kuboCid}`,
        `  tx          : ${result.txHash}`,
        `  live        : not rendered — run: s2s author publish ${notePath}`,
      ].join('\n'),
    );
  },
};
