// ============================================================================
// s2s author upload <note> — ipfs + pins only (off-chain).
// Signs the content, uploads it to Kubo, fires the durability legs
// (filebase + pinata + filecoin), and writes genesis/author back to the note.
// No on-chain offer — `offer` does upload + offer in one pass, `publish` does
// upload + offer + render. `upload` is the off-chain half on its own.
// ============================================================================

import type { CommandSpec } from '../lib/command';
import { authorWrite } from '../core/author';
import { requireNotePath, resolvePublication } from './helpers';
import { flagBool } from '../lib/args';
import { NOTE_FLAGS } from './flags';
import { ipfsGatewayUrl, ipfsUri } from '../lib/ipfs-link';

export const upload: CommandSpec = {
  name: 'upload',
  summary: 'Upload a note to IPFS + pins, off-chain only (no offer, no render).',
  params: '<note>',
  flags: NOTE_FLAGS,
  async run(ctx, args) {
    const notePath = requireNotePath(args);
    const publication = await resolvePublication(ctx, args, notePath);

    ctx.out.log(`uploading ${notePath} → ${publication}`);
    const result = await authorWrite(ctx, notePath, publication, {
      render: false,
      publish: true,
      offer: false,
      // Explicit opt-in to republishing a previously-encrypted genesis in the clear.
      allowPlaintext: flagBool(args.flags, 'allow-plaintext'),
    });

    ctx.out.result(
      {
        action: 'upload',
        note: notePath,
        publication: result.publication,
        subdomain: result.subdomain,
        objectId: result.objectId,
        cid: result.kuboCid,
        // Public links for the uploaded CID — additive scalars, existing keys unchanged.
        ipfsUrl: ipfsUri(result.kuboCid),
        gatewayUrl: ipfsGatewayUrl(result.kuboCid),
        frontmatterWritten: result.frontmatterWritten,
        // Every real upload appends to the drafts log; the key is absent when a
        // run made no append (a preview), never present-and-null.
        draft: result.draft,
      },
      [
        `Uploaded ${notePath}`,
        `  publication : ${result.publication}`,
        `  objectId    : ${result.objectId}`,
        `  cid         : ${result.kuboCid}`,
        `  link        : ${ipfsGatewayUrl(result.kuboCid)}`,
        `  offer       : not offered on-chain — run: s2s author offer ${notePath}${result.frontmatterWritten ? '' : ` --cid ${result.kuboCid}`}`,
        `  note        : \`offer\` re-uploads; pass --cid ${result.kuboCid} to anchor these exact bytes without one`,
      ].join('\n'),
    );
  },
};
